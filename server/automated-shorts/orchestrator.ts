import path from "path";
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
  bgMusicPath: string;
  logoPath?: string | null;
  targetSeconds: number;
  videoType: VideoType;
  projectName?: string;
  isVerticalSource?: boolean;
  cropType?: string;
  hookEnabled?: boolean;
  captionStyle?: string;
  voiceId?: string;
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
    fullVideoPath,
    shortVideoUrl,
    shortVideoPath,
    bgMusicPath,
    logoPath,
    targetSeconds,
    videoType,
    projectName,
    isVerticalSource: manualIsVerticalSource = false,
    cropType = "none",
    captionStyle = "capcut_green",
    voiceId,
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
    captionStyle,
    isVerticalSource: manualIsVerticalSource,
    cropType,
    hookEnabled: !!options.hookEnabled,
    originalVideoUrl: fullVideoUrl?.trim() || shortVideoUrl?.trim() || null,
    shortVideoUrl: shortVideoUrl?.trim() || null,
  });

  // 2. Spawn the heavy asynchronous tasks in the background
  runAutomatedShortBackground(project.id, options).catch(async (err) => {
    console.error(`[Project ${project.id}] Failed during background init:`, err);
    await storage.updateProject(project.id, {
      status: "failed",
      errorMessage: err.message || "Failed initializing downloads/scripts",
    });
  });

  return {
    project: { id: project.id, name: project.name },
  };
}

// Heavy lifting function that runs totally decoupled from the HTTP response
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

  let fullVideoPublicPath: string | undefined;

  let cutSourcePath: string | undefined;
  let aiAnalysisVideoPath: string | undefined;
  let scriptSourcePath: string | undefined;

  // 1. Process fullVideo FIRST
  if (fullVideoPath && fs.existsSync(fullVideoPath)) {
    cutSourcePath = fullVideoPath;
    aiAnalysisVideoPath = fullVideoPath; // no lower res downloaded for direct upload
  } else if (fullVideoUrl?.trim()) {
    try {
      const best = await downloadBest(fullVideoUrl.trim());
      cutSourcePath = best.filePath;
      fullVideoPublicPath = best.publicPath;

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

  const isVerticalSource = manualIsVerticalSource || await getIsVertical(cutSourcePath);

  const script = await generateViralVoiceoverScript(scriptSourcePath, targetSeconds, videoType, options.userId);
  const { audioPath: voiceoverPath } = await generateVoiceover(script, voiceId, options.userId);

  // 3. Hook detection (if enabled)
  let hookTimecode: { start: string; end: string } | null = null;
  if (options.hookEnabled && cutSourcePath) {
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
  }

  // 4. Update the initially created project with heavy assets
  await storage.updateProject(projectId, {
    sourceVideoPath: cutSourcePath,
    aiAnalysisVideoPath,
    voiceoverPath,
    isVerticalSource,
    ...(hookTimecode ? { hookTimecode: hookTimecode as any } : {}),
  });

  // 5. Send to the FFmpeg queue
  queuePipeline(projectId);
}
