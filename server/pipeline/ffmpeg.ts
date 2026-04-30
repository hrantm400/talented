import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import type { CaptionStyle } from "../../shared/caption-styles";
import { getCaptionStyleById } from "../../shared/caption-styles";
import { getColorPreset } from "../../shared/color-presets";

const execFileAsync = promisify(execFile);

// Resolve the project's Python interpreter (venv first, system fallback).
const PYTHON_BIN = (() => {
  const venvPython = path.join(process.cwd(), "venv", "bin", "python");
  if (fs.existsSync(venvPython)) return venvPython;
  return "python3";
})();

const PIPELINE_DIR = path.join(process.cwd(), "server", "pipeline");

async function runPython(
  script: string,
  args: string[],
  timeoutMs: number
): Promise<any> {
  const scriptPath = path.join(PIPELINE_DIR, script);
  const { stdout, stderr } = await execFileAsync(
    PYTHON_BIN,
    [scriptPath, ...args],
    { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 }
  );
  // Python scripts emit JSON on the last non-empty line of stdout.
  const lines = stdout.trim().split("\n").filter((l) => l.trim().length > 0);
  const lastLine = lines[lines.length - 1] || "{}";
  let parsed: any;
  try {
    parsed = JSON.parse(lastLine);
  } catch (err) {
    throw new Error(
      `Python ${script} did not return JSON. stderr=${stderr.slice(-1000)} stdout-tail=${lastLine.slice(0, 500)}`
    );
  }
  if (parsed && parsed.error) {
    throw new Error(`Python ${script} failed: ${parsed.error}`);
  }
  return parsed;
}
const DRAW_TEXT_FONT_CANDIDATES = [
  path.join(process.env.WINDIR || "C:/Windows", "Fonts", "arialbd.ttf"),
  path.join(process.env.WINDIR || "C:/Windows", "Fonts", "arial.ttf"),
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
];

// Escape a filesystem path for use inside an FFmpeg filter argument
// (the path is intended to be wrapped in single quotes by the caller).
function escapeFilterPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

// Escape arbitrary user text for the drawtext text= option (single-quoted).
// Backslashes are doubled, then colon and single-quote are escaped because
// FFmpeg's filter parser treats both as syntax characters.
function escapeFilterText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function resolveDrawtextFontOption(): string {
  const fontPath = DRAW_TEXT_FONT_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (fontPath) {
    return `fontfile='${escapeFilterPath(fontPath)}'`;
  }

  return "font='Sans'";
}

export async function getMediaDuration(filePath: string): Promise<number> {
  const args = ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath];
  const { stdout } = await execFileAsync("ffprobe", args);
  return parseFloat(stdout.trim());
}

export async function getVideoInfo(filePath: string): Promise<{
  duration: number;
  width: number;
  height: number;
  fps: number;
}> {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath
  ];
  const { stdout } = await execFileAsync("ffprobe", args);
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0] || {};
  const format = data.format || {};
  const fpsStr = stream.r_frame_rate || "30/1";
  const [num, den] = fpsStr.split("/").map(Number);
  return {
    duration: parseFloat(format.duration || "0"),
    width: stream.width || 1920,
    height: stream.height || 1080,
    fps: den ? num / den : 30,
  };
}

export async function mixAudio(
  sourceVideoPath: string, // Kept for signature compatibility but not strictly needed here
  voiceoverPath: string,
  bgMusicPath: string,
  outputPath: string,
  voiceoverDuration: number
): Promise<void> {
  const args = [
    "-y",
    "-i", voiceoverPath,
    "-i", bgMusicPath,
    "-filter_complex", "[0:a]volume=10dB[vo];[1:a]atempo=1.1,volume=-10dB[bg];[vo][bg]amix=inputs=2:duration=first:dropout_transition=2[out]",
    "-map", "[out]",
    "-t", voiceoverDuration.toString(),
    "-ar", "44100",
    outputPath
  ];

  await execFileAsync("ffmpeg", args, { timeout: 300000 });
}

