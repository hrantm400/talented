# ReelForge - AI-Powered Vertical Video Creator

## Overview
Web application that converts horizontal videos into 9:16 vertical Shorts/Reels with AI-powered scene curation, audio mixing, and animated captions.

## Architecture

### Frontend (client/)
- React + Vite + TypeScript
- TanStack Query for data fetching
- Tailwind CSS + shadcn/ui components
- Framer Motion animations
- wouter for routing

### Backend (server/)
- Express.js API server
- In-memory storage (MemStorage)
- FFmpeg for audio/video processing
- Gemini AI (via Replit AI Integrations) for transcription and video curation

### Pipeline Steps
1. **Transcription** - Gemini transcribes voiceover with word-level timestamps
2. **Video Curation** - Gemini analyzes source video frames, selects best segments
3. **Audio Mixing** - FFmpeg: mute original, boost voiceover +10dB, reduce bg music -10dB at 1.1x speed
4. **Video Composition** - FFmpeg: 9:16 sandwich layout (blurred 330% bg + centered 150% fg)
5. **Subtitle Overlay** - ASS subtitles with CapCut-style word highlighting
6. **Dual Export** - `_clear.mp4` (no captions/logo) and `_caption.mp4` (with captions + logo)

### Caption Styles
6 preset styles defined in `shared/caption-styles.ts`:
- CapCut Green, CapCut Yellow, Neon Pop, Minimal Clean, Fire, Pink Glow
- Each style configures: font, colors, outline, shadow, highlight behavior
- Visual preview in `client/src/components/caption-styles.tsx`

### Key Files
- `shared/schema.ts` - Data types and project schema
- `shared/caption-styles.ts` - Caption style definitions
- `server/pipeline/ffmpeg.ts` - FFmpeg operations and ASS subtitle generation
- `server/pipeline/gemini.ts` - Gemini AI transcription and video curation
- `server/pipeline/processor.ts` - Pipeline orchestration
- `server/routes.ts` - API routes with multer file upload
- `client/src/pages/home.tsx` - Main UI with upload form and pipeline tracking
- `client/src/components/caption-styles.tsx` - Caption style selector with preview

### API Endpoints
- `GET /api/projects` - List all projects
- `GET /api/projects/:id` - Get project details
- `POST /api/projects/upload` - Upload files and start pipeline
- `DELETE /api/projects/:id` - Delete project
- `GET /api/projects/:id/download/:type` - Download clear or caption video

### Dependencies
- FFmpeg (system-level, available in Nix)
- multer, fluent-ffmpeg, uuid (npm)
- @google/genai (Gemini via Replit AI Integrations)
