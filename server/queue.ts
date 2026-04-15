const PgBoss = require('pg-boss');
import { runPipeline } from './pipeline/processor';
import { runAutomatedShort } from './automated-shorts/orchestrator';

// @ts-ignore
export const boss = process.env.DATABASE_URL ? new PgBoss(process.env.DATABASE_URL) : null;

if (boss) {
  boss.on('error', (error: any) => console.error('pg-boss error:', error));
}

export async function initQueue() {
  if (!boss) {
    console.log("DATABASE_URL missing, pg-boss will not start. Queues are disabled.");
    return;
  }
  await boss.start();
  console.log("pg-boss started successfully");

  // Queue workers
  await boss.work('video-pipeline', async (job: any) => {
    const { projectId } = job.data as { projectId: number };
    console.log(`Starting pipeline job for project ${projectId}`);
    await runPipeline(projectId);
  });

  await boss.work('automated-short', async (job: any) => {
    const { config } = job.data as any;
    console.log(`Starting automated short job for project ${config.projectName}`);
    await runAutomatedShort(config);
  });
}
