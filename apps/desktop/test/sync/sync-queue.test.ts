import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeetingSyncRequest, SyncState } from "@callnotes/shared";
import { ApiError } from "../../src/main/api-client";
import { LocalStore } from "../../src/main/db/local-db";
import { SyncQueue } from "../../src/main/sync/sync-queue";

let clock = 1000;
const now = () => clock;

const dirs: string[] = [];

function store(): LocalStore {
  const dir = mkdtempSync(join(tmpdir(), "lt-syncqueue-"));
  dirs.push(dir);
  return new LocalStore(join(dir, "callnotes.db"), now);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      const { rmSync } = require("node:fs") as typeof import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures on Windows
    }
  }
});

interface QueueHarness {
  state: SyncState[];
  enqueued: MeetingSyncRequest[];
  offline: boolean;
  failWith: Error | null;
  active: boolean;
  queue: SyncQueue;
  s: LocalStore;
}

function harness(overrides: { backoffBaseMs?: number } = {}): QueueHarness {
  const s = store();
  const har: QueueHarness = {
    state: [],
    enqueued: [],
    offline: false,
    failWith: null,
    active: false,
    queue: undefined as unknown as SyncQueue,
    s,
  };
  const api = {
    async syncMeeting(payload: MeetingSyncRequest): Promise<{ id: string }> {
      if (har.failWith) throw har.failWith;
      har.enqueued.push(payload);
      return { id: payload.clientMeetingId };
    },
    async health(): Promise<{ status: string }> {
      if (har.offline) throw new Error("network down");
      return { status: "ok" };
    },
  };
  har.queue = new SyncQueue({
    api,
    store: s,
    sendState: (state) => har.state.push(state),
    probe: async () => !har.offline,
    now,
    backoffBaseMs: overrides.backoffBaseMs ?? 30_000,
    manual: true,
    isMeetingActive: () => har.active,
  });
  return har;
}

function meeting(store: LocalStore, id: string, status: "SYNC_PENDING" | "COMPLETED" | "SYNCED" = "SYNC_PENDING"): void {
  store.createMeeting({ id, title: `Meeting ${id}`, templateId: null, status, startedAt: clock });
}

const payload = (id: string): MeetingSyncRequest => ({
  clientMeetingId: id,
  title: `Meeting ${id}`,
  startedAt: new Date(clock),
  status: "COMPLETED",
  durationSeconds: 10,
});

describe("SyncQueue", () => {
  it("drains a queued meeting, deletes it, and marks the meeting SYNCED", async () => {
    const h = harness();
    meeting(h.s, "m1");
    await h.queue.enqueue("m1", payload("m1"));

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].clientMeetingId).toBe("m1");
    expect(h.s.getQueueItem("m1")).toBeNull();
    expect(h.s.getMeeting("m1")!.status).toBe("SYNCED");
    const last = h.state[h.state.length - 1];
    expect(last.status).toBe("SYNCED");
    expect(last.pendingCount).toBe(0);
  });

  it("replaces a pending payload instead of appending a duplicate", async () => {
    const h = harness();
    h.offline = true;
    await h.queue.syncNow();
    meeting(h.s, "m1");
    await h.queue.enqueue("m1", payload("m1"));
    await h.queue.enqueue("m1", { ...payload("m1"), title: "Revised title" });
    expect(h.s.pendingCount()).toBe(1);

    h.offline = false;
    await h.queue.syncNow();
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].title).toBe("Revised title");
    expect(h.s.pendingCount()).toBe(0);
  });

  it("surfaces SYNC_FAILED with backoff on a transient error and stays offline", async () => {
    const h = harness({ backoffBaseMs: 1000 });
    meeting(h.s, "m1");
    h.failWith = new ApiError("SERVICE_UNAVAILABLE", "upstream down", 503);
    await h.queue.enqueue("m1", payload("m1"));

    const row = h.s.getQueueItem("m1")!;
    expect(row.state).toBe("SYNC_FAILED");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toBe(clock + 1000);
    expect(h.s.getMeeting("m1")!.status).toBe("SYNC_PENDING");
    expect(h.state[h.state.length - 1].status).toBe("OFFLINE");
    expect(h.state[h.state.length - 1].lastError).toBe("upstream down");
  });

  it("does not retry a non-transient failure until asked (immediate retry scheduled)", async () => {
    const h = harness();
    meeting(h.s, "m1");
    h.failWith = new ApiError("VALIDATION", "bad payload", 422);
    await h.queue.enqueue("m1", payload("m1"));
    expect(h.state[h.state.length - 1].status).toBe("SYNC_FAILED");

    h.failWith = null;
    await h.queue.enqueue("m1", payload("m1"));
    expect(h.enqueued).toHaveLength(1);
  });

  it("syncNow clears backoff and drains immediately even mid-backoff", async () => {
    const h = harness({ backoffBaseMs: 90_000 });
    meeting(h.s, "m1");
    h.failWith = new ApiError("SERVICE_UNAVAILABLE", "down", 503);
    await h.queue.enqueue("m1", payload("m1"));

    clock += 5000;
    h.failWith = null;
    const state = await h.queue.syncNow();
    expect(state.status).toBe("SYNCED");
    expect(h.s.getQueueItem("m1")).toBeNull();
    expect(h.s.getMeeting("m1")!.status).toBe("SYNCED");
  });

  it("holds work while offline and resumes automatically when back online", async () => {
    const h = harness();
    h.offline = true;
    await h.queue.syncNow();
    meeting(h.s, "m1");
    await h.queue.enqueue("m1", payload("m1"));
    expect(h.enqueued).toHaveLength(0);
    expect(h.state[h.state.length - 1].status).toBe("OFFLINE");

    h.offline = false;
    await h.queue.syncNow();
    expect(h.enqueued).toHaveLength(1);
    expect(h.state[h.state.length - 1].status).toBe("SYNCED");
  });

  it("reports IDLE (and SYNCED after a success) in getState", () => {
    const h = harness();
    expect(h.queue.getState()).toMatchObject({ status: "IDLE", pendingCount: 0 });

    meeting(h.s, "m1");
    void h.queue.enqueue("m1", payload("m1")).then(() => {
      expect(h.queue.getState().status).toBe("SYNCED");
    });
  });

  it("skips network probes and pumps while a meeting is recording", async () => {
    const h = harness();
    h.offline = true;
    await h.queue.syncNow();
    meeting(h.s, "m1");
    await h.queue.enqueue("m1", payload("m1"));
    expect(h.enqueued).toHaveLength(0);
    expect(h.s.pendingCount()).toBe(1);

    // A recording starts; sync now (manual probe + pump) must stay quiet.
    h.active = true;
    await h.queue.syncNow();
    expect(h.enqueued).toHaveLength(0);
    expect(h.s.pendingCount()).toBe(1);

    // The meeting ends and the network is back: the queue drains normally.
    h.offline = false;
    h.active = false;
    const state = await h.queue.syncNow();
    expect(state.status).toBe("SYNCED");
    expect(h.enqueued).toHaveLength(1);
    expect(h.s.getMeeting("m1")!.status).toBe("SYNCED");
  });
});