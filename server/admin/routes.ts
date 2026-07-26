import { Router, Request, Response } from "express";
import { db } from "../db";
import {
  users,
  userPermissions,
  accessRequests,
  globalSettings,
  ALL_FEATURES,
} from "@shared/schema";
import { generateDockerCompose, startVpn, stopVpn } from "../vpn/manager";
import { eq, desc } from "drizzle-orm";
import bcrypt from "bcrypt";

export function createAdminRouter(): Router {
  const router = Router();

  // ──── Users ────

  router.get("/users", async (_req: Request, res: Response) => {
    try {
      const allUsers = await db
        .select()
        .from(users)
        .orderBy(desc(users.createdAt));

      const usersWithPerms = await Promise.all(
        allUsers.map(async (u) => {
          const perms = await db
            .select()
            .from(userPermissions)
            .where(eq(userPermissions.userId, u.id));
          return {
            ...u,
            passwordHash: undefined, // Never send hash to client
            elevenlabsApiKey: u.elevenlabsApiKey ? "***" : null,
            openrouterApiKey: u.openrouterApiKey ? "***" : null,
            googleServiceAccountJson: u.googleServiceAccountJson ? "***" : null,
            permissions: perms.map((p) => p.feature),
          };
        })
      );

      res.json(usersWithPerms);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/users", async (req: Request, res: Response) => {
    try {
      const {
        email,
        username,
        password,
        displayName,
        authMethod,
        permissions: perms,
        useAdminElevenlabs,
        useAdminOpenrouter,
      } = req.body as {
        email?: string;
        username?: string;
        password?: string;
        displayName: string;
        authMethod: "google" | "password";
        permissions?: string[];
        useAdminElevenlabs?: boolean;
        useAdminOpenrouter?: boolean;
      };

      if (!displayName) {
        return res.status(400).json({ error: "displayName is required" });
      }

      if (authMethod === "password" && (!username || !password)) {
        return res.status(400).json({ error: "username and password required for password auth" });
      }

      if (authMethod === "google" && !email) {
        return res.status(400).json({ error: "email required for Google auth" });
      }

      const passwordHash = password ? await bcrypt.hash(password, 10) : null;

      const [newUser] = await db
        .insert(users)
        .values({
          email: email?.toLowerCase() || null,
          username: username?.toLowerCase() || null,
          passwordHash,
          displayName,
          role: "user",
          isActive: true,
          authMethod: authMethod || "google",
          useAdminElevenlabs: !!useAdminElevenlabs,
          useAdminOpenrouter: !!useAdminOpenrouter,
        })
        .returning();

      // Add permissions
      if (perms && perms.length > 0) {
        const validPerms = perms.filter((p) =>
          (ALL_FEATURES as readonly string[]).includes(p)
        );
        if (validPerms.length > 0) {
          await db.insert(userPermissions).values(
            validPerms.map((f) => ({ userId: newUser.id, feature: f }))
          );
        }
      }

      res.status(201).json({ ...newUser, passwordHash: undefined, permissions: perms || [] });
    } catch (error: any) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Username or email already exists" });
      }
      res.status(500).json({ error: error.message });
    }
  });

  router.put("/users/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      const updates: Record<string, any> = {};

      const fields = [
        "displayName", "isActive", "role",
        "useAdminElevenlabs", "useAdminOpenrouter",
        "email", "username",
      ];
      for (const f of fields) {
        if (req.body[f] !== undefined) updates[f] = req.body[f];
      }

      if (Object.keys(updates).length > 0) {
        await db.update(users).set(updates).where(eq(users.id, id));
      }

      const [updated] = await db.select().from(users).where(eq(users.id, id));
      res.json({ ...updated, passwordHash: undefined });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete("/users/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      // Don't allow deleting yourself
      if (req.user?.id === id) {
        return res.status(400).json({ error: "Cannot delete your own account" });
      }
      await db.delete(users).where(eq(users.id, id));
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put("/users/:id/permissions", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      const { permissions: perms } = req.body as { permissions: string[] };

      // Delete existing
      await db.delete(userPermissions).where(eq(userPermissions.userId, id));

      // Insert new
      if (perms && perms.length > 0) {
        const validPerms = perms.filter((p) =>
          (ALL_FEATURES as readonly string[]).includes(p)
        );
        if (validPerms.length > 0) {
          await db.insert(userPermissions).values(
            validPerms.map((f) => ({ userId: id, feature: f }))
          );
        }
      }

      res.json({ permissions: perms });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/users/:id/reset-password", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      const { password } = req.body as { password: string };
      if (!password || password.length < 4) {
        return res.status(400).json({ error: "Password must be at least 4 characters" });
      }
      const hash = await bcrypt.hash(password, 10);
      await db.update(users).set({ passwordHash: hash }).where(eq(users.id, id));
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ──── Access Requests ────

  router.get("/access-requests", async (_req: Request, res: Response) => {
    try {
      const requests = await db
        .select()
        .from(accessRequests)
        .orderBy(desc(accessRequests.createdAt));
      res.json(requests);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/access-requests/:id/approve", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      const { permissions: perms } = req.body as { permissions?: string[] };

      const [request] = await db
        .select()
        .from(accessRequests)
        .where(eq(accessRequests.id, id));
      if (!request) return res.status(404).json({ error: "Request not found" });

      // Create user account
      const [newUser] = await db
        .insert(users)
        .values({
          email: request.email.toLowerCase(),
          displayName: request.displayName || request.email,
          avatarUrl: request.avatarUrl,
          role: "user",
          isActive: true,
          authMethod: "google",
          useAdminElevenlabs: true,
          useAdminOpenrouter: true,
        })
        .returning();

      // Set permissions
      const featureList = perms && perms.length > 0 ? perms : ["automated-shorts"];
      const validPerms = featureList.filter((p) =>
        (ALL_FEATURES as readonly string[]).includes(p)
      );
      if (validPerms.length > 0) {
        await db.insert(userPermissions).values(
          validPerms.map((f) => ({ userId: newUser.id, feature: f }))
        );
      }

      // Update request status
      await db
        .update(accessRequests)
        .set({ status: "approved" })
        .where(eq(accessRequests.id, id));

      res.json({ user: { ...newUser, passwordHash: undefined }, permissions: validPerms });
    } catch (error: any) {
      if (error.code === "23505") {
        // User already exists — just approve
        await db
          .update(accessRequests)
          .set({ status: "approved" })
          .where(eq(accessRequests.id, parseInt(req.params.id as string)));
        return res.json({ status: "user_already_exists" });
      }
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/access-requests/:id/reject", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      await db
        .update(accessRequests)
        .set({ status: "rejected" })
        .where(eq(accessRequests.id, id));
      res.json({ status: "rejected" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ──── Global Settings ────

  router.get("/settings", async (_req: Request, res: Response) => {
    try {
      const [settings] = await db.select().from(globalSettings).limit(1);
      if (!settings) {
        return res.json({
          elevenlabsApiKey: null,
          elevenlabsPlan: "free",
          elevenlabsKeyLabel: null,
          openrouterApiKey: null,
          defaultModelScript: null,
          defaultModelVideo: null,
          defaultModelSegments: null,
          defaultModelWhisper: null,
          jamendoClientId: null,
          telegramAdminChatId: null,
          elevenlabsKeys: [],
          mullvadEnabled: false,
          mullvadPrivateKey: null,
          mullvadAddress: null,
          mullvadCountry: "Sweden",
        });
      }
      
      let keys = settings.elevenlabsKeys || [];
      if (keys.length === 0 && settings.elevenlabsApiKey) {
         keys = [{
           id: "legacy",
           name: settings.elevenlabsKeyLabel || "Legacy Key",
           key: settings.elevenlabsApiKey,
           plan: (settings.elevenlabsPlan as "free" | "paid") || "free",
           isActive: true
         }];
      }

      res.json({
        ...settings,
        elevenlabsKeys: keys.map((k: any) => ({ ...k, key: k.key ? "sk_...***" : "" })),
        elevenlabsApiKey: settings.elevenlabsApiKey ? "***" : null,
        openrouterApiKey: settings.openrouterApiKey ? "***" : null,
        hasElevenlabsKey: !!settings.elevenlabsApiKey,
        hasOpenrouterKey: !!settings.openrouterApiKey,
        mullvadPrivateKey: settings.mullvadPrivateKey ? "***" : null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put("/settings", async (req: Request, res: Response) => {
    try {
      const {
        elevenlabsApiKey,
        elevenlabsPlan,
        elevenlabsKeyLabel,
        elevenlabsKeys,
        openrouterApiKey,
        defaultModelScript,
        defaultModelVideo,
        defaultModelSegments,
        defaultModelWhisper,
        jamendoClientId,
        telegramAdminChatId,
      } = req.body as {
        elevenlabsApiKey?: string;
        elevenlabsPlan?: string;
        elevenlabsKeyLabel?: string;
        elevenlabsKeys?: any[];
        openrouterApiKey?: string;
        defaultModelScript?: string;
        defaultModelVideo?: string;
        defaultModelSegments?: string;
        defaultModelWhisper?: string;
        jamendoClientId?: string;
        telegramAdminChatId?: string;
      };

      const updates: Record<string, any> = {};
      if (elevenlabsApiKey !== undefined) updates.elevenlabsApiKey = elevenlabsApiKey || null;
      if (elevenlabsPlan !== undefined) updates.elevenlabsPlan = elevenlabsPlan;
      if (elevenlabsKeyLabel !== undefined) updates.elevenlabsKeyLabel = elevenlabsKeyLabel;
      if (openrouterApiKey !== undefined) updates.openrouterApiKey = openrouterApiKey || null;
      if (defaultModelScript !== undefined) updates.defaultModelScript = defaultModelScript || null;
      if (defaultModelVideo !== undefined) updates.defaultModelVideo = defaultModelVideo || null;
      if (defaultModelSegments !== undefined) updates.defaultModelSegments = defaultModelSegments || null;
      if (defaultModelWhisper !== undefined) updates.defaultModelWhisper = defaultModelWhisper || null;
      if (jamendoClientId !== undefined) updates.jamendoClientId = jamendoClientId || null;
      if (telegramAdminChatId !== undefined) updates.telegramAdminChatId = telegramAdminChatId || null;
      
      if (req.body.mullvadEnabled !== undefined) updates.mullvadEnabled = req.body.mullvadEnabled;
      if (req.body.mullvadAddress !== undefined) updates.mullvadAddress = req.body.mullvadAddress || null;
      if (req.body.mullvadCountry !== undefined) updates.mullvadCountry = req.body.mullvadCountry || "Sweden";
      if (req.body.mullvadPrivateKey !== undefined && req.body.mullvadPrivateKey !== "***") {
        updates.mullvadPrivateKey = req.body.mullvadPrivateKey || null;
      }

      const [existing] = await db.select().from(globalSettings).limit(1);

      if (elevenlabsKeys !== undefined) {
        // If the client sent a masked key, we need to restore the real key from DB.
        const currentKeys = existing?.elevenlabsKeys || [];
        const mergedKeys = elevenlabsKeys.map((newKey: any) => {
           if (newKey.key === "sk_...***") {
              const oldKey = currentKeys.find((k: any) => k.id === newKey.id);
              if (oldKey) return { ...newKey, key: oldKey.key };
           }
           return newKey;
        });
        updates.elevenlabsKeys = mergedKeys;
      }

      updates.updatedAt = new Date();


      if (existing) {
        await db.update(globalSettings).set(updates).where(eq(globalSettings.id, existing.id));
      } else {
        await db.insert(globalSettings).values(updates);
      }

      // Handle VPN state changes
      if (
        updates.mullvadEnabled !== undefined || 
        updates.mullvadPrivateKey !== undefined || 
        updates.mullvadAddress !== undefined || 
        updates.mullvadCountry !== undefined
      ) {
        const finalConfig = {
          ...existing,
          ...updates
        };
        
        try {
          if (finalConfig.mullvadEnabled && finalConfig.mullvadPrivateKey && finalConfig.mullvadAddress) {
            await generateDockerCompose(
              finalConfig.mullvadPrivateKey, 
              finalConfig.mullvadAddress, 
              finalConfig.mullvadCountry || "Sweden"
            );
            await startVpn();
          } else if (finalConfig.mullvadEnabled === false) {
            await stopVpn();
          }
        } catch (vpnErr) {
          console.error("VPN setup error:", vpnErr);
        }
      }

      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ──── API Usage / Balance ────

  router.get("/api-usage", async (_req: Request, res: Response) => {
    try {
      const [settings] = await db.select().from(globalSettings).limit(1);
      const result: {
        elevenlabs: Array<{
          name: string;
          characterCount: number;
          characterLimit: number;
          tier: string;
        }>;
        openrouter: { credits: number; usage: number } | null;
      } = { elevenlabs: [], openrouter: null };

      // ── ElevenLabs: fetch subscription info for each key ──
      const elKeys: Array<{ name: string; key: string }> = [];
      const keys = settings?.elevenlabsKeys || [];
      for (const k of keys as any[]) {
        if (k.key && k.key !== "sk_...***") {
          elKeys.push({ name: k.name || k.id || "Key", key: k.key });
        }
      }
      if (!elKeys.length && settings?.elevenlabsApiKey) {
        elKeys.push({ name: settings.elevenlabsKeyLabel || "Legacy Key", key: settings.elevenlabsApiKey });
      }

      for (const k of elKeys) {
        try {
          const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
            headers: { "xi-api-key": k.key },
          });
          if (r.ok) {
            const d = await r.json() as any;
            result.elevenlabs.push({
              name: k.name,
              characterCount: d.character_count ?? 0,
              characterLimit: d.character_limit ?? 0,
              tier: d.tier ?? "unknown",
            });
          }
        } catch {}
      }

      // ── OpenRouter: fetch credits ──
      if (settings?.openrouterApiKey) {
        try {
          const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
            headers: { Authorization: `Bearer ${settings.openrouterApiKey}` },
          });
          if (r.ok) {
            const d = await r.json() as any;
            result.openrouter = {
              credits: d.data?.limit ?? 0,
              usage: d.data?.usage ?? 0,
            };
          }
        } catch {}
      }

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ──── Features List (for UI) ────
  router.get("/features", (_req: Request, res: Response) => {
    res.json(ALL_FEATURES);
  });

  return router;
}
