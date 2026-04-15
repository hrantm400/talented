import { db } from "../db";
import { bgMusicAssets, logoAssets } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

export async function getBgMusicAssets() {
  return db.select().from(bgMusicAssets).orderBy(desc(bgMusicAssets.createdAt));
}

export async function addBgMusicAsset(name: string, filePath: string) {
  const [row] = await db.insert(bgMusicAssets).values({ name, filePath }).returning();
  return row;
}

export async function getBgMusicAssetById(id: number) {
  const [row] = await db.select().from(bgMusicAssets).where(eq(bgMusicAssets.id, id));
  return row;
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
