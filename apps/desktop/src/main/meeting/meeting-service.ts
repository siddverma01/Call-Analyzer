import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AudioCaptureKind,
  LocalMeetingDetail,
  LocalMeetingListItem,
  LocalMeetingSegment,
  MeetingActionResult,
  MeetingEvent,
  MeetingProcessEvent,
  MeetingStartRequest,
  MeetingStatus,
  MeetingSyncRequest,
  MeetingSyncSummary,
  MeetingSyncActionItem,
  RecordingResult,
  RecordingStorageEstimate,
  WhisperEngineStatus,
  WhisperSegment,
} from "@callnotes/shared";
import { MEETING_ERROR_CODES } from "@callnotes/shared";
import { RecordingSpaceError, type AudioService } from "../audio/audio-service.js";
import { hasRecordingDir, removeRecordingDir } from "../audio/dsp/pcm-chunks.js";
import type { WhisperService } from "../whisper/whisper-service.js";
import type { LocalStore, LocalMeetingRow, LocalSegmentRow, LocalSegmentInput } from "../db/local-db.js";
import type { SyncQueue } from "../sync/sync-queue.js";

export interface MeetingServiceDeps {
  store: LocalStore;
  queue: Pick<SyncQueue, "enqueue">;
  /** Root dir holding this meeting's temporary capture files. */
  recordingsDir: string;
  whisper: Pick<WhisperService, "status" | "transcribeRecording">;
  audio: Pick<
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
  /** Push local meeting updates to the renderer. */
  sendMeeting: (event: MeetingEvent) => void;
  /** Push post-meeting processing progress (finalize -> transcribe -> clean). */
  sendProcess: (event: MeetingProcessEvent) => void;
  /**
   * Best-effort local AI analysis of a finished meeting. Wired in main wiring
   * (not a direct LlmService dependency) to avoid a circular import; failures
   * are swallowed so processing still completes.
   */
  analyze?: (meetingId: string) => Promise<void>;
  now?: () => number;
  newId?: () => string;
}

function ok(meeting: LocalMeetingListItem | null): MeetingActionResult {
  return { ok: true, meeting, error: null };
}

function fail(code: string, message: string): MeetingActionResult {
  return { ok: false, meeting: null, error: { code, message } };
}

/**
 * Owns the offline-first meeting lifecycle in the Electron main process:
 *  START  - validate mic / system audio / Whisper engine / model, verify free
 *           disk space, create the local meeting row, and capture the chosen
 *           sources into temporary on-device audio files. No transcription
 *           happens while recording (Whisper and the LLM stay idle).
 *  STOP   - stop capture, transcribe the temporary recording with the local
 *           Whisper engine, persist segments, run best-effort local analysis,
 *           queue the text snapshot for sync, then DELETE the temporary audio.
 *  FAIL   - a failed capture or transcription keeps the temporary audio on
 *           disk (files are preserved) so the user can retry() it or
 *           discardRecording() it explicitly. Interrupted sessions are
 *           reconciled to FAILED on restart and never silently deleted.
 *
 * The only durable artifacts are the transcript text and metadata, held in the
 * local SQLite database and (later, automatically) on the backend after
 * reconnection. Temporary capture audio never leaves the machine.
 */
export class MeetingService {
  private readonly store: LocalStore;
  private readonly queue: Pick<SyncQueue, "enqueue">;
  private readonly recordingsDir: string;
  private readonly whisper: Pick<WhisperService, "status" | "transcribeRecording">;
  private readonly audio: Pick<
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
  private readonly sendMeeting: (event: MeetingEvent) => void;
  private readonly sendProcess: (event: MeetingProcessEvent) => void;
  private readonly analyze?: (meetingId: string) => Promise<void>;
  private readonly now: () => number;
  private readonly newId: () => string;

  private activeMeetingId: string | null = null;
  private activeDiarization = true;
  private activeLanguage: string | null = null;

