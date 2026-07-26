import { db } from "../db";
import { bgMusicAssets, logoAssets } from "@shared/schema";
import { eq, desc, or, isNull } from "drizzle-orm";

export async function getBgMusicAssets() {
  return db.select().from(bgMusicAssets).orderBy(desc(bgMusicAssets.createdAt));
}

export async function addBgMusicAsset(name: string, filePath: string, mood?: string | null) {
  const [row] = await db.insert(bgMusicAssets).values({ name, filePath, mood: mood || null }).returning();
  return row;
}

export async function getBgMusicAssetById(id: number) {
  const [row] = await db.select().from(bgMusicAssets).where(eq(bgMusicAssets.id, id));
  return row;
}

export async function updateBgMusicAssetMood(id: number, mood: string | null) {
  const [row] = await db.update(bgMusicAssets).set({ mood: mood || null }).where(eq(bgMusicAssets.id, id)).returning();
  return row;
}

export async function deleteBgMusicAsset(id: number) {
  await db.delete(bgMusicAssets).where(eq(bgMusicAssets.id, id));
}

/**
 * Pick a RANDOM background-music asset matching the given mood, for the
 * Factory's AI-mood-matched auto music. Untagged tracks (mood = null) are
 * eligible for any mood as a fallback. Returns null when the library is empty.
 */
export async function getRandomBgMusicByMood(mood: string | null) {
  let rows = mood
    ? await db.select().from(bgMusicAssets).where(or(eq(bgMusicAssets.mood, mood), isNull(bgMusicAssets.mood)))
    : await db.select().from(bgMusicAssets);
  // Prefer an exact mood match; fall back to untagged if no exact match exists.
  if (mood) {
    const exact = rows.filter((r) => r.mood === mood);
    if (exact.length) rows = exact;
  }
  if (rows.length === 0) {
    // Last resort: any track at all.
    rows = await db.select().from(bgMusicAssets);
  }
  if (rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)];
}

export async function getLogoAssets() {
  return db.select().from(logoAssets).orderBy(desc(logoAssets.createdAt));
}

export async function addLogoAsset(name: string, filePath: string) {
  const [row] = await db.insert(logoAssets).values({ name, filePath }).returning();
  return row;
}

export async function getLogoAssetById(id: number) {
  const [row] = await db.select().from(logoAssets).where(eq(logoAssets.id, id));
  return row;
}

export async function deleteAllBgMusicAssets() {
  await db.delete(bgMusicAssets);
}

export async function deleteAllLogoAssets() {
  await db.delete(logoAssets);
}
