import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function buildUrl(absPath: string): string | null {
  const base = (process.env.APP_PUBLIC_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (!base) return null;
  const cwd = process.cwd();
  const abs = path.resolve(absPath);
  for (const dir of ["uploads", "downloads", "outputs"]) {
    const root = path.join(cwd, dir);
    if (abs.startsWith(root + path.sep) || abs === root) {
      const rel = path.relative(root, abs).split(path.sep).map(encodeURIComponent).join("/");
      return `${base}/${dir}/${rel}`;
    }
  }
  return null;
}

/**
 * Convert an absolute path on the server (uploads/, downloads/, outputs/) into
 * a publicly reachable HTTPS URL that OpenRouter — and the underlying provider
 * (Gemini, etc.) — can fetch directly, avoiding base64-encoding every request.
 *
 * Google AI Studio REJECTS .mkv (matroska) videos ("INVALID_ARGUMENT"), so if
 * the file is .mkv we remux it to .mp4 (fast stream copy; re-encode only if
 * copy fails) and return the URL of the mp4. The remux is cached on disk.
 *
 * Returns null when the file lives outside any served directory, or when
 * APP_PUBLIC_URL is not configured.
 */
export async function toPublicMediaUrl(localPath: string): Promise<string | null> {
  const base = (process.env.APP_PUBLIC_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (!base) return null;

  let abs = path.resolve(localPath);

  if (/\.mkv$/i.test(abs) && fs.existsSync(abs)) {
    const mp4 = abs.replace(/\.mkv$/i, ".gem.mp4");
    if (fs.existsSync(mp4) && fs.statSync(mp4).size > 0) {
      abs = mp4;
    } else {
      try {
        // Fast path: just swap the container (codecs untouched).
        await execFileAsync("ffmpeg", ["-y", "-i", abs, "-c", "copy", "-movflags", "+faststart", mp4], { timeout: 180000 });
        abs = mp4;
      } catch {
        try {
          // Fallback: re-encode to a Gemini-friendly mp4.
          await execFileAsync("ffmpeg", ["-y", "-i", abs, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-c:a", "aac", "-movflags", "+faststart", mp4], { timeout: 900000 });
          abs = mp4;
        } catch {
          // Could not produce mp4 → fall through (caller's base64 path handles it).
          return null;
        }
      }
    }
  }

  return buildUrl(abs);
}