  constructor(deps: MeetingServiceDeps) {
    this.store = deps.store;
    this.queue = deps.queue;
    this.recordingsDir = deps.recordingsDir;
    this.whisper = deps.whisper;
    this.audio = deps.audio;
    this.sendMeeting = deps.sendMeeting;
    this.sendProcess = deps.sendProcess;
    this.analyze = deps.analyze;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.reconcileAbandoned();
  }

  getActiveMeetingId(): string | null {
    return this.activeMeetingId;
  }

  async start(input: MeetingStartRequest): Promise<MeetingActionResult> {
    if (this.activeMeetingId) {
      return fail(MEETING_ERROR_CODES.SESSION_ACTIVE, "A meeting is already recording.");
    }

    const sources = input.sources.length > 0 ? input.sources : (["microphone"] as AudioCaptureKind[]);
    const audioInfo = this.audio.info();
    if (sources.includes("microphone") && audioInfo.mic.state !== "connected") {
      return fail(MEETING_ERROR_CODES.MIC_UNAVAILABLE, "No active microphone is connected. Enable one in settings first.");
    }
    if (sources.includes("loopback") && audioInfo.systemAudio.state !== "available") {
      return fail(MEETING_ERROR_CODES.SYSTEM_AUDIO_UNAVAILABLE, "System audio capture is unavailable on this device.");
    }

    const modelStatus = this.checkWhisperModel();
    if (modelStatus.error) {
      return modelStatus.error;
    }

    const id = this.newId();
    const now = this.now();
    const diarization = input.diarization;
    const language = input.language ?? null;
    this.store.createMeeting({
      id,
      title: input.title?.trim() || "Untitled meeting",
      templateId: input.templateId ?? null,
      status: "STARTING",
      startedAt: now,
      sources,
      diarization,
      language,
    });

    try {
      // Captures into temp files only; transcription waits until stop(). An
      // async write failure (e.g. disk full) fails the meeting but preserves
      // whatever audio was captured so it can be retried.
      this.audio.startMeeting(id, sources, { onError: (error) => this.onRecordingError(id, error) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Audio capture could not start.";
      // Clear any partial capture state left behind by the failed start so a
      // later retry does not silently stall on leftover frame consumers.
      this.audio.discardMeeting();
      this.store.updateMeeting(id, { status: "FAILED", captureError: message });
      this.emit(id);
      if (error instanceof RecordingSpaceError) {
        this.sendProcess({ type: "failed", meetingId: id, error: { code: MEETING_ERROR_CODES.INSUFFICIENT_DISK, message } });
        return fail(MEETING_ERROR_CODES.INSUFFICIENT_DISK, message);
      }
      return fail(MEETING_ERROR_CODES.CAPTURE_FAILED, message);
    }

    this.activeMeetingId = id;
    this.activeDiarization = diarization;
    this.activeLanguage = language;
    this.store.updateMeeting(id, { status: "RECORDING" });
    this.emit(id);
    return ok(this.toListItem(id));
  }

  async stop(): Promise<MeetingActionResult> {
    const id = this.activeMeetingId;
    if (!id) {
      return fail(MEETING_ERROR_CODES.NO_ACTIVE_SESSION, "No meeting is recording.");
    }
    const meeting = this.store.getMeeting(id);
    if (!meeting) {
      this.activeMeetingId = null;
      return fail(MEETING_ERROR_CODES.LOCAL_DB_ERROR, "The local meeting record is missing.");
    }

    // Capture the session settings before clearing it so processing can finish
    // even if the session is abandoned (e.g. app quit) mid-flight.
    const diarization = this.activeDiarization;
    const language = this.activeLanguage;
    const recordingDir = this.recordingDir(id);
    this.activeMeetingId = null;
    this.activeDiarization = true;
    this.activeLanguage = null;

    // 1. Finalizing the temporary capture: flush + compact the on-disk PCM
    //    chunks into the canonical recording before transcription.
    this.sendProcess({ type: "finalizing", meetingId: id });

    const recording = this.audio.finishMeeting();
    if (!recording) {
      const message = "No capture session was active for this meeting.";
      this.store.updateMeeting(id, { status: "FAILED", captureError: message });
      this.emit(id);
      this.sendProcess({
        type: "failed",
        meetingId: id,
        error: { code: MEETING_ERROR_CODES.CAPTURE_FAILED, message },
      });
      return fail(MEETING_ERROR_CODES.CAPTURE_FAILED, message);
    }

    const endedAt = this.now();
    const durationSeconds =
      meeting.startedAt !== null ? Math.max(0, Math.round((endedAt - meeting.startedAt) / 1000)) : 0;
    this.store.updateMeeting(id, {
      status: "PROCESSING",
      endedAt,
      durationSeconds,
      captureError: null,
    });
    this.emit(id);
    const processingItem = this.toListItem(id);
    if (processingItem) this.sendProcess({ type: "processing", meeting: processingItem });

    return this.processRecording(id, recording, diarization, language, recordingDir);
  }

  /** Stop writing the active meeting's audio to disk (capture stays warm). */
  pause(): MeetingActionResult {
    this.audio.pauseMeeting();
    return ok(this.activeMeetingId ? this.toListItem(this.activeMeetingId) : null);
  }

  /** Resume writing the active meeting's audio to disk. */
  resume(): MeetingActionResult {
    this.audio.resumeMeeting();
    return ok(this.activeMeetingId ? this.toListItem(this.activeMeetingId) : null);
  }

  /** Project temporary disk usage for a meeting with the given sources. */
  estimateStorage(
    sources: AudioCaptureKind[],
    maxDurationSeconds?: number,
  ): RecordingStorageEstimate {
    return this.audio.estimateRecordingSpace(sources, maxDurationSeconds);
  }

  /**
   * Re-run transcription + analysis for a FAILED meeting whose temporary audio
   * was preserved on disk. The recording is deleted only on success.
   */
  async retry(meetingId: string): Promise<MeetingActionResult> {
    const row = this.store.getMeeting(meetingId);
    if (!row) {
      return fail(MEETING_ERROR_CODES.LOCAL_DB_ERROR, "The local meeting record is missing.");
    }
    if (row.status !== "FAILED" || !this.audio.recordingExists(meetingId)) {
      return fail(MEETING_ERROR_CODES.NO_RECORDING, "There is no preserved recording to retry.");
    }

    const recording = this.audio.recordingSnapshot(meetingId, parseSources(row));
    if (!recording) {
      this.emit(meetingId);
      return fail(MEETING_ERROR_CODES.NO_RECORDING, "There is no preserved recording to retry.");
    }

    // Drop the previous partial transcript and re-process from local audio.
    this.store.clearSegments(meetingId);
    this.store.updateMeeting(meetingId, { status: "PROCESSING", captureError: null });
    this.emit(meetingId);
    const processingItem = this.toListItem(meetingId);
    if (processingItem) this.sendProcess({ type: "processing", meeting: processingItem });

    return this.processRecording(
      meetingId,
      recording,
      row.diarization === 1,
      row.language ?? null,
      this.recordingDir(meetingId),
    );
  }

  /**
   * Explicitly delete the preserved temporary audio of a FAILED meeting. The
   * meeting row (and any transcript text saved so far) stays in the local
   * database; only the audio files are removed.
   */
  discardRecording(meetingId: string): MeetingActionResult {
    if (meetingId === this.activeMeetingId) {
      return fail(MEETING_ERROR_CODES.SESSION_ACTIVE, "Stop the recording before deleting its audio.");
    }
    const row = this.store.getMeeting(meetingId);
    if (!row) {
      return fail(MEETING_ERROR_CODES.LOCAL_DB_ERROR, "The local meeting record is missing.");
    }
    if (row.status !== "FAILED") {
      return fail(
        MEETING_ERROR_CODES.SESSION_ACTIVE,
        "The meeting is still processing; wait for it to finish before deleting its audio.",
      );
    }
    if (!this.audio.recordingExists(meetingId)) {
      return fail(MEETING_ERROR_CODES.NO_RECORDING, "There is no preserved recording to delete.");
    }
    removeRecordingDir(this.recordingDir(meetingId));
    this.emit(meetingId);
    return ok(this.toListItem(meetingId));
  }

  /**
   * Abort path used on app quit: stop capture, KEEP the temporary files (so an
   * interrupted meeting can be retried), and mark the row FAILED. Never called
   * mid-processing.
   */
  abandonActive(): void {
    const id = this.activeMeetingId;
    if (!id) return;
    this.activeMeetingId = null;
    this.activeDiarization = true;
    this.activeLanguage = null;
    this.audio.finishMeeting();
    this.store.updateMeeting(id, {
      status: "FAILED",
      captureError: "Capture was interrupted before the meeting could be processed.",
    });
    this.emit(id);
  }

  /** Store a structured summary and/or action items for a meeting (local AI). */
  async setNotes(
    meetingId: string,
    options: { summary?: MeetingSyncSummary; actionItems?: MeetingSyncActionItem[] },
  ): Promise<void> {
    if (options.summary) {
      const existing = this.store.getMeeting(meetingId);
      this.store.updateMeeting(meetingId, {
        summaryDetails: JSON.stringify(options.summary),
        summary: options.summary.summary ?? existing?.summary ?? null,
      });
    }
    if (options.actionItems) this.store.setActionItems(meetingId, options.actionItems);
    await this.queue.enqueue(meetingId, buildSyncPayload(this.store, meetingId));
    this.emit(meetingId);
  }

  list(): LocalMeetingListItem[] {
    return this.store
      .listMeetings()
      .map((row) => this.toListItem(row.id) as LocalMeetingListItem);
  }

  get(id: string): LocalMeetingDetail | null {
    const row = this.store.getMeeting(id);
    if (!row) return null;
    const listItem = this.toListItem(id) as LocalMeetingListItem;
    const segments = this.store.listSegments(id).map(toSegmentDto);
    return { ...listItem, segments, summary: this.store.getSummaryDetails(id), actionItems: this.store.getActionItems(id) };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private recordingDir(id: string): string {
    return join(this.recordingsDir, id);
  }

  /**
   * Turn meetings that were interrupted mid-capture (crashes, force-quit) into
   * FAILED rows. Their temporary audio is preserved on disk - it is never
   * silently deleted - so the user can retry them.
   */
  private reconcileAbandoned(): void {
    for (const row of this.store.listMeetings()) {
      if (row.status === "STARTING" || row.status === "RECORDING") {
        const endedAt = this.now();
        const durationSeconds =
          row.startedAt !== null ? Math.max(0, Math.round((endedAt - row.startedAt) / 1000)) : 0;
        this.store.updateMeeting(row.id, {
          status: "FAILED",
          endedAt,
          durationSeconds,
          captureError: "Capture was interrupted before the meeting could be processed.",
        });
        this.emit(row.id);
      } else if (row.status === "PROCESSING") {
        // Interrupted mid-processing: transcription/analysis never finished.
        // The temporary audio is preserved on disk so the meeting can be retried.
        this.store.updateMeeting(row.id, {
          status: "FAILED",
          captureError: "Processing was interrupted before the meeting could be completed.",
        });
        this.emit(row.id);
      }
    }
  }

  /** Async capture failure (chunk write error). Audio is preserved on disk. */
  private onRecordingError(id: string, error: Error): void {
    if (this.activeMeetingId === id) {
      this.activeMeetingId = null;
      this.activeDiarization = true;
      this.activeLanguage = null;
    }
    const message = error instanceof Error ? error.message : "Audio capture failed during recording.";
    this.store.updateMeeting(id, { status: "FAILED", captureError: message });
    this.emit(id);
    this.sendProcess({ type: "failed", meetingId: id, error: { code: MEETING_ERROR_CODES.CAPTURE_FAILED, message } });
  }

  /**
   * Transcribe a finalized recording, persist the segments, run best-effort
   * analysis, queue the text for sync, then delete the temporary audio ONLY on
   * success. On transcription failure the audio stays on disk for retry.
   */
  private async processRecording(
    id: string,
    recording: RecordingResult,
    diarization: boolean,
    language: string | null,
    recordingDir: string,
  ): Promise<MeetingActionResult> {
    // 1. Transcribe the temporary recording (local Whisper engine).
    let segments: WhisperSegment[];
    try {
      const outcome = await this.whisper.transcribeRecording({
        sampleRate: recording.sampleRate,
        streams: recording.streams,
        diarization,
        language,
        onProgress: (fraction) => {
          const percent = Math.min(100, Math.max(0, Math.round(fraction * 100)));
          this.sendProcess({ type: "transcribing", meetingId: id, percent });
        },
      });
      segments = outcome.segments;
    } catch (error) {
      // The temporary audio is KEPT so the user can retry transcription.
      const message =
        error instanceof Error ? error.message : "Transcription of the meeting recording failed.";
      this.store.updateMeeting(id, { status: "FAILED", captureError: message });
      this.emit(id);
      this.sendProcess({ type: "failed", meetingId: id, error: { code: MEETING_ERROR_CODES.WHISPER_FAILED, message } });
      return fail(MEETING_ERROR_CODES.WHISPER_FAILED, message);
    }

    // 2. Persist the transcript and mark the meeting completed.
    if (segments.length > 0) {
      this.store.upsertSegments(
        id,
        segments.map((s): LocalSegmentInput => ({
          clientSegmentId: s.id,
          speaker: s.speaker,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
          confidence: s.confidence,
        })),
      );
    }
    this.store.updateMeeting(id, { status: "COMPLETED", captureError: null });
    this.emit(id);

    // 3. Best-effort local AI analysis (summary / action items). Failures are
    //    swallowed so the meeting still completes and syncs as text.
    if (this.analyze) {
      this.sendProcess({ type: "analyzing", meetingId: id });
      try {
        await this.analyze(id);
      } catch {
        // analysis is optional; the transcript itself is already saved
      }
    }

    // 4. Queue the full text snapshot for offline-first sync.
    this.store.updateMeeting(id, { status: "SYNC_PENDING" });
    this.emit(id);
    this.sendProcess({ type: "saving", meetingId: id });
    this.sendProcess({ type: "syncing", meetingId: id });
    let done: LocalMeetingListItem | null;
    try {
      await this.queue.enqueue(id, buildSyncPayload(this.store, id));
      done = this.toListItem(id);
    } catch (error) {
      // The transcript is preserved locally, but the sync snapshot could not
      // be queued; KEEP the temporary audio on disk so the meeting can be
      // retried instead of deleting audio that a failed job still needs.
      const message = error instanceof Error ? error.message : "Could not queue the meeting for sync.";
      this.store.updateMeeting(id, { status: "FAILED", captureError: message });
      this.emit(id);
      this.sendProcess({
        type: "failed",
        meetingId: id,
        error: { code: MEETING_ERROR_CODES.SYNC_FAILED, message },
      });
      return fail(MEETING_ERROR_CODES.SYNC_FAILED, message);
    }
    this.emit(id);

    // 5. Delete the temporary capture files - they have served their purpose.
    this.sendProcess({ type: "cleaning", meetingId: id });
    removeRecordingDir(recordingDir);
    if (done) this.sendProcess({ type: "complete", meeting: done });

    return ok(done);
  }

  private checkWhisperModel(): { error: MeetingActionResult | null } {
    const status: WhisperEngineStatus = this.whisper.status();
    if (status.state === "unavailable") {
      return {
        error: fail(
          MEETING_ERROR_CODES.ENGINE_UNAVAILABLE,
          status.error?.message ?? "The on-device transcription engine is unavailable.",
        ),
      };
    }
    const defaultModel = status.models.find((m) => m.isDefault);
    const usable = defaultModel && defaultModel.installed && !defaultModel.corrupt;
    if (!usable) {
      return {
        error: fail(
          MEETING_ERROR_CODES.WHISPER_MODEL_MISSING,
          "No Whisper model is installed yet. Download one in Settings → Whisper first.",
        ),
      };
    }
    return { error: null };
  }

  private toListItem(id: string): LocalMeetingListItem | null {
    const row = this.store.getMeeting(id);
    return row ? toMeetingListItem(this.store, row, this.recordingsDir) : null;
  }

  private emit(id: string): void {
    const item = this.toListItem(id);
    if (item) this.sendMeeting({ type: "updated", meeting: item });
  }
}

/** Persisted capture sources for a retry (falls back to mic-only). */
function parseSources(row: LocalMeetingRow): AudioCaptureKind[] {
  if (row.sources) {
    try {
      const parsed = JSON.parse(row.sources) as unknown;
      if (Array.isArray(parsed)) {
        const kinds = parsed.filter((k) => k === "microphone" || k === "loopback");
        if (kinds.length > 0) return kinds;
      }
    } catch {
      // fall through to the mic-only default
    }
  }
  return ["microphone"] as AudioCaptureKind[];
}

function toMeetingListItem(store: LocalStore, row: LocalMeetingRow, recordingsDir: string): LocalMeetingListItem {
  const queue = store.getQueueItem(row.id);
  let syncStatus: LocalMeetingListItem["syncStatus"];
  if (queue) {
    syncStatus = queue.state === "SYNC_FAILED" ? "SYNC_FAILED" : "PENDING_SYNC";
  } else if (row.status === "SYNCED") {
    syncStatus = "SYNCED";
  } else if (row.status === "SYNC_PENDING") {
    syncStatus = "PENDING_SYNC";
  } else {
    syncStatus = "IDLE";
  }
  return {
    id: row.id,
    title: row.title,
    templateId: row.templateId,
    startedAt: row.startedAt !== null ? new Date(row.startedAt).toISOString() : null,
    endedAt: row.endedAt !== null ? new Date(row.endedAt).toISOString() : null,
    durationSeconds: row.durationSeconds,
    status: row.status as MeetingStatus,
    segmentCount: store.countSegments(row.id),
    summaryPreview: row.summary,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    syncStatus,
    syncError: queue?.lastError ?? null,
    hasLocalRecording: hasRecordingDir(join(recordingsDir, row.id)),
    processingError: row.captureError,
  };
}

function toSegmentDto(row: LocalSegmentRow): LocalMeetingSegment {
  return {
    clientSegmentId: row.clientSegmentId,
    speaker: row.speaker,
    startMs: row.startMs,
    endMs: row.endMs,
    text: row.text,
    confidence: row.confidence,
    isEdited: row.isEdited === 1,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/** Build the idempotent full-snapshot sync payload for a local meeting. */
export function buildSyncPayload(store: LocalStore, meetingId: string): MeetingSyncRequest {
  const row = store.getMeeting(meetingId);
  if (!row) throw new Error(`missing local meeting ${meetingId}`);
  const segments = store.listSegments(meetingId).map((s) => ({
    clientSegmentId: s.clientSegmentId,
    speaker: s.speaker,
    startTime: new Date(s.startMs),
    endTime: new Date(s.endMs),
    text: s.text,
    confidence: s.confidence >= 0 ? s.confidence : undefined,
    isEdited: s.isEdited === 1,
  }));
  const summaryDetails = store.getSummaryDetails(meetingId);
  const actionItems = store.getActionItems(meetingId);
  const payload: MeetingSyncRequest = {
    clientMeetingId: meetingId,
    title: row.title,
    startedAt: new Date(row.startedAt ?? row.createdAt),
    durationSeconds: row.durationSeconds,
    status: serverStatus(row.status),
  };
  if (row.templateId) payload.templateId = row.templateId;
  if (row.endedAt !== null) payload.endedAt = new Date(row.endedAt);
  if (row.summary !== null) payload.summary = row.summary;
  if (segments.length > 0) payload.segments = segments;
  if (summaryDetails) payload.summaryDetails = summaryDetails;
  if (actionItems.length > 0) payload.actionItems = actionItems;
  return payload;
}

/** The backend stores the real lifecycle; syncing states are local-only. */
function serverStatus(local: string): MeetingStatus {
  if (local === "SYNC_PENDING" || local === "SYNCED") return "COMPLETED";
  return local as MeetingStatus;
}