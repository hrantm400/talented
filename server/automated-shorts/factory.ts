// ─────────────────────────────────────────────────────────────────────────
// Automated Shorts FACTORY.
//
// One source video → several unique shorts. Duration decides how many
// no-voiceover (NV) and voiceover (VO) variants to make (configurable rules).
// Each variant is styled by a configurable "profile" (caption style, mirror,
// noise, logo corner, music mood, top card, outro). The NV variants get
// genuinely DIFFERENT moments via a single multi-narrative Gemini call.
// ─────────────────────────────────────────────────────────────────────────
import fs from "fs";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { globalSettings, PROJECT_TYPES } from "@shared/schema";
import type { FactoryDurationRule, VariantProfile, VariantConfig } from "@shared/schema";
import { storage } from "../storage";
import { broadcastProjectUpdate } from "../websocket";
import { downloadBest, downloadForAnalysis, getRemoteDuration } from "../downloader/ytDlp";
import { getMediaDuration } from "../pipeline/ffmpeg";
import { curateMultipleNarratives, detectMoodAndTitle, generateMultipleHookTitles } from "../pipeline/gemini";
import { queueNoVoiceoverPipeline } from "./pipeline-no-voiceover";
import { runAutomatedShortBackgroundForExisting } from "./orchestrator";
import { getRandomBgMusicByMood, getLogoAssetById } from "../assets/storage";

export const DEFAULT_FACTORY_RULES: FactoryDurationRule[] = [
  { maxMin: 3, nv: 1, vo: 1 },
  { maxMin: 6, nv: 2, vo: 2 },
  { maxMin: 20, nv: 3, vo: 1 },
];

export const DEFAULT_NV_PROFILES: VariantProfile[] = [
  { name: "NV A", captionStyle: "capcut_green", mirror: false, noise: 7, logoPosition: "top-right", musicMood: "auto", topCard: true, outro: true, hookColor: "A020F0" },
  { name: "NV B", captionStyle: "neon_pop", mirror: true, noise: 7, logoPosition: "top-left", musicMood: "auto", topCard: true, outro: true, hookColor: "A020F0" },
  { name: "NV C", captionStyle: "fire", mirror: false, noise: 9, logoPosition: "top-right", musicMood: "auto", topCard: true, outro: true, hookColor: "A020F0" },
  { name: "NV D", captionStyle: "gradient_glow", mirror: true, noise: 9, logoPosition: "top-left", musicMood: "auto", topCard: true, outro: true, hookColor: "A020F0" },
];

export const DEFAULT_VO_PROFILES: VariantProfile[] = [
  { name: "VO A", captionStyle: "capcut_yellow", mirror: true, noise: 7, logoPosition: "top-right", musicMood: "auto", topCard: true, outro: true, hookColor: "2E7DFF" },
  { name: "VO B", captionStyle: "minimal_white", mirror: false, noise: 9, logoPosition: "top-left", musicMood: "auto", topCard: true, outro: true, hookColor: "2E7DFF" },
];

export type FactoryOptions = {
  userId?: number | null;
  fullVideoUrl?: string;
  fullVideoPath?: string;
  bgMusicPath?: string | null;   // optional fallback music
  logoPath?: string | null;
  projectName?: string;
  targetSeconds: number;
  isVerticalSource?: boolean;
  cropType?: string;
};

/**
 * Build the per-project render config from a variant profile. Carries the
 * uniqueization flags AND the per-variant authoring overrides (custom hook /
 * outro text, logo layout/corner). Blank text fields are dropped so the render
 * falls back to the AI title / default outro.
 */
function buildVariantConfig(profile: VariantProfile): VariantConfig {
  return {
    mirror: profile.mirror,
    noise: profile.noise,
    topCard: profile.topCard,
    outro: profile.outro,
    hookText: profile.hookText?.trim() || undefined,
    outroText: profile.outroText?.trim() || undefined,
    logoLayout: profile.logoLayout || undefined,
    logoPosition: profile.logoPosition,
    hookColor: profile.hookColor?.trim() || undefined,
  };
}

