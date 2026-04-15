import { db } from "../db";
import { elevenLabsSettings } from "@shared/schema";
import { eq } from "drizzle-orm";

export type ElevenLabsPlan = "free" | "paid";

export async function getElevenLabsSettings() {
  const rows = await db.select().from(elevenLabsSettings).limit(1);
  const row = rows[0];
  if (!row) {
    return {
      hasKey: false,
      plan: "free" as ElevenLabsPlan,
      keyLabel: null as string | null,
    };
  }
  return {
    hasKey: true,
    plan: (row.plan as ElevenLabsPlan) ?? ("free" as ElevenLabsPlan),
    keyLabel: row.keyLabel ?? null,
  };
}

export async function upsertElevenLabsSettings(input: {
  apiKey: string;
  plan: ElevenLabsPlan;
  keyLabel?: string | null;
}) {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("apiKey is required");
  }
  const plan = input.plan || "free";
  const keyLabel =
    typeof input.keyLabel === "string" ? input.keyLabel.trim() : null;

  const rows = await db.select().from(elevenLabsSettings).limit(1);
  const existing = rows[0];
  if (existing) {
    await db
      .update(elevenLabsSettings)
      .set({ apiKey, plan, keyLabel })
      .where(eq(elevenLabsSettings.id, existing.id));
  } else {
    await db.insert(elevenLabsSettings).values({ apiKey, plan, keyLabel });
  }
}

export async function getActiveElevenLabsKey(): Promise<{
  apiKey: string;
  plan: ElevenLabsPlan;
}> {
  const rows = await db.select().from(elevenLabsSettings).limit(1);
  const row = rows[0];
  if (!row || !row.apiKey.trim()) {
    throw new Error(
      "ElevenLabs API key is not configured. Open the ElevenLabs page and save your key first.",
    );
  }
  return {
    apiKey: row.apiKey.trim(),
    plan: (row.plan as ElevenLabsPlan) ?? ("free" as ElevenLabsPlan),
  };
}

