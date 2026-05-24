const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const OPENROUTER_MODEL_SCRIPT = "google/gemini-3-pro-preview";
export const OPENROUTER_MODEL_TOP_FRAMES = "google/gemini-3.1-flash-lite-preview";
export const OPENROUTER_MODEL_TRANSCRIPT = "google/gemini-3-pro-preview";

export type OpenRouterContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

export type OpenRouterMessage = {
  role: "user";
  content: OpenRouterContentPart[];
};

import { getOpenRouterKey } from "../keys";

const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504, 524]);
// "Provider returned error" is OpenRouter's catch-all when the upstream model
// provider (Gemini, OpenAI, etc.) fails to respond cleanly. Empirically it
// returns ~10-30% of the time when sending large videos via URL — a retry
// almost always succeeds. Also retry on Gemini's fetch failures / resource
// exhausted messages.
const RETRYABLE_MSG = /Unexpected end of JSON input|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|aborted|network|Provider returned error|RESOURCE_EXHAUSTED|model is overloaded|UNAVAILABLE/i;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function openRouterChatOnce(
  model: string,
  messages: OpenRouterMessage[],
  apiKey: string,
  max_tokens: number,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || process.env.APP_PUBLIC_URL || "https://localhost:5000",
      },
      body: JSON.stringify({ model, messages, max_tokens }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      const err: any = new Error(`OpenRouter API error (${res.status}): ${errText}`);
      err.httpStatus = res.status;
      throw err;
    }

    // Read as text first so we can detect empty bodies (the real cause of
    // "Unexpected end of JSON input" we used to see) and surface a clearer
    // retryable error.
    const raw = await res.text();
    if (!raw.trim()) {
      const err: any = new Error("OpenRouter returned empty body");
      err.httpStatus = 502;
      throw err;
    }
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch (parseErr) {
      const err: any = new Error(
        `OpenRouter response not valid JSON: ${raw.slice(0, 200)}`
      );
      err.httpStatus = 502;
      throw err;
    }

    if (json.error) {
      const detail = JSON.stringify(json.error);
      const err: any = new Error(`OpenRouter: ${json.error.message || detail}`);
      err.httpStatus = json.error.code || 500;
      throw err;
    }

    const text: string | undefined = json.choices?.[0]?.message?.content?.trim();
    return text ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenRouter chat with bounded retries. Retries on:
 *   - HTTP 408/429/500/502/503/504/524
 *   - empty response body / unparseable JSON (transient upstream)
 *   - network jitter (ECONNRESET, ETIMEDOUT, fetch failed)
 *
 * Non-retryable errors (e.g. 400 invalid request, 401 bad key) bubble up
 * immediately.
 */
export async function openRouterChat(
  model: string,
  messages: OpenRouterMessage[],
  options: { max_tokens?: number; timeout_ms?: number; userId?: number | null } = {}
): Promise<string> {
  const apiKey = await getOpenRouterKey(options.userId);
  const timeoutMs = options.timeout_ms ?? 120_000;
  const max_tokens = options.max_tokens ?? 8192;

  const MAX_ATTEMPTS = 3;
  let lastErr: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await openRouterChatOnce(model, messages, apiKey, max_tokens, timeoutMs);
    } catch (err: any) {
      lastErr = err;
      const status: number | undefined = err?.httpStatus;
      const msg = err?.message || String(err);
      const retryable =
        (status != null && RETRYABLE_HTTP_STATUS.has(status)) ||
        RETRYABLE_MSG.test(msg);

      if (!retryable || attempt === MAX_ATTEMPTS) {
        if (retryable) {
          console.error(
            `[OpenRouter ${model}] giving up after ${attempt} attempts: ${msg.slice(0, 300)}`
          );
        } else {
          console.error(`[OpenRouter ${model}] non-retryable: ${msg.slice(0, 300)}`);
        }
        throw err;
      }
      const backoff = 1500 * attempt;
      console.warn(
        `[OpenRouter ${model}] retryable error (attempt ${attempt}/${MAX_ATTEMPTS}, backoff ${backoff}ms): ${msg.slice(0, 200)}`
      );
      await delay(backoff);
    }
  }
  throw lastErr;
}
