/**
 * IPC contract between the Electron renderer, the preload bridge, and the main
 * process. The renderer never talks to the network directly: all authenticated
 * requests are proxied through the main process, which owns the session
 * cookie. Dates are serialized to ISO strings over the wire.
 */

import type {
  CreateMeetingRequest,
  MeetingSort,
  MeetingSummaryDto,
  TranscriptSegmentDto,
  UpdateMeetingRequest,
} from "./meetings.ts";
import type { MeetingStatus, UserRole, UserStatus } from "./enums.ts";
import type { AdminStats, AdminUserDetail, SerializedAdminUserListItem } from "./admin.ts";
import type { HealthResponse } from "./health.ts";
import type { ChangePasswordRequest, LoginRequest, RegisterRequest } from "./users.ts";
import type { CreateActionItemRequest, UpdateActionItemRequest } from "./action-items.ts";
import type { CreateTemplateRequest, UpdateTemplateRequest } from "./templates.ts";
import type { ExportFormat, ExportPayload } from "./export.ts";
import type {
  AudioCaptureKind,
  AudioInfoResponse,
  AudioMetersEvent,
  MicTestResult,
  RecordingStorageEstimate,
  RecordingUsage,
} from "./audio.ts";
import type {
  HardwareInfo,
  WhisperEngineStatus,
  WhisperModelId,
  WhisperDownloadProgress,
  WhisperTestResult,
} from "./transcription.ts";
import type {
  LocalMeetingDetail,
  LocalMeetingListItem,
  MeetingActionResult,
  MeetingEvent,
  MeetingProcessEvent,
  MeetingStartRequest,
  MeetingSyncActionItem,
  MeetingSyncSummary,
  SyncState,
} from "./sync.ts";
import type {
  LlmAnalysisOutcome,
  LlmDownloadProgress,
  LlmEngineStatus,
  LlmSetRuntimeRequest,
} from "./llm.ts";
import type {
  OverlayAction,
  OverlayEvent,
  OverlaySettingsUpdate,
  OverlayState,
} from "./overlay.ts";

/** Channel names - the only IPC surface the renderer can reach. */
export const IpcChannels = {
  APP_INFO: "callnotes:app-info",
  BACKEND_HEALTH: "callnotes:backend-health",
  API: "callnotes:api",
  AUDIO_INFO: "callnotes:audio-info",
  AUDIO_SELECT_MIC: "callnotes:audio-select-mic",
  AUDIO_MIC_TEST: "callnotes:audio-mic-test",
  AUDIO_MONITOR: "callnotes:audio-monitor",
  AUDIO_METERS: "callnotes:audio-meters",
  WHISPER_STATUS: "callnotes:whisper-status",
  WHISPER_DOWNLOAD: "callnotes:whisper-download",
  WHISPER_ABORT_DOWNLOAD: "callnotes:whisper-abort-download",
  WHISPER_DELETE: "callnotes:whisper-delete",
  WHISPER_SET_DEFAULT: "callnotes:whisper-set-default",
  WHISPER_HARDWARE: "callnotes:whisper-hardware",
  WHISPER_TEST: "callnotes:whisper-test",
  WHISPER_PROGRESS: "callnotes:whisper-progress",
  MEETING_START: "callnotes:meeting-start",
  MEETING_STOP: "callnotes:meeting-stop",
  MEETING_PAUSE: "callnotes:meeting-pause",
  MEETING_RESUME: "callnotes:meeting-resume",
  MEETING_STORAGE_ESTIMATE: "callnotes:meeting-storage-estimate",
  MEETING_RECORDING_USAGE: "callnotes:meeting-recording-usage",
  MEETING_RETRY: "callnotes:meeting-retry",
  MEETING_DISCARD_RECORDING: "callnotes:meeting-discard-recording",
  MEETING_LOCAL_LIST: "callnotes:meeting-local-list",
  MEETING_LOCAL_GET: "callnotes:meeting-local-get",
  MEETING_EVENT: "callnotes:meeting-event",
  MEETING_PROCESS: "callnotes:meeting-process",
  MEETING_SAVE_NOTES: "callnotes:meeting-save-notes",
  SYNC_STATUS: "callnotes:sync-status",
  SYNC_NOW: "callnotes:sync-now",
  SYNC_EVENT: "callnotes:sync-event",
  LLM_STATUS: "callnotes:llm-status",
  LLM_STATUS_EVENT: "callnotes:llm-status-event",
  LLM_SET_RUNTIME: "callnotes:llm-set-runtime",
  LLM_PULL: "callnotes:llm-pull",
  LLM_DELETE: "callnotes:llm-delete",
  LLM_SET_DEFAULT: "callnotes:llm-set-default",
  LLM_PROGRESS: "callnotes:llm-progress",
  LLM_ANALYZE: "callnotes:llm-analyze",
  UPDATE_STATUS: "callnotes:update-status",
  OVERLAY_STATE: "callnotes:overlay-state",
  OVERLAY_SETTINGS_UPDATE: "callnotes:overlay-settings-update",
  OVERLAY_ACTION: "callnotes:overlay-action",
  OVERLAY_EVENT: "callnotes:overlay-event",
} as const;

