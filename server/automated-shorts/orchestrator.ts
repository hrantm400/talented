import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import { storage } from "../storage";
import { downloadBest, downloadForAnalysis } from "../downloader/ytDlp";
import { generateViralVoiceoverScript, type VideoType } from "../voiceover-script/openrouter";
import { generateVoiceover } from "../elevenlabs/voiceover";
import { queuePipeline } from "../pipeline/processor";
import { findHookMoment } from "../pipeline/gemini";
import { getMediaDuration } from "../pipeline/ffmpeg";
import { PROJECT_TYPES } from "@shared/schema";

function getIsVertical(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error("FFprobe error determining aspect ratio:", err);
        return resolve(false); // default horizontal
      }
      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
      if (videoStream && videoStream.width && videoStream.height) {
        let w = videoStream.width;
        let h = videoStream.height;
        const rotate = 
          videoStream.tags?.rotate || 
          videoStream.tags?.ROTATE || 
          metadata.format?.tags?.rotate || 
          metadata.format?.tags?.ROTATE;
          
        if (rotate && (rotate === '90' || rotate === '270' || rotate === '-90')) {
           w = videoStream.height;
           h = videoStream.width;
        }
        resolve(w <= h);
      } else {
        resolve(false);
      }
    });
  });
}

export type RunAutomatedShortOptions = {
  userId?: number | null;
  fullVideoUrl?: string;
  fullVideoPath?: string;
  shortVideoUrl?: string;
  shortVideoPath?: string;
  bgMusicPath?: string;
  logoPath?: string | null;
  targetSeconds: number;
  videoType: VideoType;
  projectName?: string;
  /**
   * When true, background music is auto-selected from Jamendo (commercial-safe
   * CC-BY) by mood instead of using a user-supplied track. bgMusicPath may be
   * empty in that case.
   */
  autoMusic?: boolean;
  /** Mood tag used for the Jamendo search (e.g. "epic", "emotional"). */
  autoMusicMood?: string;
  /** Resolved visual logo placement for this project (Take 1 or Take 2 default). */
  logoLayout?: import("@shared/schema").LogoLayout | null;
  // ── Factory extras (VO variant) ──
  /** Groups this output with the rest of a factory run. */
  batchId?: string;
  /** Per-variant render config (mirror/noise/top card/outro). */
  variantConfig?: import("@shared/schema").VariantConfig | null;
  /** Logo corner (top-left / top-right). */
  logoPosition?: "top-left" | "top-right";
  /** Pre-generated headline for the top card (skips a Gemini call). */
  hookTitle?: string;
  /** Google-Sheets ordering: source number (shared by takes) + variant label. */
  sheetSourceNumber?: number;
  sheetVariantLabel?: string;
  isVerticalSource?: boolean;
  cropType?: string;
  hookEnabled?: boolean;
  captionStyle?: string;
  voiceId?: string;
  /**
   * If set, this is a 2nd take from the same source as a previous run. The
   * supplied script is fed to the LLM as "avoid this angle" so the resulting
   * voiceover (and therefore the curated highlights) are unique.
   */
  avoidPriorScript?: string;
  /**
   * Resolves with the generated voiceover script once the orchestrator has it.
   * The caller (route) uses this to chain a 2nd take.
   */
  onScriptGenerated?: (script: string) => void;
  /**
   * Resolves with the downloaded video paths once the orchestrator finishes
   * downloading from URLs. Used by Take 2 to skip the redundant download —
   * yt-dlp downloads the same source file once, both takes share it.
   */
  onSourcesReady?: (paths: { cutSourcePath: string; aiAnalysisVideoPath: string; scriptSourcePath: string }) => void;
  /**
   * Called when Take 1's background init throws. Take 2 listens on this so
   * its `Promise.all([firstScriptReady, firstSourcesReady])` rejects
   * instead of hanging forever (the root cause of "Waiting for Take 1…"
   * tasks getting stuck after a Take 1 failure).
   */
  onError?: (err: Error) => void;
};

export type RunAutomatedShortResult = {
  project: { id: number; name: string };
  fullVideoPublicPath?: string;
};

