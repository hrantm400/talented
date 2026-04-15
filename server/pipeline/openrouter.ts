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

export async function openRouterChat(
  model: string,
  messages: OpenRouterMessage[],
  options: { max_tokens?: number; timeout_ms?: number; userId?: number | null } = {}
): Promise<string> {
  const apiKey = await getOpenRouterKey(options.userId);

  const timeoutMs = options.timeout_ms ?? 120_000; // default 2 minutes
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
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.max_tokens ?? 8192,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter API error (${res.status}): ${errText}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string; code?: number; metadata?: any };
    };

    if (json.error) {
      const detail = JSON.stringify(json.error);
      console.error(`[OpenRouter] API error for model ${model}:`, detail);
      throw new Error(`OpenRouter: ${json.error.message || detail}`);
    }

    const text = json.choices?.[0]?.message?.content?.trim();
    return text ?? "";
  } finally {
    clearTimeout(timer);
  }
}
