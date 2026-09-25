import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import {
  ApiOps,
  IpcChannels,
  type ApiInvocation,
  type ApiResult,
  type AppInfoPayload,
  type AudioCaptureKind,
  type AudioInfoResponse,
  type AudioMetersEvent,
  type CallNotesBridge,
  type DesktopApi,
  type HardwareInfo,
  type HealthResponse,
  type LlmAnalysisOutcome,
  type LlmDownloadProgress,
  type LlmEngineStatus,
  type LlmSetRuntimeRequest,
  type LocalMeetingDetail,
  type LocalMeetingListItem,
  type MeetingActionResult,
  type MeetingEvent,
  type MeetingProcessEvent,
  type MeetingStartRequest,
  type MeetingSyncActionItem,
  type MeetingSyncSummary,
  type MicTestResult,
  type OverlayAction,
  type OverlayEvent,
  type OverlaySettingsUpdate,
  type OverlayState,
  type RecordingStorageEstimate,
  type RecordingUsage,
  type SyncState,
  type UpdateStatusPayload,
  type WhisperDownloadProgress,
  type WhisperEngineStatus,
  type WhisperModelId,
  type WhisperTestResult,
} from "@callnotes/shared";

function invoke<T>(op: ApiInvocation["op"], ...args: unknown[]): Promise<ApiResult<T>> {
  const invocation: ApiInvocation = { op, args };
  return ipcRenderer.invoke(IpcChannels.API, invocation) as Promise<ApiResult<T>>;
}

/**
 * Typed bridge between the sandboxed renderer and the main process. The
 * renderer can only reach the operations declared here; it never touches Node
 * APIs or the network directly - every request is proxied through main, which
 * owns the session cookie.
 */
const api: DesktopApi = {
  register: (input) => invoke(ApiOps.REGISTER, input),
  login: (input) => invoke(ApiOps.LOGIN, input),
  session: () => invoke(ApiOps.SESSION),
  logout: () => invoke(ApiOps.LOGOUT),
  changePassword: (input) => invoke(ApiOps.CHANGE_PASSWORD, input),

  listMeetings: (params) => invoke(ApiOps.LIST_MEETINGS, params),
  createMeeting: (input) => invoke(ApiOps.CREATE_MEETING, input),
  getMeeting: (id) => invoke(ApiOps.GET_MEETING, id),
  updateMeeting: (id, input) => invoke(ApiOps.UPDATE_MEETING, id, input),
  deleteMeeting: (id) => invoke(ApiOps.DELETE_MEETING, id),
  exportMeeting: (id, format) => invoke(ApiOps.EXPORT_MEETING, id, format),

  listTemplates: () => invoke(ApiOps.LIST_TEMPLATES),
  createTemplate: (input) => invoke(ApiOps.CREATE_TEMPLATE, input),
  updateTemplate: (id, input) => invoke(ApiOps.UPDATE_TEMPLATE, id, input),
  deleteTemplate: (id) => invoke(ApiOps.DELETE_TEMPLATE, id),
  duplicateTemplate: (id) => invoke(ApiOps.DUPLICATE_TEMPLATE, id),
  setDefaultTemplate: (templateId) => invoke(ApiOps.SET_DEFAULT_TEMPLATE, templateId),

  listActionItems: () => invoke(ApiOps.LIST_ACTION_ITEMS),
  createActionItem: (input) => invoke(ApiOps.CREATE_ACTION_ITEM, input),
  updateActionItem: (id, input) => invoke(ApiOps.UPDATE_ACTION_ITEM, id, input),
  deleteActionItem: (id) => invoke(ApiOps.DELETE_ACTION_ITEM, id),

  adminListUsers: (params) => invoke(ApiOps.ADMIN_USERS_LIST, params),
  adminUpdateUserStatus: (id, status) => invoke(ApiOps.ADMIN_USER_STATUS, id, status),
  adminUpdateUserRole: (id, role) => invoke(ApiOps.ADMIN_USER_ROLE, id, role),
  adminListMeetings: (params) => invoke(ApiOps.ADMIN_MEETINGS_LIST, params),
  adminListAuditLogs: (params) => invoke(ApiOps.ADMIN_AUDIT_LOGS_LIST, params),
  adminStats: () => invoke(ApiOps.ADMIN_STATS),
  adminGetUserDetail: (id) => invoke(ApiOps.ADMIN_USER_DETAIL, id),
};

