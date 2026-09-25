import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuiltApp } from "../src/app.ts";
import { setEnvForTests, getEnv } from "../src/env.ts";
import { createDatabase } from "../src/db/prisma.ts";
import { ensurePostgresStopped, startEmbeddedPostgres, runMigrations } from "../src/dev-pg.ts";

/**
 * Productivity features integration suite: meeting templates (system + custom,
 * duplicate, per-user default), standalone tasks (action items), Postgres
 * full-text search, filtered meeting listings, and meeting exports.
 */

const PASSWORD = "Secure-Password-1234";
const COOKIE_SECRET = "test-cookie-secret-0123456789abcdef0123456789abcdef";

const SYSTEM_TEMPLATE_IDS = [
  "sys-standup",
  "sys-sales",
  "sys-team",
  "sys-client",
  "sys-technical",
  "sys-planning",
  "sys-interview",
  "sys-1on1",
  "sys-custom",
];

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

function authed(opts: Record<string, unknown>, cookie: string): Record<string, unknown> {
  return { ...opts, headers: { ...(opts.headers as Record<string, unknown> | undefined), cookie: `callnotes.sid=${cookie}` } };
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

async function createMeeting(cookie: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject(authed({ method: "POST", url: "/api/meetings", payload: { title, ...extra } }, cookie));
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}

async function syncMeeting(cookie: string, payload: Record<string, unknown>) {
  return app.inject(authed({ method: "POST", url: "/api/meetings/sync", payload }, cookie));
}

const syncPayload = (clientMeetingId: string, title: string, overrides: Record<string, unknown> = {}) => ({
  clientMeetingId,
  title,
  startedAt: new Date("2026-03-01T10:00:00Z"),
  endedAt: new Date("2026-03-01T10:15:00Z"),
  durationSeconds: 900,
  status: "COMPLETED",
  segments: [
    {
      clientSegmentId: "seg-1",
      speaker: "Speaker 1",
      startTime: new Date("2026-03-01T10:00:00Z"),
      endTime: new Date("2026-03-01T10:00:05Z"),
      text: "we reviewed the deployment strategy for the new cluster",
      confidence: 0.98,
      isEdited: false,
    },
  ],
  summaryDetails: {
    summary: "Coordinated the rollout.",
    decisions: [{ text: "adopt blue green deployments" }],
    followUps: ["schedule a dry run"],
  },
  actionItems: [
    {
      clientItemId: "ai-1",
      description: "drain node pool north before maintenance",
      priority: "HIGH",
      status: "OPEN",
      assignee: "Alice",
    },
  ],
  ...overrides,
});

beforeAll(async () => {
  process.env["DEV_PG_DATA_DIR"] = "./test/.tmp-pg-prod";
  process.env["DEV_PG_PORT"] = "55634";
  process.env["DEV_PG_DATABASE"] = "callnotes_prod_test";
  rmSync("./test/.tmp-pg-prod", { recursive: true, force: true });

  setEnvForTests({ ...getEnv(), NODE_ENV: "test", LOG_LEVEL: "silent", COOKIE_SECRET });

  const pgRef = await startEmbeddedPostgres();
  pg = pgRef;
  runMigrations(pg.databaseUrl);

  setEnvForTests({ ...getEnv(), DATABASE_URL: pg.databaseUrl });
  database = createDatabase(pg.databaseUrl);
  built = await buildApp({ env: getEnv(), database });
  app = built.app;

  aliceCookie = await register("prod-alice@example.com", "Prod Alice");
  bobCookie = await register("prod-bob@example.com", "Prod Bob");
});

afterAll(async () => {
  const quietly = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[productivity] ${label} failed:`, err);
    }
  };
  await quietly("app.close", async () => app?.close());
  await quietly("database.disconnect", async () => database?.disconnect());
  await quietly("pg.stop", async () => pg?.stop());
  ensurePostgresStopped(process.env["DEV_PG_DATA_DIR"], Number(process.env["DEV_PG_PORT"]));
});

describe("seeded system templates", () => {
  it("exposes the nine system templates to every user", async () => {
    const res = await app.inject(authed({ method: "GET", url: "/api/templates" }, aliceCookie));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; type: string }[] };
    const ids = body.items.map((t) => t.id);
    for (const id of SYSTEM_TEMPLATE_IDS) {
      expect(ids).toContain(id);
    }
    const system = body.items.filter((t) => t.type === "SYSTEM");
    expect(system.length).toBe(SYSTEM_TEMPLATE_IDS.length);
  });
});

describe("custom templates", () => {
  it("creates a custom template visible only to its owner", async () => {
    const created = await app.inject(
      authed(
        {
          method: "POST",
          url: "/api/templates",
          payload: {
            name: "Alice retro",
            description: "Retro board",
            schema: { sections: [{ key: "wentwell", label: "Went well", type: "list" }] },
          },
        },
        aliceCookie,
      ),
    );
    expect(created.statusCode).toBe(200);
    const template = created.json() as { id: string; type: string; name: string; isDefault: boolean };
    expect(template.type).toBe("CUSTOM");
    expect(template.isDefault).toBe(false);

    const aliceList = (await app.inject(authed({ method: "GET", url: "/api/templates" }, aliceCookie))).json() as {
      items: { id: string }[];
    };
    expect(aliceList.items.map((t) => t.id)).toContain(template.id);

    const bobList = (await app.inject(authed({ method: "GET", url: "/api/templates" }, bobCookie))).json() as {
      items: { id: string }[];
    };
    expect(bobList.items.map((t) => t.id)).not.toContain(template.id);
  });

  it("rejects a template without a name (400)", async () => {
    const res = await app.inject(
      authed({ method: "POST", url: "/api/templates", payload: { schema: { sections: [] } } }, aliceCookie),
    );
    expect(res.statusCode).toBe(400);
  });

  it("system templates are protected from edit/delete but can be duplicated", async () => {
    const patch = await app.inject(
      authed({ method: "PATCH", url: "/api/templates/sys-standup", payload: { name: "Hacked" } }, aliceCookie),
    );
    expect(patch.statusCode).toBe(404);

    const deleted = await app.inject(authed({ method: "DELETE", url: "/api/templates/sys-standup" }, aliceCookie));
    expect(deleted.statusCode).toBe(404);

    const copy = await app.inject(authed({ method: "POST", url: "/api/templates/sys-standup/duplicate" }, aliceCookie));
    expect(copy.statusCode).toBe(200);
    const copied = copy.json() as { id: string; type: string; name: string };
    expect(copied.type).toBe("CUSTOM");
    expect(copied.name).toContain("(copy)");

    const bobCopy = await app.inject(authed({ method: "POST", url: `/api/templates/${copied.id}/duplicate` }, bobCookie));
    expect(bobCopy.statusCode).toBe(404);
  });

  it("updates and deletes an owned custom template", async () => {
    const created = await app.inject(
      authed(
        { method: "POST", url: "/api/templates", payload: { name: "Temp", schema: { sections: [] } } },
        aliceCookie,
      ),
    );
    const id = (created.json() as { id: string }).id;

    const updated = await app.inject(
      authed(
        { method: "PATCH", url: `/api/templates/${id}`, payload: { name: "Renamed", description: null } },
        aliceCookie,
      ),
    );
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { name: string; description: string | null }).name).toBe("Renamed");

    const deleted = await app.inject(authed({ method: "DELETE", url: `/api/templates/${id}` }, aliceCookie));
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject(authed({ method: "GET", url: "/api/templates" }, aliceCookie));
    const ids = (gone.json() as { items: { id: string }[] }).items.map((t) => t.id);
    expect(ids).not.toContain(id);
  });

  it("sets, reflects, and clears the per-user default template", async () => {
    const setRes = await app.inject(
      authed({ method: "PUT", url: "/api/templates/default", payload: { templateId: "sys-sales" } }, aliceCookie),
    );
    expect(setRes.statusCode).toBe(200);

    const list = (await app.inject(authed({ method: "GET", url: "/api/templates" }, aliceCookie))).json() as {
      defaultId: string | null;
    };
    expect(list.defaultId).toBe("sys-sales");
    // Alice's default must not leak to Bob.
    const bobList = (await app.inject(authed({ method: "GET", url: "/api/templates" }, bobCookie))).json() as {
      defaultId: string | null;
    };
    expect(bobList.defaultId).toBeNull();

    // A custom template can also be the default.
    const created = await app.inject(
      authed({ method: "POST", url: "/api/templates", payload: { name: "Pref tep", schema: { sections: [] } } }, aliceCookie),
    );
    const customId = (created.json() as { id: string }).id;
    const setCustom = await app.inject(
      authed({ method: "PUT", url: "/api/templates/default", payload: { templateId: customId } }, aliceCookie),
    );
    expect(setCustom.statusCode).toBe(200);
    const afterCustom = (await app.inject(authed({ method: "GET", url: "/api/templates" }, aliceCookie))).json() as {
      defaultId: string | null;
    };
    expect(afterCustom.defaultId).toBe(customId);

    const clear = await app.inject(
      authed({ method: "PUT", url: "/api/templates/default", payload: { templateId: null } }, aliceCookie),
    );
    expect(clear.statusCode).toBe(200);
    const afterClear = (await app.inject(authed({ method: "GET", url: "/api/templates" }, aliceCookie))).json() as {
      defaultId: string | null;
    };
    expect(afterClear.defaultId).toBeNull();
  });
});

describe("action items / tasks", () => {
  it("creates a task linked to one of the caller's meetings", async () => {
    const meetingId = await createMeeting(aliceCookie, "Task linking");
    const res = await app.inject(
      authed(
        {
          method: "POST",
          url: "/api/action-items",
          payload: { meetingId, description: "Prepare release notes", priority: "HIGH", status: "OPEN", assignee: "Alice" },
        },
        aliceCookie,
      ),
    );
    expect(res.statusCode).toBe(200);
    const item = res.json() as { id: string; meetingId: string; meetingTitle: string; assignee: string };
    expect(item.meetingId).toBe(meetingId);
    expect(item.meetingTitle).toBe("Task linking");
    expect(item.assignee).toBe("Alice");
  });

  it("creates a standalone task without a meeting", async () => {
    const res = await app.inject(
      authed(
        { method: "POST", url: "/api/action-items", payload: { description: "Buy coffee beans" } },
        aliceCookie,
      ),
    );
    expect(res.statusCode).toBe(200);
    const item = res.json() as { meetingId: string | null; meetingTitle: string | null; status: string; priority: string };
    expect(item.meetingId).toBeNull();
    expect(item.meetingTitle).toBeNull();
    expect(item.status).toBe("OPEN");
    expect(item.priority).toBe("MEDIUM");
  });

  it("rejects a task linked to a meeting the caller does not own (400)", async () => {
    const bobMeetingId = await createMeeting(bobCookie, "Bob secret meeting");
    const res = await app.inject(
      authed(
        { method: "POST", url: "/api/action-items", payload: { meetingId: bobMeetingId, description: "Sneaky" } },
        aliceCookie,
      ),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a task with an empty description (400)", async () => {
    const res = await app.inject(
      authed({ method: "POST", url: "/api/action-items", payload: { description: "" } }, aliceCookie),
    );
    expect(res.statusCode).toBe(400);
  });

  it("updates status and filters tasks", async () => {
    const created = await app.inject(
      authed({ method: "POST", url: "/api/action-items", payload: { description: "Ship the load balancer" } }, aliceCookie),
    );
    const id = (created.json() as { id: string }).id;

    const updated = await app.inject(
      authed({ method: "PATCH", url: `/api/action-items/${id}`, payload: { status: "IN_PROGRESS", priority: "LOW" } }, aliceCookie),
    );
    expect(updated.statusCode).toBe(200);
    const item = updated.json() as { status: string; priority: string };
    expect(item.status).toBe("IN_PROGRESS");
    expect(item.priority).toBe("LOW");

    const statusFiltered = (
      await app.inject(authed({ method: "GET", url: "/api/action-items?status=IN_PROGRESS" }, aliceCookie))
    ).json();
    expect((statusFiltered as { id: string }[]).map((a) => a.id)).toContain(id);
    const completedFiltered = (
      await app.inject(authed({ method: "GET", url: "/api/action-items?status=COMPLETED" }, aliceCookie))
    ).json();
    expect((completedFiltered as { id: string }[]).map((a) => a.id)).not.toContain(id);
  });

  it("only the owner can delete a task", async () => {
    const created = await app.inject(
      authed({ method: "POST", url: "/api/action-items", payload: { description: "Mine to delete" } }, aliceCookie),
    );
    const id = (created.json() as { id: string }).id;

    const bobDenied = await app.inject(authed({ method: "DELETE", url: `/api/action-items/${id}` }, bobCookie));
    expect(bobDenied.statusCode).toBe(404);

    const deleted = await app.inject(authed({ method: "DELETE", url: `/api/action-items/${id}` }, aliceCookie));
    expect(deleted.statusCode).toBe(204);
  });
});

describe("full-text search", () => {
  it("finds meetings by transcript and action-item text, and never leaks across users", async () => {
    await syncMeeting(
      aliceCookie,
      syncPayload("prod-search-1", "Kubernetes rollout planning"),
    );

    const byTranscript = await app.inject(
      authed({ method: "GET", url: "/api/meetings?q=cluster+deployment" }, aliceCookie),
    );
    expect(byTranscript.statusCode).toBe(200);
    const body = byTranscript.json() as { items: { title: string }[]; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.map((m) => m.title)).toContain("Kubernetes rollout planning");

    const byActionItem = await app.inject(authed({ method: "GET", url: "/api/meetings?q=maintenance" }, aliceCookie));
    expect(byActionItem.statusCode).toBe(200);
    expect((byActionItem.json() as { items: { title: string }[] }).items.map((m) => m.title)).toContain(
      "Kubernetes rollout planning",
    );

    const byDecisions = await app.inject(authed({ method: "GET", url: "/api/meetings?q=blue+green" }, aliceCookie));
    expect((byDecisions.json() as { items: { title: string }[] }).items.map((m) => m.title)).toContain(
      "Kubernetes rollout planning",
    );

    const bobSearch = await app.inject(authed({ method: "GET", url: "/api/meetings?q=kubernetes" }, bobCookie));
    expect(bobSearch.statusCode).toBe(200);
    expect((bobSearch.json() as { items: unknown[]; total: number }).total).toBe(0);
  });

  it("returns an empty page for queries without searchable terms", async () => {
    const res = await app.inject(authed({ method: "GET", url: "/api/meetings?q=!!!" }, aliceCookie));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("combines search with status and date filters", async () => {
    // Alice's DRAFT meeting from the create-flow is present alongside the
    // COMPLETED synced one.
    const draftId = await createMeeting(aliceCookie, "Draft brainstorming", {
      startedAt: new Date("2026-01-15T09:00:00Z"),
    });

    const completedOnly = await app.inject(
      authed({ method: "GET", url: "/api/meetings?q=draft&status=COMPLETED" }, aliceCookie),
    );
    expect((completedOnly.json() as { items: { id: string }[] }).items.map((m) => m.id)).not.toContain(draftId);

    const afterRange = await app.inject(
      authed({ method: "GET", url: "/api/meetings?q=draft&from=2026-02-01T00:00:00Z" }, aliceCookie),
    );
    expect((afterRange.json() as { items: { id: string }[] }).items.map((m) => m.id)).not.toContain(draftId);

    const beforeRange = await app.inject(
      authed({ method: "GET", url: "/api/meetings?q=draft&to=2026-02-01T00:00:00Z" }, aliceCookie),
    );
    expect((beforeRange.json() as { items: { id: string }[] }).items.map((m) => m.id)).toContain(draftId);
  });

  it("supports templateId filtering on the plain list", async () => {
    const created = await app.inject(
      authed(
        { method: "POST", url: "/api/templates", payload: { name: "Funnel tpl", schema: { sections: [] } } },
        aliceCookie,
      ),
    );
    const templateId = (created.json() as { id: string }).id;
    await createMeeting(aliceCookie, "Piped meet", { templateId });

    const filtered = await app.inject(
      authed({ method: "GET", url: `/api/meetings?templateId=${templateId}` }, aliceCookie),
    );
    const body = filtered.json() as { items: { templateId: string | null }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items.every((m) => m.templateId === templateId)).toBe(true);
  });

  it("pages search results", async () => {
    const page1 = await app.inject(authed({ method: "GET", url: "/api/meetings?q=draft&perPage=1&page=1" }, aliceCookie));
    const body = page1.json() as { items: unknown[]; total: number; page: number; perPage: number };
    expect(body.items.length).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.page).toBe(1);
    expect(body.perPage).toBe(1);
  });

  it("rejects an empty q with 400", async () => {
    const res = await app.inject(authed({ method: "GET", url: "/api/meetings?q=" }, aliceCookie));
    expect(res.statusCode).toBe(400);
  });
});

describe("meeting export", () => {
  it("exports markdown with the title, transcript, and action items", async () => {
    const meetingId = await createMeeting(aliceCookie, "Export me please");
    const res = await app.inject(
      authed({ method: "GET", url: `/api/meetings/${meetingId}/export?format=markdown` }, aliceCookie),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { format: string; filename: string; contentType: string; content: string };
    expect(body.format).toBe("markdown");
    expect(body.filename).toMatch(/\.md$/);
    expect(body.contentType).toContain("text/markdown");
    expect(body.content).toContain("# Export me please");
  });

  it("exports txt and json", async () => {
    const meetingId = await createMeeting(aliceCookie, "Plain text export");
    const txt = await app.inject(authed({ method: "GET", url: `/api/meetings/${meetingId}/export?format=txt` }, aliceCookie));
    expect(txt.statusCode).toBe(200);
    expect((txt.json() as { filename: string }).filename).toMatch(/\.txt$/);

    const json = await app.inject(authed({ method: "GET", url: `/api/meetings/${meetingId}/export?format=json` }, aliceCookie));
    expect(json.statusCode).toBe(200);
    const parsed = JSON.parse((json.json() as { content: string }).content) as {
      meeting: { title: string };
      transcript: unknown[];
    };
    expect(parsed.meeting.title).toBe("Plain text export");
    expect(Array.isArray(parsed.transcript)).toBe(true);
  });

  it("exports the synced meeting as a PDF (base64, %PDF magic)", async () => {
    await syncMeeting(aliceCookie, syncPayload("prod-search-export", "PDF bound meeting"));
    const list = await app.inject(authed({ method: "GET", url: "/api/meetings?q=pdf+bound" }, aliceCookie));
    const match = (list.json() as { items: { id: string }[] }).items[0];
    expect(match).toBeDefined();
    const meetingId = (match as { id: string }).id;

    const res = await app.inject(authed({ method: "GET", url: `/api/meetings/${meetingId}/export?format=pdf` }, aliceCookie));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { format: string; filename: string; contentType: string; content: string };
    expect(body.filename).toMatch(/\.pdf$/);
    expect(body.contentType).toBe("application/pdf");

    const bytes = Buffer.from(body.content, "base64");
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("refuses to export another user's meeting (404)", async () => {
    const created = await app.inject(authed({ method: "POST", url: "/api/meetings", payload: { title: "Bob locked" } }, bobCookie));
    const meetingId = (created.json() as { id: string }).id;

    const res = await app.inject(authed({ method: "GET", url: `/api/meetings/${meetingId}/export?format=markdown` }, aliceCookie));
    expect(res.statusCode).toBe(404);
  });

  it("rejects an unknown export format (400)", async () => {
    const meetingId = await createMeeting(aliceCookie, "Formats galore");
    const res = await app.inject(authed({ method: "GET", url: `/api/meetings/${meetingId}/export?format=docx` }, aliceCookie));
    expect(res.statusCode).toBe(400);
  });
});