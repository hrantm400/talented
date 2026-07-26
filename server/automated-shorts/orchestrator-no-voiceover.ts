// ─────────────────────────────────────────────────────────────────────────
// "Automated Shorts — No Voiceover" orchestrator.
//
// This is a standalone copy of ./orchestrator.ts so the No-Voiceover variant
// can be modified independently (e.g. dropping TTS/script generation) without
// touching the original Automated Shorts flow. For now it behaves identically
// to the original; the only difference is the project type it stamps
// (AUTOMATED_NO_VOICEOVER) so the two features keep separate task lists.
// ─────────────────────────────────────────────────────────────────────────
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import { storage } from "../storage";
import { downloadBest, downloadForAnalysis } from "../downloader/ytDlp";
import { queueNoVoiceoverPipeline } from "./pipeline-no-voiceover";
import { detectMoodAndTitle } from "../pipeline/gemini";
import { fetchRandomMusic } from "../music/jamendo";
import { PROJECT_TYPES } from "@shared/schema";
import type {
  RunAutomatedShortOptions,
  RunAutomatedShortResult,
} from "./orchestrator";

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

export async function runAutomatedShortNV(
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

  const name = projectName || `Automated Short (No VO) ${Date.now()}`;

  // 1. Instantly create the skeleton project so the UI can show it immediately
  const project = await storage.createProject({
    userId: options.userId || null,
    name,
    projectType: PROJECT_TYPES.AUTOMATED_NO_VOICEOVER,
    status: "processing",
    currentStep: "uploading",
    progress: 5,
    bgMusicPath,
    logoPath: logoPath || null,
    captionStyle,
    isVerticalSource: manualIsVerticalSource,
    cropType,
    hookEnabled: !!options.hookEnabled,
    originalVideoUrl: fullVideoUrl?.trim() || shortVideoUrl?.trim() || null,
    shortVideoUrl: shortVideoUrl?.trim() || null,
    logoLayout: options.logoLayout ?? null,
    ...(options.sheetSourceNumber != null ? { sheetSourceNumber: options.sheetSourceNumber } : {}),
    ...(options.sheetVariantLabel ? { sheetVariantLabel: options.sheetVariantLabel } : {}),
  });

  // 2. Spawn the heavy asynchronous tasks in the background
  runAutomatedShortBackgroundNV(project.id, options).catch(async (err) => {
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
export async function runAutomatedShortBackgroundForExistingNV(
  projectId: number,
  options: RunAutomatedShortOptions
) {
  return runAutomatedShortBackgroundNV(projectId, options);
}

// Heavy lifting function that runs totally decoupled from the HTTP response.
// Resumable: on retry, any artifact already saved on the project row (and
// still present on disk) is reused instead of being regenerated.
async function runAutomatedShortBackgroundNV(projectId: number, options: RunAutomatedShortOptions) {
  const {
    fullVideoUrl,
    fullVideoPath,
    shortVideoUrl,
    shortVideoPath,
    isVerticalSource: manualIsVerticalSource = false,
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

  // 3. NO VOICEOVER: there is no script/TTS and no hook in this variant. The
  //    dedicated NV pipeline cuts a SETUP+EPIC narrative from the full video
  //    and uses the clips' real audio for both the soundtrack and the captions.
  //    Unblock any Take 2 waiting on Take 1's "script" promise (no script here).
  if (options.onScriptGenerated) {
    try { options.onScriptGenerated(""); } catch (err) {
      console.error(`[automated-shorts-nv][project ${projectId}] onScriptGenerated callback threw:`, err);
    }
  }

  // 4b. ONE combined Gemini call → { mood, title }. Saves sending the video a
  //     second time: mood feeds the Jamendo search (auto mode) and title is
  //     stored for the pipeline's top hook card. Only call when something is
  //     actually needed (title not yet stored, or auto-mood music required).
  let bgMusicPath: string | undefined = hasOnDisk(existing?.bgMusicPath) ? existing!.bgMusicPath! : undefined;
  let musicAttribution: string | undefined = existing?.musicAttribution || undefined;
  let hookTitle: string | undefined = existing?.hookTitle || undefined;

  const needAutoMood =
    options.autoMusic && !bgMusicPath && (options.autoMusicMood || "auto") === "auto";
  const needTitle = !hookTitle;

  let detectedMood: string | undefined;
  if (needAutoMood || needTitle) {
    const r = await detectMoodAndTitle(aiAnalysisVideoPath || cutSourcePath, options.userId);
    detectedMood = r.mood;
    if (!hookTitle && r.title) hookTitle = r.title;
  }

  // Auto music (Jamendo) — when enabled and no track is set yet.
  if (options.autoMusic && !bgMusicPath) {
    try {
      let mood = options.autoMusicMood || "auto";
      if (mood === "auto") mood = detectedMood || "epic";
      console.log(`[automated-shorts-nv][project ${projectId}] fetching Jamendo music (mood=${mood})`);
      const track = await fetchRandomMusic(mood);
      bgMusicPath = track.filePath;
      musicAttribution = track.attribution;
      console.log(`[automated-shorts-nv][project ${projectId}] music: ${track.trackName} by ${track.artistName}`);
    } catch (err: any) {
      console.error(`[automated-shorts-nv][project ${projectId}] Jamendo fetch failed: ${err.message}`);
      bgMusicPath = bgMusicPath || options.bgMusicPath;
    }
  } else if (!bgMusicPath) {
    bgMusicPath = options.bgMusicPath;
  }

  // 5. Update the project with heavy assets. voiceoverDuration carries the
  //    TARGET length into the NV pipeline (it later overwrites it with the
  //    actual rendered duration).
  await storage.updateProject(projectId, {
    sourceVideoPath: cutSourcePath,
    aiAnalysisVideoPath,
    bgMusicPath,
    isVerticalSource,
    voiceoverDuration: existing?.voiceoverDuration || options.targetSeconds || 25,
    ...(musicAttribution ? { musicAttribution } : {}),
    ...(hookTitle ? { hookTitle } : {}),
  });

  // 6. Run the dedicated No-Voiceover pipeline (narrative cut → real audio →
  //    captions → sandwich → animated outro).
  queueNoVoiceoverPipeline(projectId);
}
