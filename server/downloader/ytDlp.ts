import path from "path";
import fs from "fs";
import ytDlp from "yt-dlp-exec";

// ── Download queue: serialize all yt-dlp calls to avoid parallel requests ──
// YouTube aggressively bans cookies when it sees many concurrent requests
// from the same session. This queue ensures only 1 download runs at a time.
const DELAY_BETWEEN_DOWNLOADS_MS = 2000; // 2s pause between downloads
let downloadQueueChain: Promise<void> = Promise.resolve();

function enqueueDownload<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    downloadQueueChain = downloadQueueChain
      .then(() => delay(DELAY_BETWEEN_DOWNLOADS_MS))
      .then(() => fn())
      .then(resolve)
      .catch(reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type YtFormat = {
  id: string;
  ext: string;
  formatNote?: string;
  acodec?: string;
  vcodec?: string;
  fps?: number;
  width?: number;
  height?: number;
  filesize?: number;
  filesizeApprox?: number;
  isVideoOnly: boolean;
  isAudioOnly: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
};

export type NormalizedFormat = {
  id: string;
  label: string;
  ext: string;
  height?: number;
  fps?: number;
  isVideoOnly: boolean;
  isAudioOnly: boolean;
};

/**
 * Default-but-robust yt-dlp options shared by every entry point. The big
 * deviations from yt-dlp defaults:
 *   socketTimeout:  20  → 60   (Facebook reels through Mullvad proxy were
 *                                hitting the 20s timeout on first byte)
 *   retries:        10 (yt-dlp default is 10) — we keep it but also wrap
 *                   the whole call with our own retry loop for transient
 *                   ETIMEDOUT / ECONNRESET / SSL errors that yt-dlp's
 *                   internal retry doesn't catch.
 *   fragmentRetries: same as retries
 */
function commonYtDlpOptions(): Record<string, any> {
  return {
    noCheckCertificates: true,
    noWarnings: true,
    // NOTE: do NOT set preferFreeFormats — it makes YouTube hand back AV1/VP9
    // (royalty-free but software-decode only on our VPS, which is 10× slower
    // than H.264 for our re-encode step).
    jsRuntimes: "node",
    addHeader: [
      "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ],
    socketTimeout: 60,
    retries: 10,
    fragmentRetries: 10,
    proxy: process.env.YT_DLP_PROXY,
    ...(getCookiesPath() ? { cookies: getCookiesPath() } : {}),
  };
}

// Prefer H.264 / AAC / MP4 over AV1/VP9/WebM. We re-encode every downloaded
// video later (compression for AI analysis, sandwich pipeline, etc.) and AV1
// software decoding on a no-GPU VPS dominates wall-clock time. H.264 decodes
// 5–10× faster.
const H264_FORMAT_BEST_1080 =
  "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]/" +
  "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/" +
  "best[ext=mp4][height<=1080]/" +
  "bestvideo[height<=1080]+bestaudio/" +
  "best[height<=1080]/best";

function h264FormatForAnalysis(maxHeight: number): string {
  return (
    `bestvideo[vcodec^=avc1][height<=${maxHeight}]+bestaudio[ext=m4a]/` +
    `bestvideo[ext=mp4][height<=${maxHeight}]+bestaudio[ext=m4a]/` +
    `best[ext=mp4][height<=${maxHeight}]/` +
    `bestvideo[height<=${maxHeight}]+bestaudio/` +
    `best[height<=${maxHeight}]/best`
  );
}

const NETWORK_RETRYABLE = /ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|read timed out|temporary failure|EOF occurred/i;

function getCookiesPath(): string | undefined {
  const cookiesFile = process.env.YT_COOKIES_FILE;
  if (!cookiesFile) return undefined;
  // Verify file exists
  if (!fs.existsSync(cookiesFile)) {
    console.warn(`[yt-dlp] Cookies file not found: ${cookiesFile}`);
    return undefined;
  }
  // yt-dlp hard-errors on an empty or non-Netscape cookies file
  // ("does not look like a Netscape format cookies file"), which aborts the
  // ENTIRE download. Treat an unusable file as "no cookies" so public videos
  // still download instead of every download failing outright.
  try {
    const trimmed = fs.readFileSync(cookiesFile, "utf8").trim();
    const looksNetscape =
      /^#\s*(Netscape|HTTP) /i.test(trimmed) ||
      trimmed.split("\n").some((l) => !l.startsWith("#") && l.split("\t").length >= 6);
    if (!trimmed || !looksNetscape) {
      console.warn(`[yt-dlp] Cookies file ${cookiesFile} is empty/invalid — ignoring it (downloading without cookies).`);
      return undefined;
    }
  } catch {
    console.warn(`[yt-dlp] Could not read cookies file ${cookiesFile} — ignoring it.`);
    return undefined;
  }
  return cookiesFile;
}

function isBotDetectionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /Sign in to confirm you.?re not a bot|bot detection|Please sign in/i.test(msg);
}

function isSSLError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  // Be specific to avoid false positives from "--no-check-certificates" in command text
  return /SSL_ERROR|TLSV1_ALERT|SSL_HANDSHAKE|certificate verify failed|unable to get local issuer certificate/i.test(msg);
}

