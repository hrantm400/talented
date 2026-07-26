import { google } from "googleapis";
import { db } from "../server/db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

async function cleanAndFormatSheet() {
  console.log("📊 Restoring checkboxes, preserving original row data & inserting simple blank indent rows...\n");

  const [user] = await db.select().from(users).where(eq(users.id, 1));
  const sheetId = user?.googleSheetId || process.env.GOOGLE_SHEET_ID;

  if (!sheetId) {
    console.error("❌ No Google Sheet ID configured for admin user.");
    return;
  }

  let credsBase64 = user?.googleServiceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credsBase64) {
    console.error("❌ No Google Service Account credentials found.");
    return;
  }

  let credentials: any;
  try {
    const json = Buffer.from(credsBase64, "base64").toString("utf8");
    credentials = JSON.parse(json);
  } catch {
    credentials = JSON.parse(credsBase64);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const tabs = meta.data.sheets || [];

  console.log(`📋 Found ${tabs.length} tabs in spreadsheet ID: ${sheetId}\n`);

  for (const tabObj of tabs) {
    const tabName = tabObj.properties?.title;
    const sheetGid = tabObj.properties?.sheetId;
    if (!tabName) continue;

    console.log(`🔍 Processing tab: "${tabName}"...`);

    // Read all values from the tab
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tabName}'!A1:Z5000`,
    });

    const rows = res.data.values || [];
    if (rows.length <= 1) {
      console.log(`   └ Tab "${tabName}" is empty or has only header. Skipping.\n`);
      continue;
    }

    const header = rows[0];
    const dataRows = rows.slice(1);

    // Filter out previous text gap markers, keeping true data rows intact
    const cleanDataRows = dataRows.filter((r) => {
      const colA = (r[0] || "").toString().trim();
      const colB = (r[1] || "").toString().trim();
      if (!colA && !colB) return false; // remove old empty gap rows
      if (colA.includes("ПРОПУСК") || colA.includes("⚠️")) return false;
      return true;
    });

    // Deduplicate while preserving exact row arrays (including Column H Taken values)
    const seen = new Set<string>();
    const uniqueRows: any[][] = [];

    for (const r of cleanDataRows) {
      const num = (r[0] || "").toString().trim();
      const variant = (r[3] || "").toString().trim();
      const key = `${num}_${variant}`;

      if (num && seen.has(key)) {
        continue; // Skip duplicate
      }
      if (num) seen.add(key);
      uniqueRows.push(r);
    }

    // Sort by Column A (№) numerically
    uniqueRows.sort((a, b) => {
      const numA = parseInt((a[0] || "").toString().replace(/\D/g, ""), 10) || 0;
      const numB = parseInt((b[0] || "").toString().replace(/\D/g, ""), 10) || 0;
      return numA - numB;
    });

    // Detect sequence gaps and insert simple BLANK rows (no text)
    const finalRows: any[][] = [];
    let prevNum: number | null = null;

    for (let i = 0; i < uniqueRows.length; i++) {
      const row = uniqueRows[i];
      const numStr = (row[0] || "").toString().trim();
      const num = parseInt(numStr.replace(/\D/g, ""), 10);

      if (Number.isFinite(num)) {
        if (prevNum !== null && num > prevNum + 1) {
          // Insert simple blank row(s) for sequence gap
          for (let gap = prevNum + 1; gap < num; gap++) {
            finalRows.push([]); // Simple clean empty row!
          }
        }
        prevNum = num;
      }

      finalRows.push(row);
    }

    console.log(`   ├ Original rows: ${dataRows.length}`);
    console.log(`   ├ Unique rows: ${uniqueRows.length}`);
    console.log(`   └ Final rows with blank indents: ${finalRows.length}`);

    // Clear and rewrite tab content
    await sheets.spreadsheets.values.clear({
      spreadsheetId: sheetId,
      range: `'${tabName}'!A1:Z5000`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [header, ...finalRows],
      },
    });

    // Re-apply Checkbox Data Validation on Column H
    if (sheetGid != null) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: {
            requests: [
              {
                setDataValidation: {
                  range: { sheetId: sheetGid, startRowIndex: 1, startColumnIndex: 7, endColumnIndex: 8 },
                  rule: { condition: { type: "BOOLEAN" }, showCustomUi: true },
                },
              },
            ],
          },
        });
      } catch (e: any) {
        console.warn(`[Google Sheets] Checkbox validation update warning on ${tabName}:`, e.message);
      }
    }

    console.log(`✅ Tab "${tabName}" updated with checkboxes restored and clean blank indents.\n`);
  }

  console.log("🎉 Google Sheets successfully updated!");
}

cleanAndFormatSheet().catch(console.error);
