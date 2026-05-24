import { db } from "../db";
import { globalSettings } from "@shared/schema";
import { eq } from "drizzle-orm";

export type ElevenLabsPlan = "free" | "paid";

async function getOrCreateGlobalRow() {
  const rows = await db.select().from(globalSettings).limit(1);
  if (rows[0]) return rows[0];
  const [created] = await db.insert(globalSettings).values({}).returning();
  return created;
}

export async function getElevenLabsSettings() {
  const row = (await db.select().from(globalSettings).limit(1))[0];
  if (!row) {
    return {
      hasKey: false,
      plan: "free" as ElevenLabsPlan,
      keyLabel: null as string | null,
    };
  }
  const keys = row.elevenlabsKeys || [];
  const active = keys.find((k) => k.isActive) || keys[0];
  if (active?.key) {
    return {
      hasKey: true,
      plan: (active.plan as ElevenLabsPlan) ?? "free",
      keyLabel: active.name ?? null,
    };
  }
  if (row.elevenlabsApiKey) {
    return {
      hasKey: true,
      plan: (row.elevenlabsPlan as ElevenLabsPlan) ?? "free",
      keyLabel: row.elevenlabsKeyLabel ?? null,
    };
  }
  return {
    hasKey: false,
    plan: "free" as ElevenLabsPlan,
    keyLabel: null as string | null,
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

  const existing = await getOrCreateGlobalRow();
  await db
    .update(globalSettings)
    .set({
      elevenlabsApiKey: apiKey,
      elevenlabsPlan: plan,
      elevenlabsKeyLabel: keyLabel,
      updatedAt: new Date(),
    })
    .where(eq(globalSettings.id, existing.id));
}
