import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MeetingProcessEvent,
  MeetingSyncRequest,
  RecordingResult,
  WhisperEngineStatus,
} from "@callnotes/shared";
import { MEETING_ERROR_CODES } from "@callnotes/shared";
import { ApiError } from "../../src/main/api-client";
import { LocalStore } from "../../src/main/db/local-db";
import { SyncQueue } from "../../src/main/sync/sync-queue";
import { MeetingService, type MeetingServiceDeps } from "../../src/main/meeting/meeting-service";
import { writeManifest } from "../../src/main/audio/dsp/pcm-chunks";
import type { WhisperService } from "../../src/main/whisper/whisper-service";
import type { AudioService } from "../../src/main/audio/audio-service";

let clock = 1000;
const now = () => clock;

const dirs: string[] = [];

/** Create a preserved recording (manifest + a chunk) for a meeting id. */
function seedRecording(id: string, recordingsDir: string): void {
  const dir = join(recordingsDir, id);
  writeManifest(dir, {
    version: 1,
    meetingId: id,
    createdAt: Date.now(),
    sampleRate: 16_000,
    sources: ["microphone"],
    status: "recorded",
  });
  mkdirSync(join(dir, "microphone"), { recursive: true });
  writeFileSync(join(dir, "microphone", "000000.pcm"), Buffer.alloc(16_000 * 4));
}

const READY: WhisperEngineStatus = {
  state: "ready",
  defaultModelId: "model-1",
  models: [
    { id: "model-1", name: "Tiny", sizeLabel: "75 MB", state: "installed", installed: true, isDefault: true, corrupt: false },
  ],
  error: null,
};

interface HarnessOptions {
  whisperStatus?: WhisperEngineStatus;
  micConnected?: boolean;
  whisperThrows?: boolean;
  captureThrows?: boolean;
  emptyRecording?: boolean;
  enqueueThrows?: boolean;
  /** Called once the store is ready but before MeetingService is constructed. */
  seed?: (s: LocalStore, recordingsDir: string) => void;
}

interface Harness {
  s: LocalStore;
  queue: SyncQueue;
  service: MeetingService;
  events: { type: "updated"; meeting: { id: string } }[];
  process: MeetingProcessEvent[];
  synced: MeetingSyncRequest[];
  offline: boolean;
  recordingsDir: string;
  transcribeRecording: ReturnType<typeof vi.fn>;
  analyze: ReturnType<typeof vi.fn>;
  startMeeting: ReturnType<typeof vi.fn>;
  finishMeetingMF: ReturnType<typeof vi.fn>;
  discardMeetingMF: ReturnType<typeof vi.fn>;
  pauseMeetingMF: ReturnType<typeof vi.fn>;
  resumeMeetingMF: ReturnType<typeof vi.fn>;
  recordingExistsMF: ReturnType<typeof vi.fn>;
  recordingSnapshotMF: ReturnType<typeof vi.fn>;
  estimateSpaceMF: ReturnType<typeof vi.fn>;
}