const bridge: CallNotesBridge = {
  ...api,

  appInfo(): Promise<AppInfoPayload> {
    return ipcRenderer.invoke(IpcChannels.APP_INFO) as Promise<AppInfoPayload>;
  },

  backendHealth(): Promise<{ ok: boolean; health: HealthResponse | null }> {
    return ipcRenderer.invoke(IpcChannels.BACKEND_HEALTH) as Promise<{ ok: boolean; health: HealthResponse | null }>;
  },

  audioInfo(): Promise<AudioInfoResponse> {
    return ipcRenderer.invoke(IpcChannels.AUDIO_INFO) as Promise<AudioInfoResponse>;
  },

  audioSelectMic(deviceId: string | null): Promise<AudioInfoResponse> {
    return ipcRenderer.invoke(IpcChannels.AUDIO_SELECT_MIC, deviceId) as Promise<AudioInfoResponse>;
  },

  audioMicTest(deviceId: string | null): Promise<MicTestResult> {
    return ipcRenderer.invoke(IpcChannels.AUDIO_MIC_TEST, deviceId ?? null) as Promise<MicTestResult>;
  },

  audioMonitorStart(): Promise<AudioInfoResponse> {
    return ipcRenderer.invoke(IpcChannels.AUDIO_MONITOR, "start") as Promise<AudioInfoResponse>;
  },

  audioMonitorStop(): Promise<void> {
    return ipcRenderer.invoke(IpcChannels.AUDIO_MONITOR, "stop") as Promise<void>;
  },

  onAudioMeters(listener: (event: AudioMetersEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: AudioMetersEvent): void => listener(payload);
    ipcRenderer.on(IpcChannels.AUDIO_METERS, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannels.AUDIO_METERS, handler);
    };
  },

  whisperStatus(): Promise<WhisperEngineStatus> {
    return ipcRenderer.invoke(IpcChannels.WHISPER_STATUS) as Promise<WhisperEngineStatus>;
  },

  whisperDownload(modelId: WhisperModelId): Promise<WhisperEngineStatus> {
    return ipcRenderer.invoke(IpcChannels.WHISPER_DOWNLOAD, modelId) as Promise<WhisperEngineStatus>;
  },

  whisperAbortDownload(): Promise<void> {
    return ipcRenderer.invoke(IpcChannels.WHISPER_ABORT_DOWNLOAD) as Promise<void>;
  },

  whisperDelete(modelId: WhisperModelId): Promise<WhisperEngineStatus> {
    return ipcRenderer.invoke(IpcChannels.WHISPER_DELETE, modelId) as Promise<WhisperEngineStatus>;
  },

  whisperSetDefault(modelId: WhisperModelId): Promise<WhisperEngineStatus> {
    return ipcRenderer.invoke(IpcChannels.WHISPER_SET_DEFAULT, modelId) as Promise<WhisperEngineStatus>;
  },

  whisperHardware(): Promise<HardwareInfo> {
    return ipcRenderer.invoke(IpcChannels.WHISPER_HARDWARE) as Promise<HardwareInfo>;
  },

  whisperTest(): Promise<WhisperTestResult> {
    return ipcRenderer.invoke(IpcChannels.WHISPER_TEST) as Promise<WhisperTestResult>;
  },

  onWhisperProgress(listener: (event: WhisperDownloadProgress) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: WhisperDownloadProgress): void => listener(payload);
    ipcRenderer.on(IpcChannels.WHISPER_PROGRESS, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannels.WHISPER_PROGRESS, handler);
    };
  },

  onWhisperStatus(listener: (status: WhisperEngineStatus) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: WhisperEngineStatus): void => listener(payload);
    ipcRenderer.on(IpcChannels.WHISPER_STATUS, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannels.WHISPER_STATUS, handler);
    };
  },

  meetingStart(input: MeetingStartRequest): Promise<MeetingActionResult> {
    return ipcRenderer.invoke(IpcChannels.MEETING_START, input) as Promise<MeetingActionResult>;
  },

  meetingStop(): Promise<MeetingActionResult> {
    return ipcRenderer.invoke(IpcChannels.MEETING_STOP) as Promise<MeetingActionResult>;
  },

  meetingPause(): Promise<MeetingActionResult> {
    return ipcRenderer.invoke(IpcChannels.MEETING_PAUSE) as Promise<MeetingActionResult>;
  },

  meetingResume(): Promise<MeetingActionResult> {
    return ipcRenderer.invoke(IpcChannels.MEETING_RESUME) as Promise<MeetingActionResult>;
  },

  meetingStorageEstimate(
    sources: AudioCaptureKind[],
    maxDurationSeconds?: number,
  ): Promise<RecordingStorageEstimate> {
    return ipcRenderer.invoke(IpcChannels.MEETING_STORAGE_ESTIMATE, sources, maxDurationSeconds) as Promise<RecordingStorageEstimate>;
  },

  meetingRecordingUsage(): Promise<RecordingUsage | null> {
    return ipcRenderer.invoke(IpcChannels.MEETING_RECORDING_USAGE) as Promise<RecordingUsage | null>;
  },

  meetingRetry(meetingId: string): Promise<MeetingActionResult> {
    return ipcRenderer.invoke(IpcChannels.MEETING_RETRY, meetingId) as Promise<MeetingActionResult>;
  },

  meetingDiscardRecording(meetingId: string): Promise<MeetingActionResult> {
    return ipcRenderer.invoke(IpcChannels.MEETING_DISCARD_RECORDING, meetingId) as Promise<MeetingActionResult>;
  },

  meetingListLocal(): Promise<LocalMeetingListItem[]> {
    return ipcRenderer.invoke(IpcChannels.MEETING_LOCAL_LIST) as Promise<LocalMeetingListItem[]>;
  },

  meetingGetLocal(id: string): Promise<LocalMeetingDetail | null> {
    return ipcRenderer.invoke(IpcChannels.MEETING_LOCAL_GET, id) as Promise<LocalMeetingDetail | null>;
  },

  onMeetingEvent(listener: (event: MeetingEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: MeetingEvent): void => listener(payload);
    ipcRenderer.on(IpcChannels.MEETING_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MEETING_EVENT, handler);
    };
  },

  onMeetingProcess(listener: (event: MeetingProcessEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: MeetingProcessEvent): void => listener(payload);
    ipcRenderer.on(IpcChannels.MEETING_PROCESS, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MEETING_PROCESS, handler);
    };
  },

  syncStatus(): Promise<SyncState> {
    return ipcRenderer.invoke(IpcChannels.SYNC_STATUS) as Promise<SyncState>;
  },

  syncNow(): Promise<SyncState> {
    return ipcRenderer.invoke(IpcChannels.SYNC_NOW) as Promise<SyncState>;
  },

  onSyncEvent(listener: (state: SyncState) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: SyncState): void => listener(payload);
    ipcRenderer.on(IpcChannels.SYNC_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SYNC_EVENT, handler);
    };
  },

  llmStatus(): Promise<LlmEngineStatus> {
    return ipcRenderer.invoke(IpcChannels.LLM_STATUS) as Promise<LlmEngineStatus>;
  },

  llmSetRuntime(input: LlmSetRuntimeRequest): Promise<LlmEngineStatus> {
    return ipcRenderer.invoke(IpcChannels.LLM_SET_RUNTIME, input) as Promise<LlmEngineStatus>;
  },

  llmPull(modelId: string): Promise<LlmEngineStatus> {
    return ipcRenderer.invoke(IpcChannels.LLM_PULL, modelId) as Promise<LlmEngineStatus>;
  },

  llmDelete(modelId: string): Promise<LlmEngineStatus> {
    return ipcRenderer.invoke(IpcChannels.LLM_DELETE, modelId) as Promise<LlmEngineStatus>;
  },

  llmSetDefault(modelId: string): Promise<LlmEngineStatus> {
    return ipcRenderer.invoke(IpcChannels.LLM_SET_DEFAULT, modelId) as Promise<LlmEngineStatus>;
  },

  llmAnalyzeMeeting(meetingId: string): Promise<LlmAnalysisOutcome> {
    return ipcRenderer.invoke(IpcChannels.LLM_ANALYZE, meetingId) as Promise<LlmAnalysisOutcome>;
  },

  meetingSaveNotes(
    meetingId: string,
    notes: { summary?: MeetingSyncSummary; actionItems?: MeetingSyncActionItem[] },
  ): Promise<{ ok: boolean; error: { code: string; message: string } | null }> {
    return ipcRenderer.invoke(IpcChannels.MEETING_SAVE_NOTES, meetingId, notes) as Promise<{
      ok: boolean;
      error: { code: string; message: string } | null;
    }>;
  },

  onLlmProgress(listener: (event: LlmDownloadProgress) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: LlmDownloadProgress): void => listener(payload);
    ipcRenderer.on(IpcChannels.LLM_PROGRESS, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannels.LLM_PROGRESS, handler);
    };
  },

  onLlmStatus(listener: (status: LlmEngineStatus) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: LlmEngineStatus): void => listener(payload);
    ipcRenderer.on(IpcChannels.LLM_STATUS_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannels.LLM_STATUS_EVENT, handler);
    };
  },

  onUpdateStatus(listener: (status: UpdateStatusPayload) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: UpdateStatusPayload): void => listener(payload);
    ipcRenderer.on(IpcChannels.UPDATE_STATUS, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannels.UPDATE_STATUS, handler);
    };
  },

  overlayState(): Promise<OverlayState> {
    return ipcRenderer.invoke(IpcChannels.OVERLAY_STATE) as Promise<OverlayState>;
  },

  overlayUpdateSettings(patch: OverlaySettingsUpdate): Promise<OverlayState> {
    return ipcRenderer.invoke(IpcChannels.OVERLAY_SETTINGS_UPDATE, patch) as Promise<OverlayState>;
  },

  overlayAction(action: OverlayAction): Promise<{ ok: boolean; error: string | null }> {
    return ipcRenderer.invoke(IpcChannels.OVERLAY_ACTION, action) as Promise<{ ok: boolean; error: string | null }>;
  },

  onOverlayEvent(listener: (event: OverlayEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: OverlayEvent): void => listener(payload);
    ipcRenderer.on(IpcChannels.OVERLAY_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannels.OVERLAY_EVENT, handler);
    };
  },
};

contextBridge.exposeInMainWorld("callnotes", bridge);