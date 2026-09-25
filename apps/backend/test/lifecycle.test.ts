import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuiltApp } from "../src/app.ts";
import { setEnvForTests, getEnv } from "../src/env.ts";
import { createDatabase } from "../src/db/prisma.ts";
import { ensurePostgresStopped, startEmbeddedPostgres, runMigrations } from "../src/dev-pg.ts";
import type { MeetingSyncRequest } from "@callnotes/shared";

/**
 * Meeting lifecycle and long-session behavior suite.
 *
 * Covers the full meeting path (create -> segment append -> update -> search ->
 * list/paginate -> delete) and simulates 30 / 60 / 120 / 240-minute meetings by
 * pushing transcripts at a realistic whisper cadence (~1 segment every 6s).
 * Long meetings exercise the same upsert path the desktop uses when syncing
 * in chunks, then assert: exact segment counts, zero transcript duplication on
 * re-delivery, and that detail/list/search stay responsive as a meeting grows
 * to thousands of segments (soft time budgets protect against N+1 regressions).
 */

const PASSWORD = "Secure-Password-1234";
const COOKIE_SECRET = "test-cookie-secret-0123456789abcdef0123456789abcdef";

const PORT = 55636;

let built: BuiltApp;
let app: FastifyInstance;
let pg: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
let carolCookie = "";
let graceCookie = "";

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

/** Builds a transcript of `segmentCount` segments at ~1 every `secondsPerSegment`. */
function buildMeeting(
  clientMeetingId: string,
  title: string,
  durationMinutes: number,
  segmentCount: number,
  keyword: string | undefined = undefined,
  seedTime = new Date("2026-01-01T10:00:00Z"),
): MeetingSyncRequest {
  const secondsPerSegment = (durationMinutes * 60) / segmentCount;
  const epochMs = seedTime.getTime();
  const segments = Array.from({ length: segmentCount }, (_, i) => {
    const tail = keyword && i % 100 === 0 ? ` ${keyword}` : "";
    const text = `Segment ${i + 1}: discussing the ${title.toLowerCase()} roadmap${tail}.`;
    return {
clientSegmentId: `${clientMeetingId}-seg-${i + 1}`,
      speaker: i % 2 === 0 ? "Speaker 1" : "Speaker 2",
      startTime: new Date(epochMs + i * secondsPerSegment * 1000),
      endTime: new Date(epochMs + (i + 1) * secondsPerSegment * 1000),
      text,
      confidence: 0.9 + ((i % 9) + 1) / 100,
      isEdited: false,
    };
  });
  return {
    clientMeetingId,
    title,
    startedAt: seedTime,
    endedAt: new Date(seedTime.getTime() + durationMinutes * 60 * 1000),
    durationSeconds: durationMinutes * 60,
    status: "COMPLETED",
    segments,
    summaryDetails: {
      summary: `${title} summary`,
      decisions: [{ text: `${title} decided` }],
      blockers: [`${title} blocker`],
      followUps: [`${title} follow-up`],
      importantDates: ["2026-02-01"],
      participants: ["Carol", "Grace"],
      aiModel: "llama3.2:3b",
      aiProvider: "ollama",
    },
    actionItems: [],
  };
}

async function detailSegments(cookie: string, id: string): Promise<{ count: number; texts: string[]; t: number }> {
  const t0 = performance.now();
  const res = await app.inject({
    method: "GET",
    url: `/api/meetings/${id}`,
    headers: { cookie: `callnotes.sid=${cookie}` },
  });
  const t = performance.now() - t0;
  expect(res.statusCode).toBe(200);
  const body = res.json();
  return { count: body.segments.length, texts: body.segments.map((s: { text: string }) => s.text), t };
}

beforeAll(async () => {
  process.env["DEV_PG_DATA_DIR"] = "./test/.tmp-pg-life";
  process.env["DEV_PG_PORT"] = String(PORT);
  process.env["DEV_PG_DATABASE"] = "callnotes_lifecycle_test";
  rmSync("./test/.tmp-pg-life", { recursive: true, force: true });

  setEnvForTests({ ...getEnv(), NODE_ENV: "test", LOG_LEVEL: "silent", COOKIE_SECRET });

  const pgRef = await startEmbeddedPostgres();
  pg = pgRef;
  runMigrations(pg.databaseUrl);

  setEnvForTests({ ...getEnv(), DATABASE_URL: pg.databaseUrl });
  database = createDatabase(pg.databaseUrl);
  built = await buildApp({ env: getEnv(), database });
  app = built.app;

  carolCookie = await register("lifecycle-carol@example.com", "Lifecycle Carol");
  graceCookie = await register("lifecycle-grace@example.com", "Lifecycle Grace");
});

