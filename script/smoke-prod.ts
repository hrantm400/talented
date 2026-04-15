import { spawn } from "child_process";

const port = process.env.PORT || "5099";
const databaseUrl =
  process.env.DATABASE_URL || "postgresql://user:pass@127.0.0.1:5432/local";
const openRouterApiKey = process.env.OPENROUTER_API_KEY || "smoke-test-key";

const child = spawn("node", ["dist/index.cjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: port,
    DATABASE_URL: databaseUrl,
    OPENROUTER_API_KEY: openRouterApiKey,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let settled = false;

function finish(code: number, message?: string) {
  if (settled) {
    return;
  }

  settled = true;
  clearTimeout(timeout);

  if (message) {
    console.error(message);
  }

  if (!child.killed) {
    child.kill();
  }

  process.exit(code);
}

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  stdout += text;
  process.stdout.write(text);

  if (stdout.includes(`serving on port ${port}`)) {
    finish(0);
  }
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk.toString());
});

child.on("exit", (code) => {
  if (!settled) {
    finish(1, `Smoke start failed. Server exited before listening. Exit code: ${code}`);
  }
});

const timeout = setTimeout(() => {
  finish(1, "Smoke start timed out before the server reported that it was listening.");
}, 5000);