export async function autoDucking(
  voiceoverPath: string,
  bgMusicPath: string,
  outputPath: string,
  voiceoverDuration: number
): Promise<void> {
  const args = [
    "-y",
    "-i", voiceoverPath,
    "-i", bgMusicPath,
    "-filter_complex",
    "[0:a]volume=10dB,asplit=2[sc][vo_out];[1:a]volume=0dB[bg_in];[bg_in][sc]sidechaincompress=threshold=0.01:ratio=5:attack=100:release=1000:makeup=1.5[bg_ducked];[vo_out][bg_ducked]amix=inputs=2:duration=first:dropout_transition=2[out]",
    "-map", "[out]",
    "-t", voiceoverDuration.toString(),
    "-ar", "44100",
    outputPath
  ];

  await execFileAsync("ffmpeg", args, { timeout: 300000 });
}

export async function autoColorGrade(
  sourceVideoPath: string,
  outputPath: string,
  presetId: string | null = null
): Promise<{ presetId: string; presetLabel: string }> {
  const preset = getColorPreset(presetId);
  const args = [
    "-y",
    "-i", sourceVideoPath,
    "-vf", preset.filter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "copy",
    outputPath,
  ];

  await execFileAsync("ffmpeg", args, { timeout: 300000 });
  return { presetId: preset.id, presetLabel: preset.label };
}

/**
 * Real motion-tracked overlay. Detects the dominant face in the first second of
 * the source with MediaPipe, then runs an OpenCV CSRT tracker through the rest
 * of the clip and rasterises the overlay text following that bounding box.
 *
 * The Python step writes an mp4v intermediate; we re-encode with libx264 here
 * so the result matches the rest of the pipeline (faststart, CRF, AAC audio).
 */
export async function motionTrackOverlay(
  sourceVideoPath: string,
  outputPath: string,
  overlayText: string,
  initialBbox: string = "auto"
): Promise<{ trackedFrames: number; totalFrames: number; tracking: string }> {
  const tmpPath = outputPath.replace(/\.mp4$/i, "") + "_track_raw.mp4";
  const result = await runPython(
    "motion-track.py",
    [sourceVideoPath, tmpPath, overlayText, initialBbox],
    900000
  );

  // Re-mux: bring back source audio (mp4v writer drops it) and re-encode video to libx264.
  const finalArgs = [
    "-y",
    "-i", tmpPath,
    "-i", sourceVideoPath,
    "-map", "0:v:0",
    "-map", "1:a:0?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
  ];
  await execFileAsync("ffmpeg", finalArgs, { timeout: 600000 });
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  return {
    trackedFrames: result.tracked_frames || 0,
    totalFrames: result.frames || 0,
    tracking: result.tracking_method || "unknown",
  };
}

/**
 * Real vocal source separation with Demucs (htdemucs model, CPU).
 *
 * Steps:
 *  1. If input is video, extract its audio to WAV (Demucs needs an audio file).
 *  2. Run Demucs in two-stem mode to produce vocals.wav + no_vocals.wav.
 *  3. Encode the requested stem into the final output. For video sources we
 *     mux the chosen stem back over the original video stream.
 *
 * mode="vocals" → keep only the human voice (instrumental removed).
 * mode="instrumental" → keep only the music/background (voice removed).
 */
export async function isolateVocal(
  sourcePath: string,
  outputPath: string,
  isVideo: boolean,
  mode: "vocals" | "instrumental" = "vocals"
): Promise<{ duration: number; model: string }> {
  const workDir = path.dirname(outputPath);
  const stemsDir = path.join(workDir, `stems_${Date.now()}`);
  fs.mkdirSync(stemsDir, { recursive: true });

  let demucsInput = sourcePath;
  let extractedWav: string | null = null;
  if (isVideo) {
    extractedWav = path.join(stemsDir, "source.wav");
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", sourcePath, "-vn", "-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2", extractedWav],
      { timeout: 300000 }
    );
    demucsInput = extractedWav;
  }

  const result = await runPython(
    "vocal-isolate.py",
    [demucsInput, stemsDir],
    1800000 // 30 min hard cap — demucs CPU is slow but bounded
  );

  const chosen = mode === "instrumental" ? result.no_vocals : result.vocals;
  if (!chosen || !fs.existsSync(chosen)) {
    throw new Error(`Demucs stem missing for mode=${mode}`);
  }

  // Encode/mux to final output
  if (isVideo) {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i", sourcePath,
        "-i", chosen,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        outputPath,
      ],
      { timeout: 300000 }
    );
  } else {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", chosen, "-c:a", "aac", "-b:a", "192k", outputPath],
      { timeout: 300000 }
    );
  }

  // Cleanup intermediate stems
  try {
    fs.rmSync(stemsDir, { recursive: true, force: true });
  } catch {}

  return { duration: result.duration || 0, model: result.model || "htdemucs" };
}

