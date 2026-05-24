import { storage } from "../storage";
import { transcribeAudio, curateVideoSegments, findHookMoment } from "./gemini";
import {
  mixAudio,
  extractVideoSegments,
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
import pLimit from "p-limit";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const OUTPUT_DIR = path.join(process.cwd(), "outputs");

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

// Restrict concurrent heavy FFmpeg pipelines to prevent CPU/RAM exhaustion
const pipelineLimit = pLimit(2);

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

  // Resume early-exit: if a final render is already on disk, just mark complete.
  if (
    project.captionVideoPath &&
    fs.existsSync(project.captionVideoPath) &&
    fs.statSync(project.captionVideoPath).size > 0
  ) {
    console.log(`[pipeline] Resume: caption video already exists for project ${projectId}, marking complete`);
    await updateProject(projectId, "complete", 100, {
      captionVideoPath: project.captionVideoPath,
      errorMessage: null,
    });
    return;
  }

  try {
    // Classic Sandwich Pipeline (also used by Automated Shorts).
    // Resumable: each step skips its own work if its output is already on
    // the project row / on disk. Used by /api/projects/:id/retry to avoid
    // re-doing expensive operations after a partial failure.
    const startTime = Date.now();
    console.log(`[pipeline] Starting Classic Pipeline for project ${projectId}`);

    await updateProject(projectId, "transcription", 10, { errorMessage: null });

    // ── Step 1: transcription (skip if already saved) ──
    const existingWords = (project.transcription as any[] | null) || null;
    let transcription: {
      duration: number;
      words: Array<{ word: string; start: number; end: number }>;
      text: string;
      language: string;
    };
    if (existingWords && existingWords.length > 0 && project.voiceoverDuration) {
      console.log(`[pipeline] Resume: reusing existing transcription (${existingWords.length} words)`);
      transcription = {
        duration: project.voiceoverDuration,
        words: existingWords as any,
        text: "",
        language: "en",
      };
    } else {
      const transcribeStart = Date.now();
      transcription = await transcribeAudio(project.voiceoverPath!, project.userId);
      console.log(`[pipeline] Transcription took ${((Date.now() - transcribeStart)/1000).toFixed(1)}s`);
    }
    const voiceoverDuration = transcription.duration;

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

    // ── Step 2: video curation (skip if already saved) ──
    const existingTimecodes = (project.timecodes as Array<{ start: string; end: string }> | null) || null;
    let timecodes: Array<{ start: string; end: string }>;
    if (existingTimecodes && existingTimecodes.length > 0) {
      console.log(`[pipeline] Resume: reusing existing timecodes (${existingTimecodes.length} segments)`);
      timecodes = existingTimecodes;
    } else {
      const curationStart = Date.now();
      timecodes = await curateVideoSegments(
        project.aiAnalysisVideoPath || project.sourceVideoPath!,
        transcription.words,
        voiceoverDuration,
        project.userId
      );
      console.log(`[pipeline] Video curation (Gemini) took ${((Date.now() - curationStart)/1000).toFixed(1)}s`);
    }

    await updateProject(projectId, "video_curation", 45, {
      timecodes: timecodes as any,
    });

    await updateProject(projectId, "audio_mixing", 50);

    // ── Step 3: audio mixing (skip if file already produced) ──
    const mixedAudioPath = path.join(projectDir, "mixed_audio.wav");
    if (fs.existsSync(mixedAudioPath) && fs.statSync(mixedAudioPath).size > 0) {
      console.log(`[pipeline] Resume: reusing existing mixed audio at ${mixedAudioPath}`);
    } else {
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
          project.voiceoverPath!,
          project.bgMusicPath!,
          mixedAudioPath,
          voiceoverDuration
        );
      }
      console.log(`[pipeline] Audio mixing took ${((Date.now() - mixingStart)/1000).toFixed(1)}s`);
    }

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
      const hookTranscription = await transcribeAudio(hookSegmentPath, project.userId);
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
      captionVideoPath,
      subtitlePath,
      totalDuration,
      project.isVerticalSource,
      project.cropType,
      project.logoPosition === "top-left" ? "top-left" : "top-right"
    );
    console.log(`[pipeline] Sandwich creation (rendering) took ${((Date.now() - sandwichStart)/1000).toFixed(1)}s`);

    await updateProject(projectId, "exporting", 90, {
      captionVideoPath,
    });

    console.log(`[pipeline] Project ${projectId} COMPLETE in ${((Date.now() - startTime)/1000).toFixed(1)}s`);
    await updateProject(projectId, "complete", 100, {
      captionVideoPath,
    });
  } catch (error: any) {
    console.error(`Pipeline failed for project ${projectId}:`, error);
    await updateProject(projectId, "failed", 0, {
      errorMessage: error.message || "Pipeline processing failed",
    });
  }
}