function harness(overrides: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "lt-meeting-"));
  dirs.push(dir);
  const s = new LocalStore(join(dir, "callnotes.db"), now);
  const recordingsDir = join(dir, "recordings");
  mkdirSync(recordingsDir, { recursive: true });
  if (overrides.seed) overrides.seed(s, recordingsDir);

  const h: Harness = {
    s,
    queue: undefined as unknown as SyncQueue,
    service: undefined as unknown as MeetingService,
    events: [],
    process: [],
    synced: [],
    offline: false,
    recordingsDir,
    transcribeRecording: undefined as unknown as Harness["transcribeRecording"],
    analyze: undefined as unknown as Harness["analyze"],
    startMeeting: undefined as unknown as Harness["startMeeting"],
    finishMeetingMF: undefined as unknown as Harness["finishMeetingMF"],
    discardMeetingMF: undefined as unknown as Harness["discardMeetingMF"],
    pauseMeetingMF: undefined as unknown as Harness["pauseMeetingMF"],
    resumeMeetingMF: undefined as unknown as Harness["resumeMeetingMF"],
    recordingExistsMF: undefined as unknown as Harness["recordingExistsMF"],
    recordingSnapshotMF: undefined as unknown as Harness["recordingSnapshotMF"],
    estimateSpaceMF: undefined as unknown as Harness["estimateSpaceMF"],
  };

  const transcribeRecording = vi.fn(async (input: { onProgress?: (fraction: number) => void }) => {
    if (overrides.whisperThrows) throw new Error("engine boom");
    input.onProgress?.(0.5);
    return {
      segments: [
        { id: "seg-1", speaker: "Speaker 1", startMs: 0, endMs: 1200, text: "Hello world", confidence: 0.92 },
        { id: "seg-2", speaker: "Speaker 2", startMs: 1300, endMs: 2400, text: "Good morning", confidence: 0.87 },
      ],
    };
  });
  const status: Pick<WhisperService, "status">["status"] = () => overrides.whisperStatus ?? READY;
  h.transcribeRecording = transcribeRecording;

  const startMeeting = vi.fn(() => {
    if (overrides.captureThrows) throw new Error("capture not available");
  });
  h.startMeeting = startMeeting;
  const discardMeeting = vi.fn();
  h.discardMeetingMF = discardMeeting;
  const finishMeeting = vi.fn((): RecordingResult | null => {
    if (overrides.emptyRecording) return null;
    return {
      sampleRate: 16_000,
      streams: [{ kind: "microphone", dir: join(recordingsDir, "m-local", "microphone"), frameCount: 16_000 }],
    };
  });
  h.finishMeetingMF = finishMeeting;
  const pauseMeeting = vi.fn();
  h.pauseMeetingMF = pauseMeeting;
  const resumeMeeting = vi.fn();
  h.resumeMeetingMF = resumeMeeting;
  const recordingExists = vi.fn((id: string) => existsSync(join(recordingsDir, id, "manifest.json")));
  h.recordingExistsMF = recordingExists;
  const recordingSnapshot = vi.fn(
    (id: string, sources: string[]): RecordingResult | null =>
      existsSync(join(recordingsDir, id, "manifest.json"))
        ? {
            sampleRate: 16_000,
            streams: sources.map((kind) => ({
              kind,
              dir: join(recordingsDir, id, kind),
              frameCount: 16_000,
            })),
          }
        : null,
  );
  h.recordingSnapshotMF = recordingSnapshot;
  const estimateRecordingSpace = vi.fn(() => ({
    bytesPerSecond: 64_000,
    estimatedBytes: 64_000 * 14_400,
    availableBytes: 1_000_000_000,
    minimumRequiredBytes: 64_000 * 1_800 + 128 * 1024 * 1024,
    sufficient: true,
  }));
  h.estimateSpaceMF = estimateRecordingSpace;

  const audio = {
    info: () => ({
      mic: { state: overrides.micConnected ?? true ? "connected" : "not-connected" },
      systemAudio: { state: "available" },
    }),
    startMeeting,
    finishMeeting,
    discardMeeting,
    pauseMeeting,
    resumeMeeting,
    recordingExists,
    recordingSnapshot,
    estimateRecordingSpace,
  } as unknown as Pick<
    AudioService,
    | "info"
    | "startMeeting"
    | "finishMeeting"
    | "discardMeeting"
    | "pauseMeeting"
    | "resumeMeeting"
    | "recordingExists"
    | "recordingSnapshot"
    | "estimateRecordingSpace"
  >;

  h.queue = new SyncQueue({
    api: {
      async health() {
        if (h.offline) throw new Error("network down");
        return { status: "ok" };
      },
      async syncMeeting(payload: MeetingSyncRequest) {
        if (h.offline) throw new ApiError("SERVICE_UNAVAILABLE", "offline", 503);
        h.synced.push(payload);
        return { id: payload.clientMeetingId } as never;
      },
    },
    store: s,
    sendState: () => {},
    probe: async () => !h.offline,
    now,
    backoffBaseMs: 1000,
    manual: true,
  });

  const analyze = vi.fn(async () => {});
  h.analyze = analyze;

  const base = h.queue.enqueue.bind(h.queue);
  h.queue.enqueue = async (meetingId: string, payload: MeetingSyncRequest) => {
    if (overrides.enqueueThrows) throw new Error("queue backing store failed");
    return base(meetingId, payload);
  };

  h.service = new MeetingService({
    store: s,
    queue: h.queue,
    recordingsDir,
    whisper: { transcribeRecording, status } as Pick<WhisperService, "transcribeRecording" | "status">,
    audio,
    sendMeeting: (event) => h.events.push(event),
    sendProcess: (event) => h.process.push(event),
    analyze,
    now,
    newId: () => "m-local",
  } satisfies MeetingServiceDeps);

  return h;
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

