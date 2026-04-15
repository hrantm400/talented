import TelegramBot from "node-telegram-bot-api";
import { db } from "../db";
import { globalSettings, users } from "@shared/schema";
import { eq } from "drizzle-orm";

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

export async function notifyUser(chatId: string, message: string) {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error: any) {
    console.error(`[telegram] Failed to send to ${chatId}:`, error.message);
  }
}

export async function notifyProjectComplete(
  userId: number,
  projectName: string,
  projectId: number,
  status: "complete" | "failed",
  errorMessage?: string
) {
  if (!bot) return;

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user?.telegramChatId || !user.telegramNotificationsEnabled) return;

  const baseUrl = process.env.APP_PUBLIC_URL || "https://reelforge.space";
  const clearUrl = `${baseUrl}/api/projects/${projectId}/download/clear`;
  const captionUrl = `${baseUrl}/api/projects/${projectId}/download/caption`;

  let message: string;
  if (status === "complete") {
    message =
      `🎬 *ReelForge: Video is Ready!*\n\n` +
      `📽 Project: ${projectName}\n` +
      `✅ Status: Complete\n\n` +
      `🔗 [Download Clear Video](${clearUrl})\n` +
      `🔗 [Download Captioned Video](${captionUrl})`;
  } else {
    const safeError = errorMessage ? (errorMessage.length > 500 ? errorMessage.slice(0, 500) + '...' : errorMessage) : "Unknown error";
    message =
      `❌ *ReelForge: Processing Error*\n\n` +
      `📽 Project: ${projectName}\n` +
      `💥 Error: \`${safeError}\``;
  }

  await notifyUser(user.telegramChatId, message);
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
