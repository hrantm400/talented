import { google } from "googleapis";
import fs from "fs";
import { db } from "../db";
import { globalSettings, PROJECT_TYPES } from "@shared/schema";
import type { User } from "@shared/schema";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
// Clean 7-column layout (A:G), kept sorted by source № then variant. The
// worksheet/tab is chosen per project (factory NV/VO → separate fresh tabs).
const DEFAULT_TAB = "Sheet1";
const HEADERS = [
  "№",
  "Original",
  "Created video",
  "Variant",
  "Voiceover text",
  "Date",
  "Music",
  "Taken",
  "Taken at",
];

// Auto-timestamp for the "Taken at" column (I). Position-independent (uses
// ROW()/INDIRECT) so it survives sorting, and self-references its own cell so
// the stamp is STATIC: when the H checkbox is ticked it writes the current
// date/time once; when unticked it clears. Requires iterative calculation
// (enabled per spreadsheet in setupTakenColumn).
const TAKEN_AT_FORMULA =
  '=IF(INDIRECT("H"&ROW())<>TRUE, "", IF(ISNUMBER(SEARCH(":", INDIRECT("I"&ROW()))), INDIRECT("I"&ROW()), TEXT(NOW(),"dd.mm.yyyy hh:mm")))';

function getAuth(user?: User | null): { auth: InstanceType<typeof google.auth.GoogleAuth>; sheetId: string } | null {
  const sheetId = user?.googleSheetId || process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return null;

  let credsBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (user?.googleSheetId && user?.googleServiceAccountJson) {
    credsBase64 = user.googleServiceAccountJson;
  }
  
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  let credentials: object;
  if (credsBase64) {
    try {
      const json = Buffer.from(credsBase64, "base64").toString("utf8");
      credentials = JSON.parse(json);
    } catch {
      try {
        // Fallback in case user stored raw JSON instead of base64
        credentials = JSON.parse(credsBase64);
      } catch {
        console.error("[Google Sheets] Invalid GOOGLE_SERVICE_ACCOUNT_JSON (expected base64 or raw JSON)");
        return null;
      }
    }
  } else if (credsPath) {
    try {
      const json = fs.readFileSync(credsPath, "utf8");
      credentials = JSON.parse(json);
    } catch (e) {
      console.error("[Google Sheets] Failed to read GOOGLE_APPLICATION_CREDENTIALS:", e);
      return null;
    }
  } else {
    return null;
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [SCOPE],
  });
  return { auth, sheetId };
}

type ProjectForSheet = {
  id: number;
  name: string;
  originalVideoUrl?: string | null;
  shortVideoUrl?: string | null;
  transcription?: unknown;
  musicAttribution?: string | null;
  projectType?: string;
  batchId?: string | null;
  sheetSourceNumber?: number | null;
  sheetVariantLabel?: string | null;
};

/**
 * Pick the worksheet tab for this project. Every kind of output gets its own
 * tab so nothing dumps into one sheet:
 *   - Factory voiceover / no-voiceover → VO / NV (configurable, numbered+sorted)
 *   - Standalone Automated Shorts (voiceover) → "Automated VO"
 *   - Standalone Automated Shorts No Voiceover → "Automated NV"
 *   - Classic Auto-Shorts → "Classic"
 */
export async function resolveSheetTab(project: ProjectForSheet): Promise<string> {
  const isNV = project.projectType === PROJECT_TYPES.AUTOMATED_NO_VOICEOVER;
  if (project.batchId) {
    // Factory output → its configurable tabs.
    try {
      const [g] = await db.select().from(globalSettings).limit(1);
      if (isNV) return g?.factorySheetTabNv?.trim() || "NV";
      return g?.factorySheetTabVo?.trim() || "VO";
    } catch {
      return isNV ? "NV" : "VO";
    }
  }
  // Standalone pages → their own dedicated tabs.
  if (isNV) return "old automated short nv";
  if (project.projectType === PROJECT_TYPES.AUTOMATED) return "old automated short vo";
  if (project.projectType === PROJECT_TYPES.CLASSIC) return "Classic";
  return DEFAULT_TAB;
}