export interface AppInfoPayload {
  name: string;
  version: string;
  platform: string;
  arch: string;
  backendUrl: string;
}

/** Auto-update status pushed from main when an update feed is configured. */
export type UpdateStatusPayload =
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "downloading"; version?: string; percent?: number }
  | { phase: "ready" }
  | { phase: "error"; message: string };

/** Uniform result envelope returned for every API call. */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

/** Pagination params accepted by every list operation. */
export type ListParams = { page?: number; perPage?: number };

/** Extra filters available on the meeting list/search endpoint. */
export type MeetingListParams = ListParams & {
  q?: string;
  status?: MeetingStatus;
  templateId?: string;
  from?: string;
  to?: string;
  sort?: MeetingSort;
};

// ---------------------------------------------------------------------------
// Serialized DTOs (JSON-safe: all dates are ISO strings)
// ---------------------------------------------------------------------------

export interface SerializedUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface SerializedAuthResponse {
  user: SerializedUser;
  sessionExpiresAt: string;
}

export type SessionState =
  | { state: "anonymous" }
  | { state: "authenticated"; user: SerializedUser; sessionExpiresAt: string | null };

export interface SerializedMeetingListItem {
  id: string;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  status: MeetingStatus;
  templateId: string | null;
  templateName: string | null;
  summaryPreview: string | null;
  actionItemCount: number;
  createdAt: string;
}

export interface SerializedMeetingDto extends SerializedMeetingListItem {
  userId: string;
  summary: string | null;
  updatedAt: string;
}

export interface SerializedMeetingDetail {
  meeting: SerializedMeetingDto;
  segments: TranscriptSegmentDto[];
  summary: MeetingSummaryDto | null;
}

