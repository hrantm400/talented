import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { getCaptionStyleById } from "../../shared/caption-styles";

const execFileAsync = promisify(execFile);

// Escape a filesystem path for use inside an FFmpeg filter argument
// (the path is intended to be wrapped in single quotes by the caller).
function escapeFilterPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
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

/**
 * Composes the final 9:16 video. Single output: subtitles + logo burned in.
 * The "clear" (no-subs/no-logo) variant was removed — only the captioned
 * output is produced now.
 */
export type LogoPosition = "top-right" | "top-left";

export async function createSandwichVideo(
  segmentPaths: string[],
  mixedAudioPath: string,
  logoPath: string | null,
  outputCaptionPath: string,
  subtitlePath: string | null,
  voiceoverDuration: number,
  isVerticalSource: boolean | null = false,
  cropType: string | null = "none",
  logoPosition: LogoPosition = "top-right"
): Promise<void> {
  console.log(`[createSandwichVideo] isVerticalSource=${isVerticalSource}, cropType=${cropType}, logoPosition=${logoPosition}`);
  const concatenatedPath = path.join(path.dirname(outputCaptionPath), "concatenated.mp4");
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

    const baseFilter = effectivelyVertical
      ? `[0:v]${initialCrop}scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[base]`
      : `[0:v]${initialCrop}split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[blurred];[fg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1080:1080:(iw-1080)/2:(ih-1080)/2,setsar=1[scaled];[blurred][scaled]overlay=0:(H-h)/2[base]`;

    const safeSubPath = subtitlePath ? escapeFilterPath(subtitlePath) : null;
    // Logo coordinates: 30px inset from the chosen corner. Vertical = 30px
    // from top in both cases; horizontal flips.
    const logoXY = logoPosition === "top-left" ? "30:30" : "W-w-30:30";
    let finalFilter = baseFilter;
    let outLabel = "[base]";

    if (logoPath && safeSubPath) {
      finalFilter += `;[2:v]scale=120:-1[logo];[base][logo]overlay=${logoXY},ass='${safeSubPath}'[final]`;
      outLabel = "[final]";
    } else if (safeSubPath) {
      finalFilter += `;[base]ass='${safeSubPath}'[final]`;
      outLabel = "[final]";
    } else if (logoPath) {
      finalFilter += `;[2:v]scale=120:-1[logo];[base][logo]overlay=${logoXY}[final]`;
      outLabel = "[final]";
    }

    const ffmpegArgs = ["-y", "-i", concatenatedPath, "-i", mixedAudioPath];
    if (logoPath) ffmpegArgs.push("-i", logoPath);

    ffmpegArgs.push(
      "-filter_complex", finalFilter,
      "-map", outLabel,
      "-map", "1:a?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "22",
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", voiceoverDuration.toString(),
      "-r", "30",
      "-s", "1080x1920",
      outputCaptionPath
    );

    await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 900000 });
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