export async function runAutomatedShort(
  options: RunAutomatedShortOptions
): Promise<RunAutomatedShortResult> {
  const {
    fullVideoUrl,
    shortVideoUrl,
    bgMusicPath,
    logoPath,
    projectName,
    isVerticalSource: manualIsVerticalSource = false,
    cropType = "none",
    captionStyle = "capcut_green",
  } = options;

  const name = projectName || `Automated Short ${Date.now()}`;

  // 1. Instantly create the skeleton project so the UI can show it immediately
  const project = await storage.createProject({
    userId: options.userId || null,
    name,
    projectType: PROJECT_TYPES.AUTOMATED,
    status: "processing",
    currentStep: "uploading",
    progress: 5,
    bgMusicPath,
    logoPath: logoPath || null,
    logoPosition: options.logoPosition || "top-right",
    captionStyle,
    isVerticalSource: manualIsVerticalSource,
    cropType,
    hookEnabled: !!options.hookEnabled,
    originalVideoUrl: fullVideoUrl?.trim() || shortVideoUrl?.trim() || null,
    shortVideoUrl: shortVideoUrl?.trim() || null,
    ...(options.batchId ? { batchId: options.batchId } : {}),
    ...(options.variantConfig ? { variantConfig: options.variantConfig } : {}),
    ...(options.hookTitle ? { hookTitle: options.hookTitle } : {}),
    ...(options.sheetSourceNumber != null ? { sheetSourceNumber: options.sheetSourceNumber } : {}),
    ...(options.sheetVariantLabel ? { sheetVariantLabel: options.sheetVariantLabel } : {}),
  });

  // 2. Spawn the heavy asynchronous tasks in the background
  runAutomatedShortBackground(project.id, options).catch(async (err) => {
    console.error(`[Project ${project.id}] Failed during background init:`, err);
    await storage.updateProject(project.id, {
      status: "failed",
      errorMessage: err.message || "Failed initializing downloads/scripts",
    });
    // Unstick any downstream Take 2 waiting on this run's Promises.
    if (options.onError) {
      try { options.onError(err); } catch (cbErr) {
        console.error(`[Project ${project.id}] onError callback threw:`, cbErr);
      }
    }
  });

  return {
    project: { id: project.id, name: project.name },
  };
}

/**
 * Public entry point used when a project skeleton has already been created
 * (e.g. Take 2 of a 2-takes pair, where the route created the row up-front so
 * the UI can show it immediately).
 */
export async function runAutomatedShortBackgroundForExisting(
  projectId: number,
  options: RunAutomatedShortOptions
) {
  return runAutomatedShortBackground(projectId, options);
}

