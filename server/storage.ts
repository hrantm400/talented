import { type Project, type InsertProject } from "@shared/schema";

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

export class DatabaseStorage implements IStorage {
  async createProject(project: InsertProject): Promise<Project> {
    const [newProject] = await db.insert(projects).values({
      userId: project.userId || null,
      name: project.name || "Untitled Project",
      projectType: project.projectType || "classic",
      status: project.status || "uploading",
      currentStep: project.currentStep || "uploading",
      progress: project.progress || 0,
      errorMessage: project.errorMessage || null,
      sourceVideoPath: project.sourceVideoPath || null,
      voiceoverPath: project.voiceoverPath || null,
      bgMusicPath: project.bgMusicPath || null,
      logoPath: project.logoPath || null,
      voiceoverDuration: project.voiceoverDuration || null,
      transcription: project.transcription || null,
      timecodes: project.timecodes || null,
      mixedAudioPath: project.mixedAudioPath || null,
      clearVideoPath: project.clearVideoPath || null,
      captionVideoPath: project.captionVideoPath || null,
      captionStyle: project.captionStyle || "capcut_green",
      isVerticalSource: project.isVerticalSource ?? false,
      cropType: project.cropType || "none",
      hookEnabled: project.hookEnabled ?? false,
      hookTimecode: project.hookTimecode || null,
      originalVideoUrl: project.originalVideoUrl || null,
      shortVideoUrl: project.shortVideoUrl || null,
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
