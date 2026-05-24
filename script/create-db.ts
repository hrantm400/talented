import "dotenv/config";
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url?.trim()) {
    console.error("DATABASE_URL is not set in .env");
    process.exit(1);
  }

  const parsed = new URL(url);
  const dbName = (parsed.pathname?.replace(/^\//, "") || "myviral").replace(/\/$/, "");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
    console.error("Invalid database name in DATABASE_URL:", dbName);
    process.exit(1);
  }
  parsed.pathname = "/postgres";

  const client = new Client({ connectionString: parsed.toString() });

  try {
    await client.connect();
    const res = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (res.rowCount && res.rowCount > 0) {
      console.log(`Database "${dbName}" already exists.`);
      return;
    }
    await client.query(`CREATE DATABASE ${dbName}`);
    console.log(`Database "${dbName}" created.`);
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    if (err.code === "42P04") {
      console.log(`Database "${DATABASE_NAME}" already exists.`);
      return;
    }
    console.error("Failed to create database:", err.message ?? e);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
