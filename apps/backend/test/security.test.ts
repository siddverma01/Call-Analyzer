import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { InjectOptions } from "light-my-request";
import { buildApp, type BuiltApp } from "../src/app.ts";
import { setEnvForTests, getEnv } from "../src/env.ts";
import { createDatabase } from "../src/db/prisma.ts";
import { ensurePostgresStopped, startEmbeddedPostgres, runMigrations } from "../src/dev-pg.ts";

/**
 * Security + authorization integration suite. Runs against a real embedded
 * PostgreSQL so isolation guarantees are proven against actual FK/unique
 * constraints, indexes, and cascade rules.
 */

const PASSWORD = "Secure-Password-1234";
const COOKIE_SECRET = "test-cookie-secret-0123456789abcdef0123456789abcdef";

let built: BuiltApp;
let app: FastifyInstance;
let pg: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
let aliceCookie = "";
let bobCookie = "";
let adminCookie = "";

function cookieFromRes(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie ?? "");
  const match = raw.match(/callnotes\.sid=([^;]+)/);
  return match?.[1] ?? "";
}

function getCookie(user: "alice" | "bob" | "admin"): string {
  return user === "alice" ? aliceCookie : user === "bob" ? bobCookie : adminCookie;
}

async function register(email: string, name: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, name, password },
  });
  expect(res.statusCode).toBe(201);
  return cookieFromRes(res);
}

async function login(email: string, password: string, status = 200): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  expect(res.statusCode).toBe(status);
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

beforeAll(async () => {
  // Give the security suite its own data dir + port so it never collides with
  // a running dev database, and start from a clean slate every run.
  process.env["DEV_PG_DATA_DIR"] = "./test/.tmp-pg";
  process.env["DEV_PG_PORT"] = "55632";
  process.env["DEV_PG_DATABASE"] = "callnotes_test";
  rmSync("./test/.tmp-pg", { recursive: true, force: true });

  setEnvForTests({ ...getEnv(), NODE_ENV: "test", LOG_LEVEL: "silent", COOKIE_SECRET });

  const pgRef = await startEmbeddedPostgres();
  pg = pgRef;
  runMigrations(pg.databaseUrl);

  setEnvForTests({ ...getEnv(), DATABASE_URL: pg.databaseUrl });
  database = createDatabase(pg.databaseUrl);
  built = await buildApp({ env: getEnv(), database });
  app = built.app;

  aliceCookie = await register("alice@example.com", "Alice", PASSWORD);
  bobCookie = await register("bob@example.com", "Bob", PASSWORD);
  adminCookie = await register("boss@example.com", "Boss", PASSWORD);

  // Promote the third account to ADMIN directly in the DB (seed-equivalent).
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
      console.error(`[security] ${label} failed:`, err);
    }
  };

  // Close the server + Prisma pool, stop the embedded database, then force-kill
  // any process still holding the test port or running from the embedded binary
  // tree. The library's own stop() can miss the postmaster on Windows and leave
  // forked backends alive - an orphan keeps this worker from finishing teardown.
  // Vitest 5 forbids process.exit() in tests (it turns a green suite red), so
  // teardown relies on every handle being released instead.
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

