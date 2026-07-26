import "dotenv/config";
import fs from "fs";
import { execSync } from "child_process";
import { Pool } from "pg";
import { storage } from "../server/storage";
import {
  runAutomatedShortBackgroundForExisting,
  type RunAutomatedShortOptions,
} from "../server/automated-shorts/orchestrator";
import { runAutomatedShortBackgroundForExistingNV } from "../server/automated-shorts/orchestrator-no-voiceover";
import { PROJECT_TYPES } from "@shared/schema";

// ── Resume today's stuck/failed Automated Shorts ─────────────────────────────
// Mirrors /api/projects/:id/retry, but batches the whole day's backlog.
//
// IMPORTANT: run()/runForExisting does download+TTS+hook, then hands the render
// to an in-process FFmpeg queue (pLimit(2)) via queuePipeline() and RETURNS
// EARLY — the render finishes asynchronously. So we must NOT exit once the
// run() calls resolve; we poll the DB until every target project reaches a
// terminal state (complete/failed) so the render queue can fully drain.
//
// Safe to re-run: re-queries whatever is still processing/failed today, so a
// partial run just picks up the rest. Downloads are serialised globally by the
// yt-dlp queue; renders by pLimit(2). Our own pool below only throttles how
// many run() (download+TTS) run at once.

const args = process.argv.slice(2);
const onlyIds = args.filter((a) => /^\d+$/.test(a)).map(Number);
const FEED_CONCURRENCY = 3;
const MIN_FREE_GB = 20; // hard stop feeding new downloads below this
const POLL_MS = 15000;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000; // 6h safety cap on the drain wait

function freeGB(): number {
  try {
    const line = execSync("df -kP /").toString().trim().split("\n").pop()!;
    return Number(line.split(/\s+/)[3]) / (1024 * 1024);
  } catch {
    return 999;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(
    onlyIds.length
      ? `select id from projects where id = ANY($1::int[]) order by id`
      : `select id from projects
           where created_at >= date_trunc('day', now())
             and status in ('processing','failed')
             and project_type in ('automated','automated-no-voiceover')
           order by id`,
    onlyIds.length ? [onlyIds] : []
  );

  const targetIds: number[] = rows.map((r: any) => r.id);
  const total = targetIds.length;
  const queue = [...targetIds];
  console.log(`[resume] ${total} projects to resume, free=${freeGB().toFixed(1)}GB, feedConcurrency=${FEED_CONCURRENCY}`);
  if (!total) {
    await pool.end();
    return;
  }

  let enqueued = 0;
  let feedFailed = 0;

  // ── Phase 1: feed each project through download+TTS+hook, then enqueue render.
  async function feeder(wid: number) {
    while (queue.length) {
      const free = freeGB();
      if (free < MIN_FREE_GB) {
        console.log(`[resume] LOW DISK ${free.toFixed(1)}GB < ${MIN_FREE_GB}GB — feeder ${wid} stops, ${queue.length} left unfed`);
        return;
      }
      const id = queue.shift();
      if (id == null) return;
      try {
        const project = await storage.getProject(id);
        if (!project) {
          console.log(`[resume] ? #${id} not found, skip`);
          continue;
        }
        const hasOnDisk = (p?: string | null): boolean => !!p && fs.existsSync(p);
        const isNV = project.projectType === PROJECT_TYPES.AUTOMATED_NO_VOICEOVER;

        const opts: RunAutomatedShortOptions = {
          userId: project.userId,
          fullVideoUrl: hasOnDisk(project.sourceVideoPath) ? undefined : project.originalVideoUrl || undefined,
          shortVideoUrl: hasOnDisk(project.aiAnalysisVideoPath) ? undefined : project.shortVideoUrl || undefined,
          fullVideoPath: hasOnDisk(project.sourceVideoPath) ? project.sourceVideoPath! : undefined,
          shortVideoPath: hasOnDisk(project.aiAnalysisVideoPath) ? project.aiAnalysisVideoPath! : undefined,
          bgMusicPath: project.bgMusicPath || "",
          logoPath: project.logoPath || null,
          targetSeconds:
            project.voiceoverDuration && project.voiceoverDuration > 0 ? project.voiceoverDuration : 20,
          videoType: "edited",
          projectName: project.name,
          isVerticalSource: !!project.isVerticalSource,
          cropType: project.cropType || "none",
          hookEnabled: !!project.hookEnabled,
          captionStyle: project.captionStyle || "capcut_green",
        };

        await storage.updateProject(id, {
          status: "processing",
          currentStep: "uploading",
          progress: 5,
          errorMessage: null,
        });
        console.log(`[resume] ▶ #${id} "${project.name}" feed (w${wid}, free=${free.toFixed(0)}GB, left=${queue.length})`);

        const run = isNV
          ? runAutomatedShortBackgroundForExistingNV
          : runAutomatedShortBackgroundForExisting;
        await run(id, opts); // resolves after render is ENQUEUED (not finished)
        enqueued++;
      } catch (e: any) {
        feedFailed++;
        const msg = String(e?.message || "resume failed");
        try {
          await storage.updateProject(id, { status: "failed", errorMessage: msg.slice(0, 500) });
        } catch {}
        console.log(`[resume] ✖ #${id} FEED FAILED: ${msg} [feedFail=${feedFailed}]`);
      }
    }
  }

  await Promise.all(Array.from({ length: FEED_CONCURRENCY }, (_, i) => feeder(i + 1)));
  console.log(`[resume] Phase 1 done: enqueued=${enqueued}, feedFailed=${feedFailed}, unfed=${queue.length}. Draining render queue…`);

  // ── Phase 2: keep the process alive until the render queue drains.
  const startWait = Date.now();
  while (Date.now() - startWait < MAX_WAIT_MS) {
    const { rows: st } = await pool.query(
      `select status, count(*)::int c from projects where id = ANY($1::int[]) group by status`,
      [targetIds]
    );
    const by: Record<string, number> = {};
    st.forEach((r: any) => (by[r.status] = r.c));
    const processing = by["processing"] || 0;
    console.log(
      `[resume] draining… complete=${by["complete"] || 0} failed=${by["failed"] || 0} processing=${processing} / ${total}, free=${freeGB().toFixed(0)}GB`
    );
    if (processing === 0) break;
    await sleep(POLL_MS);
  }

  const { rows: fin } = await pool.query(
    `select status, count(*)::int c from projects where id = ANY($1::int[]) group by status`,
    [targetIds]
  );
  const byFin: Record<string, number> = {};
  fin.forEach((r: any) => (byFin[r.status] = r.c));
  await pool.end();
  console.log(
    `[resume] COMPLETE. complete=${byFin["complete"] || 0} failed=${byFin["failed"] || 0} processing=${byFin["processing"] || 0} of ${total}, free=${freeGB().toFixed(1)}GB`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[resume] FATAL", e);
    process.exit(1);
  });
