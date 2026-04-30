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

export * from "./models/chat";

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
  "elevenlabs",
  "download",
  "voiceover-script",
  "smart-crop",
  "auto-ducking",
  "highlights",
  "color-grade",
  "vocal-isolate",
  "motion-track",
  "combos",
] as const;

export type FeatureKey = (typeof ALL_FEATURES)[number];

// ─── Project types ───
export const PROJECT_TYPES = {
  CLASSIC: "classic",
  AUTOMATED: "automated",
  DUCKING: "ducking",
  CROP: "crop",
  COLOR: "color",
  ISOLATE: "isolate",
  HIGHLIGHTS: "highlights",
  MOTION_TRACK: "motion-track",
  COMBO_VIRAL: "combo-viral",
  COMBO_PODCAST: "combo-podcast",
  COMBO_ACTION: "combo-action",
  COMBO_CINEMATIC: "combo-cinematic",
  COMBO_MEME: "combo-meme",
} as const;

export type ProjectType = (typeof PROJECT_TYPES)[keyof typeof PROJECT_TYPES];

export const COMBO_TYPES: ProjectType[] = [
  PROJECT_TYPES.COMBO_VIRAL,
  PROJECT_TYPES.COMBO_PODCAST,
  PROJECT_TYPES.COMBO_ACTION,
  PROJECT_TYPES.COMBO_CINEMATIC,
  PROJECT_TYPES.COMBO_MEME,
];

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
  clearVideoPath: text("clear_video_path"),
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
});

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
});

export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;

// ─── ElevenLabs Settings (legacy, kept for backward compat) ───
export const elevenLabsSettings = pgTable("eleven_labs_settings", {
  id: serial("id").primaryKey(),
  apiKey: text("api_key").notNull(),
  keyLabel: text("key_label"),
  plan: text("plan").notNull().default("free"),
  createdAt: timestamp("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type ElevenLabsSettings = typeof elevenLabsSettings.$inferSelect;

// ─── Assets ───
export const bgMusicAssets = pgTable("bg_music_assets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  filePath: text("file_path").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const logoAssets = pgTable("logo_assets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  filePath: text("file_path").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});
