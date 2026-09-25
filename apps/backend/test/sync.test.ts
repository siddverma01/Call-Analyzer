import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuiltApp } from "../src/app.ts";
import { setEnvForTests, getEnv } from "../src/env.ts";
import { createDatabase } from "../src/db/prisma.ts";
import { ensurePostgresStopped, startEmbeddedPostgres, runMigrations } from "../src/dev-pg.ts";
import type { MeetingSyncRequest } from "@callnotes/shared";

/**
 * Offline-first meeting sync integration suite. Runs against a real embedded
 * PostgreSQL so idempotency is proven against actual unique constraints
 * (Meeting.userId+clientMeetingId, TranscriptSegment.meetingId+clientSegmentId,
 * ActionItem.meetingId+clientItemId) and ownership isolation.
 */

const PASSWORD = "Secure-Password-1234";
const COOKIE_SECRET = "test-cookie-secret-0123456789abcdef0123456789abcdef";

let built: BuiltApp;
let app: FastifyInstance;
let pg: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
let aliceCookie = "";
let bobCookie = "";

function cookieFromRes(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie ?? "");
  const match = raw.match(/callnotes\.sid=([^;]+)/);
  return match?.[1] ?? "";
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

function syncMeeting(cookie: string, payload: MeetingSyncRequest) {
  return app.inject({
    method: "POST",
    url: "/api/meetings/sync",
    headers: { cookie: `callnotes.sid=${cookie}` },
    payload,
  });
}

const payload = (clientMeetingId: string, extra: Partial<MeetingSyncRequest> = {}): MeetingSyncRequest => ({
  clientMeetingId,
  title: "Offline standup",
  startedAt: new Date("2026-01-01T10:00:00Z"),
  endedAt: new Date("2026-01-01T10:15:00Z"),
  durationSeconds: 900,
  status: "COMPLETED",
  segments: [
    {
      clientSegmentId: "seg-1",
      speaker: "Speaker 1",
      startTime: new Date("2026-01-01T10:00:00Z"),
      endTime: new Date("2026-01-01T10:00:05Z"),
      text: "hello world",
      confidence: 0.98,
      isEdited: false,
    },
    {
      clientSegmentId: "seg-2",
      speaker: "Speaker 2",
      startTime: new Date("2026-01-01T10:00:06Z"),
      endTime: new Date("2026-01-01T10:00:11Z"),
      text: "ship the parser",
      confidence: 0.91,
    },
  ],
  summaryDetails: {
    summary: "Shipped the parser.",
    decisions: [{ text: "Parser ships first" }],
    blockers: ["Blocked on review"],
    followUps: ["Schedule retro"],
    importantDates: ["2026-02-01"],
    participants: ["Alice", "Bob"],
    aiModel: "llama3.2:3b",
    aiProvider: "ollama",
  },
  actionItems: [
    {
      clientItemId: "ai-1",
      description: "Open the PR",
      priority: "HIGH",
      status: "OPEN",
      assignee: "Alice",
      sourceSegmentId: "seg-2",
    },
  ],
  ...extra,
});

beforeAll(async () => {
  process.env["DEV_PG_DATA_DIR"] = "./test/.tmp-pg-sync";
  process.env["DEV_PG_PORT"] = "55633";
  process.env["DEV_PG_DATABASE"] = "callnotes_sync_test";
  rmSync("./test/.tmp-pg-sync", { recursive: true, force: true });

  setEnvForTests({ ...getEnv(), NODE_ENV: "test", LOG_LEVEL: "silent", COOKIE_SECRET });

  const pgRef = await startEmbeddedPostgres();
  pg = pgRef;
  runMigrations(pg.databaseUrl);

  setEnvForTests({ ...getEnv(), DATABASE_URL: pg.databaseUrl });
  database = createDatabase(pg.databaseUrl);
  built = await buildApp({ env: getEnv(), database });
  app = built.app;

  aliceCookie = await register("sync-alice@example.com", "Sync Alice");
  bobCookie = await register("sync-bob@example.com", "Sync Bob");
});

