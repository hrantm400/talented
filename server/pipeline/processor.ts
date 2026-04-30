import { storage } from "../storage";
import { transcribeAudio, curateVideoSegments, findHookMoment } from "./gemini";
import {
  mixAudio,
  extractVideoSegments,
  concatVideoSegments,
  createSandwichVideo,
  generateASS,
  getMediaDuration,
  extractHookSegment,
  mixAudioWithHook,
} from "./ffmpeg";
import path from "path";
import fs from "fs";
import { broadcastProjectUpdate } from "../websocket";
import { appendVideoRow } from "../google-sheets/append";
import { PROJECT_TYPES } from "@shared/schema";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const OUTPUT_DIR = path.join(process.cwd(), "outputs");
const VIDEO_SOURCE_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v",
]);

export function ensureDirectories() {
  [UPLOAD_DIR, OUTPUT_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

async function updateProject(
  id: number,
  step: string,
  progress: number,
  extra: Record<string, any> = {}
) {
  const updatedProject = await storage.updateProject(id, {
    currentStep: step,
    progress,
    status: step === "failed" ? "failed" : step === "complete" ? "complete" : "processing",
    ...extra,
  });

  if (updatedProject) {
    broadcastProjectUpdate(updatedProject);

    // Telegram notification on complete/failed
    if ((step === "complete" || step === "failed") && updatedProject.userId) {
      import("../telegram/bot").then((mod) => {
        mod.notifyProjectComplete(
          updatedProject.userId!,
          updatedProject.name,
          updatedProject.id,
          step as "complete" | "failed",
          updatedProject.errorMessage || undefined
        );
      }).catch(() => {});
    }

    if (step === "complete" && updatedProject.projectType === PROJECT_TYPES.AUTOMATED) {
      const baseUrl = process.env.APP_PUBLIC_URL || process.env.BASE_URL || "";
      if (baseUrl) {
        if (updatedProject.userId) {
          import("../auth").then((mod) => {
            mod.getUserById(updatedProject.userId!).then((user) => {
              void appendVideoRow(updatedProject, baseUrl, user);
            }).catch((err) => {
              console.error("[pipeline] Error fetching user for google sheets:", err);
              void appendVideoRow(updatedProject, baseUrl);
            });
          }).catch((err) => {
             console.error("[pipeline] Error loading auth module:", err);
             void appendVideoRow(updatedProject, baseUrl);
          });
        } else {
          void appendVideoRow(updatedProject, baseUrl);
        }
      }
    }
  }
}

import { extractHighlights } from "./gemini";
import { autoDucking, smartCropVideo, autoColorGrade, isolateVocal, motionTrackOverlay } from "./ffmpeg";
import pLimit from "p-limit";

// Restrict concurrent heavy FFmpeg pipelines to prevent CPU/RAM exhaustion
const pipelineLimit = pLimit(2);

// Keep track of temp files to delete on success/failure
function cleanupTempFiles(tempFiles: string[]) {
  for (const file of tempFiles) {
    try {
      if (fs.existsSync(file)) {
        if (fs.lstatSync(file).isDirectory()) {
          fs.rmSync(file, { recursive: true, force: true });
        } else {
          fs.unlinkSync(file);
        }
      }
    } catch (e) {
      console.error(`Failed to cleanup temp file ${file}:`, e);
    }
  }
}

export function queuePipeline(projectId: number) {
  pipelineLimit(() => runPipeline(projectId)).catch((err) => {
    console.error(`Unhandled pipeline queue error for project ${projectId}:`, err);
  });
}

export async function runPipeline(projectId: number): Promise<void> {
  const project = await storage.getProject(projectId);
  if (!project) throw new Error("Project not found");

  const projectDir = path.join(OUTPUT_DIR, `project_${projectId}`);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  try {
    switch (project.projectType) {
      case PROJECT_TYPES.DUCKING:
        await processDuckingPipeline(project, projectDir);
        return;
      case PROJECT_TYPES.CROP:
        await processCropPipeline(project, projectDir);
        return;
      case PROJECT_TYPES.HIGHLIGHTS:
        await processHighlightsPipeline(project, projectDir);
        return;
      case PROJECT_TYPES.COLOR:
        await processColorPipeline(project, projectDir);
        return;
      case PROJECT_TYPES.ISOLATE:
        await processIsolatePipeline(project, projectDir);
        return;
      case PROJECT_TYPES.MOTION_TRACK:
        await processMotionTrackPipeline(project, projectDir);
        return;
      case PROJECT_TYPES.COMBO_VIRAL:
        await processViralCombo(project, projectDir);
        return;
      case PROJECT_TYPES.COMBO_PODCAST:
        await processPodcastCombo(project, projectDir);
        return;
      case PROJECT_TYPES.COMBO_ACTION:
        await processActionCombo(project, projectDir);
        return;
      case PROJECT_TYPES.COMBO_CINEMATIC:
        await processCinematicCombo(project, projectDir);
        return;
      case PROJECT_TYPES.COMBO_MEME:
        await processMemeCombo(project, projectDir);
        return;
    }

    // Classic Sandwich Pipeline
    const startTime = Date.now();
    console.log(`[pipeline] Starting Classic Pipeline for project ${projectId}`);

    await updateProject(projectId, "transcription", 10);

    const transcribeStart = Date.now();
    const transcription = await transcribeAudio(project.voiceoverPath!);
    const voiceoverDuration = transcription.duration;
    console.log(`[pipeline] Transcription took ${((Date.now() - transcribeStart)/1000).toFixed(1)}s`);

    await updateProject(projectId, "transcription", 25, {
      voiceoverDuration: Math.round(voiceoverDuration),
      transcription: transcription.words as any,
    });

    // --- HOOK INTRO ---
    let hookSegmentPath: string | undefined;
    let hookDuration = 0;
    let hookTimecode = project.hookTimecode as { start: string; end: string } | null;

    if (project.hookEnabled) {
      if (!hookTimecode) {
        try {
          await updateProject(projectId, "video_curation", 26, {
            errorMessage: "AI is analyzing the video to find the best hook..."
          });
          const findHookStart = Date.now();
          const videoDuration = await getMediaDuration(project.sourceVideoPath!);
          hookTimecode = await findHookMoment(
            project.aiAnalysisVideoPath || project.sourceVideoPath!,
            videoDuration,
            project.userId
          );
          console.log(`[pipeline] Hook discovery took ${((Date.now() - findHookStart)/1000).toFixed(1)}s`);
          await updateProject(projectId, "video_curation", 27, { errorMessage: null });
          await storage.updateProject(projectId, { hookTimecode: hookTimecode as any });
        } catch (err: any) {
          console.warn(`[pipeline] Hook detection failed:`, err.message);
          await updateProject(projectId, "video_curation", 27, { errorMessage: null });
        }
      }

      if (hookTimecode) {
        await updateProject(projectId, "video_curation", 28);
        hookSegmentPath = path.join(projectDir, "hook_segment.mp4");
        const extractHookStart = Date.now();
        await extractHookSegment(
          project.sourceVideoPath!,
          hookTimecode.start,
          hookTimecode.end,
          hookSegmentPath
        );
        hookDuration = await getMediaDuration(hookSegmentPath);
        console.log(`[pipeline] Hook extraction took ${((Date.now() - extractHookStart)/1000).toFixed(1)}s`);
      }
    }

    await updateProject(projectId, "video_curation", 30);

    const curationStart = Date.now();
    const timecodes = await curateVideoSegments(
      project.aiAnalysisVideoPath || project.sourceVideoPath!,
      transcription.words,
      voiceoverDuration,
      project.userId
    );
    console.log(`[pipeline] Video curation (Gemini) took ${((Date.now() - curationStart)/1000).toFixed(1)}s`);

    await updateProject(projectId, "video_curation", 45, {
      timecodes: timecodes as any,
    });

    await updateProject(projectId, "audio_mixing", 50);

    const mixedAudioPath = path.join(projectDir, "mixed_audio.wav");
    const mixingStart = Date.now();

    if (hookSegmentPath && hookDuration > 0) {
      await mixAudioWithHook(
        hookSegmentPath,
        project.voiceoverPath!,
        project.bgMusicPath!,
        mixedAudioPath,
        hookDuration,
        voiceoverDuration
      );
    } else {
      await mixAudio(
        project.sourceVideoPath!,
        project.voiceoverPath!,
        project.bgMusicPath!,
        mixedAudioPath,
        voiceoverDuration
      );
    }
    console.log(`[pipeline] Audio mixing took ${((Date.now() - mixingStart)/1000).toFixed(1)}s`);

    await updateProject(projectId, "audio_mixing", 60, { mixedAudioPath });

    await updateProject(projectId, "video_composition", 65);

    const segmentsDir = path.join(projectDir, "segments");
    if (!fs.existsSync(segmentsDir)) {
      fs.mkdirSync(segmentsDir, { recursive: true });
    }

    const extractSegmentsStart = Date.now();
    const segmentPaths = await extractVideoSegments(
      project.sourceVideoPath!,
      timecodes,
      segmentsDir
    );
    console.log(`[pipeline] Segment extraction took ${((Date.now() - extractSegmentsStart)/1000).toFixed(1)}s`);

    await updateProject(projectId, "video_composition", 70);

    const captionStyleId = project.captionStyle || "capcut_green";

    // Build subtitles: hook transcription (0 → hookDuration) + voiceover (hookDuration → end)
    let assContent: string;
    if (hookSegmentPath && hookDuration > 0) {
      // Transcribe hook audio for subtitles
      const hookTranscription = await transcribeAudio(hookSegmentPath);
      const hookASS = generateASS(hookTranscription.words, captionStyleId, 0);
      const voiceoverASS = generateASS(transcription.words, captionStyleId, hookDuration);

      // Merge: take header from hookASS, combine events from both
      const hookEvents = hookASS.split("\n").filter(l => l.startsWith("Dialogue:"));
      const voiceoverEvents = voiceoverASS.split("\n").filter(l => l.startsWith("Dialogue:"));
      const headerEnd = hookASS.indexOf("Dialogue:");
      const header = headerEnd > 0 ? hookASS.substring(0, headerEnd) : hookASS.split("\n").slice(0, -1).join("\n") + "\n";
      assContent = header + [...hookEvents, ...voiceoverEvents].join("\n") + "\n";
    } else {
      assContent = generateASS(transcription.words, captionStyleId);
    }

    const subtitlePath = path.join(projectDir, "subtitles.ass");
    fs.writeFileSync(subtitlePath, assContent);

    const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
    const clearVideoPath = path.join(projectDir, `${safeName}_clear.mp4`);
    const captionVideoPath = path.join(projectDir, `${safeName}_caption.mp4`);

    await updateProject(projectId, "subtitle_overlay", 75);

    // If hook is enabled, prepend hook segment to the sandwich segments
    const finalSegmentPaths = hookSegmentPath && hookDuration > 0
      ? [hookSegmentPath, ...segmentPaths]
      : segmentPaths;

    const totalDuration = hookDuration + voiceoverDuration;

    const sandwichStart = Date.now();
    await createSandwichVideo(
      finalSegmentPaths,
      mixedAudioPath,
      project.logoPath,
      clearVideoPath,
      captionVideoPath,
      subtitlePath,
      totalDuration,
      project.isVerticalSource,
      project.cropType
    );
    console.log(`[pipeline] Sandwich creation (rendering) took ${((Date.now() - sandwichStart)/1000).toFixed(1)}s`);

    await updateProject(projectId, "exporting", 90, {
      clearVideoPath,
      captionVideoPath,
    });

    console.log(`[pipeline] Project ${projectId} COMPLETE in ${((Date.now() - startTime)/1000).toFixed(1)}s`);
    await updateProject(projectId, "complete", 100, {
      clearVideoPath,
      captionVideoPath,
    });
  } catch (error: any) {
    console.error(`Pipeline failed for project ${projectId}:`, error);
    await updateProject(projectId, "failed", 0, {
      errorMessage: error.message || "Pipeline processing failed",
    });
  }
}

// Wraps pipeline execution to catch specific inner step errors nicely
async function safeExecuteStep(projectId: number, stepName: string, execution: () => Promise<void>) {
  try {
    await execution();
  } catch (err: any) {
    console.error(`[Project ${projectId}] Error at step ${stepName}:`, err);
    throw new Error(`Failed during ${stepName}: ${err.message}`);
  }
}

async function processDuckingPipeline(project: any, projectDir: string) {
  await updateProject(project.id, "audio_mixing", 20);

  const transcription = await transcribeAudio(project.voiceoverPath!);
  const voiceoverDuration = transcription.duration;

  await updateProject(project.id, "audio_mixing", 50);

  const mixedAudioPath = path.join(projectDir, "mixed_audio.wav");
  await autoDucking(
    project.voiceoverPath!,
    project.bgMusicPath!,
    mixedAudioPath,
    voiceoverDuration
  );

  await updateProject(project.id, "complete", 100, {
    mixedAudioPath,
    clearVideoPath: mixedAudioPath, // Allow download through existing clear video route
  });
}

async function processCropPipeline(project: any, projectDir: string) {
  await updateProject(project.id, "video_curation", 30);

  const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
  const clearVideoPath = path.join(projectDir, `${safeName}_crop.mp4`);
  const duration = await getMediaDuration(project.sourceVideoPath!);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Failed to determine source video duration for Smart Crop.");
  }

  await updateProject(project.id, "video_composition", 60);

  await smartCropVideo(
    project.sourceVideoPath!,
    clearVideoPath,
    duration
  );

  await updateProject(project.id, "complete", 100, {
    clearVideoPath,
    captionVideoPath: clearVideoPath // Both point to the same file for now
  });
}

async function processHighlightsPipeline(project: any, projectDir: string) {
  await updateProject(project.id, "transcription", 20);
  const transcription = await transcribeAudio(project.sourceVideoPath!);

  await updateProject(project.id, "video_curation", 50, {
    transcription: transcription.words as any,
  });

  const timecodes = await extractHighlights(
    project.aiAnalysisVideoPath || project.sourceVideoPath!,
    transcription.text,
    transcription.duration,
    project.userId
  );

  await updateProject(project.id, "video_composition", 70, {
    timecodes: timecodes as any,
  });

  const segmentsDir = path.join(projectDir, "segments");
  if (!fs.existsSync(segmentsDir)) {
    fs.mkdirSync(segmentsDir, { recursive: true });
  }

  const segmentPaths = await extractVideoSegments(
    project.sourceVideoPath!,
    timecodes,
    segmentsDir
  );
  const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
  const clearVideoPath = path.join(projectDir, `${safeName}_highlights.mp4`);

  await concatVideoSegments(segmentPaths, clearVideoPath);

  await updateProject(project.id, "complete", 100, {
    clearVideoPath,
    captionVideoPath: clearVideoPath
  });
}

// --- COMBO PIPELINES ---


async function processViralCombo(project: any, projectDir: string) {
  const tempFiles: string[] = [];
  try {
    await updateProject(project.id, "transcription", 10);
    const transcription = await transcribeAudio(project.sourceVideoPath!);

    await updateProject(project.id, "video_curation", 30);
    const timecodes = await extractHighlights(project.aiAnalysisVideoPath || project.sourceVideoPath!, transcription.text, transcription.duration, project.userId);
    const segmentsDir = path.join(projectDir, "segments");
    if (!fs.existsSync(segmentsDir)) fs.mkdirSync(segmentsDir, { recursive: true });

    let segmentPaths: string[] = [];
    await safeExecuteStep(project.id, "extract_segments", async () => {
      segmentPaths = await extractVideoSegments(project.sourceVideoPath!, timecodes, segmentsDir);
    });
    const highlightVideo = path.join(projectDir, "highlight_source.mp4");
    await safeExecuteStep(project.id, "concat_segments", async () => {
      await concatVideoSegments(segmentPaths, highlightVideo);
    });

    // Real duration of the highlights so smart-crop and sandwich aren't trimmed to a fixed 15s.
    const highlightDuration = await getMediaDuration(highlightVideo);

    await updateProject(project.id, "video_composition", 50);
    const croppedVideo = path.join(projectDir, `cropped.mp4`);
    await safeExecuteStep(project.id, "smart_crop", async () => {
      await smartCropVideo(highlightVideo, croppedVideo, 0); // 0 = keep full duration
    });

    await updateProject(project.id, "subtitle_overlay", 70);
    const coloredVideo = path.join(projectDir, `colored.mp4`);
    await safeExecuteStep(project.id, "color_grade", async () => {
      await autoColorGrade(croppedVideo, coloredVideo, "punchy_vibrant");
    });

    await updateProject(project.id, "exporting", 90);
    const captionStyleId = project.captionStyle || "capcut_green";
    const assContent = generateASS(transcription.words, captionStyleId);
    const subtitlePath = path.join(projectDir, "subtitles.ass");
    fs.writeFileSync(subtitlePath, assContent);
    tempFiles.push(segmentsDir, croppedVideo, coloredVideo, subtitlePath);

    const clearVideo = path.join(projectDir, `clear_viral.mp4`);
    const finalVideo = path.join(projectDir, `final_viral.mp4`);

    await safeExecuteStep(project.id, "create_sandwich", async () => {
      await createSandwichVideo([coloredVideo], coloredVideo, null, clearVideo, finalVideo, subtitlePath, highlightDuration, project.isVerticalSource, project.cropType);
    });

    tempFiles.push(highlightVideo);
    await updateProject(project.id, "complete", 100, { clearVideoPath: clearVideo, captionVideoPath: finalVideo });
  } finally {
    cleanupTempFiles(tempFiles);
  }
}

async function processPodcastCombo(project: any, projectDir: string) {
  const tempFiles: string[] = [];
  try {
    await updateProject(project.id, "audio_mixing", 20);
    const isolatedAudio = path.join(projectDir, "isolated.m4a");
    await safeExecuteStep(project.id, "isolate_vocal", async () => {
      await isolateVocal(project.voiceoverPath!, isolatedAudio, false);
    });

    await updateProject(project.id, "transcription", 40);
    const transcription = await transcribeAudio(isolatedAudio);

    await updateProject(project.id, "audio_mixing", 60);
    const duckedAudio = path.join(projectDir, "ducked.m4a");
    await safeExecuteStep(project.id, "auto_ducking", async () => {
      await autoDucking(isolatedAudio, project.bgMusicPath!, duckedAudio, transcription.duration);
    });
    tempFiles.push(isolatedAudio);

    await updateProject(project.id, "complete", 100, { clearVideoPath: duckedAudio, captionVideoPath: duckedAudio });
  } finally {
    cleanupTempFiles(tempFiles);
  }
}

async function processActionCombo(project: any, projectDir: string) {
  const tempFiles: string[] = [];
  try {
    await updateProject(project.id, "video_composition", 20);
    const croppedVideo = path.join(projectDir, `cropped.mp4`);
    await safeExecuteStep(project.id, "smart_crop", async () => {
      // Keep full source duration — no more 10-second hardcoded trim.
      await smartCropVideo(project.sourceVideoPath!, croppedVideo, 0);
    });

    await updateProject(project.id, "subtitle_overlay", 50);
    const coloredVideo = path.join(projectDir, `colored.mp4`);
    await safeExecuteStep(project.id, "color_grade", async () => {
      await autoColorGrade(croppedVideo, coloredVideo, "teal_orange");
    });

    await updateProject(project.id, "exporting", 80);
    const trackedVideo = path.join(projectDir, `final_action.mp4`);
    const overlayText = project.captionStyle || "SEND IT!";
    await safeExecuteStep(project.id, "motion_track", async () => {
      await motionTrackOverlay(coloredVideo, trackedVideo, overlayText);
    });
    tempFiles.push(croppedVideo);

    await updateProject(project.id, "complete", 100, { clearVideoPath: coloredVideo, captionVideoPath: trackedVideo });
  } finally {
    cleanupTempFiles(tempFiles);
  }
}

async function processCinematicCombo(project: any, projectDir: string) {
  const tempFiles: string[] = [];
  try {
  // Sandwich -> Color -> Ducking -> Subtitles
  await updateProject(project.id, "transcription", 10);
  const transcription = await transcribeAudio(project.voiceoverPath!);
  const dur = Math.round(transcription.duration);

  await updateProject(project.id, "video_curation", 30);
  const timecodes = await curateVideoSegments(project.aiAnalysisVideoPath || project.sourceVideoPath!, transcription.words, dur, project.userId);
  const segmentsDir = path.join(projectDir, "segments");
  if (!fs.existsSync(segmentsDir)) fs.mkdirSync(segmentsDir, { recursive: true });
  const segmentPaths = await extractVideoSegments(project.sourceVideoPath!, timecodes, segmentsDir);

  await updateProject(project.id, "audio_mixing", 50);
  const duckedAudio = path.join(projectDir, "ducked.wav");
  await autoDucking(project.voiceoverPath!, project.bgMusicPath!, duckedAudio, dur);

  await updateProject(project.id, "video_composition", 70);
  const coloredSegments = [];
  for (let i=0; i<segmentPaths.length; i++) {
     const p = path.join(projectDir, `colored_seg_${i}.mp4`);
     await autoColorGrade(segmentPaths[i], p, "cinematic_warm");
     coloredSegments.push(p);
  }

  await updateProject(project.id, "exporting", 85);
  // Respect the user's caption style instead of forcing "neon_pop".
  const captionStyleId = project.captionStyle || "capcut_green";
  const assContent = generateASS(transcription.words, captionStyleId);
  const subtitlePath = path.join(projectDir, "subtitles.ass");
  fs.writeFileSync(subtitlePath, assContent);

  const clearVideoPath = path.join(projectDir, `clear_cine.mp4`);
  const captionVideoPath = path.join(projectDir, `final_cine.mp4`);

  await createSandwichVideo(coloredSegments, duckedAudio, null, clearVideoPath, captionVideoPath, subtitlePath, dur, project.isVerticalSource, project.cropType);

  tempFiles.push(segmentsDir, duckedAudio, subtitlePath, ...coloredSegments);
  await updateProject(project.id, "complete", 100, { clearVideoPath, captionVideoPath });
  } finally {
    cleanupTempFiles(tempFiles);
  }
}

async function processMemeCombo(project: any, projectDir: string) {
  const tempFiles: string[] = [];
  try {
    await updateProject(project.id, "audio_mixing", 20);
    const isolatedVideo = path.join(projectDir, "isolated.mp4");
    await safeExecuteStep(project.id, "isolate_vocal", async () => {
      await isolateVocal(project.sourceVideoPath!, isolatedVideo, true);
    });

    await updateProject(project.id, "subtitle_overlay", 50);
    const trackedVideo = path.join(projectDir, "tracked.mp4");
    const emoji = project.captionStyle || "😂";
    await safeExecuteStep(project.id, "motion_track", async () => {
      await motionTrackOverlay(isolatedVideo, trackedVideo, emoji);
    });

    await updateProject(project.id, "exporting", 80);
    const transcription = await transcribeAudio(isolatedVideo);
    const assContent = generateASS(transcription.words, "fire");
    const subtitlePath = path.join(projectDir, "subtitles.ass");
    fs.writeFileSync(subtitlePath, assContent);

    const clearVideo = path.join(projectDir, `clear_meme.mp4`);
    const finalVideo = path.join(projectDir, `final_meme.mp4`);
    await safeExecuteStep(project.id, "create_sandwich", async () => {
      await createSandwichVideo([trackedVideo], isolatedVideo, null, clearVideo, finalVideo, subtitlePath, transcription.duration, project.isVerticalSource, project.cropType);
    });

    tempFiles.push(isolatedVideo, trackedVideo, subtitlePath);
    await updateProject(project.id, "complete", 100, { clearVideoPath: clearVideo, captionVideoPath: finalVideo });
  } finally {
    cleanupTempFiles(tempFiles);
  }
}


async function processMotionTrackPipeline(project: any, projectDir: string) {
  await updateProject(project.id, "video_composition", 50);

  const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
  const clearVideoPath = path.join(projectDir, `${safeName}_tracked.mp4`);

  // We hijacked captionStyle to store overlay text
  const overlayText = project.captionStyle || "Target";
  await motionTrackOverlay(project.sourceVideoPath!, clearVideoPath, overlayText);

  await updateProject(project.id, "complete", 100, {
    clearVideoPath,
    captionVideoPath: clearVideoPath
  });
}

async function processColorPipeline(project: any, projectDir: string) {
  await updateProject(project.id, "video_composition", 50);

  const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
  const clearVideoPath = path.join(projectDir, `${safeName}_colored.mp4`);

  // captionStyle is hijacked to carry the user's chosen color preset id.
  const presetId = project.captionStyle || null;
  await safeExecuteStep(project.id, "color_grading", async () => {
    await autoColorGrade(project.sourceVideoPath!, clearVideoPath, presetId);
  });

  await updateProject(project.id, "complete", 100, {
    clearVideoPath,
    captionVideoPath: clearVideoPath,
  });
}

async function processIsolatePipeline(project: any, projectDir: string) {
  await updateProject(project.id, "audio_mixing", 50);

  const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
  const isVideo = VIDEO_SOURCE_EXTENSIONS.has(
    path.extname(project.sourceVideoPath ?? "").toLowerCase()
  );
  const ext = isVideo ? ".mp4" : ".m4a";
  const mode = project.captionStyle === "instrumental" ? "instrumental" : "vocals";
  const clearVideoPath = path.join(projectDir, `${safeName}_${mode}${ext}`);

  await isolateVocal(project.sourceVideoPath!, clearVideoPath, isVideo, mode);

  await updateProject(project.id, "complete", 100, {
    clearVideoPath,
    captionVideoPath: clearVideoPath,
  });
}
