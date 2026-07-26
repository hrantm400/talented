import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { db } from "../db";
import { globalSettings, users, projects, type Project } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { compressForTelegram } from "../pipeline/ffmpeg";
import { resolveSheetTab, isSheetConfigured } from "../google-sheets/append";

let bot: TelegramBot | null = null;

export function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[telegram] No TELEGRAM_BOT_TOKEN set — bot disabled");
    return;
  }

  try {
    bot = new TelegramBot(token, { polling: true });

    bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      const name = msg.from?.first_name || "User";
      bot?.sendMessage(
        chatId,
        `👋 Hello, ${name}!\n\n` +
          `Your Chat ID: \`${chatId}\`\n\n` +
          `Copy this ID and paste it in ReelForge → Settings → Telegram, ` +
          `to receive video readiness notifications.`,
        { parse_mode: "Markdown" }
      );
    });

    bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id.toString();
      // Find user by telegram chat id
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.telegramChatId, chatId));

      if (!user) {
        bot?.sendMessage(
          msg.chat.id,
          "❓ Your Chat ID is not linked to a ReelForge account.\n" +
            "Paste it in Settings → Telegram."
        );
        return;
      }

      bot?.sendMessage(
        msg.chat.id,
        `✅ Account: ${user.displayName}\n📧 Email: ${user.email || "—"}\n🔔 Notifications: ${user.telegramNotificationsEnabled ? "Enabled" : "Disabled"}`
      );
    });

    bot.on("polling_error", (error) => {
      console.error("[telegram] Polling error:", error.message);
    });

    console.log("[telegram] Bot started (@Reelforgespace_bot)");
  } catch (error: any) {
    console.error("[telegram] Failed to start bot:", error.message);
  }
}

export function getBot(): TelegramBot | null {
  if (bot) return bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  bot = new TelegramBot(token, { polling: false });
  return bot;
}

export async function notifyUser(chatId: string, message: string) {
  const activeBot = getBot();
  if (!activeBot) return;
  try {
    await activeBot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error: any) {
    console.error(`[telegram] Failed to send to ${chatId}:`, error.message);
  }
}

// ── Batch-completion analytics ──────────────────────────────────────────────
// When a user submits many videos and the LAST one finishes (nothing left
// processing for that user), send ONE Telegram summary: how many succeeded /
// failed and why. Per-project notifications still fire on their own — this is
// the batch wrap-up. State is in-memory & per-user; a restart at most skips one
// summary. Driven by storage's terminal hook (see setProjectTerminalHook).
const batchStreak = new Map<number, Map<number, "complete" | "failed">>();
const batchDebounce = new Map<number, ReturnType<typeof setTimeout>>();
const BATCH_MIN = 2; // never summarize a single-video submission
const BATCH_SETTLE_MS = 15000; // let the queue settle before declaring "done"

export function onProjectTerminal(project: Project) {
  const activeBot = getBot();
  if (!activeBot) return;
  const userId = project.userId;
  if (userId == null) return;
  const status = project.status === "complete" ? "complete" : "failed";
  let m = batchStreak.get(userId);
  if (!m) { m = new Map(); batchStreak.set(userId, m); }
  m.set(project.id, status);
  const prev = batchDebounce.get(userId);
  if (prev) clearTimeout(prev);
  batchDebounce.set(
    userId,
    setTimeout(() => {
      flushBatch(userId).catch((e) => console.error("[batch-report] flush failed:", e));
    }, BATCH_SETTLE_MS)
  );
}

function categorizeFailure(msg: string | null | undefined): string {
  const m = (msg || "").toLowerCase();
  if (/prohibited_content|blocked the request|safety/.test(m)) return "Gemini заблокировал контент";
  if (/403|forbidden|cookies|sign in|not a bot|cannot parse|failed to download|unable to download/.test(m)) return "Загрузка (куки/недоступно)";
  if (/valid gemini segments|json|segments/.test(m)) return "Gemini: ошибка ответа";
  return "Прочее";
}

async function flushBatch(userId: number) {
  batchDebounce.delete(userId);
  // Fire only when the user has NOTHING left processing (the last of the batch
  // is done). Otherwise keep the streak and wait for the next terminal event.
  const stillRunning = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.status, "processing")));
  if (stillRunning.length > 0) return;

  const m = batchStreak.get(userId);
  if (!m || m.size < BATCH_MIN) { batchStreak.delete(userId); return; }
  const ids = Array.from(m.keys());
  batchStreak.delete(userId);

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user?.telegramChatId || !user.telegramNotificationsEnabled) return;

  // Re-read for accurate final status + error text.
  const rows = await db.select().from(projects).where(inArray(projects.id, ids));
  if (rows.length === 0) return;
  const ok = rows.filter((r) => r.status === "complete");
  const failed = rows.filter((r) => r.status === "failed");

  const lines: string[] = [
    `📊 *Батч готов* — ${rows.length} видео`,
    "",
    `✅ Успешно: *${ok.length}*`,
    `❌ Не удалось: *${failed.length}*`,
  ];

  if (failed.length > 0) {
    const groups = new Map<string, number>();
    for (const f of failed) {
      const cat = categorizeFailure(f.errorMessage);
      groups.set(cat, (groups.get(cat) || 0) + 1);
    }
    lines.push("", "*Причины ошибок:*");
    for (const [cat, n] of Array.from(groups.entries()).sort((a, b) => b[1] - a[1])) {
      lines.push(` • ${cat}: ${n}`);
    }
  }

  // Rough elapsed since the first submission in this batch.
  const times = rows
    .map((r) => new Date(r.createdAt as any).getTime())
    .filter((t) => !Number.isNaN(t));
  if (times.length) {
    const mins = Math.round((Date.now() - Math.min(...times)) / 60000);
    if (mins >= 1) lines.push("", `⏱ от первой вставки: ~${mins} мин`);
  }

  await notifyUser(user.telegramChatId, lines.join("\n"));
}

