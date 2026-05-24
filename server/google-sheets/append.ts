import { google } from "googleapis";
import fs from "fs";
import type { User } from "@shared/schema";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
// Layout was 8 columns (A:H) with a "NEW/Clear" column at D for the no-subs
// download URL. The clear variant is no longer produced, but we keep the
// 8-column shape so existing sheets don't shift column-wise — column D is
// just left blank on new rows. The header is renamed accordingly so
// nothing in the sheet still says "Clear".
const RANGE = "Sheet1!A:H";
const HEADER_RANGE = "Sheet1!A1:H1";
const HEADERS = [
  "original",
  "NICHE",
  "REEL",
  "",
  "english/captions",
  "Text captior",
  "Date",
  "COMMENTS",
];

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
};

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

  const row = [
    project.originalVideoUrl ?? "",
    project.name,
    project.shortVideoUrl ?? "",
    "", // (was clearUrl — clear variant removed)
    captionUrl,
    transcriptionText,
    date,
    "",
  ];

  try {
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: HEADER_RANGE,
    });
    const firstCell = headerRes.data.values?.[0]?.[0];
    const fourthCell = headerRes.data.values?.[0]?.[3];
    // Rewrite the header row when it's missing OR when it still has the
    // stale "NEW/Clear" label at column D.
    if (firstCell !== "original" || fourthCell === "NEW/Clear") {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: HEADER_RANGE,
        valueInputOption: "RAW",
        requestBody: { values: [HEADERS] },
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: RANGE,
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
  } catch (e) {
    console.error("[Google Sheets] appendVideoRow failed:", e);
  }
}