/**
 * Real face-tracking smart crop. A Python pass uses MediaPipe to compute the
 * dominant face's center-x trajectory and writes a 9:16 mp4v intermediate.
 * We then re-encode with libx264 here and bring the source audio back.
 *
 * If `duration` is finite, the final output is trimmed to that length;
 * passing 0 keeps the full source.
 */
export async function smartCropVideo(
  sourceVideoPath: string,
  outputPath: string,
  duration: number
): Promise<{ tracked: boolean; facesFound: number; frames: number }> {
  const tmpPath = outputPath.replace(/\.mp4$/i, "") + "_crop_raw.mp4";
  const result = await runPython(
    "smart-crop.py",
    [sourceVideoPath, tmpPath, "1920", "1080"],
    900000
  );

  const args = [
    "-y",
    "-i", tmpPath,
    "-i", sourceVideoPath,
    "-map", "0:v:0",
    "-map", "1:a:0?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
  ];
  if (Number.isFinite(duration) && duration > 0) {
    args.push("-t", duration.toString());
  }
  args.push(outputPath);
  await execFileAsync("ffmpeg", args, { timeout: 600000 });
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  return {
    tracked: !!result.tracked,
    facesFound: result.faces_found || 0,
    frames: result.frames || 0,
  };
}

export async function extractVideoSegments(
  sourceVideoPath: string,
  timecodes: Array<{ start: string; end: string }>,
  outputDir: string
): Promise<string[]> {
  const segmentPaths: string[] = [];

  for (let i = 0; i < timecodes.length; i++) {
    const tc = timecodes[i];
    const startSeconds = parseTimestampToSeconds(tc.start);
    const endSeconds = parseTimestampToSeconds(tc.end);

    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      endSeconds - startSeconds < 0.25
    ) {
      continue;
    }

    const outPath = path.join(outputDir, `segment_${i}.mp4`);

    const args = [
      "-y",
      "-ss", tc.start,
      "-to", tc.end,
      "-i", sourceVideoPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-an",
      outPath
    ];

    await execFileAsync("ffmpeg", args, { timeout: 120000 });
    segmentPaths.push(outPath);
  }

  if (segmentPaths.length === 0) {
    throw new Error("No valid video segments were extracted from the provided timecodes.");
  }

  return segmentPaths;
}

