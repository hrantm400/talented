# Local Setup

This project is intended to run locally from the repository root on Windows.

## Required tools

- Node.js 20+
- npm
- PostgreSQL
- Python 3.10+
- FFmpeg and FFprobe available in `PATH`

## Install

1. Install JavaScript dependencies:
   `npm install`
2. Install Python dependency for Whisper transcription:
   `python -m pip install -r requirements.txt`
3. Create `.env` based on `.env.example`.

## Required environment

- `DATABASE_URL`
- `OPENROUTER_API_KEY`

## Useful optional environment

- `WHISPER_MODEL`
- `YT_DLP_PROXY`
- `APP_PUBLIC_URL`
- Google Sheets credentials if you use sheet export

## Local run

1. Start the app:
   `npm run dev`
2. Type-check:
   `npm run check`
3. Build production bundle:
   `npm run build`
4. Smoke-check the built server:
   `npm run smoke:prod`

## Notes

- ElevenLabs API keys are stored through the app UI in the database, not in the browser.
- Runtime media is generated into `uploads/`, `downloads/`, and `outputs/`.
- The built server expects to be started from the project root.
