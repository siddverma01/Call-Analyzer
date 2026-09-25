# CallNotes AI — Architecture

## 1. System overview

CallNotes AI is a **local-first, multi-user** meeting transcription platform.

- A **desktop client** captures microphone and Windows *system audio*, transcribes
  speech with a **local Whisper** runtime, and (optionally) summarizes the meeting
  with a **local LLM** — all offline-capable.
- Only **text** (transcript segments, summaries, action items, metadata) is
  synchronized to the backend.
- The **backend** (Fastify + PostgreSQL) owns accounts, authorization, meeting
  records, and admin/audit functionality.
- An **admin console** provides oversight for administrators.

```
┌─────────────────────────────────────────────────────────────────┐
│ USER'S COMPUTER                                                 │
│                                                                 │
│  Microphone ──────┐                                             │
│                   ├─→ Local Audio Capture ─→ VAD ─→ Chunks      │
│  System audio ────┘   (WASAPI loopback)        ─→ Local Whisper │
│                                                    ─→ Transcript│
│                                                    ─→ Local LLM │
│                                                    ─→ Notes     │
│                                          RAW AUDIO NEVER EXITS  │
└───────────────────────────────┬─────────────────────────────────┘
                                │  TEXT ONLY over HTTPS
                                ▼
                    ┌───────────────────────────┐
                    │  Backend API (Fastify)    │
                    │  Auth · RBAC · Meetings   │
                    │  Admin · Audit · Sync     │
                    └───────────┬───────────────┘
                                ▼
                         PostgreSQL (Prisma)
```

## 2. Monorepo

npm workspaces. Every package is strict TypeScript with `noEmit` (code is run
through `tsx`/Node type-stripping in dev and bundled for production).

| Path                  | Responsibility                                        |
| --------------------- | ----------------------------------------------------- |
| `apps/backend`        | Fastify API, Prisma client, auth, meetings, templates, action items, admin, export |
| `apps/desktop`        | Electron main + preload + React renderer              |
| `apps/admin`          | Admin web console (Vite/React/Tailwind)               |
| `packages/shared`     | Zod contracts, enums, types, IPC channel names        |
| `packages/config`     | Typed environment loading/validation (zod)            |

Cross-package imports resolve to TypeScript source, so all tools (tsx, Vite,
Vitest, Node type-stripping) consume the same code without a build step.

## 3. Desktop

- **Process model**: main / preload / renderer
- **Security**: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, locked-down navigation, deny all popups
- **IPC**: renderer → preload → typed channels (`IpcChannels` in
  `packages/shared`) → main-process services. The renderer has no Node access.
- **Backend communication** happens in the main process (fetch with timeout and
  zod validation), so tokens and URLs stay out of renderer code.
- An optional, **config-gated** auto-updater (`electron-updater`) only starts when
  `CALLNOTES_UPDATE_URL` points at an `https://` generic feed; otherwise it is a
  no-op and the app never phones an update host.

## 4. Backend

Fastify 5 with a module-per-capability layout:

```
src/
├── main.ts            bootstrap + graceful shutdown
├── app.ts             app factory (plugins + routes), injectable DB for tests
├── env.ts             typed env accessor
├── core/              errors, logger
├── db/                Database interface + Prisma client factory
└── modules/
    ├── health/        /health, /health/database, /health/ready
    ├── version/       /api/version
    ├── auth/          register/login/logout/password + session guard (RBAC)
    ├── users/         user mapping
    ├── meetings/      owner-scoped CRUD + search + /sync (idempotent offline sync)
    ├── templates/     system + custom templates, defaults
    ├── actionItems/   per-user tasks
    ├── export/        markdown / docx / json export
    ├── admin/         ADMIN-only users/stats/meetings/audit routes
    └── audit/         AuditLog writer shared by routes
```

Design rules:

- Request validation with zod; standardized error envelope; no stack traces to clients
- `setErrorHandler` maps `AppError` + zod failures to consistent JSON
- Every injected dependency goes through `buildApp({ env, database })` so tests
  replace real infra with stubs
- Structured pino logging with auth-secret redaction

## 5. Data store

- **PostgreSQL** via Prisma (driver adapter `@prisma/adapter-pg` — Prisma 7,
  no native query engine). Schema in `apps/backend/prisma/schema.prisma` and
  migrations under `apps/backend/prisma/migrations`.
- Models: `User`, `Session`, `Meeting`, `TranscriptSegment`, `MeetingSummary`,
  `ActionItem`, `SpeakerMapping`, `Template`, `Setting`, `AuditLog`.
- Offline local storage on the desktop (SQLite) is introduced with the meeting
  lifecycle module; the backend remains the system of record for text.

## 6. Privacy boundary

See `docs/privacy.md`. Summary: audio capture, buffering, VAD, Whisper
transcription, and (optionally) LLM summarization all happen on the user's
machine. The `postgres` schema contains **no audio columns**. There is **no
audio API endpoint**. This is enforced by design, not convention.

## 7. Roadmap

All phases are implemented and verified:

| Phase | Scope                                          |
| ----- | ---------------------------------------------- |
| 1     | Foundation, monorepo, backend, DB, shells      |
| 2     | Windows audio capture (mic + WASAPI loopback)  |
| 3     | Local Whisper (after-meeting transcription)  |
| 4     | Meeting lifecycle, local store, offline sync   |
| 5     | Local LLM summaries + action items             |
| 6     | Templates & custom layouts                     |
| 7     | Admin dashboard users/stats/audit              |
| 8     | Search, tasks, exports                         |
| 9     | Security hardening, packaging, installer, docs |

Future work: code signing + verified update feed, macOS/Linux support, richer
admin analytics, and offline bulk export.