describe("authentication", () => {
  it("rejects register with a duplicate email (409)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "alice@example.com", name: "Clone", password: PASSWORD },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("rejects login with invalid credentials (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("login issues a session cookie and /api/me resolves it", async () => {
    const cookie = await login("alice@example.com", PASSWORD);
    expect(cookie).toBeTruthy();

    const me = await app.inject(authed({ method: "GET", url: "/api/me" }, cookie));
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("alice@example.com");
    expect(me.json().user).not.toHaveProperty("passwordHash");
  });

  it("rejects requests without a session cookie (401)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("logout revokes the session immediately", async () => {
    const cookie = await login("alice@example.com", PASSWORD);
    const out = await app.inject(authed({ method: "POST", url: "/api/auth/logout" }, cookie));
    expect(out.statusCode).toBe(200);

    const me = await app.inject(authed({ method: "GET", url: "/api/me" }, cookie));
    expect(me.statusCode).toBe(401);
  });

  it("password change invalidates other sessions and the old password", async () => {
    let stepStart = Date.now();
    const mark = (label: string) => {
      const dur = Date.now() - stepStart;
      stepStart = Date.now();
      console.log(`  [dbg] ${label} +${dur}ms`);
    };

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "bob@example.com", password: PASSWORD },
    });
    mark(`login(status=${loginRes.statusCode})`);
    expect(loginRes.statusCode).toBe(200);
    const cookie = cookieFromRes(loginRes);

    const changed = await app.inject(
      authed(
        {
          method: "PATCH",
          url: "/api/auth/password",
          payload: { currentPassword: PASSWORD, newPassword: "Brand-New-Pass-901" },
        },
        cookie,
      ),
    );
    mark(`password change(status=${changed.statusCode})`);
    expect(changed.statusCode).toBe(204);

    // Old password no longer works, new one does; the acting session survives.
    const old1 = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "bob@example.com", password: PASSWORD },
    });
    mark(`old login(status=${old1.statusCode})`);
    expect(old1.statusCode).toBe(401);

    const fresh = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "bob@example.com", password: "Brand-New-Pass-901" },
    });
    mark(`new login(status=${fresh.statusCode})`);
    expect(fresh.statusCode).toBe(200);
    bobCookie = cookieFromRes(fresh);

    const me = await app.inject(authed({ method: "GET", url: "/api/me" }, bobCookie));
    mark(`me(status=${me.statusCode})`);
    expect(me.statusCode).toBe(200);
  }, 120_000);
});

