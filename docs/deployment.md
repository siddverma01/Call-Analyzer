# Deployment

CallNotes AI is **local-first**: the heavy lifting (audio capture, Whisper, local
LLM summarization, offline queueing) runs on the user's Windows machine. The
backend is a text-only sync/account service and is small — a single Node process
plus PostgreSQL. The admin console is a static build.

## Production topology

```
Windows desktop (CallNotes AI.exe)
   │  HTTPS, text only (environment: CALLNOTES_API_URL)
   ▼
Node backend (Fastify) ──► PostgreSQL 16/17
   │
   ▼
Admin console (static build) ──► same backend
```

Privacy invariants apply in every deployment (see `docs/privacy.md`): raw audio
never leaves the desktop, and the backend has no audio endpoints or storage.

## 1. Backend

Requirements: Node.js ≥ 22 (developed on Node 26; runtime is the TypeScript
source via Node's type-stripping, no build step), PostgreSQL 16/17.

1. Set environment / `.env`:
   - `DATABASE_URL` — e.g.
     `postgresql://callnotes:<pw>@pg-host:5432/callnotes?schema=public`
   - `PORT` (default 8080 in prod schema) and `HOST`. Keep `127.0.0.1` for a
     single-machine install; use `0.0.0.0` behind a reverse proxy.
   - `COOKIE_SECRET` — **required, minimum 32 chars**, generates the session
     signing key. Use a fresh random value per install.
   - `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=strict` when served over HTTPS.
   - `PUBLIC_API_URL` — the externally visible base URL (`https://…`).
   - `CORS_ORIGINS` — comma-separated origins of the admin console / desktop.
   - `NODE_ENV=production`, `LOG_LEVEL=info`.
2. Apply migrations: `npx prisma migrate deploy` from `apps/backend`
   (uses `DATABASE_URL` from the config file or `--url`).
3. Start: `node src/main.ts` from `apps/backend` (type-stripping runtime), under
   your process manager of choice (`systemd`, PM2, NSSM on Windows, a container).

Reverse proxy (nginx/Caddy): terminate HTTPS, forward `/health*` and `/api*`
(unauthenticated health probes stay useful), strip nothing, keep the 1 MiB body
limit or raise it. Do not terminate on plain HTTP with `COOKIE_SECURE=true`.

## 2. Desktop installer (Windows x64)

```sh
npm run build -w apps/desktop    # wasapi addon + electron-vite bundles
npm run dist:win -w apps/desktop # electron-builder → NSIS installer
```

Output (in `apps/desktop/release/`):

- `CallNotes AI-<version>-setup.exe` — the installer (~100 MB)
- `CallNotes AI-<version>-setup.exe.blockmap` — used by the auto-updater
- `win-unpacked/` — the unpacked portable build
- `builder-debug.yml` — build metadata

Config lives in `apps/desktop/electron-builder.yml`:

- Native addons ship as prebuilts under `native/prebuilds/*.node` and are
  unpacked to `resources/app.asar.unpacked/`; `npmRebuild: false` (nothing is
  compiled on the user's machine — a single Rust-free, MSVC-free install).
- NSIS one-click is **off**; the installer asks for install dir (per-user).
- `electronVersion` is pinned (44.4.4) so electron-builder always resolves the
  exact runtime.

### Code signing

Installers are **unsigned by default** (Windows SmartScreen will warn). To sign,
provide `CSC_LINK` (path/URL to the `.pfx`) and `CSC_KEY_PASSWORD` to
electron-builder (or wire a cloud signer). All signing steps run through
`signtool` automatically when a certificate is present.

## 3. Auto-update feed

Updates are **deliberately opt-in** and never contact an unconfigured host:

- The desktop only starts the electron-updater when `CALLNOTES_UPDATE_URL` is
  set to an **`https://`** endpoint at launch. Anything else is a silent no-op.
- Set the URL via a launch environment variable or a shortcut wrapper.
- Publish to that HTTPS host: `latest.yml`, the `setup.exe`, and the `.blockmap`
  (electron-builder writes these; the generic provider reads `latest.yml`).
- Updates download silently in the background and install on app quit. Status is
  surfaced as toasts in the renderer (`IpcChannels.UPDATE_STATUS`).
- Serve the feed over HTTPS only; the updater refuses plain HTTP.
- Always publish **signed** installers so the chain stays verifiable.

## 4. Admin console

`npm run build -w apps/admin` produces a static bundle in `apps/admin/dist`.
Serve it from any static host / CDN / nginx; it calls the backend at the
configured API base URL. Access is restricted to `ADMIN` role users server-side.

## 5. First-run on the user's machine

The installer deliberately does **not** bundle a Whisper model. On first run:

1. The app detects hardware and **recommends** a model (tiny → medium).
2. The user downloads it from Hugging Face; the file is SHA-1 verified, checked
   for exact size, and moved into `%APPDATA%\CallNotes AI\models`.
3. Transcription then runs fully offline.

Corporate/proxied TLS: set `NODE_OPTIONS=--use-system-ca` so the app trusts the
OS certificate store for these downloads.

## 6. Verification

- `npm run verify` at the repo root does a full one-shot backend check
  (embedded Postgres → migrate → seed → boot → health) without leaving a DB
  running.
- The test suite (`npm run test`) covers auth/security/productivity/sync/lifecycle
  on the backend (embedded Postgres, serialized) and audio/whisper/llm/sync
  units on the desktop (no hardware required).