function createConcatListFile(segmentPaths: string[], outputDir: string): string {
  const concatListPath = path.join(outputDir, `concat_${Date.now()}.txt`);
  const concatContent = segmentPaths
    .map((segmentPath) => `file '${segmentPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");

  fs.writeFileSync(concatListPath, concatContent);
  return concatListPath;
}

export async function concatVideoSegments(
  segmentPaths: string[],
  outputPath: string,
): Promise<void> {
  if (segmentPaths.length === 0) {
    throw new Error("Cannot concatenate an empty list of video segments.");
  }

  const concatListPath = createConcatListFile(segmentPaths, path.dirname(outputPath));

  try {
    const concatArgs = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-an",
      "-movflags", "+faststart",
      outputPath
    ];

    await execFileAsync("ffmpeg", concatArgs, { timeout: 300000 });
  } finally {
    if (fs.existsSync(concatListPath)) {
      fs.unlinkSync(concatListPath);
    }
  }
}

export async function createSandwichVideo(
  segmentPaths: string[],
  mixedAudioPath: string,
  logoPath: string | null,
  outputClearPath: string,
  outputCaptionPath: string,
  subtitlePath: string | null,
  voiceoverDuration: number,
  isVerticalSource: boolean | null = false,
  cropType: string | null = "none"
): Promise<void> {
  console.log(`[createSandwichVideo] isVerticalSource=${isVerticalSource}, cropType=${cropType}`);
  const concatenatedPath = path.join(path.dirname(outputClearPath), "concatenated.mp4");
  try {
    await concatVideoSegments(segmentPaths, concatenatedPath);

    let initialCrop = "";
    let effectivelyVertical = isVerticalSource;

    if (cropType === "16:9") {
      initialCrop = "crop='iw':'iw*9/16':0:'(ih-(iw*9/16))/2',";
      effectivelyVertical = false;
    } else if (cropType === "1:1") {
      initialCrop = "crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))/2':'(ih-min(iw,ih))/2',";
      effectivelyVertical = false;
    }

    const filterComplex = effectivelyVertical
      ? `[0:v]${initialCrop}scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[base]`
      : `[0:v]${initialCrop}split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[blurred];[fg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1080:1080:(iw-1080)/2:(ih-1080)/2,setsar=1[scaled];[blurred][scaled]overlay=0:(H-h)/2[base]`;

    const safeSubPath = subtitlePath ? escapeFilterPath(subtitlePath) : null;
    let finalFilter = filterComplex;

    let hasOverlay = false;
    if (logoPath || safeSubPath) {
      finalFilter += `;[base]split=2[clear][process]`;
      hasOverlay = true;

      // Build cumulative filter
      if (logoPath && safeSubPath) {
        finalFilter += `;[2:v]scale=120:-1[logo];[process][logo]overlay=W-w-30:30,ass='${safeSubPath}'[final]`;
      } else if (safeSubPath) {
        finalFilter += `;[process]ass='${safeSubPath}'[final]`;
      } else if (logoPath) {
        finalFilter += `;[2:v]scale=120:-1[logo];[process][logo]overlay=W-w-30:30[final]`;
      }
    }

    const ffmpegArgs = [
      "-y",
      "-i", concatenatedPath,
      "-i", mixedAudioPath,
    ];

    if (logoPath) {
      ffmpegArgs.push("-i", logoPath);
    }

    ffmpegArgs.push("-filter_complex", finalFilter);

    // Common output options
    const outputOptions = [
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "22",
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", voiceoverDuration.toString(),
      "-r", "30",
      "-s", "1080x1920",
    ];

    // Map clear path
    const clearMapTarget = hasOverlay ? "[clear]" : "[base]";
    ffmpegArgs.push("-map", clearMapTarget, "-map", "1:a?", ...outputOptions, outputClearPath);

    // Map [final] to the caption path (if available)
    if (hasOverlay) {
      ffmpegArgs.push("-map", "[final]", "-map", "1:a?", ...outputOptions, outputCaptionPath);
    }

    await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 900000 });

    if (!hasOverlay && outputClearPath !== outputCaptionPath) {
      fs.copyFileSync(outputClearPath, outputCaptionPath);
    }
  } finally {
    if (fs.existsSync(concatenatedPath)) {
      fs.unlinkSync(concatenatedPath);
    }
  }
}

export function generateASS(
  words: Array<{ word: string; start: number; end: number }>,
  styleId: string = "capcut_green",
  timeOffset: number = 0
): string {
  const style = getCaptionStyleById(styleId);
  const boldFlag = style.bold ? -1 : 0;

  const header = `[Script Info]
Title: Dynamic Subtitles
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontName},${style.fontSize},${style.primaryColor},&H000000FF,${style.outlineColor},${style.backColor},${boldFlag},0,0,0,100,100,2,0,1,${style.outlineWidth},${style.shadow},2,40,40,180,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  const chunkSize = 4;

  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize);
    const chunkStart = chunk[0].start;
    const chunkEnd = chunk[chunk.length - 1].end;

    for (let wi = 0; wi < chunk.length; wi++) {
      const word = chunk[wi];
      const segStart = word.start;
      const segEnd = word.end;

      const textParts = chunk.map((cw, idx) => {
        const w = style.uppercase ? cw.word.toUpperCase() : cw.word;
        if (idx === wi) {
          return `{\\c${style.highlightColor}\\fscx${style.scaleOnHighlight}\\fscy${style.scaleOnHighlight}}${w}{\\c${style.primaryColor}\\fscx100\\fscy100}`;
        }
        return w;
      });

      const line1Words = textParts.slice(0, Math.ceil(textParts.length / 2));
      const line2Words = textParts.slice(Math.ceil(textParts.length / 2));
      let text: string;
      if (line2Words.length > 0) {
        text = line1Words.join(" ") + "\\N" + line2Words.join(" ");
      } else {
        text = line1Words.join(" ");
      }

      events.push(
        `Dialogue: 0,${formatASSTime(segStart + timeOffset)},${formatASSTime(segEnd + timeOffset)},Default,,0,0,0,,${text}`
      );
    }

    if (chunk.length > 1) {
      const lastWordEnd = chunk[chunk.length - 1].end;
      const nextChunkStart = i + chunkSize < words.length ? words[i + chunkSize].start : lastWordEnd + 0.1;
      const gapEnd = Math.min(nextChunkStart, lastWordEnd + 0.3);

      if (gapEnd > lastWordEnd + 0.01) {
        const allWords = chunk.map((cw) => (style.uppercase ? cw.word.toUpperCase() : cw.word));
        const line1 = allWords.slice(0, Math.ceil(allWords.length / 2));
        const line2 = allWords.slice(Math.ceil(allWords.length / 2));
        let holdText: string;
        if (line2.length > 0) {
          holdText = line1.join(" ") + "\\N" + line2.join(" ");
        } else {
          holdText = line1.join(" ");
        }
        events.push(
          `Dialogue: 0,${formatASSTime(lastWordEnd + timeOffset)},${formatASSTime(gapEnd + timeOffset)},Default,,0,0,0,,${holdText}`
        );
      }
    }
  }

  return header + events.join("\n") + "\n";
}

