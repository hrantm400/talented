import fs from "fs";
import path from "path";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // 20MB

const CTA_REQUIREMENT = `CRITICAL: You MUST end every script with a call-to-action directing viewers to the full video in the pinned comment. Examples: "Watch the epic full performance link in the pinned comment! 👇" or "Full video in the pinned comments! 👇" — vary the wording slightly but ALWAYS redirect to full video in pinned comment at the very end.`;

function buildPrompt(
  targetSeconds: number,
  videoType: "edited" | "raw",
  avoidPriorScript?: string
): string {
  const approxWords = Math.floor(targetSeconds * 2.5);

  const editedPrompt = `This is an EDITED video with an existing voiceover. Your task:
- The video already has a good voiceover — analyze it
- REWRITE it to be COOLER and slightly different (do not copy)
- Keep the same vibe and story, but make it punchier and more engaging
- Use hooks, emojis (😱 ✨ 🔥), emotional language
- Fits within ~${targetSeconds} seconds when read (~${approxWords} words max)`;

  const rawPrompt = `This is RAW FOOTAGE (longer, no editing/montage). Your task:
- Create a FULL viral voiceover from scratch
- Describe what happens, build tension, emotional hooks
- Uses hooks, emojis (😱 ✨ 🔥), punchy sentences
- Fits within ~${targetSeconds} seconds when read (~${approxWords} words max)
- Works for clips of any length — summarize key moments engagingly`;

  const modePart = videoType === "edited" ? editedPrompt : rawPrompt;

  // When the caller is producing a SECOND take from the same source, the prior
  // take's script is supplied so this generation deliberately picks a DIFFERENT
  // angle. Re-using the same hook or moments here defeats the purpose.
  const avoidanceBlock = avoidPriorScript
    ? `

CRITICAL — THIS IS TAKE 2 OF THE SAME SOURCE VIDEO:
The first take of this video already used the script below. You MUST cover a DIFFERENT angle:
- Pick DIFFERENT moments/scenes from the source (not the same highlights)
- Use a DIFFERENT emotional hook (if take 1 was funny, go intense; if dramatic, go educational; etc.)
- Tell a DIFFERENT story (different POV, different climax, different lesson)
- DO NOT reuse phrases, structure, or punchlines from take 1
- The two shorts must feel like they were made by different editors who saw different things

Take 1 script (DO NOT REPEAT THIS — find a fresh angle):
"""
${avoidPriorScript.trim().slice(0, 2000)}
"""`
    : "";

  return `You are an expert at writing viral Shorts/Reels voiceover scripts. Analyze this video (visual and audio).

${modePart}
${avoidanceBlock}

${CTA_REQUIREMENT}

Style: Short punchy sentences, emotional buildup, climax before the CTA. Sound like a viral clip narrator.

Return ONLY the voiceover script text. No JSON, no explanation, no markdown.`;
}

export type VideoType = "edited" | "raw";

import ffmpeg from "fluent-ffmpeg";
import { prepareAnalysisVideo } from "../pipeline/gemini";
import { toPublicMediaUrl } from "../pipeline/public-url";
import { getOpenRouterKey, getVideoModel } from "../keys";

async function compressToBase64DataUrl(videoPath: string, originalSize: number): Promise<string> {
  let finalVideoPath = videoPath;
  let needsCleanup = false;

  if (originalSize > MAX_VIDEO_BYTES) {
    console.log(`[generateViralVoiceoverScript] Video is > 20MB (${(originalSize/1024/1024).toFixed(1)}MB). Compressing...`);
    try {
      const dur = await new Promise<number>((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, data) => {
          if (err) reject(err);
          else resolve(data.format.duration || 0);
        });
      });
      finalVideoPath = await prepareAnalysisVideo(videoPath, dur);
      needsCleanup = true;
    } catch (err: any) {
      console.warn(
        `[generateViralVoiceoverScript] Compression failed (${err?.message || err}); sending original ${(originalSize/1024/1024).toFixed(1)}MB file as-is`
      );
    }
  }

  const videoBuffer = fs.readFileSync(finalVideoPath);
  if (needsCleanup) {
    try { fs.unlinkSync(finalVideoPath); } catch {}
  }
  const base64Video = videoBuffer.toString("base64");
  const ext = path.extname(videoPath).toLowerCase();
  const mimeType = ext === ".webm" ? "video/webm" : "video/mp4";
  return `data:${mimeType};base64,${base64Video}`;
}

