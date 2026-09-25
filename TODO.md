# Roadmap

Phase 1 ships the project **foundation** (verified): PostgreSQL/Prisma schema,
Fastify API with health endpoints, desktop + admin shells, shared contracts, and
typed configuration. Everything below is deliberately deferred.

## Phase 2 — Auth, meetings & transcription

- **Authentication**: real Argon2id password hashing (replaces the placeholder
  seed hash), JWT access tokens + rotating refresh tokens, session rotation and
  revocation, rate-limited login/register endpoints.
- **RBAC + ownership**: `USER`/`ADMIN` enforcement via Fastify guards, all
  queries scoped to `userId`, audit-log writes on auth/sensitive events.
- **Audio capture (local)**: `desktopCapturer` system-audio capture with a
  signal-aware sink; raw audio stays in-process and is never written to disk or
  sent to the network.
- **Transcription (local)**: on-device Whisper (prebuilt binaries; verified to
  run on this CPU-only machine), streaming chunking, local model lifecycle and
  caching.
- **Transcript sync**: client-generated `clientSegmentId` upserts (idempotent
  thanks to `@@unique([meetingId, clientSegmentId])`), zustand state → IPC →
  backend; backfill on reconnect.
- **Meeting lifecycle**: create/pause/resume/end meetings, live-status, history
  pages wired to the API, offline queue.

## Phase 3 — Notes, summaries & admin

- **AI notes (local LLM)**: meeting summaries, action items, and speaker mapping
  from transcript text via local LLM; template-driven output (`Template` model).
- **Admin console**: user management, settings, audit-log viewer, usage of
  existing `AdminApp` shell and `/api` proxy.
- **Packaging**: electron-builder installers, auto-updates, signed builds.

## Never (privacy invariant)

Raw audio never leaves the machine. While a meeting runs it exists only as
temporary local files that are deleted after transcription; it is never stored
anywhere long-term. The backend accepts transcript text, summaries, action
items, and metadata only. No audio endpoints or audio tables exist
(`docs/privacy.md`).