export interface SerializedTemplate {
  id: string;
  name: string;
  type: "SYSTEM" | "CUSTOM";
  description: string | null;
  schema: unknown;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `listTemplates` response: visible templates + the user's default template id. */
export interface SerializedTemplateList {
  items: SerializedTemplate[];
  defaultId: string | null;
}

export interface SerializedActionItem {
  id: string;
  meetingId: string | null;
  meetingTitle: string | null;
  description: string;
  assignee: string | null;
  dueDate: string | null;
  priority: "LOW" | "MEDIUM" | "HIGH";
  status: "OPEN" | "IN_PROGRESS" | "COMPLETED";
  sourceSegmentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedAdminMeetingListItem extends SerializedMeetingListItem {
  ownerEmail: string;
  ownerName: string;
}

export interface SerializedAuditLogItem {
  id: string;
  action: string;
  resource: string;
  resourceId: string | null;
  metadata: unknown;
  createdAt: string;
  actor: { id: string; email: string } | null;
}

// ---------------------------------------------------------------------------
// Page-shaped list responses
// ---------------------------------------------------------------------------

export interface MeetingListPage {
  items: SerializedMeetingListItem[];
  total: number;
  page: number;
  perPage: number;
}

export interface AdminUserPage {
  items: SerializedAdminUserListItem[];
  total: number;
  page: number;
  perPage: number;
}

export interface AdminMeetingPage {
  items: SerializedAdminMeetingListItem[];
  total: number;
  page: number;
  perPage: number;
}

export interface AuditLogPage {
  items: SerializedAuditLogItem[];
  total: number;
  page: number;
  perPage: number;
}

/** Operation names routed through the single `API` IPC channel. */
export const ApiOps = {
  REGISTER: "auth.register",
  LOGIN: "auth.login",
  SESSION: "auth.session",
  LOGOUT: "auth.logout",
  CHANGE_PASSWORD: "auth.password",
  LIST_MEETINGS: "meetings.list",
  CREATE_MEETING: "meetings.create",
  GET_MEETING: "meetings.get",
  UPDATE_MEETING: "meetings.update",
  DELETE_MEETING: "meetings.delete",
  EXPORT_MEETING: "meetings.export",
  LIST_TEMPLATES: "templates.list",
  CREATE_TEMPLATE: "templates.create",
  UPDATE_TEMPLATE: "templates.update",
  DELETE_TEMPLATE: "templates.delete",
  DUPLICATE_TEMPLATE: "templates.duplicate",
  SET_DEFAULT_TEMPLATE: "templates.default",
  LIST_ACTION_ITEMS: "action-items.list",
  CREATE_ACTION_ITEM: "action-items.create",
  UPDATE_ACTION_ITEM: "action-items.update",
  DELETE_ACTION_ITEM: "action-items.delete",
  ADMIN_USERS_LIST: "admin.users.list",
  ADMIN_USER_STATUS: "admin.user.status",
  ADMIN_USER_ROLE: "admin.user.role",
  ADMIN_MEETINGS_LIST: "admin.meetings.list",
  ADMIN_AUDIT_LOGS_LIST: "admin.audit-logs.list",
  ADMIN_STATS: "admin.stats",
  ADMIN_USER_DETAIL: "admin.user.detail",
} as const;

export type ApiOp = (typeof ApiOps)[keyof typeof ApiOps];

/** Shape of the request body sent over the `API` channel. */
export interface ApiInvocation {
  op: ApiOp;
  args: unknown[];
}

// ---------------------------------------------------------------------------
// The typed API surface the preload bridge exposes to React.
// ---------------------------------------------------------------------------

export interface DesktopApi {
  register(input: RegisterRequest): Promise<ApiResult<SerializedAuthResponse>>;
  login(input: LoginRequest): Promise<ApiResult<SerializedAuthResponse>>;
  logout(): Promise<ApiResult<{ ok: boolean }>>;
  session(): Promise<ApiResult<SessionState>>;
  changePassword(input: ChangePasswordRequest): Promise<ApiResult<{ ok: boolean }>>;

  listMeetings(params?: MeetingListParams): Promise<ApiResult<MeetingListPage>>;
  createMeeting(input: CreateMeetingRequest): Promise<ApiResult<SerializedMeetingDto>>;
  getMeeting(id: string): Promise<ApiResult<SerializedMeetingDetail>>;
  updateMeeting(id: string, input: UpdateMeetingRequest): Promise<ApiResult<SerializedMeetingDto>>;
  deleteMeeting(id: string): Promise<ApiResult<{ ok: boolean }>>;
  exportMeeting(id: string, format: ExportFormat): Promise<ApiResult<ExportPayload>>;

  listTemplates(): Promise<ApiResult<SerializedTemplateList>>;
  createTemplate(input: CreateTemplateRequest): Promise<ApiResult<SerializedTemplate>>;
  updateTemplate(id: string, input: UpdateTemplateRequest): Promise<ApiResult<SerializedTemplate>>;
  deleteTemplate(id: string): Promise<ApiResult<{ ok: boolean }>>;
  duplicateTemplate(id: string): Promise<ApiResult<SerializedTemplate>>;
  setDefaultTemplate(templateId: string | null): Promise<ApiResult<{ ok: boolean }>>;

  listActionItems(): Promise<ApiResult<SerializedActionItem[]>>;
  createActionItem(input: CreateActionItemRequest): Promise<ApiResult<SerializedActionItem>>;
  updateActionItem(id: string, input: UpdateActionItemRequest): Promise<ApiResult<SerializedActionItem>>;
  deleteActionItem(id: string): Promise<ApiResult<{ ok: boolean }>>;

  adminListUsers(params?: ListParams): Promise<ApiResult<AdminUserPage>>;
  adminUpdateUserStatus(id: string, status: UserStatus): Promise<ApiResult<{ ok: boolean }>>;
  adminUpdateUserRole(id: string, role: UserRole): Promise<ApiResult<{ ok: boolean }>>;
  adminListMeetings(params?: ListParams): Promise<ApiResult<AdminMeetingPage>>;
  adminListAuditLogs(params?: ListParams): Promise<ApiResult<AuditLogPage>>;
  adminStats(): Promise<ApiResult<AdminStats>>;
  adminGetUserDetail(id: string): Promise<ApiResult<AdminUserDetail>>;
}

/**
 * The complete object exposed as `window.callnotes` in the renderer. Declared
 * here (rather than inside the preload) so the renderer type-checks without
 * ever pulling Electron's types into its program.
 */
export interface CallNotesBridge extends DesktopApi {
  appInfo(): Promise<AppInfoPayload>;
  backendHealth(): Promise<{ ok: boolean; health: HealthResponse | null }>;

