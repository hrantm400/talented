// ─────────────────────────────────────────────────────────────────────────
// Dedicated render pipeline for "Automated Shorts — No Voiceover".
//
// Unlike the shared sandwich pipeline (script → TTS → montage matched to the
// voiceover), this one:
//   1. asks Gemini for a 2-clip narrative (SETUP → EPIC), never the ending,
//   2. cuts those clips WITH their original audio,
//   3. transcribes that real audio for captions (what is actually heard),
//   4. mixes the real audio with the (Jamendo) background track,
//   5. renders the 9:16 sandwich and burns in captions + an animated
//      "Full video in the comments" outro.
// ─────────────────────────────────────────────────────────────────────────
import path from "path";
import fs from "fs";
import { renderPipelineLimit } from "../pipeline/render-limit";
import { storage } from "../storage";
import { broadcastProjectUpdate } from "../websocket";
import { appendVideoRow } from "../google-sheets/append";
import { PROJECT_TYPES } from "@shared/schema";
import {
  transcribeAudio,
  curateNarrativeSegments,
  generateHookTitle,
} from "../pipeline/gemini";
import {
  mixAudio,
  extractVideoSegmentsKeepAudio,
  concatSegmentsAudio,
  createSandwichVideo,
  generateASS,
  appendOutroToAss,
  appendTopHookToAss,
  getMediaDuration,
  detectVerticalVideo,
} from "../pipeline/ffmpeg";

const OUTPUT_DIR = path.join(process.cwd(), "outputs");
const nvLimit = renderPipelineLimit;

async function setStatus(
  id: number,
  step: string,
  progress: number,
  extra: Record<string, any> = {}
) {
  const updated = await storage.updateProject(id, {
    currentStep: step,
    progress,
    status: step === "failed" ? "failed" : step === "complete" ? "complete" : "processing",
    ...extra,
  });
  if (!updated) return;
  broadcastProjectUpdate(updated);

  if ((step === "complete" || step === "failed") && updated.userId) {
    import("../telegram/bot").then((mod) => {
      mod.notifyProjectComplete(
        updated.userId!,
        updated.name,
        updated.id,
        step as "complete" | "failed",
        updated.errorMessage || undefined
      );
    }).catch(() => {});
  }

  if (step === "complete" && updated.projectType === PROJECT_TYPES.AUTOMATED_NO_VOICEOVER) {
    const baseUrl = process.env.APP_PUBLIC_URL || process.env.BASE_URL || "";
    if (baseUrl) {
      const user = updated.userId
        ? await import("../auth").then((m) => m.getUserById(updated.userId!)).catch(() => null)
        : null;
      void appendVideoRow(updated, baseUrl, user || undefined);
    }
  }
}

export function queueNoVoiceoverPipeline(projectId: number) {
  nvLimit(() => runNoVoiceoverPipeline(projectId)).catch((err) => {
    console.error(`[nv-pipeline] unhandled queue error for ${projectId}:`, err);
  });
}

