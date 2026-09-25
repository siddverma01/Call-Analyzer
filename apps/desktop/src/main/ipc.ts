import { ipcMain, type IpcMainInvokeEvent, type IpcMain } from "electron";
import {
  ApiOps,
  IpcChannels,
  type ApiInvocation,
  type ApiResult,
  type AppInfoPayload,
  type AudioCaptureKind,
  type AudioInfoResponse,
  type HardwareInfo,
  type LlmAnalysisOutcome,
  type LlmEngineStatus,
  type LlmSetRuntimeRequest,
  type MeetingStartRequest,
  type MeetingSyncActionItem,
  type MeetingSyncSummary,
  type MicTestResult,
  type OverlayAction,
  type OverlaySettingsUpdate,
  type RecordingStorageEstimate,
  type RecordingUsage,
  type SyncState,
  type WhisperEngineStatus,
  type WhisperModelId,
  type WhisperTestResult,
} from "@callnotes/shared";
import type { DesktopConfig } from "./config.js";
import { ApiError } from "./api-client.js";
import type { ApiClient } from "./api-client.js";
import type { AudioService } from "./audio/audio-service.js";
import type { WhisperService } from "./whisper/whisper-service.js";
import type { MeetingService } from "./meeting/meeting-service.js";
import type { SyncQueue } from "./sync/sync-queue.js";
import type { LlmService } from "./llm/llm-service.js";
import type { OverlayController } from "./overlay/overlay-controller.js";

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });

/** Runs a handler and wraps its outcome in the uniform IPC result envelope. */
async function callSafely<T>(fn: () => T | Promise<T>): Promise<ApiResult<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, error: { code: error.code, message: error.message, status: error.status } };
    }
    const message = error instanceof Error ? error.message : "Unexpected error";
    return { ok: false, error: { code: "INTERNAL_ERROR", message, status: 500 } };
  }
}

/**
 * Hosts the sandboxed renderer may load from. Production ships a `file://`
 * bundle; the Vite dev server runs on localhost. Any other origin is denied.
 */
const ALLOWED_SENDER_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Fail-closed validation of the frame invoking a handler: the top-level
 * window only, loaded from file:// or the local dev server. Child frames
 * (iframes) are always rejected so embedded content can never reach the
 * privileged main-process surface.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  try {
    const url = new URL(frame.url);
    if (url.protocol === "file:") return true;
    if (url.protocol === "http:" || url.protocol === "https:") {
      return ALLOWED_SENDER_HOSTS.has(url.hostname);
    }
  } catch {
    /* fall through to deny */
  }
  return false;
}

/** `ipcMain.handle` that refuses calls from any untrusted renderer frame. */
function handleTrusted(
  ipc: IpcMain,
  channel: string,
  listener: Parameters<IpcMain["handle"]>[1],
): void {
  ipc.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      const error = new Error("Untrusted IPC sender");
      (error as Error & { code?: string }).code = "INVALID_SENDER";
      throw error;
    }
    return listener(event, ...(args as never[]));
  });
}

