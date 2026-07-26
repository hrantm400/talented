import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  openRouterChat,
} from "./openrouter";
import { getVideoModel, getWhisperModel, getOpenRouterKey, getSegmentsModel } from "../keys";
import { toPublicMediaUrl } from "./public-url";

const execFileAsync = promisify(execFile);

function resolveWhisperScriptPath(): string {
  const candidates = [
    path.join(process.cwd(), "server", "pipeline", "whisper-transcribe.py"),
    path.join(process.cwd(), "dist", "whisper-transcribe.py"),
    path.join(process.cwd(), "dist", "server", "pipeline", "whisper-transcribe.py"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Whisper helper script was not found. Expected server/pipeline/whisper-transcribe.py in the project root.",
  );
}

function resolvePythonBinaryPath(): string {
  const candidates = [
    path.join(process.cwd(), "venv", "bin", "python3"),
    path.join(process.cwd(), "venv", "bin", "python"),
    path.join(process.cwd(), "venv", "Scripts", "python.exe"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "python";
}



function getCommandErrorMessage(
  error: unknown,
  command: "python" | "ffmpeg" | "ffprobe",
): string {
  if (!(error instanceof Error)) {
    return `${command} failed with an unknown error`;
  }

  const details = "stderr" in error && typeof error.stderr === "string"
    ? error.stderr.trim()
    : "";

  if ("code" in error && error.code === "ENOENT") {
    if (command === "python") {
      return "Python is not installed or is not available in PATH.";
    }

    return `${command} is not installed or is not available in PATH.`;
  }

  if (details.includes("No module named 'faster_whisper'")) {
    return "Python dependency 'faster-whisper' is missing. Install it with `python -m pip install -r requirements.txt`.";
  }

  if (details) {
    return `${command} failed: ${details}`;
  }

  return error.message || `${command} failed`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fixWordTimestamps(
  words: Array<{ word: string; start: number; end: number }>,
  audioDuration: number
): Array<{ word: string; start: number; end: number }> {
  if (words.length === 0) return words;

  const fixed = words.map((w) => ({
    word: w.word,
    start: Math.round(w.start * 100) / 100,
    end: Math.round(w.end * 100) / 100,
  }));

  for (let i = 0; i < fixed.length; i++) {
    if (fixed[i].end <= fixed[i].start) {
      fixed[i].end = fixed[i].start + 0.15;
    }
    fixed[i].start = Math.max(0, fixed[i].start);
    fixed[i].end = Math.min(audioDuration, fixed[i].end);
  }

  for (let i = 1; i < fixed.length; i++) {
    if (fixed[i].start < fixed[i - 1].end) {
      fixed[i].start = fixed[i - 1].end + 0.01;
    }
    if (fixed[i].end <= fixed[i].start) {
      fixed[i].end = fixed[i].start + 0.15;
    }
  }

  for (let i = 0; i < fixed.length - 1; i++) {
    const gap = fixed[i + 1].start - fixed[i].end;
    if (gap > 0 && gap < 0.3) {
      fixed[i].end = fixed[i + 1].start;
    }
  }

  for (const w of fixed) {
    w.start = Math.max(0, Math.min(w.start, audioDuration - 0.1));
    w.end = Math.min(w.end, audioDuration);
    if (w.end <= w.start) {
      w.end = Math.min(w.start + 0.15, audioDuration);
    }
  }

  return fixed;
}

type TranscriptionResult = {
  duration: number;
  words: Array<{ word: string; start: number; end: number }>;
  text: string;
  language: string;
};

const WHISPER_CACHE_DIR = path.join(process.cwd(), "outputs", "whisper_cache");

function sha256OfFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readWhisperCache(key: string): TranscriptionResult | null {
  const file = path.join(WHISPER_CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as TranscriptionResult;
  } catch {
    return null;
  }
}

function writeWhisperCache(key: string, result: TranscriptionResult): void {
  try {
    if (!fs.existsSync(WHISPER_CACHE_DIR)) {
      fs.mkdirSync(WHISPER_CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(
      path.join(WHISPER_CACHE_DIR, `${key}.json`),
      JSON.stringify(result)
    );
  } catch (err) {
    console.warn("[transcribeAudio] Failed to write cache:", err);
  }
}

async function getAudioDurationSec(audioPath: string): Promise<number> {
  const durationArgs = [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath,
  ];
  try {
    const { stdout } = await execFileAsync("ffprobe", durationArgs);
    return parseFloat(stdout.trim()) || 0;
  } catch (error) {
    throw new Error(getCommandErrorMessage(error, "ffprobe"));
  }
}

async function runLocalWhisper(audioPath: string): Promise<TranscriptionResult> {
  const scriptPath = resolveWhisperScriptPath();
  const pythonBinary = resolvePythonBinaryPath();
  const modelSize = process.env.WHISPER_MODEL || "base";
  console.log(`[transcribeAudio] Local faster-whisper (${modelSize}) on: ${audioPath} using ${pythonBinary}`);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(pythonBinary, [scriptPath, audioPath, modelSize], {
      timeout: 300000,
    }));
  } catch (error) {
    throw new Error(getCommandErrorMessage(error, "python"));
  }

  const jsonStr = extractJsonObject(stdout);
  if (!jsonStr) throw new Error("Whisper returned no JSON output");
  const parsed = JSON.parse(jsonStr) as {
    text?: string;
    words?: Array<{ word: string; start: number; end: number }>;
    duration?: number;
    language?: string;
  };

  const duration = (await getAudioDurationSec(audioPath)) || parsed.duration || 0;
  const fixedWords = fixWordTimestamps(parsed.words || [], duration);

  return {
    duration,
    words: fixedWords,
    text: parsed.text ?? "",
    language: parsed.language || "en",
  };
}

async function runOpenRouterWhisper(
  audioPath: string,
  model: string,
  userId?: number | null
): Promise<TranscriptionResult> {
  const apiKey = await getOpenRouterKey(userId);
  console.log(`[transcribeAudio] OpenRouter Whisper (${model}) on: ${audioPath}`);

  const fileBuffer = fs.readFileSync(audioPath);
  const ext = path.extname(audioPath).toLowerCase().slice(1) || "wav";
  const mimeByExt: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    webm: "audio/webm",
    ogg: "audio/ogg",
    flac: "audio/flac",
  };
  const mime = mimeByExt[ext] || "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(fileBuffer)], { type: mime }), path.basename(audioPath));
  form.append("model", model);
  form.append("response_format", "verbose_json");
  // Word-level timestamps are required for our subtitle pipeline.
  form.append("timestamp_granularities[]", "word");

  const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": process.env.APP_PUBLIC_URL || process.env.BASE_URL || "https://localhost:5000",
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter Whisper ${res.status}: ${errText.slice(0, 500)}`);
  }

  const json: any = await res.json();
  // OpenAI verbose_json shape: { text, language, duration, words: [{word, start, end}] }
  const text: string = json.text || "";
  const language: string = json.language || "en";
  const rawDuration: number = typeof json.duration === "number" ? json.duration : 0;
  const rawWords: Array<{ word: string; start: number; end: number }> =
    Array.isArray(json.words)
      ? json.words.map((w: any) => ({
          word: String(w.word || ""),
          start: Number(w.start) || 0,
          end: Number(w.end) || 0,
        }))
      : [];

  const duration = rawDuration || (await getAudioDurationSec(audioPath));
  const fixedWords = fixWordTimestamps(rawWords, duration);

  if (fixedWords.length === 0) {
    throw new Error("OpenRouter Whisper returned no word timestamps");
  }

  return { duration, words: fixedWords, text, language };
}

export async function transcribeAudio(
  audioPath: string,
  userId?: number | null
): Promise<TranscriptionResult> {
  const t0 = Date.now();

  // Cache lookup — content-addressed (sha256). Same audio file always
  // produces the same transcription, regardless of provider/model.
  const cacheKey = sha256OfFile(audioPath);
  const cached = readWhisperCache(cacheKey);
  if (cached && cached.words?.length) {
    console.log(
      `[transcribeAudio] Cache hit: ${cached.words.length} words, ${cached.duration.toFixed(1)}s (saved Whisper call)`
    );
    return cached;
  }

  const model = await getWhisperModel(userId);
  const useLocal = model === "local";

  let result: TranscriptionResult;
  try {
    result = useLocal
      ? await runLocalWhisper(audioPath)
      : await runOpenRouterWhisper(audioPath, model, userId);
  } catch (err) {
    if (!useLocal) {
      console.warn(
        `[transcribeAudio] OpenRouter Whisper failed, falling back to local: ${err instanceof Error ? err.message : err}`
      );
      result = await runLocalWhisper(audioPath);
    } else {
      throw err;
    }
  }

  writeWhisperCache(cacheKey, result);

  console.log(
    `[transcribeAudio] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${result.words.length} words, ${result.duration.toFixed(1)}s`
  );
  return result;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    const candidate = codeBlock[1].trim();
    const firstBrace = candidate.indexOf("{");
    if (firstBrace !== -1) {
      const extracted = extractBalancedBraces(candidate, firstBrace);
      if (extracted) return extracted;
    }
  }
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace !== -1) {
    return extractBalancedBraces(trimmed, firstBrace);
  }
  return null;
}

function extractBalancedBraces(str: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let quoteChar = "";
  for (let i = startIndex; i < str.length; i++) {
    const c = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === quoteChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quoteChar = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return str.slice(startIndex, i + 1);
    }
  }
  return null;
}

function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseTimestamp(s: string): number {
  const parts = s.trim().split(":").map(Number);
  if (parts.length >= 3) return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
  if (parts.length === 2) return parts[0] * 60 + (parts[1] || 0);
  return parts[0] || 0;
}

// ── Video analysis preparation ──

const ANALYSIS_VIDEO_MAX_BYTES = 8 * 1024 * 1024; // 8MB → ~11MB as base64, safe for HTTP
const ANALYSIS_MAX_DURATION_SEC = 480; // 8 minutes max for analysis

/**
 * Creates a smaller MP4 copy of the source video suitable for sending to Gemini via video_url.
 * - Re-encodes to 480p at low bitrate
 * - Trims very long videos to ANALYSIS_MAX_DURATION_SEC
 * - Returns path to temp file (caller must delete)
 */
export async function prepareAnalysisVideo(
  sourceVideoPath: string,
  videoDuration: number,
  maxDuration: number = ANALYSIS_MAX_DURATION_SEC
): Promise<string> {
  const tmpDir = path.join(path.dirname(sourceVideoPath), "analysis_tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `analysis_${Date.now()}.mp4`);

  const effectiveDuration = Math.min(videoDuration, maxDuration);
  // Target: 8MB = 8 * 8 * 1024 kbits. Leave 15% headroom.
  const maxKbits = (ANALYSIS_VIDEO_MAX_BYTES * 8) / 1024 * 0.85;
  const targetBitrateKbps = Math.min(600, Math.floor(maxKbits / effectiveDuration));
  const videoBitrate = `${Math.max(150, targetBitrateKbps)}k`;

  const args = [
    "-y",
    "-i", sourceVideoPath,
    ...(videoDuration > ANALYSIS_MAX_DURATION_SEC ? ["-t", String(ANALYSIS_MAX_DURATION_SEC)] : []),
    "-vf", "scale=-2:240",
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", videoBitrate,
    "-threads", "0",
    "-an",
    "-movflags", "+faststart",
    tmpPath,
  ];

  console.log(`[prepareAnalysisVideo] Encoding analysis copy: ${videoBitrate} bitrate, ${effectiveDuration.toFixed(0)}s`);

  // 15-minute timeout: long AV1 source decoding is slow even with ultrafast x264 encode.
  try {
    await execFileAsync("ffmpeg", args, { timeout: 900000, maxBuffer: 1024 * 1024 * 16 });
  } catch (error) {
    throw new Error(getCommandErrorMessage(error, "ffmpeg"));
  }

  const stat = fs.statSync(tmpPath);
  console.log(`[prepareAnalysisVideo] Analysis video: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

  // If still too large, re-encode with even lower bitrate
  if (stat.size > ANALYSIS_VIDEO_MAX_BYTES) {
    const retrBitrate = `${Math.max(100, Math.floor(targetBitrateKbps * 0.5))}k`;
    const retryPath = tmpPath.replace(".mp4", "_retry.mp4");
    console.log(`[prepareAnalysisVideo] Still too large (${(stat.size / 1024 / 1024).toFixed(1)}MB), retrying at ${retrBitrate}`);
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-i", tmpPath,
        "-vf", "scale=-2:192",
        "-c:v", "libx264", "-preset", "ultrafast", "-b:v", retrBitrate,
        "-threads", "0",
        "-an",
        "-movflags", "+faststart",
        retryPath,
      ], { timeout: 600000, maxBuffer: 1024 * 1024 * 16 });
      fs.unlinkSync(tmpPath);
      fs.renameSync(retryPath, tmpPath);
    } catch {
      // Use original attempt even if slightly over
    }
  }

  return tmpPath;
}