async function loadFactoryConfig() {
  const [g] = await db.select().from(globalSettings).limit(1);
  return {
    rules: (g?.factoryDurationRules && g.factoryDurationRules.length ? g.factoryDurationRules : DEFAULT_FACTORY_RULES)
      .slice()
      .sort((a, b) => a.maxMin - b.maxMin),
    nvProfiles: g?.factoryNvProfiles && g.factoryNvProfiles.length ? g.factoryNvProfiles : DEFAULT_NV_PROFILES,
    voProfiles: g?.factoryVoProfiles && g.factoryVoProfiles.length ? g.factoryVoProfiles : DEFAULT_VO_PROFILES,
  };
}

function pickRule(rules: FactoryDurationRule[], minutes: number): FactoryDurationRule {
  for (const r of rules) if (minutes <= r.maxMin) return r;
  return rules[rules.length - 1]; // longer than all → use the largest bucket
}

/**
 * Assign the next sequential SOURCE number (for Google-Sheets ordering). All
 * variants of one source share it; it increments once per source/run. Returns
 * 0 on failure (the sheet append just leaves the № blank then).
 */
export async function nextSourceNumber(): Promise<number> {
  try {
    const [g] = await db.select().from(globalSettings).limit(1);
    if (!g) {
      const [ins] = await db.insert(globalSettings).values({ factoryLastSourceNumber: 1 }).returning({ n: globalSettings.factoryLastSourceNumber });
      return ins?.n ?? 1;
    }
    const next = (g.factoryLastSourceNumber ?? 0) + 1;
    await db.update(globalSettings).set({ factoryLastSourceNumber: next }).where(eq(globalSettings.id, g.id));
    return next;
  } catch (e: any) {
    console.warn(`[factory] nextSourceNumber failed: ${e.message}`);
    return 0;
  }
}

/**
 * Entry point. Creates the batch in the background and returns its id so the
 * UI can start polling immediately.
 */
/** One planned output slot the user can edit before generation. */
export type FactoryVariantSlot = {
  kind: "nv" | "vo";
  index: number;          // 1-based within its kind
  profile: VariantProfile;
};

/**
 * A factory plan: the source duration + the list of variant slots — computed
 * WITHOUT downloading the video or calling the AI (so "Build plan" is instant
 * even for long / many sources). The heavy work (download + mood + distinct
 * hooks) is deferred to generate, which runs in the background. cutSourcePath /
 * aiAnalysisVideoPath / detectedMood are filled in at generate time.
 */
export type FactoryPlan = {
  batchId: string;
  userId?: number | null;
  baseName: string;
  cutSourcePath?: string;
  aiAnalysisVideoPath?: string;
  durationSec: number;
  detectedMood: string;
  sharedTitle: string;
  targetSeconds: number;
  isVerticalSource: boolean;
  cropType: string;
  logoPath?: string | null;
  bgMusicPath?: string | null;
  fullVideoUrl?: string;
  fullVideoPath?: string;
  variants: FactoryVariantSlot[];
};

/**
 * STEP 1 of plan→edit→generate. FAST: only reads the source DURATION (yt-dlp
 * metadata for a URL, or ffprobe for an uploaded file — no download) to decide
 * how many NV/VO shorts to make and resolve each slot's profile. Creates
 * nothing and calls no AI, so it returns in seconds.
 */
export async function planFactory(opts: FactoryOptions): Promise<FactoryPlan> {
  const batchId = `batch_${Date.now()}_${Math.round(opts.userId || 0)}`;
  const baseName = opts.projectName?.trim() || `Factory ${Date.now()}`;

  // 1. Duration ONLY — no download.
  let durationSec: number | null = null;
  if (opts.fullVideoPath && fs.existsSync(opts.fullVideoPath)) {
    durationSec = await getMediaDuration(opts.fullVideoPath);
  } else if (opts.fullVideoUrl?.trim()) {
    durationSec = await getRemoteDuration(opts.fullVideoUrl.trim());
  } else {
    throw new Error("Factory: a source video (URL or file) is required");
  }
  if (!durationSec || !isFinite(durationSec) || durationSec <= 0) {
    // Couldn't read duration (private video, metadata blocked) — assume the
    // largest rule bucket so we still make a sensible plan.
    durationSec = 9999;
    console.warn(`[factory ${batchId}] could not read duration — using fallback`);
  }

  // 2. Duration → rule → how many NV / VO, then resolve each slot's profile.
  const minutes = durationSec / 60;
  const { rules, nvProfiles, voProfiles } = await loadFactoryConfig();
  const rule = pickRule(rules, minutes);
  const nvCount = nvProfiles.length > 0 ? rule.nv : 0;
  const voCount = voProfiles.length > 0 ? rule.vo : 0;
  console.log(`[factory ${batchId}] plan: ${minutes.toFixed(1)}min → ${nvCount} NV + ${voCount} VO`);

  // Clone each profile so per-slot edits never mutate the shared profile object.
  const variants: FactoryVariantSlot[] = [];
  for (let i = 0; i < nvCount; i++) variants.push({ kind: "nv", index: i + 1, profile: { ...nvProfiles[i % nvProfiles.length] } });
  for (let i = 0; i < voCount; i++) variants.push({ kind: "vo", index: i + 1, profile: { ...voProfiles[i % voProfiles.length] } });

  return {
    batchId, userId: opts.userId, baseName,
    durationSec, detectedMood: "", sharedTitle: "", targetSeconds: opts.targetSeconds,
    isVerticalSource: !!opts.isVerticalSource, cropType: opts.cropType || "none",
    logoPath: opts.logoPath || null, bgMusicPath: opts.bgMusicPath || null,
    fullVideoUrl: opts.fullVideoUrl, fullVideoPath: opts.fullVideoPath, variants,
  };
}

