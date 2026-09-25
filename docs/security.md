# Security

Implemented security controls for CallNotes AI.

## Backend

- **Helmet** security headers, CORS allow-list (local admin/dev origins), 1 MiB
  body limit, strict request validation (zod), standardized error responses
  (no stack traces), structured pino logging with authentication-secret
  redaction.
- **Rate limiting**: global + per-route (`register` 5/min, `login` 10/min,
  list/sync 60–120/min, admin 60/min).
- **Authentication**: Argon2id password hashing; rotating HttpOnly SameSite
  session cookies; password change revokes other sessions; logout revokes the
  session server-side.
- **RBAC + ownership**: `requireAuth` guard derives `userId` from the session on
  every route; ownership scoping is applied server-side in every service query
  (a user gets 404s for other users' ids). ADMIN-only routes are gated by role.
- **Audit log**: login/logout, meeting view/delete, admin mutations all write to
  `AuditLog`. Never contains passwords, tokens, or audio.
- **Privacy-by-design**: no audio columns, no audio endpoints, no audio storage.

## Electron

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`, table-driven navigation allow-list, all popups denied.
- Typed IPC surface only (`IpcChannels` in `packages/shared`); the renderer never
  touches Node APIs or the network directly — every authenticated request is
  proxied through the main process, which owns the session cookie.

## Supply chain / updates

- **Model downloads** are SHA-1 + exact-size verified with an atomic rename;
  partial or mismatched files are discarded (Whisper + local LLM).
- **Auto-update** is opt-in: electron-updater only activates in packaged builds
  when `CALLNOTES_UPDATE_URL` is an **`https://`** generic feed. Without it the
  app never contacts an update host. Plain-http feeds are rejected.
- Installers are code-signed when a certificate is configured (`CSC_LINK`).

## Non-negotiable invariants

1. Raw audio never leaves the client and never persists anywhere.
2. The client never provides its own `userId`/`role`/ownership — authorization is
   always derived from the authenticated identity server-side.
3. Renderer code never accesses Node/OS APIs directly.
4. Auto-update never contacts an unconfigured (or non-https) host.