function formatVoiceoverTimeline(
  words: Array<{ word: string; start: number; end: number }>
): string {
  if (!words || words.length === 0) return "(no voiceover provided)";

  // Group words into natural phrases (~3-4 seconds each)
  const phrases: Array<{ startSec: number; endSec: number; text: string }> = [];
  const CHUNK_SEC = 3.5;
  let chunkStart = words[0].start;
  let chunkWords: string[] = [];

  const flush = (endSec: number) => {
    if (chunkWords.length === 0) return;
    phrases.push({ startSec: chunkStart, endSec, text: chunkWords.join(" ") });
    chunkStart = endSec;
    chunkWords = [];
  };

  for (const w of words) {
    chunkWords.push(w.word);
    if (w.end - chunkStart >= CHUNK_SEC) flush(w.end);
  }
  flush(words[words.length - 1].end);

  return phrases.map((p) =>
    `[${p.startSec.toFixed(1)}s – ${p.endSec.toFixed(1)}s] "${p.text}"`
  ).join("\n");
}

// ── Main curation function ──

export async function curateVideoSegments(
  sourceVideoPath: string,
  voiceoverWords: Array<{ word: string; start: number; end: number }>,
  targetDuration: number,
  userId?: number | null
): Promise<Array<{ start: string; end: string }>> {
  const probeArgs = ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sourceVideoPath];
  let durationStr: string;
  try {
    ({ stdout: durationStr } = await execFileAsync("ffprobe", probeArgs));
  } catch (error) {
    throw new Error(getCommandErrorMessage(error, "ffprobe"));
  }
  const videoDuration = parseFloat(durationStr.trim());

  console.log(`[curateVideoSegments] Video: ${videoDuration.toFixed(1)}s, voiceover: ${targetDuration.toFixed(1)}s`);

  // Two-stage video delivery to OpenRouter:
  //   1. PREFERRED — public HTTPS URL (no compression, no base64 overhead).
  //   2. FALLBACK  — base64-encoded compressed copy, used when (a) we can't
  //      build a public URL (file outside served dirs), or (b) the URL
  //      approach keeps returning "Provider returned error" from Gemini.
  const publicUrl = await toPublicMediaUrl(sourceVideoPath);
  let analysisVideoPath: string | null = null;
  let videoUrlForRequest: string;
  let usingUrlPath = !!publicUrl;

  if (publicUrl) {
    videoUrlForRequest = publicUrl;
    console.log(`[curateVideoSegments] Sending source video to OpenRouter by URL: ${publicUrl}`);
  } else {
    analysisVideoPath = await prepareAnalysisVideo(sourceVideoPath, videoDuration);
    const videoBuffer = fs.readFileSync(analysisVideoPath);
    videoUrlForRequest = `data:video/mp4;base64,${videoBuffer.toString("base64")}`;
  }

  // Lazily compress + base64 the source video the first time the URL path
  // fails with a URL-specific error from the provider.
  const URL_FALLBACK_ERR = /Provider returned error|fetch failed|invalid.*url|unable to access|failed to fetch|400|ROBOTED|robots|Cannot fetch content/i;
  const switchToBase64Fallback = async (): Promise<void> => {
    if (!usingUrlPath) return; // already on base64
    console.warn(`[curateVideoSegments] URL approach kept failing — falling back to base64 (compressing source).`);
    analysisVideoPath = await prepareAnalysisVideo(sourceVideoPath, videoDuration);
    const videoBuffer = fs.readFileSync(analysisVideoPath);
    videoUrlForRequest = `data:video/mp4;base64,${videoBuffer.toString("base64")}`;
    usingUrlPath = false;
  };

  const voiceoverTimeline = formatVoiceoverTimeline(voiceoverWords);

  const prompt = `You are a MASTER TIER TIKTOK/REELS EDITOR. I will give you a SOURCE VIDEO and a VOICEOVER TRANSCRIPT. Your job: select the most VISUALLY STUNNING, HIGH-ENERGY segments from the source video to accompany the voiceover.

=== VOICEOVER TRANSCRIPT (with timestamps) ===
${voiceoverTimeline}

Total voiceover length: ~${targetDuration.toFixed(0)} seconds.
Source video length: ${formatTimestamp(videoDuration)} (${videoDuration.toFixed(0)} seconds).

=== YOUR TASK ===
Watch the entire source video carefully. Then select multiple segments (each 2–5 seconds) from ANYWHERE in the source video.
IMPORTANT: The TOTAL SUM duration of all your selected segments MUST BE EXACTLY between ${Math.ceil(targetDuration + 2)} and ${Math.ceil(targetDuration + 5)} seconds! Calculate it carefully! We need extra footage to prevent the video from freezing.

=== MATCHING RULES (70-80% SYNC) ===
For 70-80% of your segments, the visuals MUST match what the voiceover is describing at that moment:
- If voiceover says someone's name → show THAT person
- If voiceover says an action ("pressed the button", "started singing") → show THAT exact action happening
- If voiceover describes a reaction ("shocked", "crowd went crazy") → show THAT reaction
- You UNDERSTAND the video content — use that understanding to find the PERFECT matching moment

The remaining 20-30% can be the most visually epic "filler" moments — crowd shots, dramatic angles, emotional peaks — even if not directly described by the voiceover.

=== QUALITY RULES ===
ONLY select moments with:
✅ Peak emotion — faces showing shock, joy, tears, amazement
✅ High action — performance climaxes, golden buzzer moments, crowd eruptions, dramatic reveals
✅ Visual impact — confetti, standing ovations, close-ups of reactions, dramatic camera angles

NEVER select:
❌ Blurry, dark, or out-of-focus shots
❌ Static wide shots where nothing happens
❌ Backs of heads, empty stages
❌ Intro/outro graphics, logos, title cards
❌ People just standing around doing nothing

=== SEGMENT ORDER ===
Order segments to match the VOICEOVER FLOW, not the source video timeline.
- Segment 1 should match what the voiceover says at 0-3 seconds
- Segment 2 should match voiceover at 3-6 seconds
- etc.
You CAN and SHOULD jump around the source video to find the best matching moment for each voiceover phrase.

=== OUTPUT FORMAT ===
Return ONLY a JSON array. Each segment has "start" and "end" in HH:MM:SS format.
Maximum timestamp: ${formatTimestamp(videoDuration)}.

[{"start":"00:01:23","end":"00:01:27"},{"start":"00:03:45","end":"00:03:49"}]`;

  const buildContent = (): Array<
    | { type: "text"; text: string }
    | { type: "video_url"; video_url: { url: string } }
  > => [
    { type: "video_url", video_url: { url: videoUrlForRequest } },
    { type: "text", text: prompt },
  ];

  // Send to Gemini and parse — retry the entire cycle (API + parse) up to 3 times
  const maxAttempts = 3;
  let curationResult: Array<{ start: string; end: string }> | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let responseText: string = "";
    try {
      const model = await getVideoModel(userId);
      responseText = await openRouterChat(
        model,
        [{ role: "user", content: buildContent() }],
        { max_tokens: 8192, timeout_ms: 300_000, userId }
      );

      console.log(`[curateVideoSegments] Gemini response length: ${responseText.length} chars (attempt ${attempt + 1})`);

      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error("Gemini did not return valid JSON segments");
      }

      const raw = jsonMatch[0].replace(/,\s*([}\]])/g, "$1");
      let segments: Array<{ start: string; end: string }> = JSON.parse(raw);
      if (!Array.isArray(segments) || segments.length === 0) {
        throw new Error("Gemini returned empty segments array");
      }

      // Normalize and enforce max 5s per segment
      const normalized: Array<{ start: string; end: string }> = [];
      for (const seg of segments) {
        const s = parseTimestamp(seg.start);
        const e = Math.min(parseTimestamp(seg.end), videoDuration);
        if (e - s < 1) continue;
        if (e - s <= 5) {
          normalized.push({ start: formatTimestamp(s), end: formatTimestamp(e) });
        } else {
          // Split segments longer than 5s into 4s chunks
          let t = s;
          while (t < e) {
            const ce = Math.min(t + 4, e);
            if (ce - t >= 2) normalized.push({ start: formatTimestamp(t), end: formatTimestamp(ce) });
            t = ce;
          }
        }
      }

      if (normalized.length === 0) {
        throw new Error("All Gemini segments were too short after normalization");
      }

      // --- CAP TOTAL DURATION (Anti-Overflow) ---
      // The model sometimes returns a few GIANT ranges (e.g. 00:00:58→00:05:28)
      // which the 4s-chunk split above turns into 100+ segments — an 8-minute
      // concat that ffmpeg gets KILLED on. Keep only enough to cover the target
      // plus a small buffer; trim the segment that crosses the limit.
      const MAX_TOTAL = targetDuration + 6;
      {
        const capped: Array<{ start: string; end: string }> = [];
        let acc = 0;
        for (const seg of normalized) {
          if (acc >= MAX_TOTAL) break;
          const s = parseTimestamp(seg.start);
          let e = parseTimestamp(seg.end);
          if (acc + (e - s) > MAX_TOTAL) {
            e = s + (MAX_TOTAL - acc);
            if (e - s >= 1) capped.push({ start: formatTimestamp(s), end: formatTimestamp(e) });
            break;
          }
          capped.push(seg);
          acc += e - s;
        }
        if (capped.length > 0 && capped.length < normalized.length) {
          console.warn(`[curateVideoSegments] capped ${normalized.length} → ${capped.length} segments (~${acc.toFixed(0)}s) to avoid an oversized concat`);
        }
        normalized.length = 0;
        normalized.push(...capped);
      }

      // --- AUTO-FILL FAILSAFE (Anti-Freeze) ---
      // Mathematically guarantees we have at least targetDuration seconds of video
      const finalSegments: Array<{ start: string; end: string }> = [];
      let totalSec = 0;

      for (const seg of normalized) {
        const s = parseTimestamp(seg.start);
        const e = parseTimestamp(seg.end);
        finalSegments.push(seg);
        totalSec += (e - s);
      }

      // If AI failed to provide enough duration, auto-loop from the start
      let currentFillStart = 0;
      while (totalSec < targetDuration) {
        const fillDur = Math.min(4, targetDuration - totalSec + 1); // small buffer
        const fillEnd = Math.min(currentFillStart + fillDur, videoDuration);

        if (fillEnd - currentFillStart < 0.5) {
          currentFillStart = 0; // restart if we hit the end of the source video
          continue;
        }

        finalSegments.push({
          start: formatTimestamp(currentFillStart),
          end: formatTimestamp(fillEnd)
        });
        totalSec += (fillEnd - currentFillStart);
        currentFillStart = fillEnd;
      }

      console.log(`[curateVideoSegments] Final: ${finalSegments.length} segments, total ${totalSec.toFixed(1)}s (Target: ${targetDuration.toFixed(1)}s)`);
      curationResult = finalSegments;
      break;
    } catch (err) {
      const isLast = attempt === maxAttempts - 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[curateVideoSegments] Attempt ${attempt + 1}/${maxAttempts} failed: ${errMsg}`
      );
      if (responseText) {
        console.warn(`[curateVideoSegments] Raw response preview: ${responseText.slice(0, 300)}`);
      }

      // If the URL approach is failing with a provider-side error, switch to
      // the base64 fallback for the remaining attempts. Skip the retry-delay
      // since compression itself adds 10-30s of wall time.
      if (usingUrlPath && URL_FALLBACK_ERR.test(errMsg)) {
        try {
          await switchToBase64Fallback();
          continue;
        } catch (fallbackErr) {
          console.warn(`[curateVideoSegments] base64 fallback compression failed:`, fallbackErr);
        }
      }

      if (isLast) {
        if (analysisVideoPath) {
          try { fs.unlinkSync(analysisVideoPath); } catch {}
          try { fs.rmdirSync(path.dirname(analysisVideoPath)); } catch {}
        }
        console.warn(`[curateVideoSegments] AI curation unavailable (${errMsg}), generating fallback uniform 4s segments...`);
        const fallbackSegments: Array<{ start: string; end: string }> = [];
        let t = 0;
        let srcPos = 0;
        while (t < targetDuration) {
          const dur = Math.min(4, targetDuration - t);
          const segStart = srcPos % Math.max(1, videoDuration - dur);
          fallbackSegments.push({
            start: formatTimestamp(segStart),
            end: formatTimestamp(segStart + dur),
          });
          t += dur;
          srcPos += 12; // jump 12s in source video for high visual variety
        }
        return fallbackSegments;
      }
      const delayMs = 5000 * (attempt + 1);
      console.warn(`[curateVideoSegments] Retrying in ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }

  if (analysisVideoPath) {
    try { fs.unlinkSync(analysisVideoPath); } catch {}
    try { fs.rmdirSync(path.dirname(analysisVideoPath)); } catch {}
  }
  if (!curationResult) throw new Error("Failed to parse Gemini segments: unreachable");
  return curationResult;
}

