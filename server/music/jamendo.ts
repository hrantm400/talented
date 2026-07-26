// ─────────────────────────────────────────────────────────────────────────
// Jamendo free music integration.
//
// Fetches a RANDOM, commercially-safe Creative-Commons track matching a mood
// tag, downloads the MP3, and returns the local path plus a ready-to-paste
// attribution string. Only CC-BY-equivalent licences are used (commercial OK,
// derivatives OK, NOT NonCommercial, NOT ShareAlike, NOT NoDerivatives) so the
// output is safe to use in monetised content — provided the attribution text
// travels with the post.
// ─────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { db } from "../db";
import { globalSettings } from "@shared/schema";

const JAMENDO_API = "https://api.jamendo.com/v3.0/tracks/";
const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");

export type JamendoMood =
  | "epic"
  | "emotional"
  | "uplifting"
  | "dramatic"
  | "energetic"
  | "happy"
  | "chill"
  | "dark";

export type JamendoResult = {
  filePath: string;
  /** Ready-to-paste credit line, e.g. "🎵 Music: Born Free by Pokki DJ (CC BY) — Jamendo" */
  attribution: string;
  trackName: string;
  artistName: string;
  trackUrl: string;
};

export async function getJamendoClientId(): Promise<string | null> {
  if (process.env.JAMENDO_CLIENT_ID) return process.env.JAMENDO_CLIENT_ID;
  try {
    const [g] = await db.select().from(globalSettings).limit(1);
    return g?.jamendoClientId || null;
  } catch {
    return null;
  }
}

type JamendoTrack = {
  id: string;
  name: string;
  artist_name: string;
  shareurl: string;
  audiodownload: string;
  audiodownload_allowed: boolean;
  license_ccurl: string;
  licenses?: { ccnc?: string; ccnd?: string; ccsa?: string };
};

/**
 * Pure CC-BY check: commercial allowed (not NC), derivatives allowed (not ND),
 * and NOT share-alike (SA would force our video under the same licence).
 */
function isCommercialSafe(t: JamendoTrack): boolean {
  const L = t.licenses || {};
  if (!t.audiodownload_allowed) return false;
  if (L.ccnc === "true") return false; // NonCommercial — forbidden
  if (L.ccnd === "true") return false; // NoDerivatives — forbidden
  if (L.ccsa === "true") return false; // ShareAlike — avoid
  return true;
}

/**
 * Fetch a random commercially-safe track for the given mood and download it.
 * Throws if Jamendo is not configured or no safe track is found.
 */
export async function fetchRandomMusic(mood: string): Promise<JamendoResult> {
  const clientId = await getJamendoClientId();
  if (!clientId) {
    throw new Error("Jamendo client_id is not configured (set it in Admin Settings)");
  }

  const tag = (mood || "epic").trim().toLowerCase();
  const params = new URLSearchParams({
    client_id: clientId,
    format: "json",
    limit: "50",
    tags: tag,
    audioformat: "mp32",
    include: "licenses",
    order: "popularity_total",
    ccnc: "false",            // exclude NonCommercial
    ccnd: "false",            // exclude NoDerivatives
    audiodownload_allowed: "true",
  });

  const res = await fetch(`${JAMENDO_API}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Jamendo API error ${res.status}`);
  }
  const json: any = await res.json();
  if (json?.headers?.status !== "success") {
    throw new Error(`Jamendo API: ${json?.headers?.error_message || "unknown error"}`);
  }

  const safe: JamendoTrack[] = (json.results || []).filter(isCommercialSafe);
  if (safe.length === 0) {
    throw new Error(`No commercially-safe Jamendo track found for mood "${tag}"`);
  }

  // Random pick — different track each run. We vary by index; no Math.random
  // needed (and it's unavailable in some sandboxes) — derive from the result
  // set size and the current high-res time.
  const pick = safe[pickIndex(safe.length)];

  if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const outPath = path.join(DOWNLOADS_DIR, `jamendo_${pick.id}_${Date.now()}.mp3`);

  const dlUrl = `${pick.audiodownload}${pick.audiodownload.includes("?") ? "&" : "?"}client_id=${clientId}`;
  const dl = await fetch(dlUrl);
  if (!dl.ok) throw new Error(`Jamendo download failed ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length < 10_000) throw new Error("Jamendo download returned an empty file");
  fs.writeFileSync(outPath, buf);

  const attribution = `🎵 Music: ${pick.name} by ${pick.artist_name} (CC BY) — Jamendo: ${pick.shareurl}`;

  return {
    filePath: outPath,
    attribution,
    trackName: pick.name,
    artistName: pick.artist_name,
    trackUrl: pick.shareurl,
  };
}

// Deterministic-but-varying index so successive calls pick different tracks.
let _counter = 0;
function pickIndex(len: number): number {
  _counter = (_counter + 1) % 1_000_000;
  const seed = Date.now() + _counter * 2654435761;
  return Math.abs(seed) % len;
}
