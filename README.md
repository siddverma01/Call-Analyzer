# CallNotes AI

A Windows-first desktop application that captures meeting audio **locally**,
transcribes it afterwards with **local Whisper**, generates meeting notes with an
optional **local LLM**, and synchronizes **text only** to a backend for multi-user
access.

> **Privacy boundary — the most important rule in this project:**
> raw audio (microphone or system) **never** leaves the user's computer. While a
> meeting runs it is held in temporary files on the device that are **deleted
> after a successful transcription** — a failed or interrupted meeting keeps them
> locally only so the user can retry or explicitly discard them — and it is
> **never** stored anywhere long-term. The backend receives transcript text,
> summaries, action items, and metadata — never audio files, chunks, or streams.
> There are no audio endpoints, no audio tables, and no audio storage (see
> `docs/privacy.md`).

## Monorepo layout

```
callnotes-ai/
├── apps/
│   ├── desktop/        Electron + React + TS + Tailwind + Zustand (main/preload
│   │                   /renderer + WASAPI + whisper.cpp native addons)
│   ├── backend/        Fastify + TypeScript + Prisma + PostgreSQL
│   └── admin/          Admin web console (Vite + React + Tailwind)
├── packages/
│   ├── shared/         Zod DTOs, enums, IPC + API contracts
│   └── config/         Typed environment loading (zod)
├── docs/               Architecture, security, privacy, API, deployment docs
├── scripts/            Local PostgreSQL + verification harnesses
├── docker-compose.yml  PostgreSQL for Docker-based development/deploy
└── .env.example        Environment template (never commit real .env)
```

## Status

All phases are implemented and verified end to end:

- **Capture**: real microphone + Windows system audio (WASAPI loopback) with VAD,
  level meters, and mic testing; long meetings stream to **temporary 60 s PCM
  chunks** on disk with a disk-space preflight + storage estimate, and
  pause/resume. Temp audio is deleted after a successful transcription and kept
  (for retry / explicit discard) when a meeting fails or is interrupted.
- **Transcription**: local `whisper.cpp` (tiny/base/small/medium), models
  downloaded on demand from Hugging Face and **SHA-1 verified**, offline-capable.
- **Meetings**: local-first lifecycle (start/stop/save/finalize), offline SQLite
  store, and an idempotent sync queue to the backend on reconnect. Failed
  meetings with preserved audio offer retry or delete.
- **AI notes**: local LLM (Ollama / llama.cpp) generates summary, decisions,
  risks, and action items; templates (system + custom) shape output. No cloud LLM.
- **Backend**: accounts (Argon2id + rotating session cookies), owner-scoped
  meetings/templates/action items, search, export, admin dashboard, and audit log.
- **Build**: strict TypeScript + ESLint + Vitest across all workspaces,
  standalone progress, and a Windows NSIS installer.

## Requirements

- **Windows 10/11 64-bit** (primary target for WASAPI loopback, mic capture, and hardware VAD)
- **Node.js ≥ 22** (Node 24 or 26 recommended)
- **npm ≥ 11**
- **Zig Compiler ≥ 0.13** (required for compiling native WASAPI and Whisper addons):
  ```sh
  winget install zig.zig
  ```
- **PostgreSQL 16/17** — via Docker (`docker compose up -d`) **or** the embedded harness (`npm run db:up`), which requires zero external configuration
- For corporate/proxied networks: set `NODE_OPTIONS=--use-system-ca` so Node trusts the OS certificate store for Prisma/Electron/model downloads
- Windows installer build additionally needs internet access on first run (electron-builder downloads the Electron runtime + NSIS tooling)

## Quick start

```sh
# 1. Install workspace dependencies
npm install

# 2. Copy the environment configuration
copy .env.example .env

# 3. Build native Windows audio capture & Whisper inference addons (requires Zig)
npm run build:wasapi

# 4. Start backend (embedded PostgreSQL + auto-migrate + Fastify API at http://127.0.0.1:8787, docs at /docs)
npm run dev

# 5. Seed default development users (in a second terminal)
npm run db:seed

# 6. Start the web admin console (http://localhost:5174)
npm run dev:admin

# 7. Start the desktop client (or double-click run-desktop.bat)
npm run dev:desktop
```

> **Default Seed Credentials:**
> - **Admin:** `admin@callnotes.local` / `change-me`
> - **User:** `demo@callnotes.local` / `change-me`