/** Whether Google Sheets is configured (so a row will actually be written). */
export function isSheetConfigured(user?: User | null): boolean {
  const sheetId = user?.googleSheetId || process.env.GOOGLE_SHEET_ID;
  const creds = (user?.googleSheetId && user?.googleServiceAccountJson) ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return !!sheetId && !!creds;
}

/**
 * Ensure the worksheet tab exists and return its numeric sheetId (needed to
 * sort it). Creates the tab if missing. Returns null on failure.
 */
async function ensureTabGetId(sheets: any, spreadsheetId: string, tab: string): Promise<number | null> {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const found = (meta.data.sheets || []).find((s: any) => s.properties?.title === tab);
    if (found) return found.properties.sheetId ?? null;
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
    return res.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;
  } catch (e) {
    console.warn(`[Google Sheets] ensureTabGetId(${tab}) failed:`, e);
    return null;
  }
}

/** Sort the tab's data rows (below the header) by № (col A) then Variant (col D).
 *  Sorts A:H so the "Taken" checkbox (col H) moves WITH its row. */
async function sortTab(sheets: any, spreadsheetId: string, sheetGid: number): Promise<void> {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          sortRange: {
            range: { sheetId: sheetGid, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 },
            sortSpecs: [
              { dimensionIndex: 0, sortOrder: "ASCENDING" },
              { dimensionIndex: 3, sortOrder: "ASCENDING" },
            ],
          },
        }],
      },
    });
  } catch (e) {
    console.warn(`[Google Sheets] sortTab failed:`, e);
  }
}

/**
 * Make column H ("Taken") a checkbox and color the whole row when it's ticked,
 * so the user can mark posts they've already used. Idempotent enough to run on
 * the (rare) header rewrite — it clears existing conditional formats on the tab
 * first to avoid stacking duplicate rules.
 */
async function setupTakenColumn(sheets: any, spreadsheetId: string, sheetGid: number): Promise<void> {
  if (sheetGid == null) return;
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // Allow the self-referencing "Taken at" timestamp formula (spreadsheet-level).
          {
            updateSpreadsheetProperties: {
              properties: { iterativeCalculationSettings: { maxIterations: 5, convergenceThreshold: 0.001 } },
              fields: "iterativeCalculationSettings",
            },
          },
          // Column H below the header → checkbox.
          {
            setDataValidation: {
              range: { sheetId: sheetGid, startRowIndex: 1, startColumnIndex: 7, endColumnIndex: 8 },
              rule: { condition: { type: "BOOLEAN" }, showCustomUi: true },
            },
          },
          // Color the whole row (A:I) light green when the checkbox (H) is TRUE.
          {
            addConditionalFormatRule: {
              index: 0,
              rule: {
                ranges: [{ sheetId: sheetGid, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 }],
                booleanRule: {
                  condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: "=$H2=TRUE" }] },
                  format: { backgroundColor: { red: 0.80, green: 0.93, blue: 0.80 } },
                },
              },
            },
          },
        ],
      },
    });
  } catch (e) {
    console.warn(`[Google Sheets] setupTakenColumn failed:`, e);
  }
}

// Serialize EVERY sheet write through one chain. Google's values.append races
// when two requests run at once (both compute the same insertion row, one
// silently overwrites the other) — exactly what happens when several projects
// finish together. This queue makes appends strictly sequential so no row is
// lost ("video created but disappeared from the sheet").
let sheetWriteChain: Promise<unknown> = Promise.resolve();
function enqueueSheetWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = sheetWriteChain.then(fn, fn);
  sheetWriteChain = run.then(() => {}, () => {});
  return run as Promise<T>;
}