// ── Factory: N DISTINCT narratives in ONE call ──

/**
 * Pick `count` DIFFERENT shorts from one video in a single Gemini call. Each
 * short is a [setup, epic] pair; the pairs must NOT overlap each other and must
 * never use the last 15% (no ending/spoiler). Used by the factory so multiple
 * no-voiceover variants show genuinely different moments. Best-effort: if the
 * model returns fewer sets, the missing ones fall back to a single narrative.
 */
export async function curateMultipleNarratives(
  sourceVideoPath: string,
  targetDuration: number,
  count: number,
  userId?: number | null
): Promise<Array<Array<{ start: string; end: string }>>> {
  const n = Math.max(1, Math.min(8, count));
  if (n === 1) {
    return [await curateNarrativeSegments(sourceVideoPath, targetDuration, userId)];
  }

  let videoDuration = 0;
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sourceVideoPath,
    ]);
    videoDuration = parseFloat(stdout.trim()) || 0;
  } catch (error) {
    throw new Error(getCommandErrorMessage(error, "ffprobe"));
  }
  const cutoffSec = videoDuration > 0 ? videoDuration * 0.85 : 0;
  const maxStamp = cutoffSec > 0 ? formatTimestamp(cutoffSec) : formatTimestamp(videoDuration);

  const publicUrl = await toPublicMediaUrl(sourceVideoPath);
  let analysisVideoPath: string | null = null;
  let videoUrl: string;
  if (publicUrl) {
    videoUrl = publicUrl;
  } else {
    analysisVideoPath = await prepareAnalysisVideo(sourceVideoPath, videoDuration);
    const buf = fs.readFileSync(analysisVideoPath);
    videoUrl = `data:video/mp4;base64,${buf.toString("base64")}`;
  }
  const cleanup = () => {
    if (analysisVideoPath) {
      try { fs.unlinkSync(analysisVideoPath); } catch {}
      try { fs.rmdirSync(path.dirname(analysisVideoPath)); } catch {}
    }
  };

  const prompt = `You are a MASTER editor of viral talent-show shorts (America's Got Talent style). Watch the FULL video.

Produce ${n} DIFFERENT ${Math.round(targetDuration)}-second shorts. Each short = EXACTLY TWO clips:
1) a SETUP clip (~25-40% of total): short build-up / dialogue that creates curiosity.
2) an EPIC clip (the rest): the most jaw-dropping, high-energy, emotional payoff.

ABSOLUTE RULES:
- The ${n} shorts must use DIFFERENT moments — do NOT reuse the same setup or epic across shorts. Spread them across the video.
- NEVER use footage from the last 15% (no ending, no result reveal). Maximum timestamp: ${maxStamp}.
- Each short's two clips should sum to between ${Math.ceil(targetDuration)} and ${Math.ceil(targetDuration + 4)} seconds.
- Pick clean, in-focus, high-impact footage. No title cards/logos.

OUTPUT — return ONLY a JSON array of ${n} shorts. Each short is an array of exactly two objects (first=setup, second=epic), timestamps HH:MM:SS:
[[{"start":"00:01:10","end":"00:01:18"},{"start":"00:03:40","end":"00:04:00"}], [{"start":"00:00:30","end":"00:00:40"},{"start":"00:05:10","end":"00:05:28"}]]`;

  const content: Array<
    | { type: "text"; text: string }
    | { type: "video_url"; video_url: { url: string } }
  > = [
    { type: "video_url", video_url: { url: videoUrl } },
    { type: "text", text: prompt },
  ];

  const clampSet = (segs: Array<{ start: string; end: string }>): Array<{ start: string; end: string }> => {
    const norm: Array<{ start: string; end: string }> = [];
    for (const s of (segs || []).slice(0, 2)) {
      let a = parseTimestamp(s.start);
      let b = parseTimestamp(s.end);
      if (cutoffSec > 0) { a = Math.min(a, cutoffSec - 1); b = Math.min(b, cutoffSec); }
      if (b - a >= 1) norm.push({ start: formatTimestamp(Math.max(0, a)), end: formatTimestamp(b) });
    }
    return norm;
  };

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let responseText = "";
    try {
      const model = await getSegmentsModel(userId);
      responseText = await openRouterChat(
        model,
        [{ role: "user", content }],
        { max_tokens: 8192, timeout_ms: 300_000, userId }
      );
      const m = responseText.match(/\[[\s\S]*\]/);
      if (!m) throw new Error("no JSON array");
      const raw = m[0].replace(/,\s*([}\]])/g, "$1");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("not an array");
      // Accept BOTH shapes the model might return:
      //   nested  [[{setup},{epic}], [{setup},{epic}]]
      //   flat    [{setup},{epic},{setup},{epic}]  → chunk into pairs
      let setsRaw: any[][];
      if (Array.isArray(parsed[0])) {
        setsRaw = parsed;
      } else {
        setsRaw = [];
        for (let i = 0; i < parsed.length; i += 2) setsRaw.push(parsed.slice(i, i + 2));
      }
      const sets = setsRaw
        .map((s: any) => clampSet(s))
        .filter((s: Array<{ start: string; end: string }>) => s.length > 0);
      if (sets.length === 0) throw new Error("no valid sets after clamping");
      cleanup();
      // Pad to `n` by re-using single-narrative results if the model returned fewer.
      while (sets.length < n) {
        sets.push(await curateNarrativeSegments(sourceVideoPath, targetDuration, userId));
      }
      console.log(`[curateMultipleNarratives] produced ${sets.length}/${n} distinct sets`);
      return sets.slice(0, n);
    } catch (err) {
      const isLast = attempt === maxAttempts - 1;
      console.warn(`[curateMultipleNarratives] attempt ${attempt + 1}/${maxAttempts} failed: ${err instanceof Error ? err.message : err}`);
      if (isLast) {
        cleanup();
        // Fall back to N independent single-narrative calls.
        const out: Array<Array<{ start: string; end: string }>> = [];
        for (let i = 0; i < n; i++) out.push(await curateNarrativeSegments(sourceVideoPath, targetDuration, userId));
        return out;
      }
      await sleep(4000 * (attempt + 1));
    }
  }
  cleanup();
  throw new Error("curateMultipleNarratives: unreachable");
}

