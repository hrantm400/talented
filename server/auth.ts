import { Router, Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcrypt";
import { pool } from "./db";
import { db } from "./db";
import {
  users,
  accessRequests,
  userPermissions,
  ALL_FEATURES,
  type User,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

export type AuthUser = User & { permissions: string[] };

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ──────────────────────────────────────────────
// Session Setup
// ──────────────────────────────────────────────

const PgSession = connectPgSimple(session);

function resolveSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.trim().length >= 16) return fromEnv.trim();

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET must be set (>=16 chars) in production. Refusing to start with a derivable fallback."
    );
  }

  console.warn(
    "[auth] SESSION_SECRET not set — using a per-process random value (dev only). Sessions will be invalidated on restart."
  );
  return `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createSessionMiddleware() {
  return session({
    store: new PgSession({
      pool: pool as any,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    secret: resolveSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      secure: false, // Cloudflare handles HTTPS → Nginx is HTTP
      sameSite: "lax",
    },
  });
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

const ADMIN_EMAILS = (process.env.ADMIN_EMAIL || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

async function getUserById(id: number): Promise<AuthUser | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) return null;
  const perms = await db
    .select()
    .from(userPermissions)
    .where(eq(userPermissions.userId, id));
  return { ...user, permissions: perms.map((p) => p.feature) };
}

async function getUserByEmail(email: string): Promise<AuthUser | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()));
  if (!user) return null;
  const perms = await db
    .select()
    .from(userPermissions)
    .where(eq(userPermissions.userId, user.id));
  return { ...user, permissions: perms.map((p) => p.feature) };
}

async function getUserByUsername(username: string): Promise<AuthUser | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username.toLowerCase()));
  if (!user) return null;
  const perms = await db
    .select()
    .from(userPermissions)
    .where(eq(userPermissions.userId, user.id));
  return { ...user, permissions: perms.map((p) => p.feature) };
}

async function createAdminUser(
  email: string,
  displayName: string,
  avatarUrl?: string
): Promise<AuthUser> {
  // Hash a default password for admin (can log in via password too)
  const passwordHash = await bcrypt.hash("admin", 10);

  const [newUser] = await db
    .insert(users)
    .values({
      email: email.toLowerCase(),
      username: "admin",
      passwordHash,
      displayName,
      avatarUrl: avatarUrl || null,
      role: "admin",
      isActive: true,
      authMethod: "google",
    })
    .returning();

  // Grant all permissions
  const permRows = ALL_FEATURES.map((f) => ({
    userId: newUser.id,
    feature: f as string,
  }));
  if (permRows.length > 0) {
    await db.insert(userPermissions).values(permRows);
  }

  console.log(`\n🔑 Admin account created for ${email}`);
  console.log(`   Username: admin / Password: admin (change this!)\n`);

  return { ...newUser, permissions: [...ALL_FEATURES] };
}

// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.userId) {
    const user = await getUserById(req.session.userId);
    if (user && user.isActive) {
      req.user = user;
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

export function requireFeature(feature: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    // Admin always has access
    if (req.user.role === "admin") return next();
    if (!req.user.permissions.includes(feature)) {
      return res.status(403).json({ error: `No access to feature: ${feature}` });
    }
    next();
  };
}

// ──────────────────────────────────────────────
// Auth Routes
// ──────────────────────────────────────────────

export function createAuthRouter(): Router {
  const router = Router();

  // Public config (Google Client ID for frontend)
  router.get("/api/auth/config", (_req: Request, res: Response) => {
    res.json({
      googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    });
  });

  // Google Sign-In
  router.post("/api/auth/google", async (req: Request, res: Response) => {
    try {
      const { credential } = req.body as { credential?: string };
      if (!credential) {
        return res.status(400).json({ error: "Google credential required" });
      }

      // Verify Google token
      const { OAuth2Client } = await import("google-auth-library");
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return res.status(500).json({ error: "Google login not configured (GOOGLE_CLIENT_ID missing)" });
      }

      const client = new OAuth2Client(clientId);
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.email) {
        return res.status(400).json({ error: "Invalid Google token" });
      }

      const email = payload.email.toLowerCase();
      const displayName = payload.name || email;
      const avatarUrl = payload.picture || null;

      // Check if user exists
      let user = await getUserByEmail(email);

      if (!user) {
        // Check if this is an admin email
        if (ADMIN_EMAILS.includes(email)) {
          user = await createAdminUser(email, displayName, avatarUrl || undefined);
        } else {
          // User doesn't exist — return no_access
          return res.json({
            status: "no_access",
            email,
            displayName,
            avatarUrl,
          });
        }
      }

      if (!user.isActive) {
        return res.json({ status: "pending" });
      }

      // Success — create session
      req.session.userId = user.id;
      return res.json({
        status: "ok",
        user: sanitizeUser(user),
      });
    } catch (error: any) {
      console.error("[auth/google] Error:", error);
      return res.status(500).json({ error: error.message || "Google auth failed" });
    }
  });

  // Password Login
  router.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body as {
        username?: string;
        password?: string;
      };
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }

      const user = await getUserByUsername(username);
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: "Invalid username or password" });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid username or password" });
      }

      if (!user.isActive) {
        return res.status(403).json({ error: "Account is deactivated" });
      }

      req.session.userId = user.id;
      return res.json({
        status: "ok",
        user: sanitizeUser(user),
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message || "Login failed" });
    }
  });

  // Logout
  router.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      res.clearCookie("connect.sid");
      return res.json({ status: "ok" });
    });
  });

  // Get current user
  router.get("/api/auth/me", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    return res.json({ user: sanitizeUser(req.user) });
  });

  // Request access
  router.post("/api/auth/request-access", async (req: Request, res: Response) => {
    try {
      const { email, displayName, avatarUrl } = req.body as {
        email?: string;
        displayName?: string;
        avatarUrl?: string;
      };
      if (!email) {
        return res.status(400).json({ error: "Email required" });
      }

      // Check if already requested
      const [existing] = await db
        .select()
        .from(accessRequests)
        .where(
          and(
            eq(accessRequests.email, email.toLowerCase()),
            eq(accessRequests.status, "pending")
          )
        );
      if (existing) {
        return res.json({ status: "already_requested" });
      }

      await db.insert(accessRequests).values({
        email: email.toLowerCase(),
        displayName: displayName || null,
        avatarUrl: avatarUrl || null,
        status: "pending",
      });

      // Notify admin via Telegram
      try {
        const { notifyAdminAccessRequest } = await import("./telegram/bot");
        await notifyAdminAccessRequest(email, displayName || email);
      } catch (e) {
        console.warn("[auth] Telegram notification failed:", e);
      }

      return res.json({ status: "requested" });
    } catch (error: any) {
      return res.status(500).json({ error: error.message || "Request failed" });
    }
  });

  return router;
}

// ──────────────────────────────────────────────
// Init: ensure admin exists on startup
// ──────────────────────────────────────────────

export async function ensureAdminExists() {
  if (ADMIN_EMAILS.length === 0) {
    console.log("[auth] No ADMIN_EMAIL set in .env — admin must be created manually");
    return;
  }

  for (const email of ADMIN_EMAILS) {
    const existing = await getUserByEmail(email);
    if (!existing) {
      // Don't create until first Google login — but create password-based admin
      // so admin can log in even before Google is configured
    }
  }

  // Ensure at least one admin with password exists
  const allUsers = await db.select().from(users);
  if (allUsers.length === 0) {
    const envPassword = process.env.ADMIN_PASSWORD?.trim();
    if (process.env.NODE_ENV === "production" && (!envPassword || envPassword.length < 8)) {
      throw new Error(
        "Cannot bootstrap default admin in production without ADMIN_PASSWORD env var (>=8 chars). Set ADMIN_PASSWORD or create the admin manually."
      );
    }
    const adminPassword = envPassword || "admin";
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const [newUser] = await db
      .insert(users)
      .values({
        email: ADMIN_EMAILS[0] || null,
        username: "admin",
        passwordHash,
        displayName: "Administrator",
        role: "admin",
        isActive: true,
        authMethod: "password",
      })
      .returning();

    const permRows = ALL_FEATURES.map((f) => ({
      userId: newUser.id,
      feature: f as string,
    }));
    if (permRows.length > 0) {
      await db.insert(userPermissions).values(permRows);
    }

    console.log(`\n${"=".repeat(50)}`);
    console.log(`🔑 DEFAULT ADMIN ACCOUNT CREATED`);
    console.log(`   Username: admin`);
    if (envPassword) {
      console.log(`   Password: <from ADMIN_PASSWORD env>`);
    } else {
      console.log(`   Password: admin  (dev fallback — set ADMIN_PASSWORD env)`);
    }
    console.log(`   Email: ${ADMIN_EMAILS[0] || "not set"}`);
    console.log(`   ⚠️  CHANGE THE PASSWORD AFTER FIRST LOGIN!`);
    console.log(`${"=".repeat(50)}\n`);
  }
}

// ──────────────────────────────────────────────
// Sanitize user for client
// ──────────────────────────────────────────────

function sanitizeUser(user: AuthUser) {
  const sanitized = {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
    isActive: user.isActive,
    authMethod: user.authMethod,
    permissions: user.permissions,
    useAdminElevenlabs: user.useAdminElevenlabs,
    useAdminOpenrouter: user.useAdminOpenrouter,
    telegramChatId: user.telegramChatId,
    telegramNotificationsEnabled: user.telegramNotificationsEnabled,
    googleSheetId: user.googleSheetId,
    hasElevenlabsKey: !!user.elevenlabsApiKey,
    hasOpenrouterKey: !!user.openrouterApiKey,
    hasGoogleSheets: !!user.googleSheetId && !!user.googleServiceAccountJson,
    personalModelScript: user.personalModelScript,
    personalModelVideo: user.personalModelVideo,
    personalModelWhisper: user.personalModelWhisper,
  };
  
  let keys = user.elevenlabsKeys || [];
  if (keys.length === 0 && user.elevenlabsApiKey) {
     keys = [{
       id: "legacy",
       name: "Personal Legacy Key",
       key: user.elevenlabsApiKey,
       plan: (user.elevenlabsPlan as "free" | "paid") || "free",
       isActive: true
     }];
  }
  
  (sanitized as any).elevenlabsKeys = keys.map((k: any) => ({ ...k, key: k.key ? "sk_...***" : "" }));

  return sanitized;
}

export { sanitizeUser, getUserById, getUserByEmail, getUserByUsername };
