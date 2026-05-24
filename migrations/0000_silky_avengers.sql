CREATE TABLE "access_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bg_music_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"file_path" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eleven_labs_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"api_key" text NOT NULL,
	"key_label" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"elevenlabs_api_key" text,
	"elevenlabs_plan" text DEFAULT 'free',
	"elevenlabs_key_label" text,
	"elevenlabs_keys" jsonb DEFAULT '[]'::jsonb,
	"openrouter_api_key" text,
	"default_model_script" text,
	"default_model_video" text,
	"telegram_admin_chat_id" text,
	"mullvad_enabled" boolean DEFAULT false NOT NULL,
	"mullvad_private_key" text,
	"mullvad_address" text,
	"mullvad_country" text DEFAULT 'Sweden',
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logo_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"file_path" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"name" text NOT NULL,
	"project_type" text DEFAULT 'classic' NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"current_step" text DEFAULT 'uploading' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"source_video_path" text,
	"voiceover_path" text,
	"bg_music_path" text,
	"logo_path" text,
	"voiceover_duration" integer,
	"transcription" jsonb,
	"timecodes" jsonb,
	"mixed_audio_path" text,
	"clear_video_path" text,
	"caption_video_path" text,
	"caption_style" text DEFAULT 'capcut_green',
	"is_vertical_source" boolean DEFAULT false,
	"original_video_url" text,
	"short_video_url" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"crop_type" text DEFAULT 'none',
	"ai_analysis_video_path" text,
	"hook_enabled" boolean DEFAULT false,
	"hook_timecode" jsonb
);
--> statement-breakpoint
CREATE TABLE "user_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"feature" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text,
	"username" text,
	"password_hash" text,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"role" text DEFAULT 'user' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"auth_method" text DEFAULT 'google' NOT NULL,
	"elevenlabs_api_key" text,
	"elevenlabs_plan" text DEFAULT 'free',
	"elevenlabs_keys" jsonb DEFAULT '[]'::jsonb,
	"openrouter_api_key" text,
	"personal_model_script" text,
	"personal_model_video" text,
	"use_admin_elevenlabs" boolean DEFAULT false NOT NULL,
	"use_admin_openrouter" boolean DEFAULT false NOT NULL,
	"google_sheet_id" text,
	"google_service_account_json" text,
	"telegram_chat_id" text,
	"telegram_notifications_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;