function formatASSTime(seconds: number): string {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const hrs = Math.floor(totalCentiseconds / 360000);
  const mins = Math.floor((totalCentiseconds % 360000) / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const cs = totalCentiseconds % 100;
  return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function parseTimestampToSeconds(timestamp: string): number {
  const parts = timestamp.split(":").map(Number);

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return parts[0] ?? NaN;
}

/**
 * Extract a hook segment from the source video with its original audio.
 */
export async function extractHookSegment(
  sourceVideoPath: string,
  start: string,
  end: string,
  outputPath: string
): Promise<void> {
  const startSec = parseTimestampToSeconds(start);
  const endSec = parseTimestampToSeconds(end);
  const duration = endSec - startSec;

  const args = [
    "-y",
    "-ss", startSec.toString(),
    "-i", sourceVideoPath,
    "-t", duration.toString(),
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "18",
    "-c:a", "aac",
    "-b:a", "192k",
    outputPath,
  ];

  console.log(`[extractHookSegment] Extracting hook ${start} → ${end} (${duration.toFixed(1)}s)`);
  await execFileAsync("ffmpeg", args, { timeout: 120000 });
}

/**
 * Mix audio with a hook intro: hook original audio + quiet BGM for the first N seconds,
 * then voiceover + ducked BGM for the rest.
 */
export async function mixAudioWithHook(
  hookVideoPath: string,
  voiceoverPath: string,
  bgMusicPath: string,
  outputPath: string,
  hookDuration: number,
  voiceoverDuration: number
): Promise<void> {
  const totalDuration = hookDuration + voiceoverDuration;

  // Robust complex filter to mix audio:
  // 1. Hook audio plays at full volume for hookDuration seconds
  // 2. Voiceover correctly delayed by hookDuration using modern adelay syntax
  // 3. Format all 3 inputs to 44100 stereo to prevent amix dropping streams
  // 4. Pad shorter streams with silence (apad) so amix doesn't abruptly increase volume
  const filterComplex = [
    // 1) Hook Audio: extract, trim, volume, conform, pad
    `[0:a]atrim=0:${hookDuration},asetpts=PTS-STARTPTS,volume=8dB,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[hook_audio]`,
    
    // 2) Voiceover: volume, conform, then apply delay to all channels, and pad
    `[1:a]volume=10dB,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=${Math.round(hookDuration * 1000)}:all=1,apad[vo_delayed]`,
    
    // 3) Background Music: tempo, volume, conform, pad
    `[2:a]atempo=1.1,volume=-12dB,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[bg_padded]`,
    
    // 4) Mix them all and cut at totalDuration
    `[hook_audio][vo_delayed][bg_padded]amix=inputs=3:duration=longest:dropout_transition=0,atrim=0:${totalDuration}[out]`,
  ].join(";");

  const args = [
    "-y",
    "-i", hookVideoPath,
    "-i", voiceoverPath,
    "-i", bgMusicPath,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-t", totalDuration.toString(),
    "-ar", "44100",
    outputPath,
  ];

  console.log(`[mixAudioWithHook] Hook: ${hookDuration.toFixed(1)}s + VO: ${voiceoverDuration.toFixed(1)}s = ${totalDuration.toFixed(1)}s total`);
  await execFileAsync("ffmpeg", args, { timeout: 300000 });
}
