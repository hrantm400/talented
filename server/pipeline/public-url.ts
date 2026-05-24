import path from "path";

/**
 * Convert an absolute path on the server (uploads/, downloads/, outputs/) into
 * a publicly reachable HTTPS URL that OpenRouter — and the underlying provider
 * (Gemini, GPT-4o, etc.) — can fetch directly. This is how we avoid base64-
 * encoding multi-MB video files into every chat request.
 *
 * Returns null when the file lives outside any served directory, or when
 * APP_PUBLIC_URL is not configured.
 */
export function toPublicMediaUrl(localPath: string): string | null {
  const base = (process.env.APP_PUBLIC_URL || process.env.BASE_URL || "").replace(/\/$/, "");
  if (!base) return null;

  const cwd = process.cwd();
  const abs = path.resolve(localPath);

  for (const dir of ["uploads", "downloads", "outputs"]) {
    const root = path.join(cwd, dir);
    if (abs.startsWith(root + path.sep) || abs === root) {
      const rel = path.relative(root, abs).split(path.sep).map(encodeURIComponent).join("/");
      return `${base}/${dir}/${rel}`;
    }
  }
  return null;
}
