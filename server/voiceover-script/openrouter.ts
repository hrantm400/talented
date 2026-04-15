import fs from "fs";
import path from "path";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemini-3.1-flash-lite-preview";
const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // 20MB

const CTA_REQUIREMENT = `CRITICAL: You MUST end every script with a call-to-action directing viewers to the full video in the pinned comment. Examples: "Watch the epic full performance link in the pinned comment! 👇" or "Full video in the pinned comments! 👇" — vary the wording slightly but ALWAYS redirect to full video in pinned comment at the very end.`;

function buildPrompt(targetSeconds: number, videoType: "edited" | "raw"): string {
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

  return `You are an expert at writing viral Shorts/Reels voiceover scripts. Analyze this video (visual and audio).

${modePart}

${CTA_REQUIREMENT}

Style: Short punchy sentences, emotional buildup, climax before the CTA. Sound like a viral clip narrator.

Return ONLY the voiceover script text. No JSON, no explanation, no markdown.`;
}

export type VideoType = "edited" | "raw";

import ffmpeg from "fluent-ffmpeg";
import { prepareAnalysisVideo } from "../pipeline/gemini";
import { getOpenRouterKey } from "../keys";

export async function generateViralVoiceoverScript(
  videoPath: string,
  targetSeconds: number,
  videoType: VideoType = "raw",
  userId?: number | null
): Promise<string> {
  const apiKey = await getOpenRouterKey(userId);

  const stats = fs.statSync(videoPath);
  let finalVideoPath = videoPath;
  let needsCleanup = false;

  if (stats.size > MAX_VIDEO_BYTES) {
    console.log(`[generateViralVoiceoverScript] Video is > 20MB (${(stats.size/1024/1024).toFixed(1)}MB). Compressing...`);
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
      throw new Error(`Video too large (${(stats.size/1024/1024).toFixed(1)}MB) and compression failed: ${err.message}`);
    }
  }

  const videoBuffer = fs.readFileSync(finalVideoPath);
  if (needsCleanup) {
    try { fs.unlinkSync(finalVideoPath); } catch {}
  }
  
  const base64Video = videoBuffer.toString("base64");
  const ext = path.extname(videoPath).toLowerCase();
  const mimeType = ext === ".webm" ? "video/webm" : "video/mp4";
  const dataUrl = `data:${mimeType};base64,${base64Video}`;

  const body = {
    model: MODEL,
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
            text: buildPrompt(targetSeconds, videoType),
          },
        ],
      },
    ],
    max_tokens: 1024,
  };

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "https://localhost:5000",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API error (${res.status}): ${errText}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (json.error?.message) {
    throw new Error(`OpenRouter: ${json.error.message}`);
  }

  const script = json.choices?.[0]?.message?.content?.trim();
  if (!script) {
    throw new Error("No script returned from OpenRouter");
  }

  return script;
}
