/**
 * Offline-first meeting synchronization contract shared by the renderer, the
 * preload bridge, the Electron main process, and the backend.
 *
 * Meetings recorded offline are stored in a local SQLite database inside the
 * desktop main process and queued for sync. Only text data ever syncs (meeting
 * metadata, transcript segments, notes, action items, summaries). Raw audio
 * exists only as temporary on-device files that are captured during the
 * meeting and deleted after transcription; it never leaves the machine. Every
 * payload carries the clientMeetingId / clientSegmentId / clientItemId
 * generated on the device, so re-delivering the same payload is idempotent.
 */

import { z } from "zod";
import { ACTION_ITEM_STATUSES, MEETING_STATUSES, PRIORITIES } from "./enums.ts";
import type { AudioCaptureKind } from "./audio.ts";
import type { MeetingStatus } from "./enums.ts";

/** Sync states surfaced in the UI. */
export const SYNC_STATUSES = ["OFFLINE", "IDLE", "PENDING_SYNC", "SYNCING", "SYNCED", "SYNC_FAILED"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export interface SyncState {
  status: SyncStatus;
  /** Meetings currently backed up in the local queue (pending or failed). */
  pendingCount: number;
  /** Local meeting id currently being synced, if any. */
  syncingMeetingId: string | null;
  /** Last sync failure message when status is SYNC_FAILED, else null. */
  lastError: string | null;
  /** ISO timestamp of the last completed sync (any batch outcome). */
  lastSyncedAt: string | null;
}

/** Failure codes surfaced by the meeting lifecycle / sync queue. */
export const MEETING_ERROR_CODES = {
  MIC_UNAVAILABLE: "meeting.mic-unavailable",
  SYSTEM_AUDIO_UNAVAILABLE: "meeting.system-audio-unavailable",
  ENGINE_UNAVAILABLE: "meeting.engine-unavailable",
  WHISPER_MODEL_MISSING: "meeting.whisper-model-missing",
  SESSION_ACTIVE: "meeting.session-active",
  NO_ACTIVE_SESSION: "meeting.no-active-session",
  WHISPER_FAILED: "meeting.whisper-failed",
  CAPTURE_FAILED: "meeting.capture-failed",
  INSUFFICIENT_DISK: "meeting.insufficient-disk",
  NO_RECORDING: "meeting.no-recording",
  ANALYSIS_FAILED: "meeting.analysis-failed",
  LOCAL_DB_ERROR: "meeting.db-error",
  SYNC_FAILED: "meeting.sync-failed",
} as const;

// ---------------------------------------------------------------------------
// Meeting lifecycle (local recording)
// ---------------------------------------------------------------------------

export interface MeetingStartRequest {
  title?: string;
  templateId?: string;
  sources: AudioCaptureKind[];
  diarization: boolean;
  language?: string | null;
}

export interface MeetingActionResult {
  ok: boolean;
  /** Present when start/stop succeeded or a session was already running. */
  meeting: LocalMeetingListItem | null;
  error: { code: string; message: string } | null;
}

export interface MeetingEvent {
  type: "updated";
  meeting: LocalMeetingListItem;
}

/**
 * Progress pushed while a finished meeting is being processed in the main
 * process: post-meeting transcription -> local AI analysis -> save -> sync ->
 * temporary-audio cleanup. The renderer uses it to show the "processing"
 * screen after the user stops a meeting.
 */
export type MeetingProcessEvent =
  | { type: "processing"; meeting: LocalMeetingListItem }
  | { type: "finalizing"; meetingId: string }
  | { type: "transcribing"; meetingId: string; percent: number }
  | { type: "analyzing"; meetingId: string }
  | { type: "saving"; meetingId: string }
  | { type: "syncing"; meetingId: string }
  | { type: "cleaning"; meetingId: string }
  | { type: "complete"; meeting: LocalMeetingListItem }
  | { type: "failed"; meetingId: string; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Local meeting records (SQLite -> IPC serialization)
// ---------------------------------------------------------------------------

export interface LocalMeetingSegment {
  clientSegmentId: string;
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
  /** Mean token probability (0..1); -1 when unavailable. */
  confidence: number;
  isEdited: boolean;
  createdAt: string;
}

export interface LocalMeetingListItem {
  /** clientMeetingId - stable across devices, the idempotency key. */
  id: string;
  title: string;
  templateId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  status: MeetingStatus;
  segmentCount: number;
  summaryPreview: string | null;
  createdAt: string;
  updatedAt: string;
  /** Derived from the presence of a queued sync payload. */
  syncStatus: SyncStatus;
  syncError: string | null;
  /**
   * True while the temporary capture files for this meeting are still on disk
   * (capture in progress, waiting to be processed, or preserved after a failed
   * processing run so the user can retry). False after clean-up.
   */
  hasLocalRecording: boolean;
  /** Last capture/processing error message, kept for failed meetings. */
  processingError: string | null;
}

export interface LocalMeetingDetail extends LocalMeetingListItem {
  segments: LocalMeetingSegment[];
  summary: MeetingSyncSummary | null;
  actionItems: MeetingSyncActionItem[];
}

// ---------------------------------------------------------------------------
// Sync payload (one request per meeting, full current snapshot)
// ---------------------------------------------------------------------------

export const meetingSyncSegmentSchema = z.object({
  clientSegmentId: z.string().min(1).max(80),
  speaker: z.string().min(1).max(120).optional(),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  text: z.string(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  isEdited: z.boolean().optional(),
});

export type MeetingSyncSegment = z.infer<typeof meetingSyncSegmentSchema>;

export const meetingSyncActionItemSchema = z.object({
  clientItemId: z.string().min(1).max(80).optional(),
  description: z.string().min(1).max(100_000),
  assignee: z.string().max(120).nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(ACTION_ITEM_STATUSES).optional(),
  /** Transcript segment this item was derived from (local client segment id). */
  sourceSegmentId: z.string().max(80).nullable().optional(),
});

export type MeetingSyncActionItem = z.infer<typeof meetingSyncActionItemSchema>;

export const meetingSyncSummarySchema = z.object({
  summary: z.string().min(1),
  discussionPoints: z.unknown().nullable().optional(),
  decisions: z.unknown().nullable().optional(),
  risks: z.unknown().nullable().optional(),
  openQuestions: z.unknown().nullable().optional(),
  blockers: z.unknown().nullable().optional(),
  followUps: z.unknown().nullable().optional(),
  importantDates: z.unknown().nullable().optional(),
  participants: z.unknown().nullable().optional(),
  aiModel: z.string().max(200).nullable().optional(),
  aiProvider: z.string().max(120).nullable().optional(),
});

export type MeetingSyncSummary = z.infer<typeof meetingSyncSummarySchema>;

export const meetingSyncRequestSchema = z.object({
  clientMeetingId: z.string().min(1).max(80),
  title: z.string().min(1).max(200).optional(),
  templateId: z.string().min(1).optional(),
  startedAt: z.coerce.date().optional(),
  endedAt: z.coerce.date().nullable().optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  status: z.enum(MEETING_STATUSES).optional(),
  summary: z.string().max(100_000).nullable().optional(),
  segments: z.array(meetingSyncSegmentSchema).max(50_000).optional(),
  summaryDetails: meetingSyncSummarySchema.optional(),
  actionItems: z.array(meetingSyncActionItemSchema).max(5_000).optional(),
}).strict();

export type MeetingSyncRequest = z.infer<typeof meetingSyncRequestSchema>;