// ── Narrative curation (No-Voiceover variant): setup + epic, no ending ──

/**
 * Build a short from EXACTLY TWO clips taken from the full video:
 *   1. a SETUP clip (dialogue/build-up that creates curiosity)
 *   2. an EPIC clip (the jaw-dropping / high-energy payoff)
 * The ending of the source is never used (no spoiler / no result reveal).
 * Returns ordered timecodes [setup, epic] with original audio intact downstream.
 */
export async function curateNarrativeSegments(
  sourceVideoPath: string,
  targetDuration: number,
  userId?: number | null
): Promise<Array<{ start: string; end: string }>> {
  // Probe duration to compute the "no ending" cutoff (last 15% is off-limits).
  let videoDuration = 0;
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sourceVideoPath,
    ]);
    videoDuration = parseFloat(stdout.trim()) || 0;
  } catch (error) {
    throw new Error(getCommandErrorMessage(error, "ffprobe"));
  }
  const cutoffSec = videoDuration > 0 ? videoDuration * 0.85 : 0; // avoid last 15%

  // Video delivery: public URL preferred, base64 fallback.
  const publicUrl = await toPublicMediaUrl(sourceVideoPath);
  let analysisVideoPath: string | null = null;
  let videoUrl: string;
  if (publicUrl) {
    videoUrl = publicUrl;
  } else {
    analysisVideoPath = await prepareAnalysisVideo(sourceVideoPath, videoDuration);
    const buf = fs.readFileSync(analysisVideoPath);
    videoUrl = `data:video/mp4;base64,${buf.toString("base64")}`;
  }

  const maxStamp = cutoffSec > 0 ? formatTimestamp(cutoffSec) : formatTimestamp(videoDuration);
  const setupLo = Math.max(4, Math.round(targetDuration * 0.25));
  const setupHi = Math.max(setupLo + 2, Math.round(targetDuration * 0.4));

  const prompt = `You are a MASTER editor of viral talent-show shorts (America's Got Talent style). Watch the FULL video.

Build a ${Math.round(targetDuration)}-second short from EXACTLY TWO clips:

1) SETUP clip (~${setupLo}-${setupHi}s): a short bit of talking / build-up that creates curiosity — a judge asking a question, the contestant introducing themselves, an emotional or tense conversation, or the calm before the performance. It must make the viewer want to keep watching.

2) EPIC clip (the rest, ~${Math.round(targetDuration) - setupLo}s): the single most JAW-DROPPING, HIGH-ENERGY, emotional moment — the performance climax, the golden-buzzer slam, the crowd erupting, tears, a stunning reveal of talent.

ABSOLUTE RULES:
- NEVER use footage from the last 15% of the video. Maximum allowed timestamp: ${maxStamp}.
- Do NOT reveal the ending: no final result, no winner announcement, no "yes/no" verdict, no closing/credits. Leave them wanting the full video.
- The two clips should feel like a mini-story: intrigue → payoff.
- Pick visually clean, in-focus, high-impact footage. No blurry shots, no title cards, no logos.

The SUM of both clips must be between ${Math.ceil(targetDuration)} and ${Math.ceil(targetDuration + 4)} seconds.

OUTPUT — return ONLY a JSON array of exactly two objects, first = SETUP, second = EPIC, timestamps in HH:MM:SS:
[{"start":"00:01:10","end":"00:01:18"},{"start":"00:03:40","end":"00:04:00"}]`;

  const content: Array<
    | { type: "text"; text: string }
    | { type: "video_url"; video_url: { url: string } }
  > = [
    { type: "video_url", video_url: { url: videoUrl } },
    { type: "text", text: prompt },
  ];

  const cleanup = () => {
    if (analysisVideoPath) {
      try { fs.unlinkSync(analysisVideoPath); } catch {}
      try { fs.rmdirSync(path.dirname(analysisVideoPath)); } catch {}
    }
  };

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let responseText = "";
    try {
      // Segments is the quality-critical task → its own (optionally stronger)
      // model. Falls back to the video model when unset.
      const model = await getSegmentsModel(userId);
      responseText = await openRouterChat(
        model,
        [{ role: "user", content }],
        { max_tokens: 8192, timeout_ms: 300_000, userId }
      );
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("Gemini did not return JSON segments");
      const raw = jsonMatch[0].replace(/,\s*([}\]])/g, "$1");
      let segs: Array<{ start: string; end: string }> = JSON.parse(raw);
      if (!Array.isArray(segs) || segs.length === 0) throw new Error("Empty segments");

      // Normalize: clamp to the cutoff, drop invalid, keep at most 2.
      const norm: Array<{ start: string; end: string }> = [];
      for (const s of segs.slice(0, 2)) {
        let a = parseTimestamp(s.start);
        let b = parseTimestamp(s.end);
        if (cutoffSec > 0) {
          a = Math.min(a, cutoffSec - 1);
          b = Math.min(b, cutoffSec);
        }
        if (b - a >= 1) norm.push({ start: formatTimestamp(Math.max(0, a)), end: formatTimestamp(b) });
      }
      if (norm.length === 0) throw new Error("All narrative segments invalid after clamping");

      cleanup();
      const total = norm.reduce((s, x) => s + (parseTimestamp(x.end) - parseTimestamp(x.start)), 0);
      console.log(`[curateNarrativeSegments] ${norm.length} clip(s), total ${total.toFixed(1)}s (target ${targetDuration}s, cutoff ${maxStamp})`);
      return norm;
    } catch (err) {
      const isLast = attempt === maxAttempts - 1;
      console.warn(`[curateNarrativeSegments] attempt ${attempt + 1}/${maxAttempts} failed: ${err instanceof Error ? err.message : err}`);
      if (responseText) console.warn(`[curateNarrativeSegments] raw: ${responseText.slice(0, 200)}`);
      if (isLast) { cleanup(); throw err; }
      await sleep(4000 * (attempt + 1));
    }
  }
  cleanup();
  throw new Error("curateNarrativeSegments: unreachable");
}

