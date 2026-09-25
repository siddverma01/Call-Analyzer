import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { InjectOptions } from "light-my-request";
import { buildApp, type BuiltApp } from "../src/app.ts";
import { setEnvForTests, getEnv } from "../src/env.ts";
import { createDatabase } from "../src/db/prisma.ts";
import { ensurePostgresStopped, startEmbeddedPostgres, runMigrations } from "../src/dev-pg.ts";

/**
 * Production admin system + security hardening suite.
 *
 * Proves the ADMIN-only data plane (dashboard stats, users, user details,
 * meetings, audit logs), the immutability of the caller's identity, rejection
 * of raw-audio uploads, ownership isolation across search and export, the
 * last-active-admin invariant, the canonical audit action set, and cookie
 * session hardening - all against a real embedded PostgreSQL.
 */

const PASSWORD = "Secure-Password-1234";
const COOKIE_SECRET = "test-cookie-secret-0123456789abcdef0123456789abcdef";

let built: BuiltApp;
let app: FastifyInstance;
let pg: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
const cookies: Record<string, string> = {};

function cookieFromRes(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie ?? "");
  const match = raw.match(/callnotes\.sid=([^;]+)/);
  return match?.[1] ?? "";
}

function getCookie(user: "alice" | "bob" | "boss" | "carol"): string {
  const token = cookies[user];
  if (!token) throw new Error(`no cookie for ${user}`);
  return token;
}

async function register(email: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, name, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  return cookieFromRes(res);
}

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return cookieFromRes(res);
}

async function createMeeting(cookie: string, title: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/meetings",
    headers: { cookie: `callnotes.sid=${cookie}` },
    payload: { title },
  });
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}

function authed(opts: InjectOptions, cookie: string): InjectOptions {
  return { ...opts, headers: { ...(opts.headers ?? {}), cookie: `callnotes.sid=${cookie}` } };
}

/** User id straight from the DB - keeps logins (rate-limited) out of setup. */
async function dbUserId(email: string): Promise<string> {
  const user = await built.database.client.user.findUniqueOrThrow({ where: { email } });
  return user.id;
}

beforeAll(async () => {
  process.env["DEV_PG_DATA_DIR"] = "./test/.tmp-pg-admin";
  process.env["DEV_PG_PORT"] = "55635";
  process.env["DEV_PG_DATABASE"] = "callnotes_test";
  rmSync("./test/.tmp-pg-admin", { recursive: true, force: true });

  setEnvForTests({ ...getEnv(), NODE_ENV: "test", LOG_LEVEL: "silent", COOKIE_SECRET });

  const pgRef = await startEmbeddedPostgres();
  pg = pgRef;
  runMigrations(pg.databaseUrl);

  setEnvForTests({ ...getEnv(), DATABASE_URL: pg.databaseUrl });
  database = createDatabase(pg.databaseUrl);
  built = await buildApp({ env: getEnv(), database });
  app = built.app;

  cookies.alice = await register("alice@example.com", "Alice");
  cookies.bob = await register("bob@example.com", "Bob");
  cookies.boss = await register("boss@example.com", "Boss");
  cookies.carol = await register("carol@example.com", "Carol");

  // Promote the boss account to ADMIN directly in the DB (seed-equivalent).
  await database.client.user.update({
    where: { email: "boss@example.com" },
    data: { role: "ADMIN" },
  });
});

