# Troubleshooting

## Backend / database

| Symptom | Cause & fix |
| --- | --- |
| `Unable to get local issuer certificate` during install/verify | Proxied/corporate TLS. Set `NODE_OPTIONS=--use-system-ca` (trusts the OS store) and rerun. |
| Health shows database `down` | Postgres not running. `npm run db:up` (embedded) or `docker compose up -d postgres`, then `npm run db:migrate`. |
| Port 8787 / 5174 / 55432 already in use | Change `PORT`, admin `server.port`, `DEV_PG_PORT` in `.env`. |
| `Prisma client missing` | `npm run db:generate`. |
| Migrations fail outside `npm run dev` | Prisma reads `DATABASE_URL` from the shell, not `.env`. Set it first, e.g. `$env:DATABASE_URL="postgresql://callnotes:callnotes@127.0.0.1:55432/callnotes?schema=public"`, or pass `--url`. |
| `P2028` / interactive-transaction timeout in logs | New bug in sync batching; segments over a long meeting should no longer trigger this (see `docs/deployment.md` — 90 s tx timeout). If you see it, check for a change that reintroduced a long-running `$transaction`. |
| Search returns nothing for words that exist | The `searchVector` is maintained by DB triggers. If you modified transcripts outside the app (raw SQL), rerun a segment INSERT to refresh, or check the incremental trigger migration `2026_09_30_incremental_search_trigger`. |

## Desktop / installer

| Symptom | Cause & fix |
| --- | --- |
| Developer run fails / white window | `npm run dev:desktop` needs the backend reachable — `CALLNOTES_API_URL` (default `http://127.0.0.1:8787`). Start `npm run dev` first. |
| Windows shows "Windows protected your PC" on install | The installer is **unsigned** (no code-signing cert configured). Click "More info → Run anyway" in dev; the fix is signing via `CSC_LINK`/`CSC_KEY_PASSWORD`. |
| Installed app crashes on start (missing addon) | The native addons must be unpacked next to `app.asar`. Rebuild with `npm run dist:win` — the asarUnpack config places `native/prebuilds/*.node` under `resources/app.asar.unpacked/`. |
| Model download fails with HTTP error | Network/proxy: set `NODE_OPTIONS=--use-system-ca`; or the Hugging Face host is blocked — no offline fallback is offered (privacy: a cloud transcription endpoint is never used). |
| `SHA-1 verification failed` | The downloaded model is corrupt/truncated. Delete it from `%APPDATA%\CallNotes AI\models` and re-download. |
| `Not enough free disk space` | The download is pre-flighted against the model size. Free space and retry. |
| Model stuck "downloading" | Partial `.part` file cleanup happens on abort/failure; restart the app and retry. |
| No system-audio levels | Loopback only produces samples while something is playing. Test with music/speech playing; also confirm the default render endpoint in Sound settings. |
| Very slow transcription on big meetings | Small models are faster. The recommender picks by RAM/CPU; heavier tiers do realtime+ slower on weak CPUs. |
| Renderer is janky with a long open meeting | The transcript list is virtualized (fixed-row windowing) and meetings list pages (25/50). Still slow → report, don't work around it in the view layer. |
| App does not update from a configured feed | `CALLNOTES_UPDATE_URL` must be **https://** and set at launch; `latest.yml` + `.blockmap` + the new `setup.exe` must be published together. |

## Tests

| Symptom | Cause & fix |
| --- | --- |
| Backend test files collide / time out | Each test file boots its own embedded PostgreSQL. Vitest runs backend files serially (`fileParallelism: false` in `apps/backend/vitest.config.ts`); don't re-enable parallelism. |
| Desktop audio tests fail in CI | Unit tests need **no** hardware; live tests are gated behind `RUN_LIVE_AUDIO=1` + win32 and need a real mic. |
| Whisper engine tests fail | They hit the addon; rebuild with `npm run build:wasapi`. |

## General

- Most errors surface as structured JSON `{ error: { code, message } }` — the
  `code` is the fastest search key.
- Backend `.env` is git-ignored; the committed `.env.example` is the contract.
- Anything that looks like audio touching the backend is a bug — see
  `docs/privacy.md`.