// ── Auto music: classify the video's mood for background-music selection ──

export const MOOD_TAGS = [
  "epic",
  "emotional",
  "uplifting",
  "dramatic",
  "energetic",
  "happy",
  "chill",
  "dark",
] as const;

/**
 * Ask the vision model to classify the video's overall vibe into one of the
 * MOOD_TAGS, used to pick a fitting background track. Best-effort: returns
 * "epic" if the model misbehaves or the call fails.
 */
export async function detectVideoMood(
  sourceVideoPath: string,
  userId?: number | null
): Promise<string> {
  const publicUrl = await toPublicMediaUrl(sourceVideoPath);
  let analysisVideoPath: string | null = null;
  let videoUrl: string;

  if (publicUrl) {
    videoUrl = publicUrl;
  } else {
    let dur = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sourceVideoPath,
      ]);
      dur = parseFloat(stdout.trim()) || 0;
    } catch {}
    analysisVideoPath = await prepareAnalysisVideo(sourceVideoPath, dur, 120);
    const buf = fs.readFileSync(analysisVideoPath);
    videoUrl = `data:video/mp4;base64,${buf.toString("base64")}`;
  }

  const prompt = `Classify the overall MOOD / VIBE of this video so we can choose fitting background music.
Pick EXACTLY ONE word from this list (lowercase, nothing else):
epic, emotional, uplifting, dramatic, energetic, happy, chill, dark

Return ONLY that single word.`;

  const content: Array<
    | { type: "text"; text: string }
    | { type: "video_url"; video_url: { url: string } }
  > = [
    { type: "video_url", video_url: { url: videoUrl } },
    { type: "text", text: prompt },
  ];

  let mood = "epic";
  try {
    const model = await getVideoModel(userId);
    const resp = await openRouterChat(
      model,
      [{ role: "user", content }],
      { max_tokens: 2048, timeout_ms: 120_000, userId }
    );
    const word = resp.trim().toLowerCase().replace(/[^a-z]/g, "");
    if ((MOOD_TAGS as readonly string[]).includes(word)) {
      mood = word;
    } else {
      console.warn(`[detectVideoMood] model returned "${resp.trim()}" — not in list, defaulting to "epic"`);
    }
  } catch (err: any) {
    console.warn(`[detectVideoMood] failed, defaulting to "epic": ${err?.message || err}`);
  } finally {
    if (analysisVideoPath) {
      try { fs.unlinkSync(analysisVideoPath); } catch {}
      try { fs.rmdirSync(path.dirname(analysisVideoPath)); } catch {}
    }
  }

  console.log(`[detectVideoMood] detected mood: ${mood}`);
  return mood;
}