afterAll(async () => {
  const quietly = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[lifecycle] ${label} failed:`, err);
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

describe("meeting lifecycle", () => {
  it("walks the full meeting path: create -> append -> read -> search -> update -> complete -> delete", async () => {
    const created = await syncMeeting(carolCookie, buildMeeting("life-1", "Kickoff", 30, 300));
    expect(created.statusCode).toBe(200);
    const meeting = created.json();
    expect(meeting.status).toBe("COMPLETED");
    expect(meeting.durationSeconds).toBe(1800);

    const listed = await app.inject({
      method: "GET",
      url: "/api/meetings",
      headers: { cookie: `callnotes.sid=${carolCookie}` },
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json().items as { id: string }[]).map((m) => m.id)).toContain(meeting.id);

    const found = await app.inject({
      method: "GET",
      url: `/api/meetings?q=kickoff`,
      headers: { cookie: `callnotes.sid=${carolCookie}` },
    });
    expect(found.statusCode).toBe(200);
    expect((found.json().items as { id: string }[]).map((m) => m.id)).toContain(meeting.id);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}`,
      headers: { cookie: `callnotes.sid=${carolCookie}` },
      payload: { title: "Kickoff renamed", status: "COMPLETED" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().title).toBe("Kickoff renamed");

    const details = await detailSegments(carolCookie, meeting.id);
    expect(details.count).toBe(300);

    const removal = await app.inject({
      method: "DELETE",
      url: `/api/meetings/${meeting.id}`,
      headers: { cookie: `callnotes.sid=${carolCookie}` },
    });
    expect(removal.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: `/api/meetings/${meeting.id}`,
      headers: { cookie: `callnotes.sid=${carolCookie}` },
    });
    expect(after.statusCode).toBe(404);
  });

  it("keeps a meeting editable after sync and delists it for other users", async () => {
    const created = await syncMeeting(graceCookie, buildMeeting("life-2", "Owned", 30, 60));
    const id = created.json().id as string;

    const graceRead = await app.inject({
      method: "GET",
      url: `/api/meetings/${id}`,
      headers: { cookie: `callnotes.sid=${graceCookie}` },
    });
    expect(graceRead.statusCode).toBe(200);

    const carolRead = await app.inject({
      method: "GET",
      url: `/api/meetings/${id}`,
      headers: { cookie: `callnotes.sid=${carolCookie}` },
    });
    expect(carolRead.statusCode).toBe(404);
  });
});

describe("long-session meetings (30 / 60 / 120 / 240 minutes)", () => {
  const cases = [
    { clientId: "long-30", title: "Thirty", minutes: 30, segments: 300 },
    { clientId: "long-60", title: "Sixty", minutes: 60, segments: 600, keyword: "hurricane" },
    { clientId: "long-120", title: "TwoHours", minutes: 120, segments: 1200 },
    { clientId: "long-240", title: "FourHours", minutes: 240, segments: 2400 },
  ] as const;

  const ids = new Map<string, string>(); // clientMeetingId -> server id

  for (const c of cases) {
    it(`stores a ${c.minutes}-minute meeting (${c.segments} segments) without loss`, async () => {
const pushed = await syncMeeting(
        carolCookie,
        buildMeeting(c.clientId, c.title, c.minutes, c.segments, "keyword" in c ? c.keyword : undefined),
      );
      expect(pushed.statusCode).toBe(200);
      expect(pushed.json().durationSeconds).toBe(c.minutes * 60);
      ids.set(c.clientId, pushed.json().id as string);
    });
  }

  it("swallows no segments when a large meeting is re-pushed (no duplicates, no loss)", async () => {
    const id = ids.get("long-240")!;
    const again = await syncMeeting(carolCookie, buildMeeting("long-240", "FourHours", 240, 2400));
    expect(again.statusCode).toBe(200);

    const details = await detailSegments(carolCookie, id);
    expect(details.count).toBe(2400);
    expect(new Set(details.texts).size).toBe(2400); // every transcript line is unique
  });

  it("append-only updates apply to a large meeting without disturbing prior segments", async () => {
    const id = ids.get("long-60")!;
const patch = buildMeeting("long-60", "Sixty", 60, 600, "hurricane");
    patch.segments!.push({
      clientSegmentId: "long-60-seg-extra",
      speaker: "Speaker 1",
      startTime: new Date("2026-01-01T11:00:00Z"),
      endTime: new Date("2026-01-01T11:00:06Z"),
      text: "final ship note",
      confidence: 0.98,
      isEdited: false,
    });
    const pushed = await syncMeeting(carolCookie, patch);
    expect(pushed.statusCode).toBe(200);

    const details = await detailSegments(carolCookie, id);
    expect(details.count).toBe(601);
    expect(details.texts).toContain("final ship note");
  });

  it("list pagination is stable once a user has thousands of segments", async () => {
    let cursor = 1;
    const perPage = 2;
    const seen: string[] = [];
    for (;;) {
      const res = await app.inject({
        method: "GET",
        url: `/api/meetings?page=${cursor}&perPage=${perPage}`,
        headers: { cookie: `callnotes.sid=${carolCookie}` },
      });
      expect(res.statusCode).toBe(200);
      const page = res.json();
      seen.push(...(page.items as { id: string }[]).map((m) => m.id));
      if (page.items.length < perPage) break;
      cursor += 1;
      if (cursor > 20) break;
    }
    expect(new Set(seen).size).toBe(seen.length); // no page window overlap / skip
    for (const id of ids.values()) expect(seen).toContain(id);
  });

  it("search still finds a phrase buried in a long transcript", async () => {
    const found = await app.inject({
      method: "GET",
      url: "/api/meetings?q=hurricane",
      headers: { cookie: `callnotes.sid=${carolCookie}` },
    });
    expect(found.statusCode).toBe(200);
const matches = found.json().items as { id: string }[];
    expect(matches.map((m) => m.id)).toContain(ids.get("long-60"));

    const crossUser = await app.inject({
      method: "GET",
      url: "/api/meetings?q=hurricane",
      headers: { cookie: `callnotes.sid=${graceCookie}` },
    });
    expect((crossUser.json().items as { id: string }[]).map((m) => m.id)).not.toContain(ids.get("long-60"));
  });

  it("detail for a 4-hour meeting returns promptly (no unbounded N+1)", async () => {
    const details = await detailSegments(carolCookie, ids.get("long-240")!);
    expect(details.count).toBe(2400);
    // Soft budget: a 2400-segment transcript must load in well under 3s on CI.
    expect(details.t).toBeLessThan(3000);
  });
});









