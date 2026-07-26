// One-off watcher: waits until today's resumed Automated Shorts batch is fully
// done (no project left in 'processing'), then sends ONE Telegram message with
// the final tally to the admin, and exits. Standalone: only pg + https + dotenv
// (no tsx/venv/app needed). Launch detached:
//   node script/notify-resume-done.cjs
try { require("dotenv").config(); } catch (_) {}
const { Pool } = require("pg");
const https = require("https");
const { execSync } = require("child_process");

const POLL_MS = 30_000;
const MAX_WAIT_MS = 8 * 60 * 60 * 1000; // 8h safety cap
const CHAT_USER_ID = 1; // admin (the requester)

function freeGB() {
  try {
    const line = execSync("df -kP /").toString().trim().split("\n").pop();
    return (Number(line.split(/\s+/)[3]) / (1024 * 1024)).toFixed(0);
  } catch { return "?"; }
}
function resumeAlive() {
  try {
    const out = execSync('pgrep -f "resume-today.ts" || true').toString().trim();
    return out.length > 0;
  } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendTelegram(token, chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 20000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (j.ok) resolve(true);
            else reject(new Error("Telegram API: " + (j.description || data)));
          } catch (e) { reject(new Error("Bad TG response: " + data.slice(0, 200))); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("TG request timeout")));
    req.write(body);
    req.end();
  });
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error("[notify] No TELEGRAM_BOT_TOKEN"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Freeze the batch = today's automated project IDs that exist right now. New
  // submissions (higher ids) are excluded so they don't delay the notification.
  const { rows: idRows } = await pool.query(
    `select id from projects where created_at >= date_trunc('day', now()) and project_type='automated' order by id`
  );
  const targetIds = idRows.map((r) => r.id);
  const total = targetIds.length;

  const { rows: cRows } = await pool.query(
    `select coalesce(telegram_chat_id,'') chat from users where id=$1`, [CHAT_USER_ID]
  );
  const chatId = (cRows[0] && cRows[0].chat) || "";
  if (!chatId) { console.error("[notify] admin has no telegram_chat_id"); process.exit(1); }

  console.log(`[notify] watching ${total} projects; poll ${POLL_MS / 1000}s`);

  // Startup ping — confirms Telegram delivery works and that the watcher is armed.
  try {
    await sendTelegram(
      token,
      chatId,
      `🔔 Слежу за возобновлением (${total} видео). Пришлю сообщение, когда все будут готовы.`
    );
    console.log("[notify] startup ping sent");
  } catch (e) {
    console.error("[notify] startup ping failed:", e.message);
  }

  const start = Date.now();
  let stale = 0;
  let reason = "timeout";
  while (Date.now() - start < MAX_WAIT_MS) {
    const { rows } = await pool.query(
      `select status, count(*)::int c from projects where id = ANY($1::int[]) group by status`,
      [targetIds]
    );
    const by = {};
    rows.forEach((r) => (by[r.status] = r.c));
    const processing = by["processing"] || 0;
    console.log(`[notify] complete=${by["complete"] || 0} failed=${by["failed"] || 0} processing=${processing}/${total}`);

    if (processing === 0) { reason = "clean"; break; }
    // If the resume worker died but items are still 'processing', they're stuck
    // (e.g. disk guard stopped feeding). Confirm across 2 polls, then report.
    if (!resumeAlive()) { if (++stale >= 2) { reason = "stuck"; break; } }
    else stale = 0;

    await sleep(POLL_MS);
  }

  const { rows: fin } = await pool.query(
    `select status, count(*)::int c from projects where id = ANY($1::int[]) group by status`,
    [targetIds]
  );
  const by = {};
  fin.forEach((r) => (by[r.status] = r.c));
  const complete = by["complete"] || 0;
  const failed = by["failed"] || 0;
  const processing = by["processing"] || 0;

  let head =
    reason === "clean" ? "✅ *Возобновление завершено!*"
    : reason === "stuck" ? "⚠️ *Батч остановился* (часть застряла)"
    : "⏱ *Прошло 8ч — отчёт по батчу*";

  const lines = [
    head,
    "",
    "Сегодняшние Automated Shorts:",
    `• Готово: *${complete}*`,
    `• Не удалось: *${failed}*`,
  ];
  if (processing > 0) lines.push(`• Осталось в работе: *${processing}*`);
  lines.push("", `Всего в батче: ${total}`, `Диск свободно: ${freeGB()}G`);
  const text = lines.join("\n");

  let sent = false;
  for (let i = 0; i < 3 && !sent; i++) {
    try { await sendTelegram(token, chatId, text); sent = true; }
    catch (e) { console.error(`[notify] send attempt ${i + 1} failed:`, e.message); await sleep(5000); }
  }
  await pool.end();
  console.log(`[notify] done reason=${reason} sent=${sent} (complete=${complete} failed=${failed} processing=${processing})`);
  process.exit(sent ? 0 : 1);
}

main().catch((e) => { console.error("[notify] FATAL", e); process.exit(1); });