// ── Combined mood + headline in ONE video call (cost saver) ──

/**
 * Single video call that returns BOTH the music mood and the viral headline.
 * Replaces separate detectVideoMood + generateHookTitle calls (sends the
 * video once instead of twice). Best-effort: missing/invalid fields fall back
 * to { mood: "epic", title: "" }.
 */
export async function detectMoodAndTitle(
  sourceVideoPath: string,
  userId?: number | null
): Promise<{ mood: string; title: string }> {
  const publicUrl = await toPublicMediaUrl(sourceVideoPath);
  let analysisVideoPath: string | null = null;
  let videoUrl: string;
  if (publicUrl) {
    videoUrl = publicUrl;
  } else {
    let dur = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sourceVideoPath,
      ]);
      dur = parseFloat(stdout.trim()) || 0;
    } catch {}
    analysisVideoPath = await prepareAnalysisVideo(sourceVideoPath, dur, 180);
    const buf = fs.readFileSync(analysisVideoPath);
    videoUrl = `data:video/mp4;base64,${buf.toString("base64")}`;
  }

  const prompt = `Analyze this talent-show video and return ONLY a JSON object with exactly two fields:

{
  "mood": one word for background music, EXACTLY one of: epic, emotional, uplifting, dramatic, energetic, happy, chill, dark
  "title": a short VIRAL clickbait headline — 8 to 16 words, high emotion/curiosity, mentions what happens (e.g. a specific song/cover/talent), NO quotes, NO hashtags, NO emojis
}

Example: {"mood":"emotional","title":"She attempted the impossible! This miracle Whitney Houston cover left Simon Cowell in total shock!"}

Return ONLY the JSON object, nothing else.`;

  const content: Array<
    | { type: "text"; text: string }
    | { type: "video_url"; video_url: { url: string } }
  > = [
    { type: "video_url", video_url: { url: videoUrl } },
    { type: "text", text: prompt },
  ];

  let mood = "epic";
  let title = "";
  try {
    const model = await getVideoModel(userId);
    const resp = await openRouterChat(
      model,
      [{ role: "user", content }],
      { max_tokens: 2048, timeout_ms: 120_000, userId }
    );
    const m = resp.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0].replace(/,\s*([}\]])/g, "$1"));
      const moodWord = String(parsed.mood || "").trim().toLowerCase().replace(/[^a-z]/g, "");
      if ((MOOD_TAGS as readonly string[]).includes(moodWord)) mood = moodWord;
      title = String(parsed.title || "").trim().replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, " ");
    } else {
      console.warn(`[detectMoodAndTitle] no JSON in response: ${resp.slice(0, 160)}`);
    }
  } catch (err: any) {
    console.warn(`[detectMoodAndTitle] failed: ${err?.message || err}`);
  } finally {
    if (analysisVideoPath) {
      try { fs.unlinkSync(analysisVideoPath); } catch {}
      try { fs.rmdirSync(path.dirname(analysisVideoPath)); } catch {}
    }
  }
  console.log(`[detectMoodAndTitle] mood="${mood}" title="${title}"`);
  return { mood, title };
}

