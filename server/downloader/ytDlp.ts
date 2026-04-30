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

function getProxyArgs(): string[] {
  const proxy = process.env.YT_DLP_PROXY;
  if (!proxy) return [];
  return ["--proxy", proxy];
}

function getCookiesPath(): string | undefined {
  const cookiesFile = process.env.YT_COOKIES_FILE;
  if (!cookiesFile) return undefined;
  // Verify file exists
  if (!fs.existsSync(cookiesFile)) {
    console.warn(`[yt-dlp] Cookies file not found: ${cookiesFile}`);
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
  options: Record<string, any>
): Promise<any> {
  const proxy = options.proxy;
  try {
    return await (ytDlp as any)(url, options);
  } catch (err) {
    // Handle SSL errors with proxy fallback
    if (proxy && isSSLError(err)) {
      console.warn(
        `[yt-dlp] SSL error with proxy, retrying without proxy for: ${url}`
      );
      const { proxy: _removed, ...optionsWithoutProxy } = options;
      return await (ytDlp as any)(url, optionsWithoutProxy);
    }
    // Handle bot detection — give clear guidance
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
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      jsRuntimes: "node",
      addHeader: ["user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"],
      proxy: process.env.YT_DLP_PROXY,
      ...(getCookiesPath() ? { cookies: getCookiesPath() } : {}),
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
      format: formatSpec,
      output: outputTemplate,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      jsRuntimes: "node",
      addHeader: ["user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"],
      proxy: process.env.YT_DLP_PROXY,
      ...(getCookiesPath() ? { cookies: getCookiesPath() } : {}),
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
      format: `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`,
      output: outputTemplate,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      jsRuntimes: "node",
      addHeader: ["user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"],
      proxy: process.env.YT_DLP_PROXY,
      ...(getCookiesPath() ? { cookies: getCookiesPath() } : {}),
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
      format: "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
      output: outputTemplate,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      jsRuntimes: "node",
      addHeader: ["user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"],
      proxy: process.env.YT_DLP_PROXY,
      ...(getCookiesPath() ? { cookies: getCookiesPath() } : {}),
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
