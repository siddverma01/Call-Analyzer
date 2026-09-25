# Development

## Toolchain

- Node.js ≥ 22 (this repo is developed on Node 26)
- npm ≥ 11
- No Rust/C++ toolchain is needed for normal development: native components use
  **prebuilt binaries** (`apps/desktop/native/prebuilds/`). Rebuilding them from
  source requires Zig ≥ 0.16 for WASAPI and the whisper.cpp build chain; see
  `docs/audio-capture.md`. Windows is the target platform for those addons.

> **Corporate/proxied TLS**: if downloads fail with `unable to get local issuer
> certificate`, run Node with `NODE_OPTIONS=--use-system-ca` (trusts the OS
> certificate store). Set it per-shell or add it to your environment before
> `npm install` / `npm run verify`.

## First-time setup

```sh
npm install
```

npm 11 blocks postinstall scripts by default; `.npmrc` in the repo root
pre-approves the packages that need them (esbuild, electron, prisma, embedded
postgres).

## Running everything

```sh
npm run dev            # ONE command: embedded PostgreSQL → migrate → backend (127.0.0.1:8787, /docs)
npm run dev:admin      # admin console → http://localhost:5174
npm run dev:desktop    # Electron desktop app (connects to 127.0.0.1:8787)
```

`npm run dev` boots embedded PostgreSQL automatically (no Docker), applies
pending migrations, then serves the API. Stop it with Ctrl+C, which also stops
the database cleanly. Set `EMBEDDED_PG=0` to skip the embedded database (for
example when using Docker: `docker compose up -d postgres`).

Alternative "split terminal" workflow:

```sh
npm run db:up          # embedded PostgreSQL in the FOREGROUND (Ctrl+C to stop)
npm run db:migrate     # apply schema changes (see note below)
npm run db:seed        # development users
npm run dev:backend
```

> **Prisma 7 + `dev-db` note**: `prisma` reads `DATABASE_URL` from your shell (or
> `prisma.config.ts`). If you run migration commands outside `npm run dev`, set
> `DATABASE_URL` first, e.g.
> `$env:DATABASE_URL="postgresql://callnotes:callnotes@127.0.0.1:55432/callnotes?schema=public"`
> on PowerShell, or pass `--url "postgresql://..."` when calling `prisma migrate`.

**Creating a new migration offline** (no DB needed; useful on fresh checkouts):

```sh
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
```

## Verification

```sh
npm run typecheck   # strict TS across all workspaces
npm run lint        # ESLint
npm run test        # Vitest: desktop units (no hardware), backend integration on embedded PG
npm run verify      # one-shot: db up → generate → migrate → seed → boot → health checks → teardown
```

`npm run test` is heavier than before: the backend integration files each boot a
real embedded PostgreSQL and are **serialized** (`fileParallelism: false` in
`apps/backend/vitest.config.ts`), so the backend suites take a few minutes.
Desktop tests run standalone and fast. <code>npm run verify</code> owns the
embedded-PostgreSQL lifecycle inside a single process; after it exits, no
database is left running.

## Troubleshooting

| Symptom                                  | Fix                                                            |
| ---------------------------------------- | -------------------------------------------------------------- |
| `Unable to get local issuer certificate` | Set `NODE_OPTIONS=--use-system-ca` and rerun install/verify    |
| Backend shows database `down`            | `npm run db:up` (or `docker compose up -d postgres`), then migrate |
| Electron window won't start              | Ensure `npm run db:up` not required; desktop only needs backend URL; check `CALLNOTES_API_URL` |
| Port 8787/5174/55432 already in use      | Change `PORT` / admin `server.port` / `DEV_PG_PORT` in `.env`  |
| Prisma client missing                    | `npm run db:generate`                                          |