// ── Viral headline (No-Voiceover top card) ──

/**
 * Generate ONE short, punchy clickbait headline for the clip — shown as the
 * animated top card. Best-effort: returns "" on failure (card is skipped).
 */
export async function generateHookTitle(
  sourceVideoPath: string,
  userId?: number | null
): Promise<string> {
  const publicUrl = await toPublicMediaUrl(sourceVideoPath);
  let analysisVideoPath: string | null = null;
  let videoUrl: string;
  if (publicUrl) {
    videoUrl = publicUrl;
  } else {
    let dur = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sourceVideoPath,
      ]);
      dur = parseFloat(stdout.trim()) || 0;
    } catch {}
    analysisVideoPath = await prepareAnalysisVideo(sourceVideoPath, dur, 180);
    const buf = fs.readFileSync(analysisVideoPath);
    videoUrl = `data:video/mp4;base64,${buf.toString("base64")}`;
  }

  const prompt = `Write ONE short, punchy, VIRAL clickbait headline for this talent-show clip — the kind that makes people STOP SCROLLING.

Rules:
- 8 to 16 words, ONE or two short sentences.
- High emotion / curiosity (shock, miracle, impossible, left the judges speechless, etc.).
- Mention what actually happens (a specific song/cover/talent if visible).
- NO quotes around the whole thing, no hashtags, no emojis.

Example style: She attempted the impossible! This arresting "miracle" Whitney Houston cover just left Simon Cowell in total shock!

Return ONLY the headline text.`;

  const content: Array<
    | { type: "text"; text: string }
    | { type: "video_url"; video_url: { url: string } }
  > = [
    { type: "video_url", video_url: { url: videoUrl } },
    { type: "text", text: prompt },
  ];

  let title = "";
  try {
    const model = await getVideoModel(userId);
    const resp = await openRouterChat(
      model,
      [{ role: "user", content }],
      { max_tokens: 2048, timeout_ms: 120_000, userId }
    );
    title = resp.trim().replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, " ");
  } catch (err: any) {
    console.warn(`[generateHookTitle] failed: ${err?.message || err}`);
  } finally {
    if (analysisVideoPath) {
      try { fs.unlinkSync(analysisVideoPath); } catch {}
      try { fs.rmdirSync(path.dirname(analysisVideoPath)); } catch {}
    }
  }
  console.log(`[generateHookTitle] "${title}"`);
  return title;
}

/**
 * Generate N DISTINCT viral headlines for the clip in ONE call — one per
 * factory variant, so every short gets a DIFFERENT hook. Best-effort: returns
 * whatever it parsed (may be fewer than n, or [] on failure).
 */
export async function generateMultipleHookTitles(
  sourceVideoPath: string,
  n: number,
  userId?: number | null
): Promise<string[]> {
  if (n <= 0) return [];
  const publicUrl = await toPublicMediaUrl(sourceVideoPath);
  let analysisVideoPath: string | null = null;
  let videoUrl: string;
  if (publicUrl) {
    videoUrl = publicUrl;
  } else {
    let dur = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sourceVideoPath,
      ]);
      dur = parseFloat(stdout.trim()) || 0;
    } catch {}
    analysisVideoPath = await prepareAnalysisVideo(sourceVideoPath, dur, 180);
    const buf = fs.readFileSync(analysisVideoPath);
    videoUrl = `data:video/mp4;base64,${buf.toString("base64")}`;
  }

  const prompt = `Write ${n} DISTINCT short, punchy, VIRAL clickbait headlines for this talent-show clip. Each one is for a SEPARATE post, so they MUST feel different from each other.

Rules:
- Each headline: 8 to 16 words, one or two short sentences.
- High emotion / curiosity (shock, miracle, impossible, left the judges speechless, etc.).
- Each headline must take a DIFFERENT angle or emotion: e.g. #1 pure shock, #2 heartwarming, #3 mystery/curiosity, #4 "you won't believe what happens". Vary the hook, the wording and the focus.
- Mention what actually happens (a specific song/cover/talent if visible).
- NO quotes around each headline, no hashtags, no emojis.

Return ONLY a JSON array of exactly ${n} strings, e.g. ["headline one","headline two"].`;

  const content: Array<
    | { type: "text"; text: string }
    | { type: "video_url"; video_url: { url: string } }
  > = [
    { type: "video_url", video_url: { url: videoUrl } },
    { type: "text", text: prompt },
  ];

  let titles: string[] = [];
  try {
    const model = await getVideoModel(userId);
    const resp = await openRouterChat(
      model,
      [{ role: "user", content }],
      { max_tokens: 8192, timeout_ms: 180_000, userId }
    );
    const clean = (s: string) => s.trim().replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, " ");
    const m = resp.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        const arr = JSON.parse(m[0].replace(/,\s*\]/g, "]"));
        if (Array.isArray(arr)) titles = arr.map((x) => clean(String(x))).filter(Boolean);
      } catch {}
    }
    if (titles.length === 0) {
      // Fallback: one headline per non-empty line (strip list markers/quotes).
      titles = resp.split("\n")
        .map((l) => clean(l.replace(/^[\s\-\d.)\]]+/, "")))
        .filter((l) => l.length > 8);
    }
  } catch (err: any) {
    console.warn(`[generateMultipleHookTitles] failed: ${err?.message || err}`);
  } finally {
    if (analysisVideoPath) {
      try { fs.unlinkSync(analysisVideoPath); } catch {}
      try { fs.rmdirSync(path.dirname(analysisVideoPath)); } catch {}
    }
  }
  console.log(`[generateMultipleHookTitles] got ${titles.length}/${n} distinct titles`);
  return titles.slice(0, n);
}

