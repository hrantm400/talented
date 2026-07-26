import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { getCaptionStyleById } from "../../shared/caption-styles";
import type { LogoLayout } from "../../shared/schema";

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

/**
 * Detect whether a video is vertical (portrait, width ≤ height) from its real
 * dimensions, accounting for rotation metadata (rotate tag or Display Matrix
 * side data). Lets pipelines auto-detect 9:16 sources. Returns false on any
 * probe error (safe default → blur-sandwich for horizontal sources).
 */
export async function detectVerticalVideo(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height:stream_tags=rotate:side_data=rotation",
      "-of", "json", filePath,
    ]);
    const s = (JSON.parse(stdout).streams || [])[0] || {};
    let w = Number(s.width) || 0;
    let h = Number(s.height) || 0;
    if (!w || !h) return false;
    const rot = String(
      s.tags?.rotate ?? (s.side_data_list || []).find((d: any) => d.rotation != null)?.rotation ?? ""
    ).trim();
    if (rot === "90" || rot === "270" || rot === "-90") { const t = w; w = h; h = t; }
    return w <= h;
  } catch {
    return false;
  }
}

/**
 * Produce a compressed copy of a video that fits within `maxBytes`, so it can
 * be uploaded to Telegram as a playable video (bot uploads are capped at 50MB).
 * Targets a video bitrate derived from the duration and the size budget, keeps
 * the 1080x1920 resolution, and writes a faststart mp4. Returns the output path
 * on success, or null if it could not get the file under the budget.
 */
