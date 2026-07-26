import { type Project, type InsertProject, PROJECT_TYPES } from "@shared/schema";

export interface IStorage {
  createProject(project: InsertProject): Promise<Project>;
  getProject(id: number): Promise<Project | undefined>;
  getAllProjects(userId?: number | null): Promise<Project[]>;
  updateProject(id: number, data: Partial<InsertProject>): Promise<Project | undefined>;
  deleteProject(id: number): Promise<void>;
  deleteAllProjects(): Promise<void>;
}

import { db } from "./db";
import { projects } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

// Registered by the app at startup (see setProjectTerminalHook). Fired whenever
// a project reaches a terminal status so features like the Telegram batch
// summary can react — without storage importing them (avoids an import cycle).
type ProjectTerminalHook = (project: Project) => void;
let projectTerminalHook: ProjectTerminalHook | null = null;
export function setProjectTerminalHook(fn: ProjectTerminalHook) {
  projectTerminalHook = fn;
}

export class DatabaseStorage implements IStorage {
  async createProject(project: InsertProject): Promise<Project> {
    const [newProject] = await db.insert(projects).values({
      userId: project.userId || null,
      name: project.name || "Untitled Project",
      projectType: project.projectType || PROJECT_TYPES.CLASSIC,
      status: project.status || "uploading",
      currentStep: project.currentStep || "uploading",
      progress: project.progress || 0,
      errorMessage: project.errorMessage || null,
      sourceVideoPath: project.sourceVideoPath || null,
      voiceoverPath: project.voiceoverPath || null,
      bgMusicPath: project.bgMusicPath || null,
      logoPath: project.logoPath || null,
      logoPosition: project.logoPosition || "top-right",
      voiceoverDuration: project.voiceoverDuration || null,
      transcription: project.transcription || null,
      mixedAudioPath: project.mixedAudioPath || null,
      captionVideoPath: project.captionVideoPath || null,
      captionStyle: project.captionStyle || "capcut_green",
      isVerticalSource: project.isVerticalSource ?? false,
      cropType: project.cropType || "none",
      hookEnabled: project.hookEnabled ?? false,
      hookTimecode: project.hookTimecode || null,
      originalVideoUrl: project.originalVideoUrl || null,
      shortVideoUrl: project.shortVideoUrl || null,
      logoLayout: project.logoLayout ?? null,
      timecodes: project.timecodes ?? null,
      hookTitle: project.hookTitle ?? null,
      variantConfig: project.variantConfig ?? null,
      batchId: project.batchId ?? null,
      sheetSourceNumber: project.sheetSourceNumber ?? null,
      sheetVariantLabel: project.sheetVariantLabel ?? null,
      aiAnalysisVideoPath: project.aiAnalysisVideoPath ?? null,
      musicAttribution: project.musicAttribution ?? null,
    }).returning();
    return newProject;
  }

  async getProject(id: number): Promise<Project | undefined> {
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    return project;
  }

  async getAllProjects(userId?: number | null): Promise<Project[]> {
    if (userId) {
      return db.select().from(projects)
        .where(eq(projects.userId, userId))
        .orderBy(desc(projects.createdAt));
    }
    return db.select().from(projects).orderBy(desc(projects.createdAt));
  }

  async updateProject(id: number, data: Partial<InsertProject>): Promise<Project | undefined> {
    const [updated] = await db
      .update(projects)
      .set(data)
      .where(eq(projects.id, id))
      .returning();
    // Notify the terminal hook when this update just moved the project into a
    // final state — used for the per-user batch-completion Telegram summary.
    if (
      updated &&
      (data.status === "complete" || data.status === "failed") &&
      projectTerminalHook
    ) {
      try { projectTerminalHook(updated); } catch (e) { console.error("[terminalHook] failed:", e); }
    }
    return updated;
  }

  async deleteProject(id: number): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }

  async deleteAllProjects(): Promise<void> {
    await db.delete(projects);
  }
}

export const storage = new DatabaseStorage();