// ── Hook Intro: find the most engaging moment ──

export async function findHookMoment(
  sourceVideoPath: string,
  videoDuration: number,
  userId?: number | null
): Promise<{ start: string; end: string }> {
  console.log(`[findHookMoment] Looking for hook in first 60s of the ${videoDuration.toFixed(1)}s video...`);

  // Prefer public URL — fall back to compressed base64 on URL-specific errors.
  const publicUrl = await toPublicMediaUrl(sourceVideoPath);
  let analysisVideoPath: string | null = null;
  let videoUrlForRequest: string;
  let usingUrlPath = !!publicUrl;

  if (publicUrl) {
    videoUrlForRequest = publicUrl;
    console.log(`[findHookMoment] Sending source video to OpenRouter by URL: ${publicUrl}`);
  } else {
    analysisVideoPath = await prepareAnalysisVideo(sourceVideoPath, videoDuration, 60);
    const buf = fs.readFileSync(analysisVideoPath);
    videoUrlForRequest = `data:video/mp4;base64,${buf.toString("base64")}`;
  }

  const URL_FALLBACK_ERR = /Provider returned error|fetch failed|invalid.*url|unable to access|failed to fetch|400|ROBOTED|robots|Cannot fetch content/i;
  const switchToBase64Fallback = async (): Promise<void> => {
    if (!usingUrlPath) return;
    console.warn(`[findHookMoment] URL approach failed — falling back to base64 (compressing source first 60s).`);
    analysisVideoPath = await prepareAnalysisVideo(sourceVideoPath, videoDuration, 60);
    const buf = fs.readFileSync(analysisVideoPath);
    videoUrlForRequest = `data:video/mp4;base64,${buf.toString("base64")}`;
    usingUrlPath = false;
  };

  const prompt = `You are an expert TikTok/Reels editor. I'm giving you the first 60 seconds of a VIDEO. Your task: find the single MOST HOOK-WORTHY moment — the clip that would make someone STOP SCROLLING.

=== WHAT MAKES A GREAT HOOK ===
- Someone asking a dramatic question ("What's your name?", "Are you ready?", "Can you sing?")
- An emotional reaction — shock, jaw-drop, tears, laughter
- A dramatic reveal or unexpected moment
- Someone about to do something incredible
- An intense face-to-face confrontation or conversation
- A "golden buzzer" or crowd-eruption moment
- Any moment that creates curiosity or tension

=== RULES ===
- The hook MUST be between 3 and 13 seconds long
- It MUST include the ORIGINAL AUDIO (dialogue, reactions, crowd noise — whatever makes it powerful)
- Pick the moment that would make the BEST opening for a short viral video
- The moment should feel like a "teaser" — it should make people want to watch more
- Do NOT pick intro graphics, title screens, or boring wide shots

=== OUTPUT ===
Return ONLY a JSON object with the start and end timestamps in HH:MM:SS format:
{"start": "00:01:23", "end": "00:01:30"}

Maximum timestamp: ${formatTimestamp(Math.min(videoDuration, 60))}.`;

  const buildContent = (): Array<
    | { type: "text"; text: string }
    | { type: "video_url"; video_url: { url: string } }
  > => [
    { type: "video_url", video_url: { url: videoUrlForRequest } },
    { type: "text", text: prompt },
  ];

  let responseText = "";
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      console.log(`[findHookMoment] Calling OpenRouter API (Attempt ${attempt + 1}/${maxAttempts})...`);
      const model = await getVideoModel(userId);
      responseText = await openRouterChat(
        model,
        [{ role: "user", content: buildContent() }],
        { max_tokens: 8192, timeout_ms: 120_000, userId }
      );
      console.log(`[findHookMoment] Received response length: ${responseText.length}`);
      break;
    } catch (err) {
      const isLast = attempt === maxAttempts - 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[findHookMoment] Attempt ${attempt + 1}/${maxAttempts} failed: ${errMsg}`);
      if (usingUrlPath && URL_FALLBACK_ERR.test(errMsg)) {
        try {
          await switchToBase64Fallback();
          continue;
        } catch (fallbackErr) {
          console.warn(`[findHookMoment] base64 fallback compression failed:`, fallbackErr);
        }
      }
      if (isLast) {
        if (analysisVideoPath) {
          try { fs.unlinkSync(analysisVideoPath); } catch {}
          try { fs.rmdirSync(path.dirname(analysisVideoPath)); } catch {}
        }
        throw err;
      }
      await sleep(3000 * (attempt + 1));
    }
  }

  if (analysisVideoPath) {
    try { fs.unlinkSync(analysisVideoPath); } catch {}
    try { fs.rmdirSync(path.dirname(analysisVideoPath)); } catch {}
  }

  console.log(`[findHookMoment] Gemini response: ${responseText.slice(0, 300)}`);

  const jsonStr = extractJsonObject(responseText);
  if (!jsonStr) {
    console.warn("[findHookMoment] No JSON found in response, using fallback (first 5s)");
    return { start: "00:00:00", end: formatTimestamp(Math.min(5, videoDuration)) };
  }

  try {
    const parsed = JSON.parse(jsonStr);
    const start = parseTimestamp(parsed.start);
    let end = parseTimestamp(parsed.end);

    // Enforce max 13 seconds
    if (end - start > 13) {
      end = start + 13;
    }
    // Enforce min 3 seconds
    if (end - start < 3) {
      end = Math.min(start + 5, videoDuration);
    }
    // Clamp to video duration
    const clampedEnd = Math.min(end, videoDuration);

    const result = {
      start: formatTimestamp(Math.max(0, start)),
      end: formatTimestamp(clampedEnd),
    };

    console.log(`[findHookMoment] Found hook: ${result.start} → ${result.end} (${(clampedEnd - start).toFixed(1)}s)`);
    return result;
  } catch (err) {
    console.warn("[findHookMoment] JSON parse failed, using fallback (first 5s)");
    return { start: "00:00:00", end: formatTimestamp(Math.min(5, videoDuration)) };
  }
}