async function ytDlpWithSSLFallback(
  url: string,
  options: Record<string, any>,
  attempt = 1
): Promise<any> {
  const MAX_ATTEMPTS = 3;
  const proxy = options.proxy;
  try {
    return await (ytDlp as any)(url, options);
  } catch (err) {
    // SSL errors via proxy → retry once without proxy
    if (proxy && isSSLError(err)) {
      console.warn(
        `[yt-dlp] SSL error with proxy, retrying without proxy for: ${url}`
      );
      const { proxy: _removed, ...optionsWithoutProxy } = options;
      return await (ytDlp as any)(url, optionsWithoutProxy);
    }
    // Bot detection — explicit guidance, no retry
    if (isBotDetectionError(err)) {
      const cookiesPath = getCookiesPath();
      if (!cookiesPath) {
        console.error(
          `[yt-dlp] BOT DETECTED by YouTube! Set YT_COOKIES_FILE env variable to a valid Netscape cookies.txt file.\n` +
          `  How to get cookies: Export from browser using "Get cookies.txt LOCALLY" extension, ` +
          `then upload to server and set YT_COOKIES_FILE=/path/to/cookies.txt in .env`
        );
      } else {
        console.error(
          `[yt-dlp] BOT DETECTED by YouTube even with cookies file: ${cookiesPath}\n` +
          `  The cookies may be expired. Re-export from browser and update the file.`
        );
      }
      throw err;
    }
    // Generic network jitter (Facebook through Mullvad gets random ETIMEDOUT
    // on a clean connection) — back off and retry.
    const msg = err instanceof Error ? err.message : String(err);
    if (NETWORK_RETRYABLE.test(msg) && attempt < MAX_ATTEMPTS) {
      const backoffMs = 2000 * attempt;
      console.warn(
        `[yt-dlp] network error (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${backoffMs}ms: ${msg.slice(0, 200)}`
      );
      await delay(backoffMs);
      return ytDlpWithSSLFallback(url, options, attempt + 1);
    }
    throw err;
  }
}

export async function listFormats(url: string): Promise<NormalizedFormat[]> {
  if (!url.trim()) {
    throw new Error("URL is required");
  }

  return enqueueDownload(async () => {
    console.log(`[yt-dlp queue] listFormats: ${url}`);
    const result = (await ytDlpWithSSLFallback(url, {
      ...commonYtDlpOptions(),
      dumpSingleJson: true,
    })) as any;

    const data = result as any;
    const formats: YtFormat[] = (data.formats || []).map((f: any) => ({
      id: String(f.format_id),
      ext: String(f.ext || ""),
      formatNote: f.format_note,
      acodec: f.acodec,
      vcodec: f.vcodec,
      fps: typeof f.fps === "number" ? f.fps : undefined,
      width: typeof f.width === "number" ? f.width : undefined,
      height: typeof f.height === "number" ? f.height : undefined,
      filesize: typeof f.filesize === "number" ? f.filesize : undefined,
      filesizeApprox:
        typeof f.filesize_approx === "number" ? f.filesize_approx : undefined,
      isVideoOnly: !f.acodec || f.acodec === "none",
      isAudioOnly: !f.vcodec || f.vcodec === "none",
      hasVideo: !!(f.vcodec && f.vcodec !== "none"),
      hasAudio: !!(f.acodec && f.acodec !== "none"),
    }));

    const normalized: NormalizedFormat[] = formats
      .filter((f) => f.hasVideo)
      .map((f) => {
        const height = f.height;
        const fps = f.fps;
        const parts = [];
        if (height) parts.push(`${height}p`);
        if (fps) parts.push(`${fps}fps`);
        if (f.isVideoOnly) parts.push("video-only");
        if (f.isAudioOnly) parts.push("audio-only");
        const label =
          parts.length > 0 ? parts.join(" ") : f.formatNote || f.id || "unknown";

        return {
          id: f.id,
          label,
          ext: f.ext,
          height,
          fps,
          isVideoOnly: f.isVideoOnly,
          isAudioOnly: f.isAudioOnly,
        };
      })
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    return normalized;
  });
}

/**
 * Fetch ONLY the video's duration (seconds) from yt-dlp metadata — NO download.
 * Fast (a few seconds), used so the Factory "Build plan" step can decide how
 * many variants to make without downloading the whole (possibly 17-min) video.
 * Returns null if it can't be determined.
 */
