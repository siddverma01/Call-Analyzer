import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AudioCaptureKind,
  MeetingStatus,
  MeetingSyncActionItem,
  MeetingSyncSummary,
} from "@callnotes/shared";

/**
 * Local SQLite repository for the offline-first meeting flow. Lives in the
 * Electron main process at `userData/callnotes.db`. Stores meeting metadata,
 * transcript segments, local notes, and the sync queue. Raw audio is never
 * persisted here - it exists only as temporary capture files that are deleted
 * after transcription.
 *
 * Column values use epoch-milliseconds for timestamps and JSON strings for the
 * structured summary/action-item payloads (small, versioned, schema-free).
 */

export interface LocalMeetingRow {
  id: string;
  title: string;
  templateId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationSeconds: number;
  status: string;
  summary: string | null;
  summaryDetails: string | null;
  actionItems: string | null;
  /** JSON array of the capture sources selected for this meeting. */
  sources: string | null;
  /** 1 when transcription ran in speaker-diarization mode (1 = on). */
  diarization: number;
  /** Whisper language code captured at transcription time (when known). */
  language: string | null;
  /** Last capture/processing error message (kept for failed meetings). */
  captureError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LocalSegmentRow {
  meetingId: string;
  clientSegmentId: string;
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  isEdited: number;
  createdAt: number;
}

export interface LocalQueueRow {
  meetingId: string;
  payload: string;
  state: string;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LocalSegmentInput {
  clientSegmentId: string;
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  isEdited?: boolean;
}

export class LocalStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, private readonly now: () => number = Date.now) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Meetings
  // -------------------------------------------------------------------------

  createMeeting(input: {
    id: string;
    title: string;
    templateId: string | null;
    status: MeetingStatus;
    startedAt: number | null;
    sources?: AudioCaptureKind[];
    diarization?: boolean;
    language?: string | null;
  }): LocalMeetingRow {
    const createdAt = this.now();
    this.db
      .prepare(
        `INSERT INTO meetings (id, title, template_id, started_at, ended_at, duration_seconds, status, summary, summary_details, action_items, sources, diarization, language, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        input.templateId,
        input.startedAt,
        null,
        0,
        input.status,
        null,
        null,
        null,
        JSON.stringify(input.sources ?? []),
        input.diarization ? 1 : 0,
        input.language ?? null,
        createdAt,
        createdAt,
      );
    return this.getMeeting(input.id)!;
  }

  updateMeeting(
    id: string,
    patch: Partial<{
      title: string;
      templateId: string | null;
      status: MeetingStatus;
      endedAt: number | null;
      durationSeconds: number;
      summary: string | null;
      summaryDetails: string | null;
      actionItems: string | null;
      sources: AudioCaptureKind[];
      diarization: boolean;
      language: string | null;
      captureError: string | null;
    }>,
  ): LocalMeetingRow | null {
    const existing = this.getMeeting(id);
    if (!existing) return null;
    const merged: Required<typeof patch> = {
      title: patch.title ?? existing.title,
      templateId: patch.templateId !== undefined ? patch.templateId : existing.templateId,
      status: patch.status ?? (existing.status as MeetingStatus),
      endedAt: patch.endedAt !== undefined ? patch.endedAt : existing.endedAt,
      durationSeconds: patch.durationSeconds ?? existing.durationSeconds,
      summary: patch.summary !== undefined ? patch.summary : existing.summary,
      summaryDetails: patch.summaryDetails !== undefined ? patch.summaryDetails : existing.summaryDetails,
      actionItems: patch.actionItems !== undefined ? patch.actionItems : existing.actionItems,
      sources: patch.sources ?? (existing.sources ? (JSON.parse(existing.sources) as AudioCaptureKind[]) : []),
      diarization: patch.diarization ?? existing.diarization === 1,
      language: patch.language !== undefined ? patch.language : existing.language,
      captureError: patch.captureError !== undefined ? patch.captureError : existing.captureError,
    };
    this.db
      .prepare(
        `UPDATE meetings
         SET title = ?, template_id = ?, status = ?, ended_at = ?, duration_seconds = ?, summary = ?,
             summary_details = ?, action_items = ?, sources = ?, diarization = ?, language = ?, capture_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.title,
        merged.templateId,
        merged.status,
        merged.endedAt,
        merged.durationSeconds,
        merged.summary,
        merged.summaryDetails,
        merged.actionItems,
        JSON.stringify(merged.sources),
        merged.diarization ? 1 : 0,
        merged.language,
        merged.captureError,
        this.now(),
        id,
      );
    return this.getMeeting(id);
  }