  /** Current microphone + system-audio availability and devices. */
  audioInfo(): Promise<AudioInfoResponse>;

  /** Persist the user's chosen microphone (null = OS default). */
  audioSelectMic(deviceId: string | null): Promise<AudioInfoResponse>;

  /** Run a short live mic test; measures real samples in memory. */
  audioMicTest(deviceId: string | null): Promise<MicTestResult>;

  /** Start/stop live level monitoring (meters flow via onAudioMeters). */
  audioMonitorStart(): Promise<AudioInfoResponse>;
  audioMonitorStop(): Promise<void>;

  /** Subscribe to live level meters; returns an unsubscribe function. */
  onAudioMeters(listener: (event: AudioMetersEvent) => void): () => void;

  // -------------------------------------------------------------------------
  // Local whisper.cpp transcription (on-device, offline, no cloud fallback)
  // -------------------------------------------------------------------------

  /** Engine + installed-model status. */
  whisperStatus(): Promise<WhisperEngineStatus>;

  /** Download + verify a model (progress flows via onWhisperProgress). */
  whisperDownload(modelId: WhisperModelId): Promise<WhisperEngineStatus>;

  /** Cancel an in-flight model download (partial file is discarded). */
  whisperAbortDownload(): Promise<void>;

  /** Delete a downloaded model (the default model cannot be deleted). */
  whisperDelete(modelId: WhisperModelId): Promise<WhisperEngineStatus>;

  /** Mark a model as the one used for transcription. */
  whisperSetDefault(modelId: WhisperModelId): Promise<WhisperEngineStatus>;

  /** CPU/RAM/GPU detection + recommended model. */
  whisperHardware(): Promise<HardwareInfo>;

  /** Transcribe a short generated/silence probe to verify the engine. */
  whisperTest(): Promise<WhisperTestResult>;

  /** Subscribe to model download progress; returns an unsubscribe function. */
  onWhisperProgress(listener: (event: WhisperDownloadProgress) => void): () => void;

  /** Subscribe to engine status pushes (busy/ready, downloads finishing). */
  onWhisperStatus(listener: (status: WhisperEngineStatus) => void): () => void;

  // -------------------------------------------------------------------------
  // Offline-first meeting lifecycle + synchronization (SQLite in main)
  // -------------------------------------------------------------------------

  /**
   * Start a meeting recording: validates mic / system audio / Whisper model,
   * creates the local meeting row, and captures the chosen sources into
   * temporary on-device audio files. No transcription runs while recording -
   * it happens after the meeting stops. Works fully offline.
   */
  meetingStart(input: MeetingStartRequest): Promise<MeetingActionResult>;

  /**
   * Stop the active session, then transcribe the recorded audio with the local
   * Whisper engine, run local AI analysis (best-effort), save the transcript
   * and notes, queue the text for sync, and delete the temporary audio files.
   * Resolves when processing finishes; progress flows via onMeetingProcess.
   * If processing fails the temporary audio is preserved so it can be retried.
   */
  meetingStop(): Promise<MeetingActionResult>;

  /**
   * Pause/resume writing the current meeting's audio to disk. Capture and the
   * live meters keep running so devices stay warm; frames are dropped while
   * paused and the timeline excludes the paused interval.
   */
  meetingPause(): Promise<MeetingActionResult>;
  meetingResume(): Promise<MeetingActionResult>;

  /**
   * Project temporary disk usage for a meeting of the given sources before it
   * starts. Used to show expected storage and warn about low free space.
   */
  meetingStorageEstimate(
    sources: AudioCaptureKind[],
    maxDurationSeconds?: number,
  ): Promise<RecordingStorageEstimate>;

  /**
   * Live temporary-storage usage of the in-progress meeting capture (real
   * bytes written by the chunk writers), or null when nothing is recording.
   */
  meetingRecordingUsage(): Promise<RecordingUsage | null>;