export async function getRemoteDuration(url: string): Promise<number | null> {
  if (!url.trim()) return null;
  return enqueueDownload(async () => {
    console.log(`[yt-dlp queue] getRemoteDuration: ${url}`);
    try {
      const result = (await ytDlpWithSSLFallback(url, {
        ...commonYtDlpOptions(),
        dumpSingleJson: true,
        skipDownload: true,
      })) as any;
      const dur = Number(result?.duration);
      return isFinite(dur) && dur > 0 ? dur : null;
    } catch (e: any) {
      console.warn(`[yt-dlp] getRemoteDuration failed: ${e?.message || e}`);
      return null;
    }
  });
}

export async function downloadVideo(
  url: string,
  formatId: string,
  isVideoOnly?: boolean,
): Promise<{ filePath: string; publicPath: string }> {
  if (!url.trim()) {
    throw new Error("URL is required");
  }
  if (!formatId.trim()) {
    throw new Error("formatId is required");
  }

  return enqueueDownload(async () => {
    console.log(`[yt-dlp queue] downloadVideo: ${url} (format: ${formatId})`);
    const downloadsRoot = path.join(process.cwd(), "downloads");
    if (!fs.existsSync(downloadsRoot)) {
      fs.mkdirSync(downloadsRoot, { recursive: true });
    }

    const safeName = Date.now().toString();
    const outputTemplate = path.join(downloadsRoot, `${safeName}.%(ext)s`);

    // For video-only formats, merge with best audio (download separately then merge)
    const formatSpec = isVideoOnly ? `${formatId}+bestaudio/best` : formatId;

    await ytDlpWithSSLFallback(url, {
      ...commonYtDlpOptions(),
      format: formatSpec,
      output: outputTemplate,
    });

    // Find the actual file by globbing for safeName.*
    const files = fs
      .readdirSync(downloadsRoot)
      .filter((f) => f.startsWith(safeName + "."));
    if (!files.length) {
      throw new Error("Download finished but file not found");
    }

    const fileName = files[0];
    const filePath = path.join(downloadsRoot, fileName);
    const publicPath = `/downloads/${fileName}`;

    return { filePath, publicPath };
  });
}

/** Download in lower quality (max 480p) for AI analysis — faster and smaller. */
export async function downloadForAnalysis(
  url: string,
  maxHeight: number = 480
): Promise<{ filePath: string; publicPath: string }> {
  if (!url.trim()) {
    throw new Error("URL is required");
  }

  return enqueueDownload(async () => {
    console.log(`[yt-dlp queue] downloadForAnalysis: ${url} (max ${maxHeight}p)`);
    const downloadsRoot = path.join(process.cwd(), "downloads");
    if (!fs.existsSync(downloadsRoot)) {
      fs.mkdirSync(downloadsRoot, { recursive: true });
    }

    const safeName = "short-" + Date.now().toString();
    const outputTemplate = path.join(downloadsRoot, `${safeName}.%(ext)s`);

    await ytDlpWithSSLFallback(url, {
      ...commonYtDlpOptions(),
      format: h264FormatForAnalysis(maxHeight),
      mergeOutputFormat: "mp4",
      output: outputTemplate,
    });

    const files = fs
      .readdirSync(downloadsRoot)
      .filter((f) => f.startsWith(safeName + "."));
    if (!files.length) {
      throw new Error("Download finished but file not found");
    }

    const fileName = files[0];
    const filePath = path.join(downloadsRoot, fileName);
    const publicPath = `/downloads/${fileName}`;

    return { filePath, publicPath };
  });
}

/** Download best quality (video+audio merged) from URL. Saves to downloads/. */
export async function downloadBest(
  url: string
): Promise<{ filePath: string; publicPath: string }> {
  if (!url.trim()) {
    throw new Error("URL is required");
  }

  return enqueueDownload(async () => {
    console.log(`[yt-dlp queue] downloadBest: ${url}`);
    const downloadsRoot = path.join(process.cwd(), "downloads");
    if (!fs.existsSync(downloadsRoot)) {
      fs.mkdirSync(downloadsRoot, { recursive: true });
    }

    const safeName = Date.now().toString();
    const outputTemplate = path.join(downloadsRoot, `${safeName}.%(ext)s`);

    await ytDlpWithSSLFallback(url, {
      ...commonYtDlpOptions(),
      format: H264_FORMAT_BEST_1080,
      mergeOutputFormat: "mp4",
      output: outputTemplate,
    });

    const files = fs
      .readdirSync(downloadsRoot)
      .filter((f) => f.startsWith(safeName + "."));
    if (!files.length) {
      throw new Error("Download finished but file not found");
    }

    const fileName = files[0];
    const filePath = path.join(downloadsRoot, fileName);
    const publicPath = `/downloads/${fileName}`;

    return { filePath, publicPath };
  });
}