export async function notifyProjectComplete(
  userId: number,
  projectName: string,
  projectId: number,
  status: "complete" | "failed",
  errorMessage?: string
) {
  const activeBot = getBot();
  if (!activeBot) return;

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user?.telegramChatId || !user.telegramNotificationsEnabled) return;

  const baseUrl = process.env.APP_PUBLIC_URL || "https://reelforge.space";
  const captionUrl = `${baseUrl}/api/projects/${projectId}/download/caption`;

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));

  // Tell the user which Google-Sheet tab this output was written to.
  let sheetLine = "";
  if (project && isSheetConfigured(user)) {
    try { sheetLine = `\n📄 Sheet tab: *${await resolveSheetTab(project as any)}*`; } catch {}
  }

  if (status !== "complete") {
    const safeError = errorMessage ? (errorMessage.length > 500 ? errorMessage.slice(0, 500) + '...' : errorMessage) : "Unknown error";
    await notifyUser(
      user.telegramChatId,
      `❌ *ReelForge: Processing Error*\n\n` +
        `📽 Project: ${projectName}\n` +
        `💥 Error: \`${safeError}\``
    );
    return;
  }

  // Prefer UPLOADING the finished video so the user can watch it inline in
  // Telegram (an inline player), instead of just a download link. Telegram bot
  // uploads are capped at 50MB — for anything larger (or if the upload fails)
  // we fall back to the text message with a download link.
  const caption =
    `🎬 *${projectName}* is ready!${sheetLine}\n` +
    `🔗 [Download](${captionUrl})`;

  const MAX_UPLOAD_BYTES = 49 * 1024 * 1024; // Telegram bot upload cap (~50MB)
  let tempPath: string | null = null;
  try {
    const filePath = project?.captionVideoPath;
    if (filePath && fs.existsSync(filePath)) {
      let sendPath: string | null = filePath;

      if (fs.statSync(filePath).size > MAX_UPLOAD_BYTES) {
        // Too big to upload as-is — make a compressed copy that fits so it can
        // still be watched inline. The original stays for the download link.
        const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
        console.log(
          `[telegram] project ${projectId} caption is ${sizeMB}MB (>49MB) — compressing a Telegram copy`
        );
        tempPath = filePath.replace(/\.mp4$/i, "") + ".tg.mp4";
        sendPath = await compressForTelegram(filePath, tempPath, MAX_UPLOAD_BYTES);
        if (sendPath) {
          const cMB = (fs.statSync(sendPath).size / (1024 * 1024)).toFixed(1);
          console.log(`[telegram] compressed copy is ${cMB}MB — uploading inline`);
        } else {
          console.log(`[telegram] could not compress under 49MB — sending link instead`);
        }
      }

      if (sendPath) {
        await activeBot.sendVideo(
          user.telegramChatId,
          sendPath,
          {
            caption,
            parse_mode: "Markdown",
            // supports_streaming is a valid Telegram Bot API field but missing
            // from the outdated @types — cast to keep tsc happy.
            supports_streaming: true,
          } as TelegramBot.SendVideoOptions,
          // Pin the content type to video/mp4. Newer node-telegram-bot-api
          // versions default uploads to application/octet-stream, which would
          // make Telegram treat it as a DOCUMENT (no inline player) instead of
          // a playable video.
          { contentType: "video/mp4" }
        );
        return;
      }
    }
  } catch (error: any) {
    console.error(
      `[telegram] sendVideo failed for project ${projectId}, falling back to link:`,
      error.message
    );
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }

  await notifyUser(
    user.telegramChatId,
    `🎬 *ReelForge: Video is Ready!*\n\n` +
      `📽 Project: ${projectName}\n` +
      `✅ Status: Complete${sheetLine}\n\n` +
      `🔗 [Download Video](${captionUrl})`
  );
}

export async function notifyAdminAccessRequest(
  email: string,
  displayName: string
) {
  if (!bot) return;

  // Get admin telegram chat id from global settings
  const [settings] = await db.select().from(globalSettings).limit(1);
  const adminChatId = settings?.telegramAdminChatId;
  if (!adminChatId) {
    // Fallback: try to find admin users with telegram configured
    const adminUsers = await db
      .select()
      .from(users)
      .where(eq(users.role, "admin"));
    for (const admin of adminUsers) {
      if (admin.telegramChatId) {
        await notifyUser(
          admin.telegramChatId,
          `📩 *New Access Request!*\n\n` +
            `👤 Name: ${displayName}\n` +
            `📧 Email: ${email}\n` +
            `🕐 Time: ${new Date().toLocaleString("en-US")}\n\n` +
            `Open the admin panel to approve.`
        );
      }
    }
    return;
  }

  await notifyUser(
    adminChatId,
    `📩 *New Access Request!*\n\n` +
      `👤 Name: ${displayName}\n` +
      `📧 Email: ${email}\n` +
      `🕐 Time: ${new Date().toLocaleString("en-US")}\n\n` +
      `Open the admin panel to approve.`
  );
}