  touchMeeting(id: string): void {
    this.db.prepare("UPDATE meetings SET updated_at = ? WHERE id = ?").run(this.now(), id);
  }

  getMeeting(id: string): LocalMeetingRow | null {
    const row = this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(id);
    return row ? this.toMeetingRow(row) : null;
  }

  listMeetings(): LocalMeetingRow[] {
    return (this.db.prepare("SELECT * FROM meetings ORDER BY created_at DESC").all()).map(
      (row) => this.toMeetingRow(row),
    );
  }

  deleteMeeting(id: string): void {
    this.db.prepare("DELETE FROM segments WHERE meeting_id = ?").run(id);
    this.db.prepare("DELETE FROM notes WHERE meeting_id = ?").run(id);
    this.db.prepare("DELETE FROM sync_queue WHERE meeting_id = ?").run(id);
    this.db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
  }

  // -------------------------------------------------------------------------
  // Transcript segments
  // -------------------------------------------------------------------------

  upsertSegments(meetingId: string, segments: LocalSegmentInput[]): void {
    if (segments.length === 0) return;
    const createdAt = this.now();
    const stmt = this.db.prepare(
      `INSERT INTO segments (meeting_id, client_segment_id, speaker, start_ms, end_ms, text, confidence, is_edited, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (meeting_id, client_segment_id) DO UPDATE SET
         speaker = excluded.speaker,
         start_ms = excluded.start_ms,
         end_ms = excluded.end_ms,
         text = excluded.text,
         confidence = excluded.confidence,
         is_edited = excluded.is_edited`,
    );
    for (const segment of segments) {
      stmt.run(
        meetingId,
        segment.clientSegmentId,
        segment.speaker,
        segment.startMs,
        segment.endMs,
        segment.text,
        segment.confidence,
        segment.isEdited ? 1 : 0,
        createdAt,
      );
    }
  }

  listSegments(meetingId: string): LocalSegmentRow[] {
    return (
      this.db
        .prepare("SELECT * FROM segments WHERE meeting_id = ? ORDER BY start_ms ASC")
        .all(meetingId)
    ).map((row) => this.toSegmentRow(row));
  }

  countSegments(meetingId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM segments WHERE meeting_id = ?")
      .get(meetingId) as { n: number };
    return Number(row.n);
  }

  /** Drop a meeting's transcript segments (e.g. before re-transcribing). */
  clearSegments(meetingId: string): void {
    this.db.prepare("DELETE FROM segments WHERE meeting_id = ?").run(meetingId);
  }

  // -------------------------------------------------------------------------
  // Local notes
  // -------------------------------------------------------------------------

  appendNote(meetingId: string, content: string): void {
    this.db
      .prepare("INSERT INTO notes (meeting_id, content, created_at) VALUES (?, ?, ?)")
      .run(meetingId, content, this.now());
  }

  // -------------------------------------------------------------------------
  // Structured summary + action items
  // -------------------------------------------------------------------------

  setSummaryDetails(meetingId: string, summary: MeetingSyncSummary): void {
    const existing = this.getMeeting(meetingId);
    if (!existing) return;
    this.updateMeeting(meetingId, { summaryDetails: JSON.stringify(summary) });
  }

  getSummaryDetails(meetingId: string): MeetingSyncSummary | null {
    const row = this.getMeeting(meetingId);
    if (!row?.summaryDetails) return null;
    try {
      return JSON.parse(row.summaryDetails) as MeetingSyncSummary;
    } catch {
      return null;
    }
  }

  setActionItems(meetingId: string, items: MeetingSyncActionItem[]): void {
    this.updateMeeting(meetingId, { actionItems: JSON.stringify(items) });
  }