export async function appendVideoRow(
  project: ProjectForSheet,
  baseUrl: string,
  user?: User | null
): Promise<void> {
  const cfg = getAuth(user);
  if (!cfg) return;

  const { auth, sheetId } = cfg;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sheets = google.sheets({ version: "v4", auth: auth as any });

  const now = new Date();
  const date =
    String(now.getDate()).padStart(2, "0") +
    "." +
    String(now.getMonth() + 1).padStart(2, "0") +
    "." +
    now.getFullYear();

  const transcriptionText = Array.isArray(project.transcription)
    ? (project.transcription as { word: string }[]).map((w) => w.word).join(" ")
    : "";

  const captionUrl = `${baseUrl.replace(/\/$/, "")}/api/projects/${project.id}/download/caption`;

  // No-Voiceover variants have no voiceover script → a dash. Voiceover variants
  // show the spoken script (from the transcription).
  const isNoVoiceover = project.projectType === PROJECT_TYPES.AUTOMATED_NO_VOICEOVER;
  const voiceoverText = isNoVoiceover ? "—" : (transcriptionText || "—");

  // № = the user's OWN number — the project NAME they typed (e.g. "1" or "1.1"),
  // with any "— Take 2 / — VO 1 / — NV 3" variant suffix stripped. The sheet is
  // ordered by THIS, so each video keeps its own place regardless of the order
  // they finish in or whether some failed. Written as a real number when numeric
  // so Google Sheets sorts it correctly (1, 2, 10 — not 1, 10, 2).
  const baseName = String(project.name || "").replace(/\s*[—–-]\s*(take|vo|nv)\s*\d+\s*$/i, "").trim();
  const numberCell: string | number = /^\d+(\.\d+)?$/.test(baseName)
    ? Number(baseName)
    : (project.sheetSourceNumber ?? baseName);

  const row = [
    numberCell,                                                        // № (the user's number → sorts numerically)
    project.originalVideoUrl ?? "",                                    // Original (source)
    captionUrl,                                                        // Created video
    project.sheetVariantLabel ?? project.name,                        // Variant ("voiceover 1" / "no voiceover 1")
    voiceoverText,                                                     // Voiceover text (— for NV)
    date,                                                              // Date
    project.musicAttribution ?? "—",                                  // Music
    false,                                                             // Taken (checkbox — tick to mark "used")
  ];

  // All Google-Sheets API work runs through the serial queue so two projects
  // finishing at the same time can never race the append (and lose a row).
  await enqueueSheetWrite(async () => {
    try {
      const tab = await resolveSheetTab(project);
      const sheetGid = await ensureTabGetId(sheets, sheetId, tab);
      const RANGE = `${tab}!A:H`;
      const HEADER_RANGE = `${tab}!A1:I1`;

      const headerRes = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: HEADER_RANGE,
      });
      const hdr = headerRes.data.values?.[0] || [];
      // Rewrite the header (and (re)install the checkbox + row-color + iterative
      // calc) when it's missing or on an older layout (no "Taken at" column).
      if (hdr[0] !== "№" || hdr[8] !== "Taken at") {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: HEADER_RANGE,
          valueInputOption: "RAW",
          requestBody: { values: [HEADERS] },
        });
        await setupTakenColumn(sheets, sheetId, sheetGid as number);
      }

      const appendRes = await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: RANGE,
        valueInputOption: "RAW",
        // INSERT_ROWS (not the default OVERWRITE) so a concurrent edit can't
        // make two appends target the same row.
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [row] },
      });

      // Put the auto-timestamp formula in column I of the new row (so when the
      // user ticks the H checkbox, the date/time it was taken appears, and
      // clears if unticked). USER_ENTERED so it's parsed as a formula.
      const updatedRange: string = appendRes.data.updates?.updatedRange || "";
      const rowMatch = updatedRange.match(/![A-Z]+(\d+):/);
      if (rowMatch) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: `${tab}!I${rowMatch[1]}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[TAKEN_AT_FORMULA]] },
        });
      }

      // Keep the tab ordered by № → variant (so each video sits in its own place
      // by the user's number, not by the order it finished or whether some failed).
      if (sheetGid != null && (project.sheetSourceNumber != null || project.sheetVariantLabel != null)) {
        await sortTab(sheets, sheetId, sheetGid);
      }
    } catch (e) {
      console.error("[Google Sheets] appendVideoRow failed:", e);
    }
  });
}
