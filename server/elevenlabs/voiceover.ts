import path from "path";
import fs from "fs";
import pLimit from "p-limit";
import { getElevenLabsKey } from "../keys";

// Global concurrency limiter: ElevenLabs allows max 2 concurrent requests,
// we use 1 to leave headroom for fetchVoices and avoid 429s.
const elevenLabsLimit = pLimit(1);

const ELEVEN_API_BASE = "https://api.elevenlabs.io/v1";

type ElevenVoice = {
  voice_id: string;
  name: string;
  category?: string;
  preview_url?: string;
};

// Both free and paid plans use the same multilingual TTS model.
const ELEVEN_MODEL = "eleven_multilingual_v2";

/**
 * Clone a new voice in ElevenLabs Voice Lab from one or more audio samples.
 * Returns the new voice_id which can then be used with generateVoiceover().
 *
 * Free plan: limited number of cloned voices. Paid plans: more slots.
 */
export async function cloneVoice(
  name: string,
  description: string,
  sampleFiles: Array<{ path: string; filename: string }>,
  userId?: number | null
): Promise<{ voice_id: string }> {
  const { apiKey } = await getElevenLabsKey(userId);
  const form = new FormData();
  form.append("name", name);
  if (description) form.append("description", description);
  for (const f of sampleFiles) {
    const buf = fs.readFileSync(f.path);
    form.append("files", new Blob([new Uint8Array(buf)]), f.filename);
  }

  const res = await fetch(`${ELEVEN_API_BASE}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Voice clone failed: ${res.status} ${text}`);
  }
  return (await res.json()) as { voice_id: string };
}

export async function fetchElevenLabsVoices(userId?: number | null): Promise<ElevenVoice[]> {
  const { apiKey } = await getElevenLabsKey(userId);

  const res = await fetch(`${ELEVEN_API_BASE}/voices?show_legacy=true`, {
    method: "GET",
    headers: {
      "xi-api-key": apiKey,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch voices: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { voices?: ElevenVoice[] };
  return data.voices ?? [];
}

export async function generateVoiceover(
  text: string,
  voiceId?: string,
  userId?: number | null
): Promise<{ audioPath: string; publicPath: string }> {
  return elevenLabsLimit(() => generateVoiceoverInner(text, voiceId, userId));
}

async function generateVoiceoverInner(
  text: string,
  voiceId?: string,
  userId?: number | null
): Promise<{ audioPath: string; publicPath: string }> {
  const { apiKey } = await getElevenLabsKey(userId);
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Text is required for voiceover");
  }

  let effectiveVoiceId = voiceId;
  if (!effectiveVoiceId) {
    const voices = await fetchElevenLabsVoices(userId);
    if (!voices.length) {
      throw new Error("No ElevenLabs voices available for this API key");
    }
    const liam =
      voices.find((v) => v.name.toLowerCase().includes("liam")) ?? voices[0];
    effectiveVoiceId = liam.voice_id;
  }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(
      `${ELEVEN_API_BASE}/text-to-speech/${effectiveVoiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: trimmed,
          model_id: ELEVEN_MODEL,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
          },
        }),
      },
    );

    if (res.ok) {
      const downloadsRoot = path.join(process.cwd(), "downloads");
      if (!fs.existsSync(downloadsRoot)) {
        fs.mkdirSync(downloadsRoot, { recursive: true });
      }

      const fileName = `voiceover-${Date.now()}.mp3`;
      const filePath = path.join(downloadsRoot, fileName);
      const arrayBuffer = await res.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

      const publicPath = `/downloads/${fileName}`;
      return { audioPath: filePath, publicPath };
    }

    const textBody = await res.text();

    // Retry only on 429 (rate limit / concurrent limit)
    if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
      const delaySec = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : 10 * (attempt + 1); // 10s, 20s
      console.warn(
        `[ElevenLabs] 429 rate limited (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${delaySec}s...`
      );
      await new Promise((r) => setTimeout(r, delaySec * 1000));
      continue;
    }

    throw new Error(`Failed to generate voiceover: ${res.status} ${textBody}`);
  }

  throw new Error("Failed to generate voiceover: max retries exceeded");
}

