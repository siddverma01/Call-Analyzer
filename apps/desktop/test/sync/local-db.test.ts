import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../../src/main/db/local-db.ts";

let clock = 1000;
const now = () => clock;

const dirs: string[] = [];

function freshStore(): LocalStore {
  const dir = mkdtempSync(join(tmpdir(), "lt-localdb-"));
  dirs.push(dir);
  const store = new LocalStore(join(dir, "callnotes.db"), now);
  return store;
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      const { rmSync } = require("node:fs") as typeof import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures on Windows
    }
  }
});

describe("LocalStore", () => {
  it("creates and reads back a meeting", () => {
    const store = freshStore();
    store.createMeeting({ id: "m1", title: "Standup", templateId: null, status: "STARTING", startedAt: clock });
    const row = store.getMeeting("m1");
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Standup");
    expect(row!.status).toBe("STARTING");
    expect(row!.durationSeconds).toBe(0);
    store.close();
  });

  it("patches only the supplied fields", () => {
    const store = freshStore();
    store.createMeeting({ id: "m1", title: "Old", templateId: "tpl_1", status: "RECORDING", startedAt: clock });
    store.updateMeeting("m1", { title: "New", status: "COMPLETED", endedAt: clock + 60_000, durationSeconds: 60 });
    const row = store.getMeeting("m1")!;
    expect(row.title).toBe("New");
    expect(row.templateId).toBe("tpl_1");
    expect(row.status).toBe("COMPLETED");
    expect(row.durationSeconds).toBe(60);
    expect(row.endedAt).toBe(clock + 60_000);
    store.close();
  });

  it("upserts transcript segments idempotently by clientSegmentId", () => {
    const store = freshStore();
    store.createMeeting({ id: "m1", title: "T", templateId: null, status: "RECORDING", startedAt: clock });
    store.upsertSegments("m1", [
      { clientSegmentId: "s1", speaker: "Speaker 1", startMs: 0, endMs: 500, text: "hello", confidence: 0.9 },
    ]);
    store.upsertSegments("m1", [
      { clientSegmentId: "s1", speaker: "Speaker 1", startMs: 0, endMs: 500, text: "hello there", confidence: 0.95 },
      { clientSegmentId: "s2", speaker: "Speaker 2", startMs: 600, endMs: 900, text: "world", confidence: 0.8 },
    ]);
    const segments = store.listSegments("m1");
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("hello there");
    expect(segments[0].confidence).toBe(0.95);
    expect(store.countSegments("m1")).toBe(2);
    store.close();
  });

  it("round-trips structured summaries and action items as JSON", () => {
    const store = freshStore();
    store.createMeeting({ id: "m1", title: "T", templateId: null, status: "DRAFT", startedAt: null });
    store.setSummaryDetails("m1", { summary: "We shipped.", decisions: ["Ship"], risks: null });
    store.setActionItems("m1", [{ description: "Follow up", status: "OPEN" }]);
    expect(store.getSummaryDetails("m1")!.summary).toBe("We shipped.");
    expect(store.getSummaryDetails("m1")!.decisions).toEqual(["Ship"]);
    expect(store.getActionItems("m1")).toEqual([{ description: "Follow up", status: "OPEN" }]);
    store.close();
  });

  it("replaces a queued payload on re-enqueue and resets attempts", () => {
    const store = freshStore();
    store.createMeeting({ id: "m1", title: "T", templateId: null, status: "SYNC_PENDING", startedAt: clock });
    store.enqueueSync("m1", JSON.stringify({ v: 1 }));
    store.markQueueFailed("m1", "boom", clock + 5000);
    expect(store.getQueueItem("m1")!.state).toBe("SYNC_FAILED");
    expect(store.pendingCount()).toBe(1);

    store.enqueueSync("m1", JSON.stringify({ v: 2 }));
    const row = store.getQueueItem("m1")!;
    expect(JSON.parse(row.payload)).toEqual({ v: 2 });
    expect(row.state).toBe("PENDING_SYNC");
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt).toBeNull();
    expect(row.lastError).toBeNull();
    store.close();
  });

  it("lists only due syncs based on next_attempt_at", () => {
    const store = freshStore();
    clock = 5000;
    store.createMeeting({ id: "m1", title: "T", templateId: null, status: "SYNC_PENDING", startedAt: clock });
    store.createMeeting({ id: "m2", title: "T2", templateId: null, status: "SYNC_PENDING", startedAt: clock });
    store.enqueueSync("m1", "{}");
    store.enqueueSync("m2", "{}");
    store.markQueueFailed("m1", "retry later", clock + 10_000);
    // m1 is back into the future; m2 has no retry time yet (due now).
    const due = store.listDueSyncs();
    expect(due.map((r) => r.meetingId)).toEqual(["m2"]);
    store.close();
  });

  it("cascades deletes across segments, queue, and the meeting row", () => {
    const store = freshStore();
    store.createMeeting({ id: "m1", title: "T", templateId: null, status: "RECORDING", startedAt: clock });
    store.upsertSegments("m1", [{ clientSegmentId: "s1", speaker: "S", startMs: 0, endMs: 1, text: "hi", confidence: -1 }]);
    store.enqueueSync("m1", "{}");
    store.appendNote("m1", "a stray note");
    store.deleteMeeting("m1");
    expect(store.getMeeting("m1")).toBeNull();
    expect(store.listSegments("m1")).toHaveLength(0);
    expect(store.pendingCount()).toBe(0);
    store.close();
  });
});