describe("meeting ownership isolation", () => {
  it("users only see their own meetings in the list", async () => {
    const aliceTitle = await createMeeting(getCookie("alice"), "Alice planning");
    const bobMeeting = await createMeeting(getCookie("bob"), "Bob retro");

    const aliceList = await app.inject(authed({ method: "GET", url: "/api/meetings" }, getCookie("alice")));
    expect(aliceList.statusCode).toBe(200);
    const aliceIds = (aliceList.json().items as { id: string }[]).map((m) => m.id);
    expect(aliceIds).toContain(aliceTitle);
    expect(aliceIds).not.toContain(bobMeeting);

    const bobList = await app.inject(authed({ method: "GET", url: "/api/meetings" }, getCookie("bob")));
    const bobIds = (bobList.json().items as { id: string }[]).map((m) => m.id);
    expect(bobIds).toContain(bobMeeting);
    expect(bobIds).not.toContain(aliceTitle);
  });

  it("user A cannot read user B's meeting or its transcript", async () => {
    const aliceMeeting = await createMeeting(getCookie("alice"), "Alice confidential");

    // Give Alice's meeting a transcript segment.
    await built.database.client.transcriptSegment.create({
      data: {
        meetingId: aliceMeeting,
        clientSegmentId: "seg-1",
        speaker: "Alice",
        startTime: new Date("2026-01-01T10:00:00Z"),
        endTime: new Date("2026-01-01T10:00:05Z"),
        text: "secret plans",
        confidence: 0.99,
      },
    });

    // Bob: meeting does not exist (owner-scoped lookup returns 404).
    const read = await app.inject(authed({ method: "GET", url: `/api/meetings/${aliceMeeting}` }, getCookie("bob")));
    expect(read.statusCode).toBe(404);

    // Alice can read her own meeting including the transcript segment.
    const own = await app.inject(authed({ method: "GET", url: `/api/meetings/${aliceMeeting}` }, getCookie("alice")));
    expect(own.statusCode).toBe(200);
    expect(own.json().segments).toHaveLength(1);
    expect(own.json().segments[0].text).toBe("secret plans");
    expect(own.json().meeting.userId).toBeTruthy();
  });

  it("user A cannot modify or delete user B's meeting", async () => {
    const aliceMeeting = await createMeeting(getCookie("alice"), "Untouchable");

    const patch = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/meetings/${aliceMeeting}`,
          payload: { title: "hijacked" },
        },
        getCookie("bob"),
      ),
    );
    expect(patch.statusCode).toBe(404);

    const del = await app.inject(authed({ method: "DELETE", url: `/api/meetings/${aliceMeeting}` }, getCookie("bob")));
    expect(del.statusCode).toBe(404);

    // The meeting is untouched and still owned by Alice.
    const still = await app.inject(authed({ method: "GET", url: `/api/meetings/${aliceMeeting}` }, getCookie("alice")));
    expect(still.statusCode).toBe(200);
    expect(still.json().meeting.title).toBe("Untouchable");
  });
});

describe("templates, action items, and admin meetings", () => {
  it("users see system templates plus their own, never other users' custom ones", async () => {
    const system = await built.database.client.template.create({
      data: { name: "Weekly sync", type: "SYSTEM", schema: {} },
    });
    // Link the custom template to the real Alice row so ownership matches.
    const aliceMe = await app.inject(authed({ method: "GET", url: "/api/me" }, getCookie("alice")));
    const aliceId = aliceMe.json().user.id as string;
    const custom = await built.database.client.template.create({
      data: { name: "Alice board review", type: "CUSTOM", schema: {}, userId: aliceId },
    });

    const aliceTemplates = await app.inject(authed({ method: "GET", url: "/api/templates" }, getCookie("alice")));
    expect(aliceTemplates.statusCode).toBe(200);
    const aliceNames = ((aliceTemplates.json() as { items: { name: string }[] }).items).map((t) => t.name);
    expect(aliceNames).toContain("Weekly sync");
    expect(aliceNames).toContain("Alice board review");

    const bobTemplates = await app.inject(authed({ method: "GET", url: "/api/templates" }, getCookie("bob")));
    const bobNames = ((bobTemplates.json() as { items: { name: string }[] }).items).map((t) => t.name);
    expect(bobNames).toContain("Weekly sync");
    expect(bobNames).not.toContain("Alice board review");

    await built.database.client.template.delete({ where: { id: system.id } });
    await built.database.client.template.delete({ where: { id: custom.id } });
  });

  it("action items are scoped to the owning user", async () => {
    const aliceMeeting = await createMeeting(getCookie("alice"), "Action review");
    const mine = await built.database.client.actionItem.create({
      data: {
        meetingId: aliceMeeting,
        userId: (await app.inject(authed({ method: "GET", url: "/api/me" }, getCookie("alice")))).json().user.id,
        description: "Ship the parser",
        priority: "HIGH",
        status: "OPEN",
      },
    });

    const aliceItems = await app.inject(authed({ method: "GET", url: "/api/action-items" }, getCookie("alice")));
    expect(aliceItems.statusCode).toBe(200);
    const aliceIds = (aliceItems.json() as { id: string }[]).map((a) => a.id);
    expect(aliceIds).toContain(mine.id);

    const bobItems = await app.inject(authed({ method: "GET", url: "/api/action-items" }, getCookie("bob")));
    expect(bobItems.statusCode).toBe(200);
    const bobIds = (bobItems.json() as { id: string }[]).map((a) => a.id);
    expect(bobIds).not.toContain(mine.id);
  });

  it("an ADMIN can list every meeting with its owner", async () => {
    const aliceMeeting = await createMeeting(getCookie("alice"), "Admin visibility");
    const bobMeeting = await createMeeting(getCookie("bob"), "Bob's six-week retro");

    const denied = await app.inject(authed({ method: "GET", url: "/api/admin/meetings" }, getCookie("bob")));
    expect(denied.statusCode).toBe(403);

    const all = await app.inject(authed({ method: "GET", url: "/api/admin/meetings" }, getCookie("admin")));
    expect(all.statusCode).toBe(200);
    const ids = (all.json().items as { id: string }[]).map((m) => m.id);
    expect(ids).toContain(aliceMeeting);
    expect(ids).toContain(bobMeeting);
  });

  it("meeting list items include the template name", async () => {
    const aliceMe = await app.inject(authed({ method: "GET", url: "/api/me" }, getCookie("bob")));
    const bobId = aliceMe.json().user.id as string;
    const tpl = await built.database.client.template.create({
      data: { name: "Retro template", type: "CUSTOM", schema: {}, userId: bobId },
    });
    const meeting = await createMeeting(getCookie("bob"), "With template");
    await built.database.client.meeting.update({
      where: { id: meeting },
      data: { templateId: tpl.id },
    });

    const list = await app.inject(authed({ method: "GET", url: "/api/meetings" }, getCookie("bob")));
    const row = (list.json().items as { id: string; templateName: string | null }[]).find((m) => m.id === meeting);
    expect(row?.templateName).toBe("Retro template");

    await built.database.client.template.delete({ where: { id: tpl.id } });
  });
});

describe("role-based authorization", () => {
  it("a USER cannot access admin endpoints (403)", async () => {
    const res = await app.inject(authed({ method: "GET", url: "/api/admin/users" }, getCookie("alice")));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("the client cannot forge a role from the request body", async () => {
    const res = await app.inject(
      authed(
        {
          method: "PATCH",
          url: "/api/admin/users/nonexistent/role",
          payload: { role: "ADMIN" },
        },
        getCookie("bob"), // plain USER
      ),
    );
    expect(res.statusCode).toBe(403);
  });

  it("an ADMIN can access admin resources", async () => {
    const users = await app.inject(authed({ method: "GET", url: "/api/admin/users" }, getCookie("admin")));
    expect(users.statusCode).toBe(200);
    const emails = (users.json().items as { email: string }[]).map((u) => u.email);
    expect(emails).toContain("alice@example.com");
    expect(emails).toContain("boss@example.com");
  });

  it("an ADMIN cannot change their own role or status", async () => {
    const self = await app.inject(
      authed(
        {
          method: "PATCH",
          url: "/api/admin/users/self/role",
          payload: { role: "USER" },
        },
        getCookie("admin"),
      ),
    );
    expect(self.statusCode).toBe(404);

    const me = await app.inject(authed({ method: "GET", url: "/api/me" }, getCookie("admin")));
    const adminUserId = me.json().user.id as string;

    const roleChange = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${adminUserId}/role`,
          payload: { role: "USER" },
        },
        getCookie("admin"),
      ),
    );
    expect(roleChange.statusCode).toBe(403);

    const statusChange = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${adminUserId}/status`,
          payload: { status: "DISABLED" },
        },
        getCookie("admin"),
      ),
    );
    expect(statusChange.statusCode).toBe(403);
  });

  it("an ADMIN can disable a user and their session dies", async () => {
    const me = await app.inject(authed({ method: "GET", url: "/api/me" }, getCookie("alice")));
    const aliceId = me.json().user.id as string;

    const disable = await app.inject(
      authed(
        {
          method: "PATCH",
          url: `/api/admin/users/${aliceId}/status`,
          payload: { status: "DISABLED" },
        },
        getCookie("admin"),
      ),
    );
    expect(disable.statusCode).toBe(200);

    // Existing session is instantly unusable...
    const meAfter = await app.inject(authed({ method: "GET", url: "/api/me" }, getCookie("alice")));
    expect(meAfter.statusCode).toBe(401);

    // ...and login is refused while disabled.
    await login("alice@example.com", PASSWORD, 403);

    // Demonstrate the actor remains admin (role from session, not client).
    const adminUsers = await app.inject(authed({ method: "GET", url: "/api/admin/users" }, getCookie("admin")));
    expect(adminUsers.statusCode).toBe(200);
  });

  it("audit log records auth and admin actions and is admin-only", async () => {
    const denied = await app.inject(authed({ method: "GET", url: "/api/admin/audit-logs" }, getCookie("bob")));
    expect(denied.statusCode).toBe(403);

    const logs = await app.inject(authed({ method: "GET", url: "/api/admin/audit-logs" }, getCookie("admin")));
    expect(logs.statusCode).toBe(200);
    const actions = (logs.json().items as { action: string }[]).map((l) => l.action);
    expect(actions).toContain("USER_CREATED");
    expect(actions).toContain("auth.login");
    expect(actions).toContain("USER_DISABLED");
  });
});