export async function compressForTelegram(
  srcPath: string,
  outPath: string,
  maxBytes: number
): Promise<string | null> {
  const duration = await getMediaDuration(srcPath);
  if (!duration || !isFinite(duration) || duration <= 0) return null;

  // Reserve headroom for container overhead + bitrate overshoot.
  const budgetBits = maxBytes * 8 * 0.9;
  const audioKbps = 128;
  let videoKbps = Math.floor(budgetBits / 1000 / duration) - audioKbps;
  // Don't drop below a floor that still looks acceptable; if the clip is so
  // long that even the floor overshoots, the post-encode size check catches it.
  if (videoKbps < 500) videoKbps = 500;

  const maxrate = Math.floor(videoKbps * 1.45);
  const bufsize = Math.floor(videoKbps * 2);

  const args = [
    "-y", "-i", srcPath,
    "-c:v", "libx264", "-preset", "veryfast",
    "-b:v", `${videoKbps}k`,
    "-maxrate", `${maxrate}k`,
    "-bufsize", `${bufsize}k`,
    "-c:a", "aac", "-b:a", `${audioKbps}k`,
    "-movflags", "+faststart",
    outPath,
  ];
  await execFileAsync("ffmpeg", args, { timeout: 900000 });

  if (fs.existsSync(outPath) && fs.statSync(outPath).size <= maxBytes) {
    return outPath;
  }
  return null;
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

/**
 * Extract the original audio track from a video into a standalone MP3. Used by
 * the "No Voiceover" variant: instead of generating a TTS voiceover, we keep
 * the clip's real audio (singing, speech, crowd) as the soundtrack, and the
 * captions are produced by transcribing this audio downstream.
 */
export async function extractAudio(
  videoPath: string,
  outputPath: string
): Promise<void> {
  const args = [
    "-y",
    "-i", videoPath,
    "-vn",                     // drop the video stream
    "-acodec", "libmp3lame",
    "-q:a", "2",               // ~190kbps VBR — plenty for transcription + playback
    "-ac", "2",
    "-ar", "44100",
    outputPath,
  ];
  await execFileAsync("ffmpeg", args, { timeout: 300000 });
}

export async function mixAudio(
  voiceoverPath: string,
  bgMusicPath: string,
  outputPath: string,
  voiceoverDuration: number,
  // Defaults preserve the original Automated Shorts mix (quiet TTS boosted,
  // music ducked). The No-Voiceover variant overrides these because its main
  // track is the clip's real (already-loud) audio, so the music must sit much
  // lower and the main track should not be boosted (avoids clipping).
  voVolumeDb: number = 10,
  bgVolumeDb: number = -10,
  // Filters applied to the music BEFORE volume (must end with a comma, or be
  // empty). Default = the original 1.1x speed-up. The No-Voiceover variant
  // passes an anti-fingerprint chain (pitch shift + tempo + EQ) so Facebook's
  // content-ID is less likely to match the track.
  bgPreFilters: string = "atempo=1.1,"
): Promise<void> {
  // No background track (e.g. Jamendo outage or a "none" profile) → just use
  // the main audio as-is, trimmed to length. Never feed ffmpeg an empty -i.
  if (!bgMusicPath || !fs.existsSync(bgMusicPath)) {
    const args = [
      "-y", "-i", voiceoverPath,
      "-filter_complex", `[0:a]volume=${voVolumeDb}dB[out]`,
      "-map", "[out]", "-t", voiceoverDuration.toString(), "-ar", "44100",
      outputPath,
    ];
    await execFileAsync("ffmpeg", args, { timeout: 300000 });
    return;
  }
  const bgChain = `[1:a]${bgPreFilters}volume=${bgVolumeDb}dB[bg]`;
  const args = [
    "-y",
    "-i", voiceoverPath,
    "-i", bgMusicPath,
    "-filter_complex", `[0:a]volume=${voVolumeDb}dB[vo];${bgChain};[vo][bg]amix=inputs=2:duration=first:dropout_transition=2[out]`,
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

    const duration = Math.max(0.25, endSeconds - startSeconds);
    const args = [
      "-y",
      "-ss", tc.start,
      "-i", sourceVideoPath,
      "-t", duration.toFixed(3),
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

/**
 * Like extractVideoSegments but KEEPS the original audio of each clip. Used by
 * the No-Voiceover variant where the real audio of the chosen moments is the
 * soundtrack (and the source of captions).
 */
export async function extractVideoSegmentsKeepAudio(
  sourceVideoPath: string,
  timecodes: Array<{ start: string; end: string }>,
  outputDir: string
): Promise<string[]> {
  const segmentPaths: string[] = [];
  for (let i = 0; i < timecodes.length; i++) {
    const tc = timecodes[i];
    const startSeconds = parseTimestampToSeconds(tc.start);
    const endSeconds = parseTimestampToSeconds(tc.end);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds - startSeconds < 0.25) {
      continue;
    }
    const outPath = path.join(outputDir, `seg_audio_${i}.mp4`);
    const duration = Math.max(0.25, endSeconds - startSeconds);
    const args = [
      "-y",
      "-ss", tc.start,
      "-i", sourceVideoPath,
      "-t", duration.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
      outPath,
    ];
    await execFileAsync("ffmpeg", args, { timeout: 120000 });
    segmentPaths.push(outPath);
  }
  if (segmentPaths.length === 0) {
    throw new Error("No valid segments were extracted (keep-audio).");
  }
  return segmentPaths;
}

/**
 * Concatenate the AUDIO of the given clips (in order) into one WAV. This is the
 * real performance audio that gets transcribed for captions and mixed with the
 * background track.
 */
export async function concatSegmentsAudio(
  segmentPaths: string[],
  outputWavPath: string
): Promise<void> {
  if (segmentPaths.length === 0) throw new Error("No segments to concat audio from");
  const args: string[] = ["-y"];
  for (const p of segmentPaths) args.push("-i", p);
  const inputs = segmentPaths.map((_, i) => `[${i}:a]`).join("");
  const filter = `${inputs}concat=n=${segmentPaths.length}:v=0:a=1[a]`;
  args.push(
    "-filter_complex", filter,
    "-map", "[a]",
    "-ar", "44100", "-ac", "2",
    outputWavPath,
  );
  await execFileAsync("ffmpeg", args, { timeout: 300000 });
}

function assTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
}

function wrapWords(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.length ? lines : [text.slice(0, maxChars)];
}

// Rounded rectangle in POSITIVE coords (0,0)→(w,h). With \an5\pos libass
// centers the bounding box on \pos, so a same-\pos text event lands centered.
function roundedRectPath(w: number, h: number, r: number): string {
  const R = (n: number) => Math.round(n);
  return [
    `m ${R(r)} 0`,
    `l ${R(w - r)} 0`,
    `b ${R(w)} 0 ${R(w)} ${R(r)} ${R(w)} ${R(r)}`,
    `l ${R(w)} ${R(h - r)}`,
    `b ${R(w)} ${R(h)} ${R(w - r)} ${R(h)} ${R(w - r)} ${R(h)}`,
    `l ${R(r)} ${R(h)}`,
    `b 0 ${R(h)} 0 ${R(h - r)} 0 ${R(h - r)}`,
    `l 0 ${R(r)}`,
    `b 0 0 ${R(r)} 0 ${R(r)} 0`,
  ].join(" ");
}

/**
 * Append the animated TOP HOOK card: a white rounded card with a bold purple
 * clickbait headline that bounce-pops in at the start and stays static for the
 * whole video. Rendered above captions.
 */
/** Convert an RGB hex ("A020F0") to an ASS BGR hex ("F020A0"). */
function rgbToAssBgr(rgb: string): string {
  const h = (rgb || "").replace(/[^0-9a-fA-F]/g, "").padStart(6, "0").slice(0, 6);
  return (h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toUpperCase();
}

export function appendTopHookToAss(
  assContent: string,
  rawText: string,
  totalDurationSec: number,
  textColorRgb?: string
): string {
  const text = (rawText || "").replace(/[{}\\]/g, "").trim().toUpperCase();
  if (!text) return assContent;
  // Headline text color (default purple). Different defaults for VO vs NV come
  // from the variant profile.
  const bgr = rgbToAssBgr(textColorRgb || "A020F0");

  const fontSize = 52;
  const maxChars = 20;
  const maxLines = 5;
  const lines = wrapWords(text, maxChars, maxLines);
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);

  const charW = 30;
  const padX = 46;
  const padY = 34;
  const lineH = Math.round(fontSize * 1.18);
  const cardW = Math.max(620, Math.min(1010, longest * charW + padX * 2));
  const cardH = lines.length * lineH + padY * 2;
  const topY = 18;
  const cy = topY + Math.round(cardH / 2);

  const endStr = assTime(totalDurationSec);
  // Identical bounce transform on card + text so they scale together.
  const anim = `\\fad(120,0)\\fscx16\\fscy16\\t(0,170,\\fscx112\\fscy112)\\t(170,340,\\fscx100\\fscy100)`;

  const card =
    `Dialogue: 5,0:00:00.00,${endStr},Default,,0,0,0,,` +
    `{\\an5\\pos(540,${cy})\\bord0\\shad8\\4c&H000000&\\4a&H80&\\1c&H00FFFFFF&${anim}\\p1}` +
    `${roundedRectPath(cardW, cardH, 36)}{\\p0}`;

  const label =
    `Dialogue: 6,0:00:00.00,${endStr},Default,,0,0,0,,` +
    `{\\an5\\pos(540,${cy})\\q2\\fs${fontSize}\\b1\\bord0\\shad0\\1c&H00${bgr}&${anim}}` +
    lines.join("\\N");

  const base = assContent.endsWith("\n") ? assContent : assContent + "\n";
  return base + card + "\n" + label + "\n";
}

/**
 * Append an animated "Full video in the comments" outro to an ASS subtitle
 * string. Renders a translucent band + bold white text that fades/pops in over
 * the final ~2.5s of the video.
 */
export function appendOutroToAss(
  assContent: string,
  totalDurationSec: number,
  text: string = "Full video in the comments"
): string {
  const dur = 2.6;
  const start = Math.max(0, totalDurationSec - dur);
  const startStr = assTime(start);
  const endStr = assTime(totalDurationSec);

  const upper = (text || "").replace(/[{}\\]/g, "").trim().toUpperCase();
  const lines = wrapWords(upper, 15, 3);
  const fontSize = 60;
  const lineH = Math.round(fontSize * 1.18);
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);

  // Card holds the text block + a drawn down-arrow below it.
  const padX = 50;
  const padY = 40;
  const arrowH = 54;
  const gap = 18;
  const textH = lines.length * lineH;
  const cardW = Math.max(560, Math.min(960, longest * 34 + padX * 2));
  const cardH = textH + gap + arrowH + padY * 2;
  const cy = 960; // vertical center of the 1080×1920 frame
  const textCy = cy - Math.round((arrowH + gap) / 2);
  const arrowCy = textCy + Math.round(textH / 2) + gap + Math.round(arrowH / 2);

  // Identical pop-in so card, text and arrow animate together.
  const anim = `\\fad(220,180)\\fscx20\\fscy20\\t(0,170,\\fscx110\\fscy110)\\t(170,330,\\fscx100\\fscy100)`;

  // Rounded translucent dark card (centered via \an5 + positive-coord path).
  const card =
    `Dialogue: 5,${startStr},${endStr},Default,,0,0,0,,` +
    `{\\an5\\pos(540,${cy})\\bord0\\shad6\\4c&H000000&\\4a&H70&\\1c&H101010&\\1a&H22&${anim}\\p1}` +
    `${roundedRectPath(cardW, cardH, 34)}{\\p0}`;

  const label =
    `Dialogue: 6,${startStr},${endStr},Default,,0,0,0,,` +
    `{\\an5\\pos(540,${textCy})\\q2\\fs${fontSize}\\b1\\bord0\\shad0\\1c&HFFFFFF&${anim}}` +
    lines.join("\\N");

  // Down-arrow drawing (white, shaft + head), centered below the text.
  const arrow =
    `Dialogue: 6,${startStr},${endStr},Default,,0,0,0,,` +
    `{\\an5\\pos(540,${arrowCy})\\bord0\\shad0\\1c&HFFFFFF&${anim}\\p1}` +
    `m 24 0 l 40 0 l 40 30 l 56 30 l 32 58 l 8 30 l 24 30{\\p0}`;

  const base = assContent.endsWith("\n") ? assContent : assContent + "\n";
  return base + card + "\n" + label + "\n" + arrow + "\n";
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
      "-r", "30",
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
  logoPosition: LogoPosition = "top-right",
  logoLayout: LogoLayout | null = null,
  // Uniqueization: horizontally mirror the video and/or add faint temporal
  // noise so the output differs from the source / other reposts. Applied to the
  // BASE only — captions and logo are overlaid afterwards so they stay readable
  // and correctly oriented. null = no uniqueization.
  uniquify: { mirror: boolean; noise: number } | null = null
): Promise<void> {
  console.log(`[createSandwichVideo] isVerticalSource=${isVerticalSource}, cropType=${cropType}, logoPosition=${logoPosition}, uniquify=${JSON.stringify(uniquify)}`);
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
      ? `[0:v]fps=30,${initialCrop}scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[base]`
      : `[0:v]fps=30,${initialCrop}split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[blurred];[fg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1080:1080:(iw-1080)/2:(ih-1080)/2,setsar=1[scaled];[blurred][scaled]overlay=0:(H-h)/2[base]`;

    const safeSubPath = subtitlePath ? escapeFilterPath(subtitlePath) : null;

    let finalFilter = baseFilter;
    let outLabel = "[base]";
    // Mirror + faint noise on the base video only (before logo/captions).
    let B = "[base]";
    const doUniquify = !!uniquify && (uniquify.mirror || uniquify.noise > 0);
    if (doUniquify) {
      const steps: string[] = [];
      if (uniquify!.mirror) steps.push("hflip");
      if (uniquify!.noise > 0) steps.push(`noise=alls=${Math.round(uniquify!.noise)}:allf=t`);
      finalFilter += `;[base]${steps.join(",")}[baseu]`;
      B = "[baseu]";
    }

    // Logo placement: prefer an explicit visual layout (position/size/opacity
    // on the 1080×1920 canvas). Falls back to the legacy 30px-inset corner.
    const buildLogo = (): { chain: string; overlay: string } => {
      if (logoLayout) {
        const W = Math.max(20, Math.round((logoLayout.widthPct ?? 0.3) * 1080));
        const X = Math.round((logoLayout.xPct ?? 0) * 1080);
        const Y = Math.round((logoLayout.yPct ?? 0) * 1920);
        const op = Math.max(0, Math.min(1, logoLayout.opacity ?? 1));
        return {
          chain: `[2:v]scale=${W}:-1,format=rgba,colorchannelmixer=aa=${op}[logo]`,
          overlay: `${B}[logo]overlay=${X}:${Y}`,
        };
      }
      const logoXY = logoPosition === "top-left" ? "30:30" : "W-w-30:30";
      return { chain: `[2:v]scale=120:-1[logo]`, overlay: `${B}[logo]overlay=${logoXY}` };
    };

    if (logoPath && safeSubPath) {
      const { chain, overlay } = buildLogo();
      finalFilter += `;${chain};${overlay},ass='${safeSubPath}'[final]`;
      outLabel = "[final]";
    } else if (safeSubPath) {
      finalFilter += `;${B}ass='${safeSubPath}'[final]`;
      outLabel = "[final]";
    } else if (logoPath) {
      const { chain, overlay } = buildLogo();
      finalFilter += `;${chain};${overlay}[final]`;
      outLabel = "[final]";
    } else if (doUniquify) {
      // No logo/subs but still uniqueized — output the mirrored/noised base.
      outLabel = B;
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
      // Place the moov atom at the front so the mp4 is progressively
      // streamable. Without this the moov lands at the end and Telegram (and
      // web <video>) can't start playback until the whole file downloads — the
      // delivered short would not preview/play inline.
      "-movflags", "+faststart",
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
  let endSec = parseTimestampToSeconds(end);
  // The AI sometimes returns a hook BEYOND the video or an inverted range
  // (start > end) → a negative -t that makes ffmpeg fail and kills the whole
  // project. Clamp to the real length and reject anything still invalid.
  let videoDuration = 0;
  try { videoDuration = await getMediaDuration(sourceVideoPath); } catch {}
  if (videoDuration > 0) endSec = Math.min(endSec, videoDuration);
  const duration = endSec - startSec;
  if (!(startSec >= 0 && duration >= 0.5 && (videoDuration === 0 || startSec < videoDuration))) {
    throw new Error(`Invalid hook segment (start=${startSec}s end=${endSec}s, video=${videoDuration}s)`);
  }

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
    
    // 3) Background Music: tempo, volume (kept quiet under the voiceover), conform, pad
    `[2:a]atempo=1.1,volume=-20dB,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[bg_padded]`,
    
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