/** Registers the small, typed IPC surface exposed to the renderer. */
export function registerIpc(
  config: DesktopConfig,
  api: ApiClient,
  audio: AudioService,
  whisper: WhisperService,
  meeting: MeetingService,
  queue: SyncQueue,
  llm: LlmService,
  overlay: OverlayController | null = null,
): void {
  handleTrusted(ipcMain, IpcChannels.APP_INFO, () => {
    const payload: AppInfoPayload = {
      name: config.appName,
      version: config.appVersion,
      platform: process.platform,
      arch: process.arch,
      backendUrl: config.backendUrl,
    };
    return payload;
  });

  handleTrusted(ipcMain, IpcChannels.BACKEND_HEALTH, async () => {
    try {
      return { ok: true, health: await api.health() };
    } catch {
      return { ok: false, health: null };
    }
  });

  handleTrusted(ipcMain, IpcChannels.AUDIO_INFO, (): AudioInfoResponse => audio.info());

  handleTrusted(ipcMain, IpcChannels.AUDIO_SELECT_MIC, (_event, deviceId: unknown): AudioInfoResponse => {
    const id = deviceId === null || typeof deviceId !== "string" ? null : deviceId;
    return audio.selectMic(id);
  });

  handleTrusted(ipcMain, IpcChannels.AUDIO_MIC_TEST, (_event, deviceId: unknown): Promise<MicTestResult> => {
    const id = deviceId === null || typeof deviceId !== "string" ? null : deviceId;
    return audio.micTest(id);
  });

  handleTrusted(ipcMain, IpcChannels.AUDIO_MONITOR, (_event, action: "start" | "stop"): AudioInfoResponse | void => {
    if (action === "stop") {
      audio.stopMonitoring();
      return;
    }
    return audio.startMonitoring();
  });

  // -------------------------------------------------------------------------
  // Local whisper.cpp transcription
  // -------------------------------------------------------------------------

  handleTrusted(ipcMain, IpcChannels.WHISPER_STATUS, (): WhisperEngineStatus => whisper.status());

  handleTrusted(ipcMain, IpcChannels.WHISPER_HARDWARE, (): Promise<HardwareInfo> => whisper.hardware());

  handleTrusted(ipcMain, 
    IpcChannels.WHISPER_DOWNLOAD,
    (_event, modelId: unknown): Promise<WhisperEngineStatus> => {
      const id = sanitizeModelId(modelId);
      if (!id) return Promise.resolve(whisper.status());
      return whisper.download(id);
    },
  );

  handleTrusted(ipcMain, IpcChannels.WHISPER_ABORT_DOWNLOAD, (): Promise<void> => whisper.abortDownload());

  handleTrusted(ipcMain, 
    IpcChannels.WHISPER_DELETE,
    (_event, modelId: unknown): WhisperEngineStatus => {
      const id = sanitizeModelId(modelId);
      return whisper.deleteModel(id ?? "tiny");
    },
  );

  handleTrusted(ipcMain, 
    IpcChannels.WHISPER_SET_DEFAULT,
    async (_event, modelId: unknown): Promise<WhisperEngineStatus> => {
      const id = sanitizeModelId(modelId);
      if (!id) return whisper.status();
      return whisper.setDefault(id);
    },
  );

  handleTrusted(ipcMain, 
    IpcChannels.WHISPER_TEST,
    (_event, modelId?: unknown): Promise<WhisperTestResult> => {
      const id = modelId === undefined || modelId === null ? undefined : sanitizeModelId(modelId);
      return whisper.testModel(id ?? undefined);
    },
  );

  // -------------------------------------------------------------------------
  // Offline-first meeting lifecycle + synchronization
  // -------------------------------------------------------------------------

  handleTrusted(ipcMain, 
    IpcChannels.MEETING_START,
    (_event, input: unknown) => meeting.start(input as MeetingStartRequest),
  );

  handleTrusted(ipcMain, IpcChannels.MEETING_STOP, () => meeting.stop());

  handleTrusted(ipcMain, IpcChannels.MEETING_PAUSE, () => meeting.pause());

  handleTrusted(ipcMain, IpcChannels.MEETING_RESUME, () => meeting.resume());

  handleTrusted(
    ipcMain,
    IpcChannels.MEETING_STORAGE_ESTIMATE,
    (_event, sources: unknown, maxDurationSeconds: unknown): RecordingStorageEstimate => {
      const list = (Array.isArray(sources)
        ? sources.filter((s) => s === "microphone" || s === "loopback")
        : []) as AudioCaptureKind[];
      const max = typeof maxDurationSeconds === "number" && Number.isFinite(maxDurationSeconds)
        ? maxDurationSeconds
        : undefined;
      return meeting.estimateStorage(list, max);
    },
  );

  handleTrusted(ipcMain, IpcChannels.MEETING_RECORDING_USAGE, (): RecordingUsage | null => audio.recordingUsage());

  handleTrusted(ipcMain, IpcChannels.MEETING_RETRY, (_event, id: unknown) => {
    return meeting.retry(typeof id === "string" ? id : "");
  });

  handleTrusted(ipcMain, IpcChannels.MEETING_DISCARD_RECORDING, (_event, id: unknown) => {
    return meeting.discardRecording(typeof id === "string" ? id : "");
  });

  handleTrusted(ipcMain, IpcChannels.MEETING_LOCAL_LIST, () => meeting.list());

  handleTrusted(ipcMain, IpcChannels.MEETING_LOCAL_GET, (_event, id: unknown) => {
    return meeting.get(typeof id === "string" ? id : "");
  });

  handleTrusted(ipcMain, 
    IpcChannels.MEETING_SAVE_NOTES,
    async (
      _event,
      meetingId: unknown,
      notes: unknown,
    ): Promise<{ ok: boolean; error: { code: string; message: string } | null }> => {
      const id = typeof meetingId === "string" ? meetingId : "";
      const raw = (notes ?? {}) as { summary?: unknown; actionItems?: unknown };
      const summary =
        raw.summary != null && typeof raw.summary === "object" ? (raw.summary as MeetingSyncSummary) : undefined;
      const actionItems = Array.isArray(raw.actionItems)
        ? (raw.actionItems as MeetingSyncActionItem[])
        : undefined;
      try {
        await meeting.setNotes(id, { summary, actionItems });
        return { ok: true, error: null };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "meeting.save-notes-failed",
            message: error instanceof Error ? error.message : "Could not save notes.",
          },
        };
      }
    },
  );

  handleTrusted(ipcMain, IpcChannels.SYNC_STATUS, (): SyncState => queue.getState());

  handleTrusted(ipcMain, IpcChannels.SYNC_NOW, (): Promise<SyncState> => queue.syncNow());

  // -------------------------------------------------------------------------
  // Local AI meeting analysis (Ollama / llama.cpp)
  // -------------------------------------------------------------------------

  handleTrusted(ipcMain, IpcChannels.LLM_STATUS, (): Promise<LlmEngineStatus> => llm.status());

  handleTrusted(ipcMain, IpcChannels.LLM_SET_RUNTIME, (_event, input: unknown): Promise<LlmEngineStatus> => {
    const raw = (input ?? {}) as Partial<LlmSetRuntimeRequest>;
    return llm.setRuntime({
      runtime: raw.runtime === "llamacpp" ? "llamacpp" : "ollama",
      ollamaUrl: typeof raw.ollamaUrl === "string" ? raw.ollamaUrl : undefined,
      llamacppUrl: typeof raw.llamacppUrl === "string" ? raw.llamacppUrl : undefined,
    });
  });

  handleTrusted(ipcMain, IpcChannels.LLM_PULL, (_event, modelId: unknown): Promise<LlmEngineStatus> => {
    const id = typeof modelId === "string" ? modelId.trim() : "";
    if (!id) return llm.status();
    return llm.pull(id);
  });

  handleTrusted(ipcMain, IpcChannels.LLM_DELETE, (_event, modelId: unknown): Promise<LlmEngineStatus> => {
    const id = typeof modelId === "string" ? modelId : "";
    if (!id) return llm.status();
    return llm.deleteModel(id);
  });

  handleTrusted(ipcMain, IpcChannels.LLM_SET_DEFAULT, (_event, modelId: unknown): Promise<LlmEngineStatus> => {
    const id = typeof modelId === "string" ? modelId : "";
    if (!id) return llm.status();
    return llm.setDefault(id);
  });

  handleTrusted(ipcMain, IpcChannels.LLM_ANALYZE, (_event, meetingId: unknown): Promise<LlmAnalysisOutcome> => {
    return llm.analyzeMeeting(typeof meetingId === "string" ? meetingId : "");
  });

  handleTrusted(ipcMain, IpcChannels.API, (_event, invocation: ApiInvocation) => {
    const args: unknown[] = Array.isArray(invocation?.args) ? invocation.args : [];

    switch (invocation?.op) {
      case ApiOps.REGISTER:
        return callSafely(() => api.register(args[0] as never));
      case ApiOps.LOGIN:
        return callSafely(() => api.login(args[0] as never));
      case ApiOps.SESSION:
        return callSafely(() => api.sessionInfo());
      case ApiOps.LOGOUT:
        return callSafely(() => api.logout());
      case ApiOps.CHANGE_PASSWORD:
        return callSafely(() => api.changePassword(args[0] as never));

      case ApiOps.LIST_MEETINGS:
        return callSafely(() => api.listMeetings(args[0] as never));
      case ApiOps.CREATE_MEETING:
        return callSafely(() => api.createMeeting(args[0] as never));
      case ApiOps.GET_MEETING:
        return callSafely(() => api.getMeeting(args[0] as string));
      case ApiOps.UPDATE_MEETING:
        return callSafely(() => api.updateMeeting(args[0] as string, args[1] as never));
      case ApiOps.DELETE_MEETING:
        return callSafely(() => api.deleteMeeting(args[0] as string));
      case ApiOps.EXPORT_MEETING:
        return callSafely(() => api.exportMeeting(args[0] as string, args[1] as never));

      case ApiOps.LIST_TEMPLATES:
        return callSafely(() => api.listTemplates());
      case ApiOps.CREATE_TEMPLATE:
        return callSafely(() => api.createTemplate(args[0] as never));
      case ApiOps.UPDATE_TEMPLATE:
        return callSafely(() => api.updateTemplate(args[0] as string, args[1] as never));
      case ApiOps.DELETE_TEMPLATE:
        return callSafely(() => api.deleteTemplate(args[0] as string));
      case ApiOps.DUPLICATE_TEMPLATE:
        return callSafely(() => api.duplicateTemplate(args[0] as string));
      case ApiOps.SET_DEFAULT_TEMPLATE:
        return callSafely(() => api.setDefaultTemplate(args[0] as string | null));
      case ApiOps.LIST_ACTION_ITEMS:
        return callSafely(() => api.listActionItems());
      case ApiOps.CREATE_ACTION_ITEM:
        return callSafely(() => api.createActionItem(args[0] as never));
      case ApiOps.UPDATE_ACTION_ITEM:
        return callSafely(() => api.updateActionItem(args[0] as string, args[1] as never));
      case ApiOps.DELETE_ACTION_ITEM:
        return callSafely(() => api.deleteActionItem(args[0] as string));

      case ApiOps.ADMIN_USERS_LIST:
        return callSafely(() => api.adminListUsers(args[0] as never));
      case ApiOps.ADMIN_USER_STATUS:
        return callSafely(() => api.adminUpdateUserStatus(args[0] as string, args[1] as never));
      case ApiOps.ADMIN_USER_ROLE:
        return callSafely(() => api.adminUpdateUserRole(args[0] as string, args[1] as never));
      case ApiOps.ADMIN_MEETINGS_LIST:
        return callSafely(() => api.adminListMeetings(args[0] as never));
      case ApiOps.ADMIN_AUDIT_LOGS_LIST:
        return callSafely(() => api.adminListAuditLogs(args[0] as never));
      case ApiOps.ADMIN_STATS:
        return callSafely(() => api.adminStats());
      case ApiOps.ADMIN_USER_DETAIL:
        return callSafely(() => api.adminGetUserDetail(args[0] as string));

      default:
        return { ok: false, error: { code: "UNKNOWN_OP", message: "Unknown API operation", status: 400 } };
    }
  });

  if (overlay) registerOverlayIpc(overlay);
}