/**
 * STEP 2 of the flow. Take a plan (with possibly user-edited variant slots) and
 * produce the shorts. Fire-and-forget; returns the batchId immediately.
 */
export function generateFromPlan(plan: FactoryPlan, editedVariants?: FactoryVariantSlot[]): { batchId: string } {
  const variants = (editedVariants && editedVariants.length) ? editedVariants : plan.variants;
  generateFromPlanBackground(plan, variants).catch((err) => {
    console.error(`[factory ${plan.batchId}] generate failed:`, err);
  });
  return { batchId: plan.batchId };
}

/**
 * Back-compat one-shot: plan + generate with no UI round-trip (used by the
 * legacy /api/automated-shorts-factory endpoint).
 */
export async function runFactory(opts: FactoryOptions): Promise<{ batchId: string }> {
  const plan = await planFactory(opts);
  return generateFromPlan(plan);
}

async function generateFromPlanBackground(plan: FactoryPlan, variants: FactoryVariantSlot[]) {
  const { batchId, baseName } = plan;
  const nvSlots = variants.filter((v) => v.kind === "nv");
  const voSlots = variants.filter((v) => v.kind === "vo");

  // One sequential SOURCE number for this whole run (shared by every variant).
  const sourceNumber = await nextSourceNumber();

  // A variant may carry its OWN saved logo (set via the bulk-logo bar in the
  // plan editor); otherwise fall back to the run-level logo.
  const resolveLogoPath = async (profile: VariantProfile): Promise<string | null> => {
    if (profile.logoAssetId) {
      try {
        const asset = await getLogoAssetById(profile.logoAssetId);
        if (asset?.filePath) return asset.filePath;
      } catch { /* fall through to run default */ }
    }
    return plan.logoPath || null;
  };

  // 1. Create ALL skeleton projects UPFRONT and BROADCAST them so the UI shows
  //    every task INSTANTLY (status "Downloading source…"). The download + AI
  //    run happen next; each card then advances through the live steps.
  const nvSkeletons: Array<{ id: number; profile: VariantProfile }> = [];
  for (const slot of nvSlots) {
    const profile = slot.profile;
    const proj = await storage.createProject({
      userId: plan.userId || null,
      name: `${baseName} — NV ${slot.index}`,
      projectType: PROJECT_TYPES.AUTOMATED_NO_VOICEOVER,
      status: "processing",
      currentStep: "uploading",
      progress: 5,
      logoPath: await resolveLogoPath(profile),
      logoPosition: profile.logoPosition,
      logoLayout: profile.logoLayout || null,
      captionStyle: profile.captionStyle,
      isVerticalSource: !!plan.isVerticalSource,
      cropType: plan.cropType || "none",
      hookEnabled: false,
      voiceoverDuration: plan.targetSeconds,
      variantConfig: buildVariantConfig(profile),
      batchId,
      sheetSourceNumber: sourceNumber,
      sheetVariantLabel: `no voiceover ${slot.index}`,
      originalVideoUrl: plan.fullVideoUrl || null,
      errorMessage: "Downloading source…",
    });
    broadcastProjectUpdate(proj);
    nvSkeletons.push({ id: proj.id, profile });
  }

  const voSkeletons: Array<{ id: number; profile: VariantProfile }> = [];
  for (const slot of voSlots) {
    const profile = slot.profile;
    const proj = await storage.createProject({
      userId: plan.userId || null,
      name: `${baseName} — VO ${slot.index}`,
      projectType: PROJECT_TYPES.AUTOMATED,
      status: "processing",
      currentStep: "uploading",
      progress: 5,
      logoPath: await resolveLogoPath(profile),
      logoPosition: profile.logoPosition,
      logoLayout: profile.logoLayout || null,
      captionStyle: profile.captionStyle,
      isVerticalSource: !!plan.isVerticalSource,
      cropType: plan.cropType || "none",
      hookEnabled: false,
      variantConfig: buildVariantConfig(profile),
      batchId,
      sheetSourceNumber: sourceNumber,
      sheetVariantLabel: `voiceover ${slot.index}`,
      originalVideoUrl: plan.fullVideoUrl || null,
      errorMessage: "Downloading source…",
    });
    broadcastProjectUpdate(proj);
    voSkeletons.push({ id: proj.id, profile });
  }

  const allSkeletonIds = [...nvSkeletons, ...voSkeletons].map((s) => s.id);
  const failAll = async (msg: string) => {
    for (const id of allSkeletonIds) {
      try { await storage.updateProject(id, { status: "failed", currentStep: "failed", errorMessage: msg }); } catch {}
    }
  };

  // 2. Download the source (full + 480p), shared by every variant. On failure,
  //    mark every card failed so the user sees it (no silent black box).
  let cutSourcePath = plan.cutSourcePath;
  let aiAnalysisVideoPath = plan.aiAnalysisVideoPath;
  try {
    if (!cutSourcePath || !aiAnalysisVideoPath) {
      if (plan.fullVideoPath && fs.existsSync(plan.fullVideoPath)) {
        cutSourcePath = plan.fullVideoPath;
        aiAnalysisVideoPath = plan.fullVideoPath;
      } else if (plan.fullVideoUrl?.trim()) {
        const best = await downloadBest(plan.fullVideoUrl.trim());
        cutSourcePath = best.filePath;
        const analysis = await downloadForAnalysis(plan.fullVideoUrl.trim(), 480);
        aiAnalysisVideoPath = analysis.filePath;
      } else {
        throw new Error("a source video (URL or file) is required");
      }
    }
  } catch (err: any) {
    console.error(`[factory ${batchId}] source download failed: ${err.message}`);
    await failAll(`Could not download source: ${err.message}`);
    return;
  }
  if (!cutSourcePath || !aiAnalysisVideoPath) { await failAll("Could not resolve source video"); return; }

  // Cards move past "Downloading…".
  for (const id of allSkeletonIds) {
    try { await storage.updateProject(id, { errorMessage: "Analyzing & preparing…" }); } catch {}
  }

  // 3. Shared mood (for music) + a DISTINCT viral hook per variant. Best-effort.
  let detectedMood = "epic";
  let sharedTitle = "";
  try {
    const r = await detectMoodAndTitle(aiAnalysisVideoPath, plan.userId);
    detectedMood = r.mood; sharedTitle = r.title;
  } catch (err: any) {
    console.warn(`[factory ${batchId}] mood/title failed: ${err.message}`);
  }
  const slotsNeedingHook = variants.filter((v) => !v.profile.hookText?.trim());
  if (slotsNeedingHook.length > 0) {
    try {
      const titles = await generateMultipleHookTitles(aiAnalysisVideoPath, slotsNeedingHook.length, plan.userId);
      slotsNeedingHook.forEach((v, i) => {
        const t = titles[i] || titles[titles.length - 1] || sharedTitle;
        if (t) v.profile.hookText = t;
      });
    } catch (err: any) {
      console.warn(`[factory ${batchId}] distinct hooks failed: ${err.message}`);
    }
  }

  // Per-variant music from the user's OWN Mood Music Library (no external API).
  //  - musicMood "none"      → silence for this variant
  //  - a manually-uploaded track (per run) wins over the library
  //  - musicMood "auto"      → use the AI-detected mood; else the forced mood
  //  - a random track is picked each call → variety across variants
  //  - empty library / no match → no background music
  const fetchMusic = async (profile: VariantProfile): Promise<{ path: string; attribution?: string }> => {
    if (profile.musicMood === "none") return { path: "", attribution: undefined };
    if (plan.bgMusicPath) return { path: plan.bgMusicPath, attribution: undefined };
    const mood = (profile.musicMood && profile.musicMood !== "auto") ? profile.musicMood : detectedMood;
    try {
      const song = await getRandomBgMusicByMood(mood);
      return { path: song?.filePath || "", attribution: undefined };
    } catch (err: any) {
      console.warn(`[factory ${batchId}] mood music lookup failed: ${err.message}`);
      return { path: "", attribution: undefined };
    }
  };

  // 2. NV: curate N distinct narratives, then finalize each skeleton + queue.
  if (nvSkeletons.length > 0) {
    try {
      // Gemini video calls flake intermittently ("Provider returned error" /
      // non-JSON). curateMultipleNarratives already retries internally; we add
      // ONE more outer retry after a longer pause to ride out a bad window.
      let narratives;
      try {
        narratives = await curateMultipleNarratives(aiAnalysisVideoPath, plan.targetSeconds, nvSkeletons.length, plan.userId);
      } catch (firstErr: any) {
        console.warn(`[factory ${batchId}] NV curation failed once (${firstErr.message}); retrying in 25s…`);
        await new Promise((r) => setTimeout(r, 25_000));
        narratives = await curateMultipleNarratives(aiAnalysisVideoPath, plan.targetSeconds, nvSkeletons.length, plan.userId);
      }
      for (let i = 0; i < nvSkeletons.length; i++) {
        const { id, profile } = nvSkeletons[i];
        try {
          const music = await fetchMusic(profile);
          await storage.updateProject(id, {
            sourceVideoPath: cutSourcePath,
            aiAnalysisVideoPath,
            currentStep: "video_curation",
            progress: 10,
            timecodes: (narratives[i] || narratives[0]) as any,
            bgMusicPath: music.path,
            hookTitle: profile.topCard ? (profile.hookText?.trim() || sharedTitle || null) : null,
            errorMessage: null,
            ...(music.attribution ? { musicAttribution: music.attribution } : {}),
          });
          queueNoVoiceoverPipeline(id);
        } catch (err: any) {
          await storage.updateProject(id, { status: "failed", errorMessage: err.message || "NV variant failed" });
        }
      }
    } catch (err: any) {
      console.error(`[factory ${batchId}] NV curation failed:`, err.message);
      for (const { id } of nvSkeletons) {
        await storage.updateProject(id, { status: "failed", errorMessage: `Could not select moments: ${err.message}` });
      }
    }
  }

  // 3. VO: run each pre-created skeleton (original script+TTS+montage pipeline),
  //    sequentially so each variant can AVOID the previous one's script.
  let priorVoScript: string | undefined;
  for (let i = 0; i < voSkeletons.length; i++) {
    const { id, profile } = voSkeletons[i];
    try {
      const music = await fetchMusic(profile);
      await storage.updateProject(id, {
        bgMusicPath: music.path,
        hookTitle: profile.topCard ? (profile.hookText?.trim() || sharedTitle || null) : null,
        currentStep: "uploading",
        errorMessage: null,
        ...(music.attribution ? { musicAttribution: music.attribution } : {}),
      });
      const captured = priorVoScript;
      // runAutomatedShortBackgroundForExisting awaits through script+TTS, so
      // onScriptGenerated has fired by the time it returns.
      await runAutomatedShortBackgroundForExisting(id, {
        userId: plan.userId,
        fullVideoPath: cutSourcePath,
        shortVideoPath: aiAnalysisVideoPath,
        bgMusicPath: music.path,
        logoPath: plan.logoPath || null,
        targetSeconds: plan.targetSeconds,
        videoType: "raw",
        captionStyle: profile.captionStyle,
        isVerticalSource: !!plan.isVerticalSource,
        cropType: plan.cropType || "none",
        avoidPriorScript: captured,
        onScriptGenerated: (s: string) => { priorVoScript = s; },
      });
    } catch (err: any) {
      console.error(`[factory ${batchId}] VO ${i + 1} failed:`, err.message);
      try { await storage.updateProject(id, { status: "failed", errorMessage: err.message || "VO variant failed" }); } catch {}
    }
  }
}
