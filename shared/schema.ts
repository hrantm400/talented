import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const wordTimestamp = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
});

export const videoTimecode = z.object({
  start: z.string(),
  end: z.string(),
});

export type WordTimestamp = z.infer<typeof wordTimestamp>;
export type VideoTimecode = z.infer<typeof videoTimecode>;

export const pipelineStepEnum = z.enum([
  "uploading",
  "transcription",
  "video_curation",
  "audio_mixing",
  "video_composition",
  "subtitle_overlay",
  "exporting",
  "complete",
  "failed",
]);

export type PipelineStep = z.infer<typeof pipelineStepEnum>;

export interface ElevenLabsKey {
  id: string;
  name: string;
  key: string;
  plan: "free" | "paid";
  isActive: boolean;
}

/**
 * Visual logo placement on the 1080×1920 canvas, stored as fractions so it is
 * resolution-independent. xPct/yPct = top-left of the logo; widthPct = logo
 * width; opacity 0..1.
 */
export interface LogoLayout {
  xPct: number;
  yPct: number;
  widthPct: number;
  opacity: number;
}

// ─── Automated Shorts Factory ───
// One source video → several unique shorts (mix of no-voiceover + voiceover)
// based on duration rules, each styled by a variant profile.

/** How many NV / VO videos to make for sources up to maxMin minutes long. */
export interface FactoryDurationRule {
  maxMin: number; // upper bound (inclusive) in minutes; rules are ascending
  nv: number;     // number of no-voiceover variants
  vo: number;     // number of voiceover variants
}

/** A reusable "recipe" the factory assigns to each generated short. */
export interface VariantProfile {
  name?: string;
  captionStyle: string;                       // one of the 6 preset ids
  mirror: boolean;                            // horizontal flip
  noise: number;                              // 0 = off, else strength (~4-12)
  logoPosition: "top-left" | "top-right";     // logo corner
  musicMood: string;                          // "auto" | mood tag | "none"
  topCard: boolean;                           // animated headline card on top
  outro: boolean;                             // animated "full video in comments"
  hookText?: string;                          // custom top-card text; blank ⇒ AI title
  outroText?: string;                         // custom outro text; blank ⇒ default
  logoLayout?: LogoLayout;                    // per-variant logo placement/scale/opacity
  logoAssetId?: number | null;                // per-variant logo IMAGE (saved logo asset); null ⇒ run default
  hookColor?: string;                         // headline text color, RGB hex (e.g. "A020F0"); blank ⇒ default purple
}

/** Per-project rendering config the factory writes onto each output. */
export interface VariantConfig {
  mirror: boolean;
  noise: number;
  topCard: boolean;
  outro: boolean;
  hookText?: string;                          // custom top-card text override
  outroText?: string;                         // custom outro text override
  logoLayout?: LogoLayout;                    // overrides project.logoLayout at render
  logoPosition?: "top-left" | "top-right";    // legacy-corner override
  hookColor?: string;                         // headline text color (RGB hex)
}

// ─── Users ───
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").unique(),
  username: text("username").unique(),
  passwordHash: text("password_hash"),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  role: text("role").notNull().default("user"),
  isActive: boolean("is_active").notNull().default(true),
  authMethod: text("auth_method").notNull().default("google"),

  // Per-user API keys (Phase 3)
  elevenlabsApiKey: text("elevenlabs_api_key"),
  elevenlabsPlan: text("elevenlabs_plan").default("free"),
  elevenlabsKeys: jsonb("elevenlabs_keys").$type<ElevenLabsKey[]>().default([]),
  openrouterApiKey: text("openrouter_api_key"),
  
  // Per-user AI Models
  personalModelScript: text("personal_model_script"),
  personalModelVideo: text("personal_model_video"),
  personalModelWhisper: text("personal_model_whisper"),
  // Model for the No-Voiceover SEGMENTS task (setup+epic curation). Lets you
  // run a stronger model here while keeping the cheaper video model for
  // mood/title. Falls back to the video model when unset.
  personalModelSegments: text("personal_model_segments"),
  useAdminElevenlabs: boolean("use_admin_elevenlabs").notNull().default(false),
  useAdminOpenrouter: boolean("use_admin_openrouter").notNull().default(false),

  // Per-user Google Sheets (Phase 3)
  googleSheetId: text("google_sheet_id"),
  googleServiceAccountJson: text("google_service_account_json"),

  // Telegram (Phase 4)
  telegramChatId: text("telegram_chat_id"),
  telegramNotificationsEnabled: boolean("telegram_notifications_enabled").notNull().default(false),

  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

// ─── Access Requests ───
export const accessRequests = pgTable("access_requests", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type AccessRequest = typeof accessRequests.$inferSelect;

// ─── User Permissions ───
export const userPermissions = pgTable("user_permissions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  feature: text("feature").notNull(),
});

export type UserPermission = typeof userPermissions.$inferSelect;