afterAll(async () => {
  const quietly = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[admin-security] ${label} failed:`, err);
    }
  };
  await quietly("app.close", async () => {
    await app?.close();
  });
  await quietly("database.disconnect", async () => {
    await database?.disconnect();
  });
  await quietly("pg.stop", async () => {
    await pg?.stop();
  });
  ensurePostgresStopped(process.env["DEV_PG_DATA_DIR"], Number(process.env["DEV_PG_PORT"]));
});

describe("admin API access control", () => {
  it("normal users get 403 on every admin endpoint", async () => {
    const endpoints = [
      "/api/admin/users",
      "/api/admin/stats",
      "/api/admin/meetings",
      "/api/admin/audit-logs",
      "/api/admin/users/some-id",
    ];
    for (const url of endpoints) {
      const res = await app.inject(authed({ method: "GET", url }, getCookie("bob")));
      expect(res.statusCode, `${url} for a USER`).toBe(403);
      expect(res.json().error.code, `${url} error code`).toBe("FORBIDDEN");
    }
  });

  it("admins can read dashboard stats and the enriched user list", async () => {
    const aliceId = await dbUserId("alice@example.com");
    const meeting = await createMeeting(getCookie("alice"), "Stats baseline meeting");
    await built.database.client.actionItem.create({
      data: {
        userId: aliceId,
        meetingId: meeting,
        description: "Nail the admin numbers",
        priority: "MEDIUM",
        status: "OPEN",
      },
    });

    const stats = await app.inject(authed({ method: "GET", url: "/api/admin/stats" }, getCookie("boss")));
    expect(stats.statusCode).toBe(200);
    expect(stats.json().totalUsers).toBe(4);
    expect(stats.json().activeUsers).toBe(4);
    expect(stats.json().totalMeetings).toBeGreaterThanOrEqual(1);
    expect(stats.json().totalTranscribedMinutes).toBeGreaterThanOrEqual(0);
    expect(stats.json().totalActionItems).toBeGreaterThanOrEqual(1);

    const users = await app.inject(authed({ method: "GET", url: "/api/admin/users" }, getCookie("boss")));
    expect(users.statusCode).toBe(200);
    const aliceRow = (users.json().items as { email: string; meetingCount: number; lastActivityAt: string | null }[]).find(
      (u) => u.email === "alice@example.com",
    );
    expect(aliceRow?.meetingCount).toBeGreaterThanOrEqual(1);
    expect(aliceRow?.lastActivityAt).toBeTruthy();
  });

  it("admins can open a user detail with profile, stats, meetings, and tasks", async () => {
    const aliceId = await dbUserId("alice@example.com");
    const detail = await app.inject(authed({ method: "GET", url: `/api/admin/users/${aliceId}` }, getCookie("boss")));
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.user.email).toBe("alice@example.com");
    expect(body.user.meetingCount).toBeGreaterThanOrEqual(1);
    expect(body.stats.meetingCount).toBe(body.user.meetingCount);
    expect(Array.isArray(body.meetings)).toBe(true);
    expect(body.meetings[0]).toHaveProperty("ownerEmail", "alice@example.com");
    expect(Array.isArray(body.actionItems)).toBe(true);
    expect(body.actionItems.some((a: { description: string }) => a.description === "Nail the admin numbers")).toBe(true);
  });

  it("a normal user cannot read another user's detail via the admin endpoint", async () => {
    const aliceId = await dbUserId("alice@example.com");
    const res = await app.inject(authed({ method: "GET", url: `/api/admin/users/${aliceId}` }, getCookie("alice")));
    expect(res.statusCode).toBe(403);
  });
});

describe("caller identity cannot be forged from the request body", () => {
  it("meeting create ignores/forbids a client-supplied userId (strict schema, 400)", async () => {
    const bobId = await dbUserId("bob@example.com");
    const res = await app.inject(
      authed(
        {
          method: "POST",
          url: "/api/meetings",
          payload: { title: "Sneaky meeting", userId: bobId },
        },
        getCookie("alice"),
      ),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("meeting sync forbids a client-supplied userId (400)", async () => {
    const res = await app.inject(
      authed(
        {
          method: "POST",
          url: "/api/meetings/sync",
          payload: { clientMeetingId: "client-1", userId: "whoever", title: "Sneaky sync" },
        },
        getCookie("alice"),
      ),
    );
    expect(res.statusCode).toBe(400);
  });

  it("register forbids a client-supplied role (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Sneaky", email: "sneaky@example.com", password: PASSWORD, role: "ADMIN" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("raw audio cannot be uploaded through any API", () => {
  it("meeting create with an audio field is rejected (400)", async () => {
    const res = await app.inject(
      authed(
        {
          method: "POST",
          url: "/api/meetings",
          payload: { title: "Carrier meeting", audio: "data:audio/wav;base64,UklGRlVVVVV..." },
        },
        getCookie("alice"),
      ),
    );
    expect(res.statusCode).toBe(400);
  });

  it("meeting sync with an audio field is rejected (400)", async () => {
    const res = await app.inject(
      authed(
        {
          method: "POST",
          url: "/api/meetings/sync",
          payload: { clientMeetingId: "client-audio-1", audio: "base64:AAAA" },
        },
        getCookie("alice"),
      ),
    );
    expect(res.statusCode).toBe(400);
  });

  it("meeting detail never exposes audio or media content", async () => {
    const meeting = await createMeeting(getCookie("alice"), "Text-only notes");
    const res = await app.inject(authed({ method: "GET", url: `/api/meetings/${meeting}` }, getCookie("alice")));
    expect(res.statusCode).toBe(200);
    const serialized = JSON.stringify(res.json());
    expect(serialized).not.toMatch(/"audio"/i);
    expect(serialized).not.toMatch(/"media"/i);
    expect(serialized).not.toMatch(/"transcriptFile"/i);
  });
});

describe("search and export keep ownership isolation", () => {
  it("full-text search cannot surface another user's meetings", async () => {
    await createMeeting(getCookie("alice"), "Quantum nebula planning");
    const bobMeeting = await createMeeting(getCookie("bob"), "Bob coordinate review");

    const bobSearch = await app.inject(authed({ method: "GET", url: "/api/meetings?q=nebula" }, getCookie("bob")));
    expect(bobSearch.statusCode).toBe(200);
    const titles = (bobSearch.json().items as { title: string }[]).map((m) => m.title);
    expect(titles.some((t) => t.includes("nebula"))).toBe(false);

    const aliceSearch = await app.inject(authed({ method: "GET", url: "/api/meetings?q=nebula" }, getCookie("alice")));
    const aliceTitles = (aliceSearch.json().items as { title: string }[]).map((m) => m.title);
    expect(aliceTitles).toContain("Quantum nebula planning");
    expect(bobMeeting).toBeTruthy();
  });

  it("export cannot export another user's meeting", async () => {
    const meeting = await createMeeting(getCookie("alice"), "Export me only");

    const denied = await app.inject(
      authed({ method: "GET", url: `/api/meetings/${meeting}/export?format=markdown` }, getCookie("bob")),
    );
    expect(denied.statusCode).toBe(404);

    const own = await app.inject(
      authed({ method: "GET", url: `/api/meetings/${meeting}/export?format=markdown` }, getCookie("alice")),
    );
    expect(own.statusCode).toBe(200);
  });
});

describe("admin account management", () => {
  it("role and status changes are recorded and take effect", async () => {
    const carolId = await dbUserId("carol@example.com");

    const promote = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${carolId}/role`,
          payload: { role: "ADMIN" },
        },
        getCookie("boss"),
      ),
    );
    expect(promote.statusCode).toBe(200);

    const carolUsers = await app.inject(authed({ method: "GET", url: "/api/admin/users" }, getCookie("carol")));
    expect(carolUsers.statusCode).toBe(200);

    const demote = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${carolId}/role`,
          payload: { role: "USER" },
        },
        getCookie("boss"),
      ),
    );
    expect(demote.statusCode).toBe(200);
  });

  it("the last active admin cannot be removed", async () => {
    const bossId = await dbUserId("boss@example.com");
    const bobId = await dbUserId("bob@example.com");

    // Boss is currently the only admin. Bob is promoted, so neither is "last".
    const promoteBob = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${bobId}/role`,
          payload: { role: "ADMIN" },
        },
        getCookie("boss"),
      ),
    );
    expect(promoteBob.statusCode).toBe(200);

    // Bob (now admin) demotes Boss: allowed, Bob remains an admin.
    const demoteBoss = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${bossId}/role`,
          payload: { role: "USER" },
        },
        getCookie("bob"),
      ),
    );
    expect(demoteBoss.statusCode).toBe(200);

    // Bob is now the only active admin: he can neither demote nor disable himself.
    const demoteSelf = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${bobId}/role`,
          payload: { role: "USER" },
        },
        getCookie("bob"),
      ),
    );
    expect(demoteSelf.statusCode).toBe(403);

    const disableSelf = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${bobId}/status`,
          payload: { status: "DISABLED" },
        },
        getCookie("bob"),
      ),
    );
    expect(disableSelf.statusCode).toBe(403);

    // Restore the baseline: Bob (admin) promotes Boss back, then Boss demotes Bob.
    const restoreBoss = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${bossId}/role`,
          payload: { role: "ADMIN" },
        },
        getCookie("bob"),
      ),
    );
    expect(restoreBoss.statusCode).toBe(200);

    const demoteBob = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${bobId}/role`,
          payload: { role: "USER" },
        },
        getCookie("boss"),
      ),
    );
    expect(demoteBob.statusCode).toBe(200);
  });
});

describe("audit trail covers the required action set", () => {
  it("records every canonical admin/security action without leaking secrets", async () => {
    // MEETING_VIEWED + MEETING_DELETED (owner opens then deletes their meeting).
    const meeting = await createMeeting(getCookie("alice"), "Auditable meeting");
    const viewed = await app.inject(authed({ method: "GET", url: `/api/meetings/${meeting}` }, getCookie("alice")));
    expect(viewed.statusCode).toBe(200);
    const deleted = await app.inject(authed({ method: "DELETE", url: `/api/meetings/${meeting}` }, getCookie("alice")));
    expect(deleted.statusCode).toBe(204);

    // TEMPLATE_CHANGED on create/update/delete.
    const tplRes = await app.inject(
      authed(
        {
          method: "POST",
          url: "/api/templates",
          payload: { name: "Board cadence", schema: { sections: [{ key: "k", label: "Updates", type: "list" }] } },
        },
        getCookie("bob"),
      ),
    );
    expect(tplRes.statusCode).toBe(200);
    const tplId = tplRes.json().id as string;

    const tplPatch = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/templates/${tplId}`,
          payload: { name: "Board cadence v2" },
        },
        getCookie("bob"),
      ),
    );
    expect(tplPatch.statusCode).toBe(200);

    const tplDel = await app.inject(
      authed({ method: "DELETE", url: `/api/templates/${tplId}` }, getCookie("bob")),
    );
    expect(tplDel.statusCode).toBe(204);

    // USER_DISABLED + USER_ENABLED.
    const bobId = await dbUserId("bob@example.com");
    const disable = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${bobId}/status`,
          payload: { status: "DISABLED" },
        },
        getCookie("boss"),
      ),
    );
    expect(disable.statusCode).toBe(200);

    const enable = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${bobId}/status`,
          payload: { status: "ACTIVE" },
        },
        getCookie("boss"),
      ),
    );
    expect(enable.statusCode).toBe(200);

    // USER_ROLE_CHANGED (Carol promoted then demoted).
    const carolId = await dbUserId("carol@example.com");
    await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${carolId}/role`,
          payload: { role: "ADMIN" },
        },
        getCookie("boss"),
      ),
    );
    await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${carolId}/role`,
          payload: { role: "USER" },
        },
        getCookie("boss"),
      ),
    );

    // ADMIN_LOGIN (fresh login by the boss).
    cookies.boss = await login("boss@example.com", PASSWORD);

    const logs = await app.inject(
      authed({ method: "GET", url: "/api/admin/audit-logs?perPage=200" }, getCookie("boss")),
    );
    expect(logs.statusCode).toBe(200);
    const entries = logs.json().items as { action: string; metadata: unknown }[];
    const actions = entries.map((e) => e.action);

    for (const expected of [
      "ADMIN_LOGIN",
      "USER_CREATED",
      "USER_DISABLED",
      "USER_ENABLED",
      "USER_ROLE_CHANGED",
      "MEETING_VIEWED",
      "MEETING_DELETED",
      "TEMPLATE_CHANGED",
      "auth.login",
    ]) {
      expect(actions, `audit log contains ${expected}`).toContain(expected);
    }

    // No audit metadata may leak passwords, tokens, hashes, or the raw secret.
    for (const entry of entries) {
      const serialized = JSON.stringify(entry.metadata ?? {});
      expect(serialized).not.toMatch(/\b(password|token|secret|hash)\b/i);
    }
  });
});

describe("session cookie hardening", () => {
  it("login sets an HttpOnly SameSite session cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", password: PASSWORD },
    });
    console.error("LOGIN RESULT:", res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie ?? "");
    expect(raw).toContain("HttpOnly");
    expect(raw.toLowerCase()).toContain("samesite=strict");
  });
});

describe("login rate limiting surfaces a proper 429 (not a 500)", () => {
  it("exceeding the per-route login limit returns 429 after successful logins", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "carol@example.com", password: PASSWORD },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
    expect(last).not.toBe(500);
  });
});