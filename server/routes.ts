import express, { type Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import path from "path";
import fs from "fs";
import { ensureDirectories } from "./pipeline/processor";
import { requireAdmin } from "./auth";
import { rateLimit } from "./rate-limit";
import { listFormats, downloadVideo } from "./downloader/ytDlp";
import {
  fetchElevenLabsVoices,
  generateVoiceover,
} from "./elevenlabs/voiceover";
import { generateViralVoiceoverScript } from "./voiceover-script/openrouter";
import { runAutomatedShort } from "./automated-shorts/orchestrator";
import * as assetsStorage from "./assets/storage";
import {
  getElevenLabsSettings,
  upsertElevenLabsSettings,
} from "./elevenlabs/settings";
import { AUTOMATED_SHORTS_MAX_TABS } from "../shared/project-limits";
import { PROJECT_TYPES, COMBO_TYPES, type ProjectType } from "@shared/schema";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const OUTPUT_DIR = path.join(process.cwd(), "outputs");
const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");
const ASSETS_BG_DIR = path.join(UPLOAD_DIR, "assets", "bg-music");
const ASSETS_LOGO_DIR = path.join(UPLOAD_DIR, "assets", "logos");

ensureDirectories();
[ASSETS_BG_DIR, ASSETS_LOGO_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function isWithinDir(baseDir: string, targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return resolved.startsWith(path.resolve(baseDir));
}

function parseIntStrict(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

// Per-user rate limits for yt-dlp endpoints. Keep formats more permissive
// (it's a metadata probe), download tighter (each call hits YouTube heavily
// and abusing it gets the cookies banned).
const formatsRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  capacity: 30,
  name: "downloader/formats",
});
const downloadRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  capacity: 10,
  name: "downloader/download",
});

function sanitizeAssetName(originalName: string): string {
  const base = path.basename(originalName, path.extname(originalName));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return cleaned || "asset";
}

function isValidAssetPath(targetPath: string): boolean {
  return isWithinDir(ASSETS_BG_DIR, targetPath) || isWithinDir(ASSETS_LOGO_DIR, targetPath);
}

function removeIfExists(filePath: string) {
  try {
    if (fs.existsSync(filePath)) {
      if (fs.lstatSync(filePath).isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
    }
  } catch (error) {
    console.warn(`Failed to remove ${filePath}:`, error);
  }
}

function cleanupProjectFiles(project: any) {
  const inputFiles = [
    project.sourceVideoPath,
    project.voiceoverPath,
    project.bgMusicPath,
  ];

  for (const inputPath of inputFiles) {
    if (inputPath && isWithinDir(UPLOAD_DIR, inputPath) && !isValidAssetPath(inputPath)) {
      removeIfExists(inputPath);
    }
  }

  if (
    project.logoPath &&
    isWithinDir(UPLOAD_DIR, project.logoPath) &&
    !isValidAssetPath(project.logoPath)
  ) {
    removeIfExists(project.logoPath);
  }

  const outputDirs = new Set<string>();
  for (const outputPath of [
    project.mixedAudioPath,
    project.clearVideoPath,
    project.captionVideoPath,
  ]) {
    if (outputPath && isWithinDir(OUTPUT_DIR, outputPath)) {
      outputDirs.add(path.dirname(outputPath));
    }
  }

  for (const outputDir of Array.from(outputDirs)) {
    try {
      removeIfExists(outputDir);
    } catch (error) {
      console.warn(`Failed to remove output directory ${outputDir}:`, error);
    }
  }
}

function getContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".mov":
      return "video/quicktime";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    default:
      return "application/octet-stream";
  }
}

const fileStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage: fileStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
  fileFilter: (_req, file, cb) => {
    // Basic strict mime-type validation based on expected fields
    const isVideoField =
      ["sourceVideo", "sourceMedia", "video"].includes(file.fieldname) ||
      file.fieldname.startsWith("fullVideo") ||
      file.fieldname.startsWith("shortVideo");
    const isAudioField = ["voiceover", "bgMusic"].includes(file.fieldname);
    const isImageField = ["logo"].includes(file.fieldname);

    if (isVideoField && !file.mimetype.startsWith("video/")) {
      return cb(new Error(`Invalid file type for ${file.fieldname}. Expected video.`));
    }
    if (isAudioField && !file.mimetype.startsWith("audio/") && !file.mimetype.startsWith("video/")) {
      // Allow video for voiceover in case users upload MP4s for audio extraction
      return cb(new Error(`Invalid file type for ${file.fieldname}. Expected audio or video.`));
    }
    if (isImageField && !file.mimetype.startsWith("image/")) {
      return cb(new Error(`Invalid file type for ${file.fieldname}. Expected image.`));
    }

    cb(null, true);
  }
});

const assetsBgStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(ASSETS_BG_DIR)) fs.mkdirSync(ASSETS_BG_DIR, { recursive: true });
    cb(null, ASSETS_BG_DIR);
  },
  filename: (_req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const assetsLogoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(ASSETS_LOGO_DIR)) fs.mkdirSync(ASSETS_LOGO_DIR, { recursive: true });
    cb(null, ASSETS_LOGO_DIR);
  },
  filename: (_req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const uploadBgMusic = multer({
  storage: assetsBgStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("audio/") && !file.mimetype.startsWith("video/")) {
      return cb(new Error("Expected audio or video"));
    }
    cb(null, true);
  },
});

const uploadLogos = multer({
  storage: assetsLogoStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Expected image"));
    }
    cb(null, true);
  },
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Static downloads (for Social Downloader)
  const downloadsDir = path.join(process.cwd(), "downloads");
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }
  app.use("/downloads", express.static(downloadsDir));

  app.get("/api/assets/bg-music", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Authentication required" });
      const list = await assetsStorage.getBgMusicAssets();
      res.json(list);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post(
    "/api/assets/bg-music",
    uploadBgMusic.array("files", 10),
    async (req, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: "Authentication required" });
        const files = req.files as Express.Multer.File[];
        if (!files?.length) {
          return res.status(400).json({ error: "No files uploaded" });
        }
        const created = await Promise.all(
          files.map((f) =>
            assetsStorage.addBgMusicAsset(sanitizeAssetName(f.originalname), f.path)
          )
        );
        res.json(created);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );

  app.get("/api/assets/logos", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Authentication required" });
      const list = await assetsStorage.getLogoAssets();
      res.json(list);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post(
    "/api/assets/logos",
    uploadLogos.array("files", 10),
    async (req, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: "Authentication required" });
        const files = req.files as Express.Multer.File[];
        if (!files?.length) {
          return res.status(400).json({ error: "No files uploaded" });
        }
        const created = await Promise.all(
          files.map((f) =>
            assetsStorage.addLogoAsset(sanitizeAssetName(f.originalname), f.path)
          )
        );
        res.json(created);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );
  // ──── User Settings ────
  app.put("/api/user/settings", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const {
        elevenlabsApiKey,
        elevenlabsKeys,
        openrouterApiKey,
        telegramChatId,
        telegramNotificationsEnabled,
        googleSheetId,
        googleServiceAccountJson,
        personalModelScript,
        personalModelVideo,
      } = req.body;

      const updates: Record<string, any> = {};
      if (elevenlabsApiKey !== undefined) updates.elevenlabsApiKey = elevenlabsApiKey || null;
      if (openrouterApiKey !== undefined) updates.openrouterApiKey = openrouterApiKey || null;
      if (telegramChatId !== undefined) updates.telegramChatId = telegramChatId || null;
      if (telegramNotificationsEnabled !== undefined) updates.telegramNotificationsEnabled = !!telegramNotificationsEnabled;
      if (googleSheetId !== undefined) updates.googleSheetId = googleSheetId || null;
      if (googleServiceAccountJson !== undefined) updates.googleServiceAccountJson = googleServiceAccountJson || null;
      if (personalModelScript !== undefined) updates.personalModelScript = personalModelScript || null;
      if (personalModelVideo !== undefined) updates.personalModelVideo = personalModelVideo || null;

      const { db } = await import("./db");
      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      if (elevenlabsKeys !== undefined) {
         // Get current keys to restore masked values
         const [existing] = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
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

      await db.update(users).set(updates).where(eq(users.id, req.user.id));

      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/openrouter/models", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const { getOpenRouterKey } = await import("./keys");
      const apiKey = await getOpenRouterKey(req.user.id);
      
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": process.env.APP_URL || "https://localhost:5000",
        }
      });
      
      if (!response.ok) {
        throw new Error(`OpenRouter returned ${response.status}: ${await response.text()}`);
      }
      
      const data = await response.json();
      res.json(data);
    } catch (error: any) {
      console.error("[OpenRouter Models] Proxy fail:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/projects", async (req, res) => {
    try {
      // Admin sees all, users see their own
      const userId = req.user?.role === "admin" ? null : req.user?.id;
      const projects = await storage.getAllProjects(userId);
      res.json(projects);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/projects/:id", async (req, res) => {
    try {
      const id = parseIntStrict(req.params.id);
      if (id === null) return res.status(400).json({ error: "Invalid project id" });
      const project = await storage.getProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }
      if (
        req.user?.role !== "admin" &&
        project.userId != null &&
        project.userId !== req.user?.id
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }
      res.json(project);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/elevenlabs/settings", requireAdmin, async (_req, res) => {
    try {
      const settings = await getElevenLabsSettings();
      res.json(settings);
    } catch (error: any) {
      res
        .status(500)
        .json({ error: error.message || "Failed to load settings" });
    }
  });

  app.post("/api/elevenlabs/settings", requireAdmin, async (req, res) => {
    try {
      const { apiKey, plan, keyLabel } = req.body as {
        apiKey?: string;
        plan?: "free" | "paid";
        keyLabel?: string | null;
      };
      if (!apiKey || !apiKey.trim()) {
        return res.status(400).json({ error: "apiKey is required" });
      }
      await upsertElevenLabsSettings({
        apiKey,
        plan: (plan as "free" | "paid") || "free",
        keyLabel,
      });
      const settings = await getElevenLabsSettings();
      res.json(settings);
    } catch (error: any) {
      res
        .status(500)
        .json({ error: error.message || "Failed to save settings" });
    }
  });

  app.get("/api/elevenlabs/voices", async (req, res) => {
    try {
      const voices = await fetchElevenLabsVoices(req.user?.id);
      res.json({ voices });
    } catch (error: any) {
      res
        .status(500)
        .json({ error: error.message || "Failed to fetch voices" });
    }
  });

  app.post("/api/elevenlabs/voiceover", async (req, res) => {
    try {
      const { text, voiceId } = req.body as {
        text?: string;
        voiceId?: string;
      };
      if (!text || !text.trim()) {
        return res.status(400).json({ error: "Text is required" });
      }
      const { publicPath } = await generateVoiceover(text, voiceId, req.user?.id);
      res.json({ audioUrl: publicPath });
    } catch (error: any) {
      res
        .status(500)
        .json({ error: error.message || "Failed to generate voiceover" });
    }
  });

  app.post("/api/downloader/formats", formatsRateLimit, async (req, res) => {
    try {
      const { url } = req.body as { url?: string };
      if (!url || !url.trim()) {
        return res.status(400).json({ error: "URL is required" });
      }
      const formats = await listFormats(url);
      res.json({ formats });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to list formats" });
    }
  });

  app.post("/api/downloader/download", downloadRateLimit, async (req, res) => {
    try {
      const { url, formatId, isVideoOnly } = req.body as {
        url?: string;
        formatId?: string;
        isVideoOnly?: boolean;
      };
      if (!url || !url.trim() || !formatId || !formatId.trim()) {
        return res
          .status(400)
          .json({ error: "Both url and formatId are required" });
      }
      const { publicPath } = await downloadVideo(url, formatId, !!isVideoOnly);
      res.json({ downloadUrl: publicPath });
    } catch (error: any) {
      res
        .status(500)
        .json({ error: error.message || "Failed to download video" });
    }
  });

  app.post(
    "/api/voiceover-script",
    upload.single("video"),
    async (req, res) => {
      try {
        const file = req.file;
        if (!file) {
          return res.status(400).json({ error: "Video file is required" });
        }
        const targetSeconds = parseInt(String(req.body?.targetSeconds || "20"), 10);
        if (isNaN(targetSeconds) || targetSeconds < 8 || targetSeconds > 60) {
          return res.status(400).json({ error: "targetSeconds must be between 8 and 60" });
        }
        const videoType = req.body?.videoType === "edited" ? "edited" : "raw";
        const script = await generateViralVoiceoverScript(file.path, targetSeconds, videoType, req.user?.id);
        const generateAudio = req.query.generateAudio === "true";
        let audioUrl: string | undefined;
        if (generateAudio && script) {
          try {
            const { publicPath } = await generateVoiceover(script, undefined, req.user?.id);
            audioUrl = publicPath;
          } catch (e: any) {
            console.warn("Voiceover audio generation failed:", e?.message);
          }
        }
        res.json({ script, ...(audioUrl && { audioUrl }) });
      } catch (error: any) {
        res
          .status(500)
          .json({ error: error.message || "Failed to generate voiceover script" });
      }
    }
  );

  const automatedShortsFields: multer.Field[] = [
    { name: "bgMusic", maxCount: 1 },
    { name: "logo", maxCount: 1 },
  ];
  for (let i = 0; i < AUTOMATED_SHORTS_MAX_TABS; i++) {
    automatedShortsFields.push({ name: `fullVideo_${i}`, maxCount: 1 });
    automatedShortsFields.push({ name: `shortVideo_${i}`, maxCount: 1 });
  }

  app.post(
    "/api/automated-shorts",
    upload.fields(automatedShortsFields),
    async (req, res) => {
      try {
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const bgMusicFile = files.bgMusic?.[0];
        const bgMusicAssetId = parseIntStrict(req.body.bgMusicAssetId);
        let bgMusicPath: string;
        if (bgMusicFile) {
          bgMusicPath = bgMusicFile.path;
        } else if (bgMusicAssetId !== null) {
          const asset = await assetsStorage.getBgMusicAssetById(bgMusicAssetId);
          if (!asset) return res.status(400).json({ error: "Invalid bgMusicAssetId" });
          bgMusicPath = asset.filePath;
        } else {
          return res.status(400).json({ error: "Background music (file or saved) is required" });
        }

        const logoFile = files.logo?.[0];
        const logoAssetId = parseIntStrict(req.body.logoAssetId);
        let logoPath: string | undefined;
        if (logoFile) {
          logoPath = logoFile.path;
        } else if (logoAssetId !== null) {
          const asset = await assetsStorage.getLogoAssetById(logoAssetId);
          if (!asset) return res.status(400).json({ error: "Invalid logoAssetId" });
          logoPath = asset.filePath;
        }

        const tabsJson = req.body.tabs as string;
        if (!tabsJson) {
          return res.status(400).json({ error: "tabs is required" });
        }
        let tabs: Array<{ projectName?: string; isVerticalSource?: boolean; cropType?: string; hookEnabled?: boolean; fullVideoUrl?: string; shortVideoUrl?: string }>;
        try {
          tabs = JSON.parse(tabsJson);
        } catch {
          return res.status(400).json({ error: "tabs must be valid JSON array" });
        }
        if (!Array.isArray(tabs) || tabs.length === 0) {
          return res.status(400).json({ error: "At least one tab is required" });
        }
        if (tabs.length > AUTOMATED_SHORTS_MAX_TABS) {
          return res.status(400).json({
            error: `A maximum of ${AUTOMATED_SHORTS_MAX_TABS} tabs is supported per run`,
          });
        }
        const targetSeconds = parseInt(String(req.body.targetSeconds || "20"), 10);
        if (isNaN(targetSeconds) || targetSeconds < 8 || targetSeconds > 60) {
          return res.status(400).json({ error: "targetSeconds must be between 8 and 60" });
        }
        const videoType = req.body.videoType === "edited" ? "edited" : "raw";
        const captionStyle = (req.body.captionStyle as string) || "capcut_green";

        const results: Array<{ project: { id: number; name: string }; fullVideoPublicPath?: string }> = [];

        for (let i = 0; i < tabs.length; i++) {
          const tab = tabs[i];
          const fullFile = files[`fullVideo_${i}`]?.[0];
          const shortFile = files[`shortVideo_${i}`]?.[0];
          const fullVideoUrl = tab.fullVideoUrl?.trim() || undefined;
          const shortVideoUrl = tab.shortVideoUrl?.trim() || undefined;

          if (!shortVideoUrl && !shortFile) {
            return res.status(400).json({ error: `Tab ${i + 1}: short video (URL or file) is required` });
          }

          const voiceId = req.body.voiceId?.trim() || undefined;

          const result = await runAutomatedShort({
            userId: req.user?.id || null,
            fullVideoUrl,
            fullVideoPath: fullFile?.path,
            shortVideoUrl,
            shortVideoPath: shortFile?.path,
            bgMusicPath,
            logoPath: logoPath || null,
            targetSeconds,
            videoType,
            projectName: tab.projectName?.trim() || `Automated Short ${i + 1}`,
            isVerticalSource: !!tab.isVerticalSource,
            cropType: tab.cropType || "none",
            hookEnabled: !!tab.hookEnabled,
            captionStyle,
            voiceId,
          });
          results.push(result);
        }

        res.status(201).json({ projects: results.map((r) => r.project), fullVideoPaths: results.map((r) => r.fullVideoPublicPath) });
      } catch (error: any) {
        res.status(500).json({ error: error.message || "Automated shorts failed" });
      }
    }
  );

  app.post(
    "/api/projects/upload",
    upload.fields([
      { name: "sourceVideo", maxCount: 1 },
      { name: "voiceover", maxCount: 1 },
      { name: "bgMusic", maxCount: 1 },
      { name: "logo", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        if (!files.sourceVideo?.[0] || !files.voiceover?.[0]) {
          return res
            .status(400)
            .json({ error: "Source video and voiceover are required" });
        }

        let bgMusicPath: string | null = files.bgMusic?.[0]?.path ?? null;
        const bgMusicAssetId = parseIntStrict(req.body.bgMusicAssetId);
        if (!bgMusicPath && bgMusicAssetId !== null) {
          const asset = await assetsStorage.getBgMusicAssetById(bgMusicAssetId);
          if (!asset) return res.status(400).json({ error: "Invalid bgMusicAssetId" });
          bgMusicPath = asset.filePath;
        }
        if (!bgMusicPath) {
          return res.status(400).json({ error: "Background music is required (upload a file or select from library)" });
        }

        let logoPath: string | null = files.logo?.[0]?.path ?? null;
        const logoAssetId = parseIntStrict(req.body.logoAssetId);
        if (!logoPath && logoAssetId !== null) {
          const asset = await assetsStorage.getLogoAssetById(logoAssetId);
          if (!asset) return res.status(400).json({ error: "Invalid logoAssetId" });
          logoPath = asset.filePath;
        }

        const projectName =
          (req.body.name as string) ||
          path.basename(files.sourceVideo[0].originalname, path.extname(files.sourceVideo[0].originalname));

        const captionStyle = (req.body.captionStyle as string) || "capcut_green";
        const isVerticalSource = req.body.isVerticalSource === "true";
        const cropType = (req.body.cropType as string) || "none";
        const hookEnabled = req.body.hookEnabled === "true";

        const project = await storage.createProject({
          userId: req.user?.id || null,
          name: projectName,
          projectType: PROJECT_TYPES.CLASSIC,
          status: "processing",
          currentStep: "uploading",
          progress: 5,
          sourceVideoPath: files.sourceVideo[0].path,
          voiceoverPath: files.voiceover[0].path,
          bgMusicPath,
          logoPath,
          captionStyle,
          isVerticalSource,
          cropType,
          hookEnabled,
        });

        const { queuePipeline } = await import("./pipeline/processor");
        queuePipeline(project.id);

        res.status(201).json(project);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/api/projects/ducking",
    upload.fields([
      { name: "voiceover", maxCount: 1 },
      { name: "bgMusic", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        if (!files.voiceover?.[0] || !files.bgMusic?.[0]) {
          return res.status(400).json({ error: "Voiceover and bgMusic required" });
        }

        const project = await storage.createProject({
          userId: req.user?.id || null,
          name: (req.body.name as string) || "Auto-Ducked Audio",
          projectType: PROJECT_TYPES.DUCKING,
          status: "processing",
          currentStep: "uploading",
          progress: 5,
          voiceoverPath: files.voiceover[0].path,
          bgMusicPath: files.bgMusic[0].path,
        });

        const { queuePipeline } = await import("./pipeline/processor");
        queuePipeline(project.id);
        res.status(201).json(project);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/api/projects/crop",
    upload.fields([{ name: "sourceVideo", maxCount: 1 }]),
    async (req, res) => {
      try {
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        if (!files.sourceVideo?.[0]) return res.status(400).json({ error: "Source video required" });

        const project = await storage.createProject({
          userId: req.user?.id || null,
          name: (req.body.name as string) || "Smart Cropped Video",
          projectType: PROJECT_TYPES.CROP,
          status: "processing",
          currentStep: "uploading",
          progress: 5,
          sourceVideoPath: files.sourceVideo[0].path,
        });

        const { queuePipeline } = await import("./pipeline/processor");
        queuePipeline(project.id);
        res.status(201).json(project);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/api/projects/color",
    upload.fields([{ name: "sourceVideo", maxCount: 1 }]),
    async (req, res) => {
      try {
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        if (!files.sourceVideo?.[0]) return res.status(400).json({ error: "Source video required" });

        const project = await storage.createProject({
          userId: req.user?.id || null,
          name: (req.body.name as string) || "Cinematic Color Grade",
          projectType: PROJECT_TYPES.COLOR,
          status: "processing",
          currentStep: "uploading",
          progress: 5,
          sourceVideoPath: files.sourceVideo[0].path,
        });

        const { queuePipeline } = await import("./pipeline/processor");
        queuePipeline(project.id);
        res.status(201).json(project);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/api/projects/motion-track",
    upload.fields([{ name: "sourceVideo", maxCount: 1 }]),
    async (req, res) => {
      try {
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        if (!files.sourceVideo?.[0]) return res.status(400).json({ error: "Source video required" });

        const overlayText = (req.body.overlayText as string) || "Tracked Object";

        const project = await storage.createProject({
          userId: req.user?.id || null,
          name: (req.body.name as string) || "Motion Tracked Video",
          projectType: PROJECT_TYPES.MOTION_TRACK,
          status: "processing",
          currentStep: "uploading",
          progress: 5,
          sourceVideoPath: files.sourceVideo[0].path,
          // temporarily storing overlay text in captionStyle field or similar, or just relying on a DB update later if needed.
          // since we only process once, we can pass this via extra state, but schema doesn't have a freeform meta column.
          // let's hijack captionStyle for overlayText
          captionStyle: overlayText,
        });

        const { queuePipeline } = await import("./pipeline/processor");
        queuePipeline(project.id);
        res.status(201).json(project);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/api/projects/isolate",
    upload.fields([{ name: "sourceMedia", maxCount: 1 }]),
    async (req, res) => {
      try {
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        if (!files.sourceMedia?.[0]) return res.status(400).json({ error: "Source media required" });

        const project = await storage.createProject({
          userId: req.user?.id || null,
          name: (req.body.name as string) || "Studio Clear Vocal",
          projectType: PROJECT_TYPES.ISOLATE,
          status: "processing",
          currentStep: "uploading",
          progress: 5,
          sourceVideoPath: files.sourceMedia[0].path, // Store both audio/video in the same path column
        });

        const { queuePipeline } = await import("./pipeline/processor");
        queuePipeline(project.id);
        res.status(201).json(project);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/api/projects/highlights",
    upload.fields([{ name: "sourceVideo", maxCount: 1 }]),
    async (req, res) => {
      try {
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        if (!files.sourceVideo?.[0]) return res.status(400).json({ error: "Source video required" });

        const project = await storage.createProject({
          userId: req.user?.id || null,
          name: (req.body.name as string) || "Podcast Highlights",
          projectType: PROJECT_TYPES.HIGHLIGHTS,
          status: "processing",
          currentStep: "uploading",
          progress: 5,
          sourceVideoPath: files.sourceVideo[0].path,
        });

        const { queuePipeline } = await import("./pipeline/processor");
        queuePipeline(project.id);
        res.status(201).json(project);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );

  app.post(
    "/api/projects/combo",
    upload.fields([
      { name: "sourceVideo", maxCount: 1 },
      { name: "voiceover", maxCount: 1 },
      { name: "bgMusic", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const comboType = req.body.comboType as string;

        if (!comboType) {
          return res.status(400).json({ error: "comboType is required" });
        }
        if (!COMBO_TYPES.includes(comboType as ProjectType)) {
          return res.status(400).json({
            error: `Invalid comboType. Allowed: ${COMBO_TYPES.join(", ")}`,
          });
        }

        // We hijack captionStyle to pass dynamic text inputs like overlayText or specific subtitle styles
        const extraText = (req.body.extraText as string) || "capcut_green";

        const project = await storage.createProject({
          userId: req.user?.id || null,
          name: (req.body.name as string) || `Magic Combo: ${comboType}`,
          projectType: comboType,
          status: "processing",
          currentStep: "uploading",
          progress: 5,
          sourceVideoPath: files.sourceVideo?.[0]?.path || null,
          voiceoverPath: files.voiceover?.[0]?.path || null,
          bgMusicPath: files.bgMusic?.[0]?.path || null,
          captionStyle: extraText,
        });

        const { queuePipeline } = await import("./pipeline/processor");
        queuePipeline(project.id);
        res.status(201).json(project);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    }
  );

  app.delete("/api/projects/:id", async (req, res) => {
    try {
      const id = parseIntStrict(req.params.id);
      if (id === null) return res.status(400).json({ error: "Invalid project id" });
      const project = await storage.getProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }
      if (
        req.user?.role !== "admin" &&
        project.userId != null &&
        project.userId !== req.user?.id
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }

      cleanupProjectFiles(project);
      await storage.deleteProject(id);
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/projects/:id/download/:type", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Authentication required" });
      const id = parseIntStrict(req.params.id);
      if (id === null) return res.status(400).json({ error: "Invalid project id" });
      const project = await storage.getProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }
      if (
        req.user.role !== "admin" &&
        project.userId != null &&
        project.userId !== req.user.id
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (req.params.type !== "clear" && req.params.type !== "caption") {
        return res.status(400).json({ error: "Invalid download type" });
      }

      const filePath =
        req.params.type === "clear" ? project.clearVideoPath : project.captionVideoPath;

      if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
      }

      const safeName = project.name.replace(/[^a-z0-9]/gi, '_');
      const suffix = req.params.type === "clear" ? "clear" : "caption";
      const filename = `${safeName}_${suffix}.mp4`;
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", getContentType(filePath));

      const stat = fs.statSync(filePath);
      res.setHeader("Content-Length", stat.size);

      const readStream = fs.createReadStream(filePath);
      readStream.pipe(res);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/cleanup", requireAdmin, async (_req, res) => {
    try {
      // Calculate size before cleanup
      const getDirSize = (dir: string): number => {
        if (!fs.existsSync(dir)) return 0;
        let total = 0;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            total += getDirSize(fullPath);
          } else {
            try { total += fs.statSync(fullPath).size; } catch {}
          }
        }
        return total;
      }

      // Directories to fully remove
      const dirsToClean = [OUTPUT_DIR, DOWNLOADS_DIR, path.join(UPLOAD_DIR, "frames")];
      let freedBytes = 0;
      for (const dir of dirsToClean) {
        freedBytes += getDirSize(dir);
      }

      // Calculate size of upload root files (excluding assets/ subdirectory)
      if (fs.existsSync(UPLOAD_DIR)) {
        const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === "assets" || entry.name === "frames") continue;
          const fullPath = path.join(UPLOAD_DIR, entry.name);
          if (entry.isDirectory()) {
            freedBytes += getDirSize(fullPath);
          } else {
            try { freedBytes += fs.statSync(fullPath).size; } catch {}
          }
        }
      }

      // Delete all projects from DB
      await storage.deleteAllProjects();

      // Remove output & download dirs
      for (const dir of dirsToClean) {
        removeIfExists(dir);
      }

      // Remove upload files but keep the assets/ subdirectory
      if (fs.existsSync(UPLOAD_DIR)) {
        const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === "assets") continue;
          removeIfExists(path.join(UPLOAD_DIR, entry.name));
        }
      }

      const freedMB = (freedBytes / (1024 * 1024)).toFixed(1);
      res.json({ message: `Cleanup complete. Freed ~${freedMB} MB.`, freedBytes });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Cleanup failed" });
    }
  });

  return httpServer;
}