export async function generateViralVoiceoverScript(
  videoPath: string,
  targetSeconds: number,
  videoType: VideoType = "raw",
  userId?: number | null,
  avoidPriorScript?: string
): Promise<string> {
  const apiKey = await getOpenRouterKey(userId);

  // Preferred path: send video as public HTTPS URL. Fallback path: locally
  // compress + base64. We start on the preferred path and switch to fallback
  // if Gemini keeps returning "Provider returned error" (a flaky upstream).
  const stats = fs.statSync(videoPath);
  const publicUrl = await toPublicMediaUrl(videoPath);
  let dataUrl: string;
  let usingUrlPath = !!publicUrl;

  if (publicUrl) {
    console.log(`[generateViralVoiceoverScript] Sending video by URL: ${publicUrl} (${(stats.size/1024/1024).toFixed(1)}MB)`);
    dataUrl = publicUrl;
  } else {
    dataUrl = await compressToBase64DataUrl(videoPath, stats.size);
  }

  // Lazy fallback: only compress on demand once we know the URL approach
  // failed. Avoids paying the compression cost on the happy path.
  const switchToBase64Fallback = async (): Promise<void> => {
    if (!usingUrlPath) return;
    console.warn(`[generateViralVoiceoverScript] URL approach failed — falling back to base64 (compressing source).`);
    dataUrl = await compressToBase64DataUrl(videoPath, stats.size);
    usingUrlPath = false;
  };

  // Respect the user's "Personal Video Analysis" setting (or admin global
  // default if no per-user override). Was previously hardcoded to Lite,
  // ignoring whatever the user picked in Settings.
  const model = await getVideoModel(userId);
  console.log(`[voiceover-script] using model=${model} for userId=${userId ?? "anon"}`);

  const buildBody = () => ({
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "video_url",
            video_url: { url: dataUrl },
          },
          {
            type: "text",
            text: buildPrompt(targetSeconds, videoType, avoidPriorScript),
          },
        ],
      },
    ],
    // Reasoning models (Gemini 2.5 Pro, etc.) emit thinking tokens that eat
    // into max_tokens; left unbounded with a tiny cap they return reasoning
    // instead of the script. Keep reasoning low + excluded and give the answer
    // generous headroom.
    max_tokens: 4096,
    reasoning: { effort: "low", exclude: true },
  });

  // Retry the request up to 3 times on transient upstream failures (empty
  // body, 5xx, network jitter). Was the source of "Unexpected end of JSON
  // input" failures during bulk runs.
  const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504, 524]);
  const RETRYABLE_MSG = /Unexpected end of JSON input|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|aborted|empty body|Provider returned error/i;
  // URL-specific errors that should trigger the base64 fallback before any
  // further retries.
  const URL_FALLBACK_ERR = /Provider returned error|fetch failed|invalid.*url|unable to access|failed to fetch|400|ROBOTED|robots|Cannot fetch content/i;
  const MAX_ATTEMPTS = 3;

  let lastErr: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "https://localhost:5000",
        },
        body: JSON.stringify(buildBody()),
      });

      if (!res.ok) {
        const errText = await res.text();
        const e: any = new Error(`OpenRouter API error (${res.status}): ${errText}`);
        e.httpStatus = res.status;
        throw e;
      }

      const raw = await res.text();
      if (!raw.trim()) {
        const e: any = new Error("OpenRouter returned empty body");
        e.httpStatus = 502;
        throw e;
      }
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        const e: any = new Error(`OpenRouter response not valid JSON: ${raw.slice(0, 200)}`);
        e.httpStatus = 502;
        throw e;
      }
      if (json.error?.message) {
        throw new Error(`OpenRouter: ${json.error.message}`);
      }
      const script: string | undefined = json.choices?.[0]?.message?.content?.trim();
      if (!script) {
        const e: any = new Error("No script returned from OpenRouter");
        e.httpStatus = 502;
        throw e;
      }
      return script;
    } catch (err: any) {
      lastErr = err;
      const status: number | undefined = err?.httpStatus;
      const msg = err?.message || String(err);
      const retryable =
        (status != null && RETRYABLE_HTTP.has(status)) || RETRYABLE_MSG.test(msg);

      // Provider-side flake on the URL-based path → switch to base64 for
      // the remaining retries. Compression cost (~10-30s) is paid only once.
      if (usingUrlPath && URL_FALLBACK_ERR.test(msg)) {
        try {
          await switchToBase64Fallback();
          // Don't count this against MAX_ATTEMPTS — the next iteration retries
          // with a fundamentally different payload.
          attempt--;
          continue;
        } catch (fallbackErr) {
          console.warn(`[voiceover-script] base64 fallback compression failed:`, fallbackErr);
        }
      }

      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      const backoff = 2000 * attempt;
      console.warn(
        `[voiceover-script] retry ${attempt}/${MAX_ATTEMPTS} in ${backoff}ms: ${msg.slice(0, 200)}`
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}