// ─── Global Settings ───
export const globalSettings = pgTable("global_settings", {
  id: serial("id").primaryKey(),
  elevenlabsApiKey: text("elevenlabs_api_key"),
  elevenlabsPlan: text("elevenlabs_plan").default("free"),
  elevenlabsKeyLabel: text("elevenlabs_key_label"),
  elevenlabsKeys: jsonb("elevenlabs_keys").$type<ElevenLabsKey[]>().default([]),
  openrouterApiKey: text("openrouter_api_key"),
  defaultModelScript: text("default_model_script"),
  defaultModelVideo: text("default_model_video"),
  defaultModelWhisper: text("default_model_whisper"),
  defaultModelSegments: text("default_model_segments"),
  jamendoClientId: text("jamendo_client_id"),
  // Visual logo placement defaults (No-Voiceover variant). Each layout is
  // { xPct, yPct, widthPct, opacity } relative to the 1080×1920 canvas.
  // Take 1 / Take 2 let a 2x pair put the logo in two different spots.
  logoLayoutTake1: jsonb("logo_layout_take1").$type<LogoLayout>(),
  logoLayoutTake2: jsonb("logo_layout_take2").$type<LogoLayout>(),
  // ── Automated Shorts Factory config ──
  factoryDurationRules: jsonb("factory_duration_rules").$type<FactoryDurationRule[]>(),
  factoryNvProfiles: jsonb("factory_nv_profiles").$type<VariantProfile[]>(),
  factoryVoProfiles: jsonb("factory_vo_profiles").$type<VariantProfile[]>(),
  factorySheetTabNv: text("factory_sheet_tab_nv"),
  factorySheetTabVo: text("factory_sheet_tab_vo"),
  // Saved default logo placement for the Factory bulk-logo bar (drag editor).
  factoryDefaultLogoLayout: jsonb("factory_default_logo_layout").$type<LogoLayout>(),
  // Monotonic counter: the last SOURCE number assigned for Google-Sheets ordering.
  factoryLastSourceNumber: integer("factory_last_source_number").default(0),
  telegramAdminChatId: text("telegram_admin_chat_id"),
  
  // Mullvad VPN 
  mullvadEnabled: boolean("mullvad_enabled").notNull().default(false),
  mullvadPrivateKey: text("mullvad_private_key"),
  mullvadAddress: text("mullvad_address"),
  mullvadCountry: text("mullvad_country").default("Sweden"),

  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type GlobalSettings = typeof globalSettings.$inferSelect;

// ─── All available features for permissions ───
export const ALL_FEATURES = [
  "classic",
  "automated-shorts",
  "automated-shorts-no-voiceover",
  "automated-shorts-factory",
  "elevenlabs",
  "download",
  "voiceover-script",
] as const;

export type FeatureKey = (typeof ALL_FEATURES)[number];

// ─── Project types ───
export const PROJECT_TYPES = {
  CLASSIC: "classic",
  AUTOMATED: "automated",
  AUTOMATED_NO_VOICEOVER: "automated-no-voiceover",
} as const;

export type ProjectType = (typeof PROJECT_TYPES)[keyof typeof PROJECT_TYPES];

// ─── Projects (with userId) ───
export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  projectType: text("project_type").notNull().default("classic"),
  status: text("status").notNull().default("uploading"),
  currentStep: text("current_step").notNull().default("uploading"),
  progress: integer("progress").notNull().default(0),
  errorMessage: text("error_message"),
  sourceVideoPath: text("source_video_path"),
  voiceoverPath: text("voiceover_path"),
  bgMusicPath: text("bg_music_path"),
  logoPath: text("logo_path"),
  voiceoverDuration: integer("voiceover_duration"),
  transcription: jsonb("transcription"),
  timecodes: jsonb("timecodes"),
  mixedAudioPath: text("mixed_audio_path"),
  captionVideoPath: text("caption_video_path"),
  captionStyle: text("caption_style").default("capcut_green"),
  isVerticalSource: boolean("is_vertical_source").default(false),
  originalVideoUrl: text("original_video_url"),
  shortVideoUrl: text("short_video_url"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  cropType: text("crop_type").default("none"),
  aiAnalysisVideoPath: text("ai_analysis_video_path"),
  hookEnabled: boolean("hook_enabled").default(false),
  hookTimecode: jsonb("hook_timecode"),
  // Logo overlay corner. Default top-right matches the historical position.
  // Bulk Paste's 2x feature lets the user pick "top-left" for Take 2.
  logoPosition: text("logo_position").default("top-right"),
  // When auto-music (Jamendo) is used, the ready-to-paste credit line for the
  // post description, e.g. "🎵 Music: X by Y (CC BY) — Jamendo: <url>".
  musicAttribution: text("music_attribution"),
  // Resolved visual logo placement for THIS project (from the global Take 1 /
  // Take 2 defaults). Null = use the legacy corner placement.
  logoLayout: jsonb("logo_layout").$type<LogoLayout>(),
  // AI-generated viral headline shown as the animated top card (No-Voiceover).
  hookTitle: text("hook_title"),
  // Per-variant rendering config written by the factory (mirror/noise/cards).
  variantConfig: jsonb("variant_config").$type<VariantConfig>(),
  // Groups all outputs of one factory run (source video) together.
  batchId: text("batch_id"),
  // Google-Sheets ordering: sequential number of the SOURCE this output came
  // from (same for all its variants), and the variant label ("voiceover 1" /
  // "no voiceover 2"). Used to keep the sheet sorted instead of append-order.
  sheetSourceNumber: integer("sheet_source_number"),
  sheetVariantLabel: text("sheet_variant_label"),
});

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
});

export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;

// ─── Assets ───
export const bgMusicAssets = pgTable("bg_music_assets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  filePath: text("file_path").notNull(),
  // Mood tag (one of MOOD_TAGS) used for AI-mood-matched auto music in the
  // Factory. null = untagged ("any") — eligible as a fallback for any mood.
  mood: text("mood"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const logoAssets = pgTable("logo_assets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  filePath: text("file_path").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});