> `npm run dev` boots embedded PostgreSQL automatically (no Docker needed) and applies pending migrations; Ctrl+C also stops the database cleanly. For a Docker-based setup use `docker compose up -d postgres` plus `EMBEDDED_PG=0`. The desktop app talks to the backend at `CALLNOTES_API_URL` (default `http://127.0.0.1:8787`).

## Desktop Client & Meeting Detection

- **1-Click Launcher:** Windows users can double-click `run-desktop.bat` in the root folder to start the desktop app.
- **Audio Capture Pipeline:** Connects directly to Windows WASAPI for dual-stream capture (Microphone Array + System Audio Loopback). No virtual audio cables or cloud audio bots.
- **On-Device Whisper:** Uses local `whisper.cpp` (compiled with AVX2 and FMA optimizations). Whisper models (`tiny`, `base`, `small`, etc.) download on-demand and are verified via SHA-1.
- **Pre-Meeting Mic Test:** The "Test" button on the New Meeting page records a 3-second sample to verify microphone levels and voice activity before starting.
- **Automatic Call Detection & Floating Overlay:** The desktop app continuously monitors system audio energy via loopback capture. When sustained speech is detected from web meetings (such as Google Meet or Zoom in Chrome/Edge) or native conferencing apps (Teams, Slack), a transparent floating overlay automatically pops up offering 1-click meeting transcription.
- **Offline-First Storage:** Transcripts and notes are persisted locally in SQLite (`%APPDATA%/@callnotes/desktop/callnotes.db`) and synced idempotently to the backend when online.

## Commands

| Command                             | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `npm run dev`                       | Backend: embedded PostgreSQL + migrate + API (`:8787`)     |
| `npm run dev:backend`               | Backend only (skip embedded DB)                            |
| `npm run dev:admin`                 | Start the Vite Admin web console (`:5174`)                 |
| `npm run dev:desktop`               | Start the Electron desktop client (or `run-desktop.bat`)   |
| `npm run build:wasapi`              | Compile native WASAPI and Whisper addons with Zig          |
| `npm run build`                     | Build all workspaces for production                        |
| `npm run typecheck`                 | Type-check all workspaces (strict TypeScript)              |
| `npm run lint`                      | ESLint all workspaces                                      |
| `npm run test`                      | Run all workspace unit & integration tests (Vitest)        |
| `npm run db:up / db:down`           | Start/stop embedded PostgreSQL (foreground)                |
| `npm run db:migrate`                | Create + run Prisma database migrations                    |
| `npm run db:seed`                   | Seed development admin and demo users                      |
| `npm run verify`                    | End-to-end backend health & API verification               |
| `npm run dist:win -w @callnotes/desktop` | Build the standalone Windows NSIS installer (`.exe`)  |

## Environment

Copy `.env.example` to `.env` and adjust. `DATABASE_URL` targets PostgreSQL and
`COOKIE_SECRET` (≥ 32 chars) signs the session cookie. Everything is exposed
through `packages/config` with zod validation so invalid or missing config fails
fast with a clear message.

## Security model

- Fastify with `@fastify/helmet`, CORS allow-list, 1 MiB body limit, and global
  + per-route rate limiting
- Account auth with Argon2id and **rotating HttpOnly session cookies**; RBAC for
  USER/ADMIN; server-side ownership scoping on every query (never from the client)
- Standardized, structured error responses — no stack traces leak to clients
- Admin-only routes gated by role; mutations and meeting views logged to `AuditLog`
- Electron window: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, navigation locked to app content
- Typed, minimal IPC surface; the renderer never touches Node APIs or the network
- Whisper + LLM model downloads are SHA-1 verified; auto-update refuses anything
  that is not an explicitly configured `https://` feed
- Secrets live only in `.env`, never committed

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — system architecture and data flow
- [`docs/api.md`](docs/api.md) — backend REST API reference
- [`docs/privacy.md`](docs/privacy.md) — privacy design (audio stays local)
- [`docs/security.md`](docs/security.md) — security model
- [`docs/database.md`](docs/database.md) — PostgreSQL schema
- [`docs/audio-capture.md`](docs/audio-capture.md) — WASAPI capture pipeline
- [`docs/whisper.md`](docs/whisper.md) — local transcription + model management
- [`docs/deployment.md`](docs/deployment.md) — backend/installer/auto-update deploys
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — symptoms and fixes
- [`docs/development.md`](docs/development.md) — developer setup and toolchain

## License

UNLICENSED — internal project.