// Heavy lifting function that runs totally decoupled from the HTTP response.
// Resumable: on retry, any artifact already saved on the project row (and
// still present on disk) is reused instead of being regenerated.
async function runAutomatedShortBackground(projectId: number, options: RunAutomatedShortOptions) {
  const {
    fullVideoUrl,
    fullVideoPath,
    shortVideoUrl,
    shortVideoPath,
    targetSeconds,
    videoType,
    isVerticalSource: manualIsVerticalSource = false,
    voiceId,
  } = options;

  // Resume support: load any existing artifacts from the project row.
  const existing = await storage.getProject(projectId);
  const hasOnDisk = (p?: string | null): p is string => !!p && fs.existsSync(p);

  let cutSourcePath: string | undefined = hasOnDisk(existing?.sourceVideoPath) ? existing!.sourceVideoPath! : undefined;
  let aiAnalysisVideoPath: string | undefined = hasOnDisk(existing?.aiAnalysisVideoPath) ? existing!.aiAnalysisVideoPath! : undefined;
  let scriptSourcePath: string | undefined;

  // 1. Process fullVideo FIRST (skip if already on disk)
  if (cutSourcePath && aiAnalysisVideoPath) {
    console.log(`[Project ${projectId}] Resume: reusing existing source video paths`);
  } else if (fullVideoPath && fs.existsSync(fullVideoPath)) {
    cutSourcePath = fullVideoPath;
    aiAnalysisVideoPath = fullVideoPath; // no lower res downloaded for direct upload
  } else if (fullVideoUrl?.trim()) {
    try {
      const best = await downloadBest(fullVideoUrl.trim());
      cutSourcePath = best.filePath;

      const analysis = await downloadForAnalysis(fullVideoUrl.trim(), 480);
      aiAnalysisVideoPath = analysis.filePath;
    } catch (e: any) {
      throw new Error(`Failed to download full video URL: ${e.message}`);
    }
  } else {
    throw new Error("Full video URL or path is required for the final cut");
  }

  // 2. Process shortVideo (for Script Generation)
  if (shortVideoPath && fs.existsSync(shortVideoPath)) {
    scriptSourcePath = shortVideoPath;
  } else if (shortVideoUrl?.trim()) {
    try {
      const analysis = await downloadForAnalysis(shortVideoUrl.trim(), 480);
      scriptSourcePath = analysis.filePath;
    } catch (e: any) {
      console.warn(`Failed to download short video from ${shortVideoUrl}, falling back to fullVideo low-res:`, e.message);
      scriptSourcePath = aiAnalysisVideoPath;
    }
  } else {
    scriptSourcePath = aiAnalysisVideoPath;
  }

  if (!scriptSourcePath) {
    throw new Error("Failed to resolve a video source for script generation");
  }

  // Notify the caller (route) that downloads are done — Take 2 reuses these
  // paths instead of re-downloading the same source video from URL.
  if (options.onSourcesReady) {
    try {
      options.onSourcesReady({
        cutSourcePath,
        aiAnalysisVideoPath: aiAnalysisVideoPath || cutSourcePath,
        scriptSourcePath,
      });
    } catch (err) {
      console.error(`[Project ${projectId}] onSourcesReady callback threw:`, err);
    }
  }

  const isVerticalSource = manualIsVerticalSource || await getIsVertical(cutSourcePath);

  // 3. Voiceover: skip generation entirely if we already have an audio file
  let voiceoverPath: string | undefined = hasOnDisk(existing?.voiceoverPath) ? existing!.voiceoverPath! : undefined;
  if (voiceoverPath) {
    console.log(`[Project ${projectId}] Resume: reusing existing voiceover at ${voiceoverPath}`);
    // Still need to notify the Take 2 chain about the script — but we don't
    // store the script text anywhere. Best we can do: skip the callback. Take
    // 2 will simply generate without the avoidPriorScript hint, which is
    // acceptable for a recovery flow.
  } else {
    console.log(
      `[automated-shorts][project ${projectId}] generating script ` +
        `(avoidPriorScript=${!!options.avoidPriorScript}, twoTakesPair=${options.onScriptGenerated ? "TAKE_1" : options.avoidPriorScript ? "TAKE_2" : "single"})`
    );
    const script = await generateViralVoiceoverScript(
      scriptSourcePath,
      targetSeconds,
      videoType,
      options.userId,
      options.avoidPriorScript
    );
    if (options.onScriptGenerated) {
      console.log(`[automated-shorts][project ${projectId}] notifying Take 2 (script length=${script.length})`);
      try { options.onScriptGenerated(script); } catch (err) {
        console.error(`[automated-shorts][project ${projectId}] onScriptGenerated callback threw:`, err);
      }
    }
    const tts = await generateVoiceover(script, voiceId, options.userId);
    voiceoverPath = tts.audioPath;
  }

  // 4. Hook detection (skip if already saved)
  let hookTimecode: { start: string; end: string } | null =
    (existing?.hookTimecode as { start: string; end: string } | null) || null;
  if (!hookTimecode && options.hookEnabled && cutSourcePath) {
    try {
      const videoDuration = await getMediaDuration(cutSourcePath);
      hookTimecode = await findHookMoment(
        aiAnalysisVideoPath || cutSourcePath,
        videoDuration,
        options.userId
      );
      console.log(`[Project ${projectId}] Hook found: ${hookTimecode.start} → ${hookTimecode.end}`);
    } catch (err: any) {
      console.warn(`[Project ${projectId}] Hook detection failed, continuing without hook:`, err.message);
    }
  } else if (hookTimecode) {
    console.log(`[Project ${projectId}] Resume: reusing existing hookTimecode`);
  }

  // 5. Update the initially created project with heavy assets
  await storage.updateProject(projectId, {
    sourceVideoPath: cutSourcePath,
    aiAnalysisVideoPath,
    voiceoverPath,
    isVerticalSource,
    ...(hookTimecode ? { hookTimecode: hookTimecode as any } : {}),
  });

  // 6. Send to the FFmpeg queue (which itself resumes mid-pipeline)
  queuePipeline(projectId);
}
