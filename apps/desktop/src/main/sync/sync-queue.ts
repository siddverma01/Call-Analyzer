import type { MeetingSyncRequest, SyncState } from "@callnotes/shared";
import type { ApiClient } from "../api-client.js";
import { ApiError } from "../api-client.js";
import type { LocalStore } from "../db/local-db.js";

export interface SyncQueueDeps {
  api: Pick<ApiClient, "syncMeeting" | "health">;
  store: LocalStore;
  /** Push the derived sync state to the UI. */
  sendState: (state: SyncState) => void;
  /** Connectivity probe; resolves true when the backend is reachable. */
  probe?: () => Promise<boolean>;
  now?: () => number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  probeIntervalMs?: number;
  /**
   * When true the queue skips connectivity probes and network pumps. Wired to
   * "a meeting is actively recording" so raw capture never competes with sync
   * traffic (payloads are text-only, but the probe/pump round-trips are
   * suppressed during a live session and resume as soon as it ends).
   */
  isMeetingActive?: () => boolean;
  /** Test seam: run a single synchronous pump instead of scheduling probes. */
  manual?: boolean;
}

const DEFAULT_BACKOFF_BASE_MS = 30_000;
const DEFAULT_BACKOFF_MAX_MS = 900_000;
const DEFAULT_PROBE_INTERVAL_MS = 15_000;

function defaultProbe(api: SyncQueueDeps["api"]): () => Promise<boolean> {
  return async () => {
    try {
      await api.health();
      return true;
    } catch {
      return false;
    }
  };
}

/** Failures that indicate the backend is unreachable (retry later). */
function isTransient(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (
      error.code === "SERVICE_UNAVAILABLE" ||
      error.code === "INTERNAL_ERROR" ||
      error.code === "UNAUTHORIZED" ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504
    );
  }
  return true;
}

/**
 * Offline-first meeting sync queue. Each queued meeting holds a full snapshot
 * payload (idempotent upsert on the backend), so re-enqueuing a meeting simply
 * replaces its payload. Items move PENDING_SYNC -> SYNCING; on success they are
 * removed and the local meeting is marked SYNCED, on failure they become
 * SYNC_FAILED and are retried with exponential backoff capped to a maximum.
 * Nothing is ever dropped - reconnection and manual "sync now" both drain the
 * queue.
 */
export class SyncQueue {
  private readonly api: SyncQueueDeps["api"];
  private readonly store: LocalStore;
  private readonly sendState: (state: SyncState) => void;
  private readonly probe: () => Promise<boolean>;
  private readonly now: () => number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly probeIntervalMs: number;
  private readonly manual: boolean;
  private readonly isMeetingActive: () => boolean;

  private online = true;
  private syncingMeetingId: string | null = null;
  private lastError: string | null = null;
  private lastSucceededAt: string | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private pumpPromise: Promise<void> | null = null;

  constructor(deps: SyncQueueDeps) {
    this.api = deps.api;
    this.store = deps.store;
    this.sendState = deps.sendState;
    this.probe = deps.probe ?? defaultProbe(deps.api);
    this.now = deps.now ?? Date.now;
    this.backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.probeIntervalMs = deps.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.manual = deps.manual ?? false;
    this.isMeetingActive = deps.isMeetingActive ?? (() => false);
  }

  start(): void {
    if (this.manual || this.probeTimer || this.disposed) return;
    void this.checkConnectivity();
    this.probeTimer = setInterval(() => {
      void this.checkConnectivity();
    }, this.probeIntervalMs);
    if (this.probeTimer.unref) this.probeTimer.unref();
  }

  stop(): void {
    this.disposed = true;
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /** Replace (or add) the queued snapshot for a meeting and kick a sync. */
  async enqueue(meetingId: string, payload: MeetingSyncRequest): Promise<void> {
    this.store.enqueueSync(meetingId, JSON.stringify(payload));
    this.pushState();
    await this.pump();
  }

  /** User-initiated sync: clear backoff for every queued meeting and flush. */
  async syncNow(): Promise<SyncState> {
    await this.checkConnectivity();
    this.store.listQueueItems().forEach((row) => {
      if (row.nextAttemptAt !== null) {
        this.store.markQueueFailed(row.meetingId, row.lastError ?? "", this.now());
      }
    });
    await this.pump();
    return this.getState();
  }

  getState(): SyncState {
    const pending = this.store.pendingCount();
    let status: SyncState["status"];
    if (!this.online) {
      status = "OFFLINE";
    } else if (this.syncingMeetingId !== null) {
      status = "SYNCING";
    } else if (pending > 0) {
      const failed = this.store.listQueueItems().some((row) => row.state === "SYNC_FAILED");
      status = failed ? "SYNC_FAILED" : "PENDING_SYNC";
    } else {
      status = this.lastSucceededAt !== null ? "SYNCED" : "IDLE";
    }
    return { status, pendingCount: pending, syncingMeetingId: this.syncingMeetingId, lastError: this.lastError, lastSyncedAt: this.lastSucceededAt };
  }

  private pushState(): void {
    if (this.disposed) return;
    this.sendState(this.getState());
  }

  private async checkConnectivity(): Promise<void> {
    // No network activity during a live recording (the renderer knows a
    // session is active and the queue resumes when it ends).
    if (this.isMeetingActive()) {
      this.pushState();
      return;
    }
    const reachable = await this.probe();
    const wasOnline = this.online;
    this.online = reachable;
    if (!wasOnline && reachable) {
      // Back online: drain whatever accumulated while offline.
      void this.pump();
    }
    if (this.online && this.store.pendingCount() > 0) {
      void this.pump();
    }
    this.pushState();
  }

  /** Attempt one queued meeting at a time until the queue is empty. */
  private async pump(): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise;
    this.pumpPromise = this.drain().finally(() => {
      this.pumpPromise = null;
      this.pushState();
    });
    return this.pumpPromise;
  }

  private async drain(): Promise<void> {
    if (!this.online || this.isMeetingActive()) {
      this.pushState();
      return;
    }
    const due = this.store.listDueSyncs();
    for (const row of due) {
      // Re-check before each item; a meeting may have started mid-drain.
      if (!this.online || this.disposed || this.isMeetingActive()) return;
      const meetingId = row.meetingId;
      this.syncingMeetingId = meetingId;
      this.lastError = null;
      this.pushState();

      let payload: MeetingSyncRequest;
      try {
        payload = JSON.parse(row.payload) as MeetingSyncRequest;
      } catch {
        this.store.deleteQueueItem(meetingId);
        continue;
      }

      try {
        await this.api.syncMeeting(payload);
        this.store.deleteQueueItem(meetingId);
        this.store.updateMeeting(meetingId, { status: "SYNCED" });
        this.lastSucceededAt = new Date(this.now()).toISOString();
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : "Sync failed";
        const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(attempts - 1, 8));
        const nextAttemptAt = isTransient(error) ? this.now() + delay : null;
        this.store.markQueueFailed(meetingId, message, nextAttemptAt ?? this.now(), attempts);
        this.lastError = message;
        // A connectivity failure flips the visible state to offline right away.
        if (isTransient(error)) this.online = false;
      } finally {
        this.syncingMeetingId = null;
      }
    }
    this.pushState();
  }
}