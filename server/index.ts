import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupWebSocket } from "./websocket";
import {
  createSessionMiddleware,
  createAuthRouter,
  loadUser,
  requireAuth,
  requireAdmin,
  ensureAdminExists,
} from "./auth";
import { createAdminRouter } from "./admin/routes";
import { startTelegramBot, onProjectTerminal } from "./telegram/bot";
import { setProjectTerminalHook } from "./storage";

const app = express();
const httpServer = createServer(app);
setupWebSocket(httpServer);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// ──── Session ────
app.use(createSessionMiddleware());

// ──── Load user from session ────
app.use(loadUser);

// ──── Auth routes (public — no requireAuth) ────
app.use(createAuthRouter());

// ──── Protect all /api/* routes (except /api/auth/* and project downloads) ────
// Project download links are intentionally public so existing shareable URLs
// in Telegram messages, Google Sheets logs, and bookmarks keep working without
// a browser session. The download handler itself returns 404 for unknown
// project IDs, so this is not an enumeration risk worth blocking.
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/auth/")) return next();
  if (req.path.match(/^\/projects\/\d+\/download\//)) return next();
  return requireAuth(req, res, next);
});

// ──── Admin routes (require admin for /api/admin/*) ────
app.use("/api/admin", requireAdmin, createAdminRouter());

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Ensure admin user exists
  await ensureAdminExists();

  // Start Telegram bot + wire the batch-completion summary hook.
  startTelegramBot();
  setProjectTerminalHook(onProjectTerminal);

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  const listenOptions: { port: number; host: string; reusePort?: boolean } = {
    port,
    host: "0.0.0.0",
  };
  if (process.platform !== "win32") {
    listenOptions.reusePort = true;
  }
  httpServer.listen(listenOptions, () => {
    log(`serving on port ${port}`);
    log(
      `features: classic, automated-shorts (2-takes=ON), elevenlabs (voice-clone), ` +
        `download, voiceover-script`
    );
  });
})();
