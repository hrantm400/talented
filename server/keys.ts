import { db } from "./db";
import { users, globalSettings } from "@shared/schema";
import { eq } from "drizzle-orm";

export async function getOpenRouterKey(userId?: number | null): Promise<string> {
  // If no user context, fallback to global admin key
  if (!userId) {
    const [global] = await db.select().from(globalSettings).limit(1);
    if (!global?.openrouterApiKey) {
      throw new Error("OpenRouter API key is not configured globally and no user context was provided");
    }
    return global.openrouterApiKey;
  }

  // Get user
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) {
    throw new Error("User not found for API key resolution");
  }

  // 1. Try personal key first
  if (user.openrouterApiKey) {
    return user.openrouterApiKey;
  }

  // 2. Fallback to admin key if permitted (or if user is admin)
  if (user.useAdminOpenrouter || user.role === "admin") {
    const [global] = await db.select().from(globalSettings).limit(1);
    if (global && global.openrouterApiKey) {
      return global.openrouterApiKey;
    }
    throw new Error("Admin OpenRouter key is not configured, but user is set to use it");
  }

  throw new Error("No OpenRouter API key found for this user. Please configure it in Settings.");
}

export async function getElevenLabsKey(userId?: number | null): Promise<{apiKey: string, plan: "free"|"paid"}> {
  // If no user context, fallback to global admin key
  if (!userId) {
    const [global] = await db.select().from(globalSettings).limit(1);
    const keys = global?.elevenlabsKeys || [];
    const activeKey = keys.find((k: any) => k.isActive) || keys[0];
    
    if (activeKey?.key) {
      return { apiKey: activeKey.key, plan: activeKey.plan || "free" };
    }
    if (global?.elevenlabsApiKey) {
      return { apiKey: global.elevenlabsApiKey, plan: (global.elevenlabsPlan as "free"|"paid") || "free" };
    }
    
    throw new Error("ElevenLabs API key is not configured globally and no user context was provided");
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error("User not found");

  // 1. Try personal key first
  const userKeys = user.elevenlabsKeys || [];
  const activeUserKey = userKeys.find((k: any) => k.isActive) || userKeys[0];
  if (activeUserKey?.key) {
    return { apiKey: activeUserKey.key, plan: activeUserKey.plan || "free" };
  }
  if (user.elevenlabsApiKey) {
    return { apiKey: user.elevenlabsApiKey, plan: (user.elevenlabsPlan as "free"|"paid") || "free" };
  }

  // 2. Fallback to admin key if permitted (or if the user IS the admin)
  if (user.useAdminElevenlabs || user.role === "admin") {
    const [global] = await db.select().from(globalSettings).limit(1);
    const globalKeys = global?.elevenlabsKeys || [];
    const activeGlobalKey = globalKeys.find((k: any) => k.isActive) || globalKeys[0];
    if (activeGlobalKey?.key) {
      return { apiKey: activeGlobalKey.key, plan: activeGlobalKey.plan || "free" };
    }
    if (global && global.elevenlabsApiKey) {
      return { apiKey: global.elevenlabsApiKey, plan: (global.elevenlabsPlan as "free"|"paid") || "free" };
    }
    throw new Error("Admin ElevenLabs key is not configured");
  }

  throw new Error("No ElevenLabs API key found for this user. Please configure it in Settings.");
}

const DEFAULT_SCRIPT_MODEL = "google/gemini-3-pro-preview";
const DEFAULT_VIDEO_MODEL = "google/gemini-3.1-flash-lite-preview";
// We default to "local" because OpenRouter's /audio/transcriptions endpoint
// currently returns only the plain text — no word-level timestamps. Our
// subtitle generator (generateASS) requires per-word timing. The setting is
// still pasteable in the admin panel for the day OpenRouter adds verbose_json
// + timestamp_granularities support upstream; the transcribe code falls back
// to local automatically if the remote model returns 0 words.
const DEFAULT_WHISPER_MODEL = "local";

export async function getScriptModel(userId?: number | null): Promise<string> {
  const [global] = await db.select().from(globalSettings).limit(1);
  let globalModel = global?.defaultModelScript || DEFAULT_SCRIPT_MODEL;

  if (!userId) return globalModel;

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (user?.personalModelScript) return user.personalModelScript;

  return globalModel;
}

export async function getVideoModel(userId?: number | null): Promise<string> {
  const [global] = await db.select().from(globalSettings).limit(1);
  let globalModel = global?.defaultModelVideo || DEFAULT_VIDEO_MODEL;

  if (!userId) return globalModel;

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (user?.personalModelVideo) return user.personalModelVideo;

  return globalModel;
}

/**
 * Resolve the model for the No-Voiceover SEGMENTS task (setup+epic curation).
 * Personal override → global default → falls back to the video model so that
 * "unset" behaves exactly like today.
 */
export async function getSegmentsModel(userId?: number | null): Promise<string> {
  const [global] = await db.select().from(globalSettings).limit(1);
  if (userId) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (user?.personalModelSegments) return user.personalModelSegments;
  }
  if (global?.defaultModelSegments) return global.defaultModelSegments;
  return getVideoModel(userId);
}

/**
 * Resolve which Whisper model to use for this user's transcriptions.
 * Returns "local" to mean "use the bundled faster-whisper Python script" —
 * otherwise the value is forwarded to OpenRouter (e.g.
 * "openai/whisper-large-v3-turbo").
 */
export async function getWhisperModel(userId?: number | null): Promise<string> {
  const [global] = await db.select().from(globalSettings).limit(1);
  const globalModel = global?.defaultModelWhisper || DEFAULT_WHISPER_MODEL;

  if (!userId) return globalModel;

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (user?.personalModelWhisper) return user.personalModelWhisper;

  return globalModel;
}
