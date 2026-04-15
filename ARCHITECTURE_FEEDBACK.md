# ReelForge / MyViral - Architecture & Feedback

## Overview
ReelForge is a very promising AI-powered video editing platform. It connects numerous powerful tools like OpenRouter/Gemini (LLM), ElevenLabs (Voice Generation), and FFmpeg (Audio/Video Processing) with a robust React/Express/Drizzle stack.

However, from a professional standpoint, there are several areas of the codebase that are unfinished or could cause issues in a production environment.

## 1. Test Environment & Database Dependency
- **Issue:** Several tests originally failed because functions like `getVideoModel` and `getOpenRouterKey` interact directly with the PostgreSQL database. When the test environment lacks a running DB, it crashes (`ECONNREFUSED`).
- **Fix Applied:** In `server/pipeline/gemini.test.ts`, the `db.select` call was mocked out to avoid the database dependency.
- **Recommendation:** Isolate side-effects. Use dependency injection for configuration and keys rather than making inline database calls.

## 2. Pipeline Manager & Async Processing
- **Issue:** The `runPipeline` function executes heavy, long-running FFmpeg commands synchronously via `execPromise` within the main Express loop.
- **Why it's bad:** Node.js is single-threaded. Spawning heavy subprocesses and waiting on them within an API route (or a simple async loop) can lead to starvation. Under heavy load (e.g., 5 users generating 4K videos at once), the server will become unresponsive or crash due to memory/CPU overload.
- **Recommendation:** Implement a proper background job queue like [BullMQ](https://docs.bullmq.io/) with Redis. Offload FFmpeg processing to separate worker processes.

## 3. API Key Security
- **Issue:** API keys for OpenRouter and ElevenLabs are stored as plain text in the PostgreSQL database (`globalSettings` and `users` tables).
- **Why it's bad:** If the database is compromised, all paid API keys are exposed.
- **Recommendation:** Encrypt keys at rest using a symmetric encryption library (e.g., `crypto` module in Node.js) with a master key stored in `.env`.

## 4. OpenRouter/LLM JSON Parsing
- **Issue:** `extractHighlights` asks the LLM to return JSON. Even with a good prompt, LLMs frequently return markdown blocks, extra text, or truncated JSON.
- **Recommendation:** Use modern JSON enforcement features if the model supports it (like `response_format: { type: "json_object" }`). Or, use a robust parser like `json5` or a regex to extract content inside `[` and `]` instead of relying on exact string matches.

## 5. Storage / File Management
- **Issue:** Videos are stored locally in the `uploads/` and `outputs/` directories.
- **Recommendation:** If the application scales across multiple servers, local storage won't work. Move file storage to an S3-compatible service (AWS S3, Cloudflare R2, MinIO).