const OVERLAY_ACTIONS = new Set<OverlayAction>([
  "start-meeting",
  "snooze",
  "disable",
  "detection-off",
  "dismiss",
  "open-app",
  "settings",
]);

/** Only channels invoked by the overlay (and Settings) window hit these. */
function registerOverlayIpc(overlay: OverlayController): void {
  handleTrusted(ipcMain, IpcChannels.OVERLAY_STATE, () => overlay.getState());

  handleTrusted(ipcMain, IpcChannels.OVERLAY_SETTINGS_UPDATE, (_event, raw: unknown) => {
    const patch = sanitizeOverlayUpdate(raw);
    if (!patch) return overlay.getState();
    return overlay.updateSettings(patch);
  });

  handleTrusted(ipcMain, IpcChannels.OVERLAY_ACTION, (_event, raw: unknown) => {
    if (typeof raw !== "string" || !OVERLAY_ACTIONS.has(raw as OverlayAction)) {
      return { ok: false, error: "Unknown overlay action." };
    }
    return overlay.handleAction(raw as OverlayAction);
  });
}

/** Whitelist-only patch deserialization; malformed values are dropped. */
function sanitizeOverlayUpdate(raw: unknown): OverlaySettingsUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const patch: OverlaySettingsUpdate = {};
  for (const key of ["enabled", "detectionEnabled", "autoRecord"] as const) {
    if (typeof src[key] === "boolean") patch[key] = src[key];
  }
  if (typeof src.consent === "boolean") patch.consent = src.consent;
  if (Array.isArray(src.sources)) {
    const allowed = new Set<AudioCaptureKind>(["microphone", "loopback"]);
    const filtered = src.sources.filter((s): s is AudioCaptureKind => typeof s === "string" && allowed.has(s as AudioCaptureKind));
    if (filtered.length > 0) patch.sources = filtered;
  }
  if (src.snoozedUntil === null) {
    patch.snoozedUntil = null;
  } else if (typeof src.snoozedUntil === "string" && !Number.isNaN(Date.parse(src.snoozedUntil))) {
    patch.snoozedUntil = src.snoozedUntil;
  }
  return patch;
}

const WHISPER_MODEL_ID_SET = new Set<string>(["tiny", "base", "small", "medium"]);

function sanitizeModelId(value: unknown): WhisperModelId | null {
  if (typeof value === "string" && WHISPER_MODEL_ID_SET.has(value)) return value as WhisperModelId;
  return null;
}