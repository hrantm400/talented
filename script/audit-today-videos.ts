import { db } from "../server/db";
import { projects } from "@shared/schema";
import { gte } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

interface AuditResult {
  id: number;
  name: string;
  status: string;
  defectType: "OK" | "FREEZE_FRAME" | "BLACK_SCREEN_LOW_FPS" | "AUDIO_MISMATCH" | "MISSING_FILE" | "FAILED_DB";
  details: string;
}

async function auditProject(proj: any): Promise<AuditResult> {
  if (proj.status === "failed") {
    const msg = proj.errorMessage || "Unknown DB failure";
    let shortErr = "DB Failure";
    if (/private/i.test(msg)) shortErr = "Private YouTube/FB video";
    else if (/ROBOTED|robots|Cannot fetch/i.test(msg)) shortErr = "Cloudflare ROBOTED link";
    else if (/balance|402/i.test(msg)) shortErr = "OpenRouter $1.00 balance limit";

    return {
      id: proj.id,
      name: proj.name,
      status: "failed",
      defectType: "FAILED_DB",
      details: shortErr,
    };
  }

  if (proj.status !== "complete") {
    return {
      id: proj.id,
      name: proj.name,
      status: proj.status,
      defectType: "FAILED_DB",
      details: `In status '${proj.status}' (${proj.currentStep})`,
    };
  }

  const videoPath = proj.captionVideoPath;
  if (!videoPath || !fs.existsSync(videoPath)) {
    return {
      id: proj.id,
      name: proj.name,
      status: "complete",
      defectType: "MISSING_FILE",
      details: "Output MP4 file missing on disk",
    };
  }

  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-show_entries", "stream=codec_name,codec_type,width,height,avg_frame_rate,nb_frames",
      "-of", "json",
      videoPath,
    ], { timeout: 10000 });

    const probe = JSON.parse(stdout);
    const vStream = probe.streams?.find((s: any) => s.codec_type === "video");
    const duration = parseFloat(probe.format?.duration || "0");

    if (!vStream) {
      return {
        id: proj.id,
        name: proj.name,
        status: "complete",
        defectType: "BLACK_SCREEN_LOW_FPS",
        details: "No video stream in MP4 container",
      };
    }

    let fps = 30;
    if (vStream.avg_frame_rate && vStream.avg_frame_rate.includes("/")) {
      const [num, den] = vStream.avg_frame_rate.split("/").map(Number);
      if (den > 0) fps = num / den;
    }
    const nbFrames = parseInt(vStream.nb_frames || "0", 10);

    if (fps < 20 || (nbFrames > 0 && duration > 5 && nbFrames / duration < 18)) {
      return {
        id: proj.id,
        name: proj.name,
        status: "complete",
        defectType: "BLACK_SCREEN_LOW_FPS",
        details: `Low frame rate (${fps.toFixed(1)} fps, ${nbFrames} frames for ${duration.toFixed(1)}s)`,
      };
    }

    // Check segments folder for 1-frame static image segment
    const projDir = path.dirname(videoPath);
    const segDir = path.join(projDir, "segments");
    let hasFrozenSegment = false;
    let frozenInfo = "";

    if (fs.existsSync(segDir)) {
      const segFiles = fs.readdirSync(segDir).filter((f) => f.endsWith(".mp4"));
      for (const segFile of segFiles) {
        const segPath = path.join(segDir, segFile);
        try {
          const { stdout: segOut } = await execFileAsync("ffprobe", [
            "-v", "error",
            "-show_entries", "stream=nb_frames",
            "-of", "csv=p=0",
            segPath,
          ], { timeout: 5000 });
          const frames = parseInt(segOut.trim(), 10);
          if (frames === 1) {
            hasFrozenSegment = true;
            frozenInfo = `Segment '${segFile}' is a 1-frame static image`;
            break;
          }
        } catch {}
      }
    }

    if (hasFrozenSegment) {
      return {
        id: proj.id,
        name: proj.name,
        status: "complete",
        defectType: "FREEZE_FRAME",
        details: frozenInfo,
      };
    }

    return {
      id: proj.id,
      name: proj.name,
      status: "complete",
      defectType: "OK",
      details: `Valid 30fps video (${duration.toFixed(1)}s, ${nbFrames} frames)`,
    };
  } catch (err: any) {
    return {
      id: proj.id,
      name: proj.name,
      status: "complete",
      defectType: "BLACK_SCREEN_LOW_FPS",
      details: `Corrupted MP4: ${err.message}`,
    };
  }
}

async function runAudit() {
  console.log("🔍 Starting fast parallel audit of all projects created today (2026-07-22)...\n");

  const todayStr = "2026-07-22";
  const allProjects = await db
    .select()
    .from(projects)
    .where(gte(projects.createdAt, new Date(todayStr)));

  console.log(`📋 Total projects found for today: ${allProjects.length}`);

  const results: AuditResult[] = [];
  const BATCH_SIZE = 25;

  for (let i = 0; i < allProjects.length; i += BATCH_SIZE) {
    const batch = allProjects.slice(i, i + BATCH_SIZE);
    process.stdout.write(`Analyzing projects ${i + 1}..${Math.min(i + BATCH_SIZE, allProjects.length)} / ${allProjects.length}...\r`);
    const batchResults = await Promise.all(batch.map((p) => auditProject(p)));
    results.push(...batchResults);
  }

  console.log("\n\n=======================================================");
  console.log("📊 FULL AUDIT RESULTS FOR TODAY (2026-07-22)");
  console.log("=======================================================\n");

  const byDefect = new Map<string, AuditResult[]>();
  for (const r of results) {
    const list = byDefect.get(r.defectType) || [];
    list.push(r);
    byDefect.set(r.defectType, list);
  }

  const okList = byDefect.get("OK") || [];
  const freezeList = byDefect.get("FREEZE_FRAME") || [];
  const blackList = byDefect.get("BLACK_SCREEN_LOW_FPS") || [];
  const failedList = byDefect.get("FAILED_DB") || [];
  const missingList = byDefect.get("MISSING_FILE") || [];

  console.log(`🟢 OK (100% Идеальные): ${okList.length} (${((okList.length / allProjects.length) * 100).toFixed(1)}%)`);
  console.log(`🧊 FREEZE_FRAME (Застывший кадр): ${freezeList.length}`);
  console.log(`⬛ BLACK_SCREEN_LOW_FPS (Черный экран / 5 fps): ${blackList.length}`);
  console.log(`❌ FAILED_DB (Ошибки / Не создались): ${failedList.length}`);
  console.log(`📂 MISSING_FILE (Файл не найден): ${missingList.length}\n`);

  if (freezeList.length > 0) {
    console.log("🧊 Ролики с FREEZE_FRAME (Застывший кадр):");
    console.log(freezeList.map((r) => `#${r.id} ("${r.name}")`).join(", "));
    console.log("");
  }

  if (blackList.length > 0) {
    console.log("⬛ Ролики с BLACK_SCREEN_LOW_FPS (Черный экран / 5 fps):");
    console.log(blackList.map((r) => `#${r.id} ("${r.name}")`).join(", "));
    console.log("");
  }

  if (failedList.length > 0) {
    console.log("❌ Неуспешные ролики:");
    for (const f of failedList) {
      console.log(`   • #${f.id} ("${f.name}"): ${f.details}`);
    }
    console.log("");
  }

  const reportPath = "/var/www/reelsforge/outputs/audit_report.json";
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`💾 Полный отчёт сохранён в: ${reportPath}\n`);
}

runAudit().catch(console.error);