  /**
   * Re-run transcription + analysis for a FAILED meeting whose temporary audio
   * is still on disk (the recording is deleted only once it succeeds).
   */
  meetingRetry(meetingId: string): Promise<MeetingActionResult>;

  /**
   * Explicitly delete the preserved temporary audio of a FAILED meeting. The
   * meeting row (and any transcript text saved so far) stays in the local
   * database.
   */
  meetingDiscardRecording(meetingId: string): Promise<MeetingActionResult>;

  /** Meetings stored locally (including ones not yet synced to the backend). */
  meetingListLocal(): Promise<LocalMeetingListItem[]>;

  /** Full local meeting (metadata + transcript + notes) for a local id. */
  meetingGetLocal(id: string): Promise<LocalMeetingDetail | null>;

  /** Subscribe to local meeting updates; returns an unsubscribe function. */
  onMeetingEvent(listener: (event: MeetingEvent) => void): () => void;

  /** Subscribe to post-meeting processing progress (transcribe -> clean). */
  onMeetingProcess(listener: (event: MeetingProcessEvent) => void): () => void;

  /** Current sync state (Offline / Pending / Syncing / Synced / Failed). */
  syncStatus(): Promise<SyncState>;

  /** Trigger an immediate sync of everything queued. */
  syncNow(): Promise<SyncState>;

  /** Subscribe to sync-state pushes; returns an unsubscribe function. */
  onSyncEvent(listener: (state: SyncState) => void): () => void;

  // -------------------------------------------------------------------------
  // Local AI meeting analysis (Ollama / llama.cpp, everything on-device)
  // -------------------------------------------------------------------------

  /** Runtime + model status (connectivity, installed models, default). */
  llmStatus(): Promise<LlmEngineStatus>;

  /** Switch runtime/endpoint and rescan available models. */
  llmSetRuntime(input: LlmSetRuntimeRequest): Promise<LlmEngineStatus>;

  /** Download a model via the runtime. Only ever triggered by the user. */
  llmPull(modelId: string): Promise<LlmEngineStatus>;

  /** Delete an installed model (the default model cannot be deleted). */
  llmDelete(modelId: string): Promise<LlmEngineStatus>;

  /** Mark a model as the one used for meeting analysis. */
  llmSetDefault(modelId: string): Promise<LlmEngineStatus>;

  /**
   * Analyze the transcript of a locally-recorded meeting with the local LLM,
   * validate the structured JSON, save it, and return the refreshed meeting.
   * Requires internet-free local runtime only; never uploads transcript audio.
   */
  llmAnalyzeMeeting(meetingId: string): Promise<LlmAnalysisOutcome>;

  /** Persist manually-edited / generated summary + action items locally. */
  meetingSaveNotes(
    meetingId: string,
    notes: { summary?: MeetingSyncSummary; actionItems?: MeetingSyncActionItem[] },
  ): Promise<{ ok: boolean; error: { code: string; message: string } | null }>;

  /** Subscribe to model download progress; returns an unsubscribe function. */
  onLlmProgress(listener: (event: LlmDownloadProgress) => void): () => void;

  /** Subscribe to engine status pushes (connectivity, downloads finishing). */
  onLlmStatus(listener: (status: LlmEngineStatus) => void): () => void;

  /** Subscribe to auto-update status (only emitted when a feed is configured). */
  onUpdateStatus(listener: (status: UpdateStatusPayload) => void): () => void;

  // -------------------------------------------------------------------------
  // Flying "CallNotes AI assistant" overlay
  // -------------------------------------------------------------------------

  /** Current overlay settings + flags (enabled state, consent, detection). */
  overlayState(): Promise<OverlayState>;

  /**
   * Persist overlay preferences. Only the whitelisted fields in
   * OverlaySettingsUpdate are accepted; returns the refreshed snapshot.
   */
  overlayUpdateSettings(patch: OverlaySettingsUpdate): Promise<OverlayState>;

  /** Issue an overlay action (start meeting, snooze, disable, open app...). */
  overlayAction(action: OverlayAction): Promise<{ ok: boolean; error: string | null }>;

  /**
   * Events pushed to the main renderer when the overlay triggers app work
   * (a meeting that just started, or navigation). Returns an unsubscribe fn.
   */
  onOverlayEvent(listener: (event: OverlayEvent) => void): () => void;
}