  getActionItems(meetingId: string): MeetingSyncActionItem[] {
    const row = this.getMeeting(meetingId);
    if (!row?.actionItems) return [];
    try {
      return JSON.parse(row.actionItems) as MeetingSyncActionItem[];
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Sync queue (one payload per meeting; re-enqueue replaces the old one)
  // -------------------------------------------------------------------------

  enqueueSync(meetingId: string, payload: string): void {
    const existing = this.getQueueItem(meetingId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE sync_queue SET payload = ?, state = 'PENDING_SYNC', attempts = 0, next_attempt_at = NULL,
           last_error = NULL, updated_at = ? WHERE meeting_id = ?`,
        )
        .run(payload, this.now(), meetingId);
    } else {
      this.db
        .prepare(
          `INSERT INTO sync_queue (meeting_id, payload, state, attempts, next_attempt_at, last_error, created_at, updated_at)
           VALUES (?, ?, 'PENDING_SYNC', 0, NULL, NULL, ?, ?)`,
        )
        .run(meetingId, payload, this.now(), this.now());
    }
  }

  getQueueItem(meetingId: string): LocalQueueRow | null {
  const row = this.db
    .prepare("SELECT * FROM sync_queue WHERE meeting_id = ?")
    .get(meetingId);
  return row ? this.toQueueRow(row) : null;
}

listQueueItems(): LocalQueueRow[] {
  return (this.db.prepare("SELECT * FROM sync_queue ORDER BY created_at ASC").all()).map(
    (row) => this.toQueueRow(row),
  );
}

  deleteQueueItem(meetingId: string): void {
    this.db.prepare("DELETE FROM sync_queue WHERE meeting_id = ?").run(meetingId);
  }

  markQueueFailed(meetingId: string, lastError: string, nextAttemptAt: number, attempts?: number): void {
    if (attempts !== undefined) {
      this.db
        .prepare(
          "UPDATE sync_queue SET state = 'SYNC_FAILED', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE meeting_id = ?",
        )
        .run(attempts, nextAttemptAt, lastError, this.now(), meetingId);
    } else {
      this.db
        .prepare(
          "UPDATE sync_queue SET state = 'SYNC_FAILED', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE meeting_id = ?",
        )
        .run(nextAttemptAt, lastError, this.now(), meetingId);
    }
  }

  /** Meetings waiting to be pushed (pending or failed, retry time reached). */
  listDueSyncs(): LocalQueueRow[] {
    const now = this.now();
    return (
      this.db
        .prepare(
          "SELECT * FROM sync_queue WHERE next_attempt_at IS NULL OR next_attempt_at <= ? ORDER BY created_at ASC",
        )
        .all(now)
    ).map((row) => this.toQueueRow(row));
  }

  pendingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sync_queue").get() as { n: number };
    return Number(row.n);
  }

  // -------------------------------------------------------------------------
  // Row mappers (node:sqlite returns snake_case column keys)
  // -------------------------------------------------------------------------

  private toMeetingRow(row: Record<string, SQLOutputValue>): LocalMeetingRow {
    return {
      id: String(row.id),
      title: String(row.title),
      templateId: row.template_id == null ? null : String(row.template_id),
      startedAt: row.started_at == null ? null : Number(row.started_at),
      endedAt: row.ended_at == null ? null : Number(row.ended_at),
      durationSeconds: Number(row.duration_seconds),
      status: String(row.status),
      summary: row.summary == null ? null : String(row.summary),
      summaryDetails: row.summary_details == null ? null : String(row.summary_details),
      actionItems: row.action_items == null ? null : String(row.action_items),
      sources: row.sources == null ? null : String(row.sources),
      diarization: Number(row.diarization),
      language: row.language == null ? null : String(row.language),
      captureError: row.capture_error == null ? null : String(row.capture_error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private toSegmentRow(row: Record<string, SQLOutputValue>): LocalSegmentRow {
    return {
      meetingId: String(row.meeting_id),
      clientSegmentId: String(row.client_segment_id),
      speaker: String(row.speaker),
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      text: String(row.text),
      confidence: Number(row.confidence),
      isEdited: Number(row.is_edited),
      createdAt: Number(row.created_at),
    };
  }

  private toQueueRow(row: Record<string, SQLOutputValue>): LocalQueueRow {
    return {
      meetingId: String(row.meeting_id),
      payload: String(row.payload),
      state: String(row.state),
      attempts: Number(row.attempts),
      nextAttemptAt: row.next_attempt_at == null ? null : Number(row.next_attempt_at),
      lastError: row.last_error == null ? null : String(row.last_error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        template_id TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        summary TEXT,
        summary_details TEXT,
        action_items TEXT,
        sources TEXT,
        diarization INTEGER NOT NULL DEFAULT 0,
        language TEXT,
        capture_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS segments (
        meeting_id TEXT NOT NULL,
        client_segment_id TEXT NOT NULL,
        speaker TEXT NOT NULL DEFAULT 'Speaker 1',
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        text TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT -1,
        is_edited INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (meeting_id, client_segment_id)
      );

      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_queue (
        meeting_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'PENDING_SYNC',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_segments_meeting ON segments (meeting_id, start_ms);
      CREATE INDEX IF NOT EXISTS idx_queue_created ON sync_queue (created_at);
    `);
    this.ensureColumn("meetings", "sources", "TEXT");
    this.ensureColumn("meetings", "diarization", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("meetings", "language", "TEXT");
    this.ensureColumn("meetings", "capture_error", "TEXT");
  }

  /** Add a column to an existing table when it is missing (schema migration). */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((col) => col.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}