export async function runNoVoiceoverPipeline(projectId: number): Promise<void> {
  const project = await storage.getProject(projectId);
  if (!project) throw new Error("Project not found");

  const projectDir = path.join(OUTPUT_DIR, `project_${projectId}`);
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

  // Resume early-exit.
  if (project.captionVideoPath && fs.existsSync(project.captionVideoPath) && fs.statSync(project.captionVideoPath).size > 0) {
    console.log(`[nv-pipeline] caption video already exists for ${projectId}, marking complete`);
    await setStatus(projectId, "complete", 100, { captionVideoPath: project.captionVideoPath, errorMessage: null });
    return;
  }

  try {
    const startTime = Date.now();
    console.log(`[nv-pipeline] Starting for project ${projectId}`);
    const targetSeconds = project.voiceoverDuration && project.voiceoverDuration > 0 ? project.voiceoverDuration : 25;

    // 1. Narrative curation (setup + epic, no ending) from the FULL video.
    await setStatus(projectId, "video_curation", 20);
    const source = project.sourceVideoPath!;
    const aiSource = project.aiAnalysisVideoPath || source;
    const timecodes =
      (project.timecodes as Array<{ start: string; end: string }> | null)?.length
        ? (project.timecodes as Array<{ start: string; end: string }>)
        : await curateNarrativeSegments(aiSource, targetSeconds, project.userId);
    await setStatus(projectId, "video_curation", 40, { timecodes: timecodes as any });

    // 2. Cut the chosen clips WITH their original audio (from the full-res source).
    await setStatus(projectId, "video_composition", 50);
    const segmentsDir = path.join(projectDir, "segments");
    if (!fs.existsSync(segmentsDir)) fs.mkdirSync(segmentsDir, { recursive: true });
    const segmentPaths = await extractVideoSegmentsKeepAudio(source, timecodes, segmentsDir);

    // 3. Build the performance audio (real audio of the clips) and transcribe it.
    const performanceAudio = path.join(projectDir, "performance.wav");
    await concatSegmentsAudio(segmentPaths, performanceAudio);
    await setStatus(projectId, "transcription", 60);
    const transcription = await transcribeAudio(performanceAudio, project.userId);
    const totalDuration = (await getMediaDuration(performanceAudio)) || transcription.duration;
    await setStatus(projectId, "transcription", 68, {
      voiceoverDuration: Math.round(totalDuration),
      transcription: transcription.words as any,
    });

    // 4. Mix the real audio with the background track. The clip audio is the
    //    main track (no boost — avoids clipping); the music sits well below it.
    //    The music is also obfuscated against content-ID: pitch shifted ~+1
    //    semitone, net ~1.1x speed, and lightly EQ'd so its fingerprint differs.
    await setStatus(projectId, "audio_mixing", 75);
    const mixedAudioPath = path.join(projectDir, "mixed_audio.wav");
    const antiFingerprint = "asetrate=44100*1.057,aresample=44100,atempo=1.041,bass=g=-2,treble=g=2,";
    await mixAudio(performanceAudio, project.bgMusicPath!, mixedAudioPath, totalDuration, 0, -30, antiFingerprint);

    // Per-variant config (set by the factory). Defaults preserve the standard
    // No-Voiceover behaviour: mirror + noise + top card + outro all on.
    const vc = (project.variantConfig as any) || null;
    const wantTopCard = vc ? !!vc.topCard : true;
    const wantOutro = vc ? !!vc.outro : true;
    const uniquify = vc
      ? { mirror: !!vc.mirror, noise: Number(vc.noise) || 0 }
      : { mirror: true, noise: 7 };

    // 4b. Viral headline for the animated top card. A per-variant custom hook
    //     text wins; otherwise reuse the stored title or generate one.
    let hookTitle = vc?.hookText?.trim() || project.hookTitle || "";
    if (wantTopCard && !hookTitle) {
      try {
        hookTitle = await generateHookTitle(aiSource, project.userId);
        if (hookTitle) await storage.updateProject(projectId, { hookTitle });
      } catch (err: any) {
        console.warn(`[nv-pipeline] hook title failed: ${err?.message || err}`);
      }
    }

    // 5. Captions + animated top hook card + animated outro.
    const captionStyleId = project.captionStyle || "capcut_green";
    let assContent = generateASS(transcription.words, captionStyleId);
    if (wantTopCard && hookTitle) assContent = appendTopHookToAss(assContent, hookTitle, totalDuration, vc?.hookColor);
    if (wantOutro) assContent = appendOutroToAss(assContent, totalDuration, vc?.outroText?.trim() || undefined);
    const subtitlePath = path.join(projectDir, "subtitles.ass");
    fs.writeFileSync(subtitlePath, assContent);

    // 6. Render the 9:16 sandwich.
    await setStatus(projectId, "subtitle_overlay", 82);
    const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
    const captionVideoPath = path.join(projectDir, `${safeName}_caption.mp4`);
    // Auto-detect a 9:16 source (the manual checkbox just force-overrides it),
    // matching the VO + standalone pipelines so the factory NV path doesn't
    // blur-sandwich an already-vertical clip.
    const effectiveVertical = project.isVerticalSource || await detectVerticalVideo(source);
    await createSandwichVideo(
      segmentPaths,
      mixedAudioPath,
      project.logoPath,
      captionVideoPath,
      subtitlePath,
      totalDuration,
      effectiveVertical,
      project.cropType,
      (vc?.logoPosition ?? project.logoPosition) === "top-left" ? "top-left" : "top-right",
      (vc?.logoLayout as any) ?? (project.logoLayout as any) ?? null,
      uniquify
    );

    await setStatus(projectId, "exporting", 92, { captionVideoPath });
    console.log(`[nv-pipeline] Project ${projectId} COMPLETE in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    await setStatus(projectId, "complete", 100, { captionVideoPath });
  } catch (error: any) {
    console.error(`[nv-pipeline] failed for project ${projectId}:`, error);
    await setStatus(projectId, "failed", 0, { errorMessage: error.message || "No-Voiceover pipeline failed" });
  }
}