describe("MeetingService", () => {
  it("returns MIC_UNAVAILABLE when no microphone is connected", async () => {
    const h = harness({ micConnected: false });
    const result = await h.service.start({ sources: ["microphone", "loopback"], diarization: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(MEETING_ERROR_CODES.MIC_UNAVAILABLE);
  });

  it("returns WHISPER_MODEL_MISSING when the engine is healthy but no model is installed", async () => {
    const h = harness({
      whisperStatus: {
        state: "ready",
        defaultModelId: null,
        models: [],
        error: null,
      },
    });
    const result = await h.service.start({ sources: ["microphone"], diarization: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(MEETING_ERROR_CODES.WHISPER_MODEL_MISSING);
  });

  it("starts a meeting, records it locally, and captures to disk", async () => {
    const h = harness();
    const start = await h.service.start({ sources: ["microphone"], diarization: true, title: "Standup" });
    expect(start.ok).toBe(true);
    expect(start.meeting?.id).toBe("m-local");
    expect(h.s.getMeeting("m-local")!.status).toBe("RECORDING");
    // capture-only: start captures to temp files and reports write errors back
    expect(h.startMeeting).toHaveBeenCalledWith(
      "m-local",
      ["microphone"],
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    // capture settings persist so a retry knows how to process the audio
    expect(JSON.parse(h.s.getMeeting("m-local")!.sources!)).toEqual(["microphone"]);
    expect(h.s.getMeeting("m-local")!.diarization).toBe(1);
    // no transcription runs while recording
    expect(h.transcribeRecording).not.toHaveBeenCalled();
    expect(h.s.countSegments("m-local")).toBe(0);
  });

  it("marks the meeting FAILED and returns CAPTURE_FAILED when capture cannot start", async () => {
    const h = harness({ captureThrows: true });
    const result = await h.service.start({ sources: ["microphone"], diarization: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(MEETING_ERROR_CODES.CAPTURE_FAILED);
    expect(h.s.getMeeting("m-local")!.status).toBe("FAILED");
    expect(h.service.getActiveMeetingId()).toBeNull();
  });

  it("runs the full offline lifecycle: transcribe, analyze, save, sync once online", async () => {
    const h = harness();
    const start = await h.service.start({ sources: ["microphone"], diarization: true });
    expect(start.ok).toBe(true);

    // Go offline before stopping. Stop must still finalize locally.
    h.offline = true;
    const stop = await h.service.stop();
    expect(stop.ok).toBe(true);

    // Transcription ran over the temporary capture snapshot.
    expect(h.transcribeRecording).toHaveBeenCalledWith(
      expect.objectContaining({ sampleRate: 16_000, diarization: true }),
    );
    expect(h.s.countSegments("m-local")).toBe(2);

    // Local analysis ran after transcription.
    expect(h.analyze).toHaveBeenCalledWith("m-local");

    const local = h.s.getMeeting("m-local")!;
    expect(local.status).toBe("SYNC_PENDING");
    expect(local.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(h.s.pendingCount()).toBe(1);
    expect(h.service.list().find((m) => m.id === "m-local")?.syncStatus).toBe("SYNC_FAILED");
    // Transcript text is preserved locally even though sync failed.
    expect(h.service.get("m-local")!.segments.map((seg) => seg.text)).toEqual(["Hello world", "Good morning"]);
    // Nothing reached the backend while offline.
    expect(h.synced).toHaveLength(0);

    // The temporary capture files are deleted after transcription + sync.
    expect(existsSync(join(h.recordingsDir, "m-local"))).toBe(false);

    // Processing progress was pushed to the renderer.
    expect(JSON.stringify(h.process)).toContain("transcribing");
    expect(h.process).toContainEqual(expect.objectContaining({ type: "complete", meeting: expect.objectContaining({ id: "m-local" }) }));

    // Back online: the queue drains automatically on the next probe.
    h.offline = false;
    await h.queue.syncNow();

    expect(h.synced).toHaveLength(1);
    expect(h.synced[0].clientMeetingId).toBe("m-local");
    expect(h.synced[0].segments!.map((seg) => seg.clientSegmentId)).toEqual(["seg-1", "seg-2"]);
    expect(h.synced[0].status).toBe("COMPLETED");
    expect(h.s.pendingCount()).toBe(0);
    expect(h.s.getMeeting("m-local")!.status).toBe("SYNCED");
    expect(h.service.get("m-local")!.syncStatus).toBe("SYNCED");
    expect(h.service.get("m-local")!.summary).toBeNull();
  });

  it("swallows local AI analysis failures so the meeting still completes", async () => {
    const h = harness();
    await h.service.start({ sources: ["microphone"], diarization: false });
    h.analyze.mockRejectedValueOnce(new Error("llm offline"));
    h.offline = true;
    const stop = await h.service.stop();
    expect(stop.ok).toBe(true);
    expect(h.s.getMeeting("m-local")!.status).toBe("SYNC_PENDING");
    expect(h.process).toContainEqual(expect.objectContaining({ type: "complete" }));
  });

  it("marks the meeting FAILED and PRESERVES temp audio when transcription fails", async () => {
    const h = harness({ whisperThrows: true });
    await h.service.start({ sources: ["microphone"], diarization: true });
    seedRecording("m-local", h.recordingsDir);
    const stop = await h.service.stop();
    expect(stop.ok).toBe(false);
    expect(stop.error?.code).toBe(MEETING_ERROR_CODES.WHISPER_FAILED);
    expect(h.s.getMeeting("m-local")!.status).toBe("FAILED");
    expect(h.s.getMeeting("m-local")!.captureError).toContain("engine boom");
    // the raw audio is KEPT so the user can retry transcription
    expect(existsSync(join(h.recordingsDir, "m-local"))).toBe(true);
    expect(h.service.get("m-local")!.hasLocalRecording).toBe(true);
    expect(h.service.get("m-local")!.processingError).toContain("engine boom");
    expect(h.process).toContainEqual(expect.objectContaining({ type: "failed", meetingId: "m-local" }));
  });

  it("returns CAPTURE_FAILED when the capture session can no longer be finalized", async () => {
    const h = harness({ emptyRecording: true });
    await h.service.start({ sources: ["microphone"], diarization: true });
    const stop = await h.service.stop();
    expect(stop.ok).toBe(false);
    expect(stop.error?.code).toBe(MEETING_ERROR_CODES.CAPTURE_FAILED);
    expect(h.s.getMeeting("m-local")!.status).toBe("FAILED");
    expect(h.service.getActiveMeetingId()).toBeNull();
  });

  it("abandons an active session on quit and PRESERVES temp audio", async () => {
    const h = harness();
    await h.service.start({ sources: ["microphone"], diarization: true });
    seedRecording("m-local", h.recordingsDir);
    h.service.abandonActive();
    // capture is finalized (not discarded) so the interrupted meeting can retry
    expect(h.finishMeetingMF).toHaveBeenCalled();
    expect(h.discardMeetingMF).not.toHaveBeenCalled();
    expect(h.service.getActiveMeetingId()).toBeNull();
    expect(h.s.getMeeting("m-local")!.status).toBe("FAILED");
    expect(h.s.getMeeting("m-local")!.captureError).toContain("Capture was interrupted");
    expect(existsSync(join(h.recordingsDir, "m-local"))).toBe(true);
    expect(JSON.stringify(h.events)).toContain('"FAILED"');
  });

  it("returns NO_ACTIVE_SESSION when stopped without a running meeting", async () => {
    const h = harness();
    const result = await h.service.stop();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(MEETING_ERROR_CODES.NO_ACTIVE_SESSION);
  });

  it("refuses a second start while a meeting is recording", async () => {
    const h = harness();
    await h.service.start({ sources: ["microphone"], diarization: false });
    const again = await h.service.start({ sources: ["microphone"], diarization: false });
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe(MEETING_ERROR_CODES.SESSION_ACTIVE);
  });

  it("retries transcription from preserved audio and deletes it on success", async () => {
    const h = harness({
      seed: (s) => {
        s.createMeeting({
          id: "m-local",
          title: "Interrupted",
          templateId: null,
          status: "FAILED",
          startedAt: now() - 60_000,
          sources: ["microphone"],
          diarization: true,
          language: "en",
        });
      },
    });
    expect(h.service.get("m-local")!.hasLocalRecording).toBe(false);
    seedRecording("m-local", h.recordingsDir);
    expect(h.service.get("m-local")!.hasLocalRecording).toBe(true);

    h.offline = true;
    const result = await h.service.retry("m-local");
    expect(result.ok).toBe(true);
    expect(h.transcribeRecording).toHaveBeenCalledWith(expect.objectContaining({ diarization: true, language: "en" }));
    expect(h.s.countSegments("m-local")).toBe(2);
    expect(h.s.getMeeting("m-local")!.status).toBe("SYNC_PENDING");
    expect(h.process).toContainEqual(
      expect.objectContaining({ type: "complete", meeting: expect.objectContaining({ id: "m-local" }) }),
    );
    // the preserved audio is deleted only after a successful retry
    expect(existsSync(join(h.recordingsDir, "m-local"))).toBe(false);
    expect(h.service.get("m-local")!.hasLocalRecording).toBe(false);
    expect(h.s.pendingCount()).toBe(1);
  });

  it("refuses to retry a failed meeting with no preserved audio", async () => {
    const h = harness({
      seed: (s) => {
        s.createMeeting({
          id: "m-local",
          title: "Interrupted",
          templateId: null,
          status: "FAILED",
          startedAt: now(),
          sources: ["microphone"],
          diarization: false,
          language: null,
        });
      },
    });
    const result = await h.service.retry("m-local");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(MEETING_ERROR_CODES.NO_RECORDING);
  });

  it("discards preserved local audio but keeps the failed meeting record", () => {
    const h = harness({
      seed: (s) => {
        s.createMeeting({
          id: "m-local",
          title: "Interrupted",
          templateId: null,
          status: "FAILED",
          startedAt: now(),
          sources: ["microphone"],
          diarization: false,
          language: null,
        });
      },
    });
    seedRecording("m-local", h.recordingsDir);
    expect(h.service.get("m-local")!.hasLocalRecording).toBe(true);

    const result = h.service.discardRecording("m-local");
    expect(result.ok).toBe(true);
    expect(existsSync(join(h.recordingsDir, "m-local"))).toBe(false);
    expect(h.service.get("m-local")!.hasLocalRecording).toBe(false);
    // the meeting row itself is untouched
    expect(h.s.getMeeting("m-local")!.status).toBe("FAILED");
  });

  it("refuses to discard the audio of a meeting that is still processing", () => {
    const h = harness({
      seed: (s) => {
        s.createMeeting({
          id: "m-busy",
          title: "Busy",
          templateId: null,
          status: "FAILED",
          startedAt: now(),
          sources: ["microphone"],
          diarization: false,
          language: null,
        });
      },
    });
    seedRecording("m-busy", h.recordingsDir);
    // Mark the row PROCESSING after construction, as a live in-process
    // processing run would (a startup reconcile would have handled it instead).
    h.s.updateMeeting("m-busy", { status: "PROCESSING", captureError: null });
    expect(h.service.get("m-busy")!.hasLocalRecording).toBe(true);

    const result = h.service.discardRecording("m-busy");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(MEETING_ERROR_CODES.SESSION_ACTIVE);
    // the audio a processing job still needs is preserved
    expect(existsSync(join(h.recordingsDir, "m-busy"))).toBe(true);
    expect(h.service.get("m-busy")!.hasLocalRecording).toBe(true);
  });

  it("reconciles stale STARTING/RECORDING meetings to FAILED on startup", () => {
    const h = harness({
      seed: (s) => {
        s.createMeeting({
          id: "stale-rec",
          title: "Interrupted",
          templateId: null,
          status: "RECORDING",
          startedAt: now() - 10_000,
          sources: ["microphone"],
          diarization: true,
          language: null,
        });
        s.createMeeting({
          id: "stale-start",
          title: "Interrupted 2",
          templateId: null,
          status: "STARTING",
          startedAt: now() - 5_000,
          sources: ["microphone"],
          diarization: true,
          language: null,
        });
        s.createMeeting({
          id: "stale-proc",
          title: "Interrupted 3",
          templateId: null,
          status: "PROCESSING",
          startedAt: now() - 5_000,
          sources: ["microphone"],
          diarization: false,
          language: null,
        });
        s.createMeeting({
          id: "done",
          title: "Done",
          templateId: null,
          status: "COMPLETED",
          startedAt: now() - 60_000,
          sources: ["microphone"],
          diarization: false,
          language: null,
        });
      },
    });
    const rec = h.s.getMeeting("stale-rec")!;
    expect(rec.status).toBe("FAILED");
    expect(rec.captureError).toContain("Capture was interrupted");
    expect(h.s.getMeeting("stale-start")!.status).toBe("FAILED");
    expect(h.s.getMeeting("stale-proc")!.status).toBe("FAILED");
    expect(h.s.getMeeting("stale-proc")!.captureError).toContain("Processing was interrupted");
    expect(h.s.getMeeting("done")!.status).toBe("COMPLETED");
  });

  it("keeps the temporary audio and marks the meeting FAILED when queueing for sync fails", async () => {
    const h = harness({ enqueueThrows: true });
    seedRecording("m-local", h.recordingsDir);
    const start = await h.service.start({ sources: ["microphone"], diarization: false });
    expect(start.ok).toBe(true);

    const stop = await h.service.stop();
    expect(stop.ok).toBe(false);
    expect(stop.error?.code).toBe(MEETING_ERROR_CODES.SYNC_FAILED);
    expect(h.s.getMeeting("m-local")!.status).toBe("FAILED");
    // the transcript text is preserved locally
    expect(h.s.countSegments("m-local")).toBe(2);
    // the temporary audio is NOT deleted - a failed sync job still needs it
    expect(existsSync(join(h.recordingsDir, "m-local"))).toBe(true);
    expect(h.process.at(-1)).toMatchObject({
      type: "failed",
      error: { code: MEETING_ERROR_CODES.SYNC_FAILED },
    });
  });

  it("pause and resume proxy to the audio service during recording", async () => {
    const h = harness();
    await h.service.start({ sources: ["microphone"], diarization: true });
    const paused = h.service.pause();
    expect(h.pauseMeetingMF).toHaveBeenCalled();
    expect(paused.ok).toBe(true);
    expect(paused.meeting?.id).toBe("m-local");
    const resumed = h.service.resume();
    expect(h.resumeMeetingMF).toHaveBeenCalled();
    expect(resumed.ok).toBe(true);
  });

  it("surfaces a disk-space estimate for the selected sources", () => {
    const h = harness();
    const estimate = h.service.estimateStorage(["microphone", "loopback"], 7_200);
    expect(h.estimateSpaceMF).toHaveBeenCalledWith(["microphone", "loopback"], 7_200);
    expect(estimate.bytesPerSecond).toBe(64_000);
    expect(estimate.sufficient).toBe(true);
  });
});