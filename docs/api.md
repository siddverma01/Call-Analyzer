# Backend API

Base URL: `http://127.0.0.1:8787` in development (`CALLNOTES_API_URL` on the
desktop side). Interactive OpenAPI docs in dev: `/docs`.

All endpoints require the session cookie except `POST /api/auth/register` and
`POST /api/auth/login`. Authentication is an HttpOnly, SameSite session cookie
set by the server; ownership is **always** derived server-side from the session
(`request.authUser.id`), never trusted from the client. A user can only see and
mutate their own resources (404s on other users' ids).

Request bodies are validated with zod against the shared contracts in
`packages/shared/src`; failures return the standard error envelope:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }
```

## Health (no auth)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, service name + version |
| GET | `/health/database` | Database connectivity (SELECT 1) |
| GET | `/health/ready` | Readiness (everything required for traffic) |
| GET | `/api/version` | API version string |

## Auth

| Method | Path | Rate limit | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | 5/min | Create account (Argon2id); sets session cookie |
| POST | `/api/auth/login` | 10/min | Verify credentials; sets session cookie |
| POST | `/api/auth/logout` | 30/min | Revoke session + clear cookie |
| GET | `/api/me` | 60/min | Current user profile + session expiry |
| PATCH | `/api/auth/password` | 5/min | Change password (revokes other sessions) |

`register`/`login` return:

```json
{
  "user": { "id": "...", "name": "...", "email": "...", "role": "USER", "status": "ACTIVE", "createdAt": "..." },
  "sessionExpiresAt": "..."
}
```

## Meetings (owner-scoped)

| Method | Path | Rate limit | Purpose |
| --- | --- | --- | --- |
| GET | `/api/meetings` | 60/min | List/search with `page`, `perPage`, `status`, `templateId`, `from`, `to`, `sort` and free-text `q` (PostgreSQL full-text over title + transcript) |
| POST | `/api/meetings` | 30/min | Create a meeting (title, optional template) |
| GET | `/api/meetings/:id` | — | Full detail: meeting + `segments` + `summary`; writes an audit event |
| PATCH | `/api/meetings/:id` | 30/min | Update title/status/summary/notes |
| DELETE | `/api/meetings/:id` | — | Soft-lifecycle delete; 204; writes audit event |
| POST | `/api/meetings/sync` | 120/min | Offline-sync batch (idempotent upsert, see below) |
| GET | `/api/meetings/:id/export` | 60/min | Export as `?format=markdown|docx|json` |

### Sync endpoint

The desktop's offline queue replays transcript segments through
`POST /api/meetings/sync`. The body carries one meeting with `clientSegmentId`s;
segments are deduplicated with a unique constraint on `(meetingId, clientSegmentId)`
and matched by `new Date().getTime()` comparison for in-place updates, so
re-pushing the same meeting is idempotent. The meeting row itself is upserted in
a small transaction; segment writes are batched (`createMany` +
`skipDuplicates`, spot `update`s) to stay well inside the interactive
transaction limits — validated with 2,400-segment (4-hour) meetings in tests.

## Templates

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/templates` | Visible templates + user's default id |
| POST | `/api/templates` | Create custom template (JSON schema) |
| PATCH | `/api/templates/:id` | Update own custom template |
| DELETE | `/api/templates/:id` | Delete own custom template |
| POST | `/api/templates/:id/duplicate` | Copy a template (system → custom) |
| PUT | `/api/templates/default` | Set the user's default template id |

## Action items

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/action-items` | All action items for the user |
| POST | `/api/action-items` | Create one (optionally linked to a segment) |
| PATCH | `/api/action-items/:id` | Update status/assignee/due date/priority |
| DELETE | `/api/action-items/:id` | Delete |

## Admin (ADMIN role only, all audited)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/users` | Paginated user list |
| GET | `/api/admin/users/:id` | User detail (sessions, meetings) |
| GET | `/api/admin/stats` | Counts/aggregates for the dashboard |
| PATCH | `/api/admin/users/:id/status` | Suspend/activate |
| PATCH | `/api/admin/users/:id/role` | Promote/demote |
| GET | `/api/admin/meetings` | Paginated all-user meetings |
| GET | `/api/admin/audit-logs` | Paginated audit events |

Admin routes require `role === "ADMIN"` (derived from the session) and write
`AuditLog` records for every mutation and for meeting views.

## Rate limiting & headers

- Global rate limit + per-route limits above (`@fastify/rate-limit`).
- `@fastify/helmet` security headers, CORS allow-list (local admin/dev), 1 MiB
  body limit.
- Interactive transaction timeout: 90 s (`maxWait` 10 s) is set on the Prisma
  client so large batched syncs never hit the default 5 s cap.