afterAll(async () => {
  const quietly = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[sync] ${label} failed:`, err);
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

describe("meeting sync endpoint", () => {
  it("requires an authenticated session (401)", async () => {
    const res = await syncMeeting("", payload("cm-anon"));
    expect(res.statusCode).toBe(401);
  });

  it("rejects a payload without clientMeetingId (400)", async () => {
    const res = await syncMeeting(aliceCookie, { ...payload("cm-x"), clientMeetingId: "" });
    expect(res.statusCode).toBe(400);
  });

  it("creates a meeting with segments, summary details, and action items", async () => {
    const res = await syncMeeting(aliceCookie, payload("cm-1"));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe("Offline standup");
    expect(body.status).toBe("COMPLETED");
    expect(body.durationSeconds).toBe(900);
    expect(body.userId).toBeTruthy();

    const detail = await app.inject({
      method: "GET",
      url: `/api/meetings/${body.id}`,
      headers: { cookie: `callnotes.sid=${aliceCookie}` },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.segments).toHaveLength(2);
    expect(detailBody.segments.map((s: { text: string }) => s.text)).toContain("hello world");
    expect(detailBody.summary?.summary).toBe("Shipped the parser.");
    // Local-AI analysis fields round-trip through the sync endpoint.
    expect(detailBody.summary?.blockers).toEqual(["Blocked on review"]);
    expect(detailBody.summary?.followUps).toEqual(["Schedule retro"]);
    expect(detailBody.summary?.importantDates).toEqual(["2026-02-01"]);
    expect(detailBody.summary?.participants).toEqual(["Alice", "Bob"]);
    expect(detailBody.summary?.aiModel).toBe("llama3.2:3b");
    expect(detailBody.summary?.aiProvider).toBe("ollama");

    // Action item links its source transcript segment (clientSeg-2) by server id.
    const items = await app.inject({
      method: "GET",
      url: "/api/action-items",
      headers: { cookie: `callnotes.sid=${aliceCookie}` },
    });
    const parsedItems = items.json() as {
      description: string;
      assignee: string | null;
      sourceSegmentId: string | null;
    }[];
    const pr = parsedItems.find((a) => a.description === "Open the PR");
    expect(pr?.assignee).toBe("Alice");
    // Client segment id maps to the server TranscriptSegment id.
    expect(pr?.sourceSegmentId).toBeTruthy();
    expect(pr?.sourceSegmentId).not.toBe("seg-2");

    const listed = await app.inject({
      method: "GET",
      url: "/api/meetings",
      headers: { cookie: `callnotes.sid=${aliceCookie}` },
    });
    expect((listed.json().items as { id: string }[]).map((m) => m.id)).toContain(body.id);
  });

  it("is idempotent: re-delivering the same payload creates no duplicates", async () => {
    const first = await syncMeeting(aliceCookie, payload("cm-1"));
    expect(first.statusCode).toBe(200);

    const second = await syncMeeting(aliceCookie, payload("cm-1"));
    expect(second.statusCode).toBe(200);

    const detailRes = await app.inject({
      method: "GET",
      url: `/api/meetings/${first.json().id}`,
      headers: { cookie: `callnotes.sid=${aliceCookie}` },
    });
    const detail = detailRes.json();
    expect(detail.segments).toHaveLength(2);

    const items = await app.inject({
      method: "GET",
      url: "/api/action-items",
      headers: { cookie: `callnotes.sid=${aliceCookie}` },
    });
    expect(
      (items.json() as { description: string }[]).filter((a) => a.description === "Open the PR"),
    ).toHaveLength(1);
  });

  it("applies updates on subsequent syncs (last payload wins)", async () => {
    const res = await syncMeeting(aliceCookie, payload("cm-1", { title: "Renamed standup", durationSeconds: 1200 }));
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("Renamed standup");
    expect(res.json().durationSeconds).toBe(1200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/meetings/${res.json().id}`,
      headers: { cookie: `callnotes.sid=${aliceCookie}` },
    });
    expect(detail.json().meeting.title).toBe("Renamed standup");
  });

  it("keeps segments owned per meeting even when ids repeat across meetings", async () => {
    const first = await syncMeeting(aliceCookie, payload("cm-2"));
    expect(first.statusCode).toBe(200);

    const detailRes = await app.inject({
      method: "GET",
      url: `/api/meetings/${first.json().id}`,
      headers: { cookie: `callnotes.sid=${aliceCookie}` },
    });
    expect(detailRes.json().segments).toHaveLength(2);
  });

  it("isolates ownership: one user cannot reach another user's synced meeting", async () => {
    // Bob syncs a meeting with the same clientMeetingId Alice used - keyed per user.
    const bobRes = await syncMeeting(bobCookie, payload("cm-owner", { title: "Bob secret" }));
    expect(bobRes.statusCode).toBe(200);

    const aliceAttempt = await app.inject({
      method: "GET",
      url: `/api/meetings/${bobRes.json().id}`,
      headers: { cookie: `callnotes.sid=${aliceCookie}` },
    });
    expect(aliceAttempt.statusCode).toBe(404);

    // Both lists stay isolated too.
    const aliceList = await app.inject({
      method: "GET",
      url: "/api/meetings",
      headers: { cookie: `callnotes.sid=${aliceCookie}` },
    });
    const aliceIds = (aliceList.json().items as { id: string }[]).map((m) => m.id);
    expect(aliceIds).not.toContain(bobRes.json().id);
  });
});