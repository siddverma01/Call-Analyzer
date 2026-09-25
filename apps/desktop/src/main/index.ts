import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { IpcChannels } from "@callnotes/shared";
import type {
  AudioMetersEvent,
  LlmDownloadProgress,
  LlmEngineStatus,
  MeetingEvent,
  MeetingProcessEvent,
  OverlayEvent,
  SyncState,
  WhisperDownloadProgress,
  WhisperEngineStatus,
} from "@callnotes/shared";
import { loadDesktopConfig } from "./config.js";
import { ApiClient } from "./api-client.js";
import { createSessionStorage } from "./session-storage.js";
import { registerIpc } from "./ipc.js";
import { createMainWindow } from "./window.js";
import { AudioService } from "./audio/audio-service.js";
import { WhisperService } from "./whisper/whisper-service.js";
import { LocalStore } from "./db/local-db.js";
import { SyncQueue } from "./sync/sync-queue.js";
import { MeetingService } from "./meeting/meeting-service.js";
import { LlmService } from "./llm/llm-service.js";
import { LlmSettingsStore } from "./llm/llm-settings.js";
import { configureAutoUpdate } from "./updater.js";
import { loadNativeAddon, nativeAvailable } from "./audio/native-loader.js";
import { OverlayController } from "./overlay/overlay-controller.js";
import { OverlaySettingsStore } from "./overlay/overlay-settings.js";

const isDevelopment = !app.isPackaged && !!process.env["ELECTRON_RENDERER_URL"];
let audioService: AudioService | null = null;
let whisperService: WhisperService | null = null;
let localStore: LocalStore | null = null;
let syncQueue: SyncQueue | null = null;
let meetingService: MeetingService | null = null;
let llmService: LlmService | null = null;
let overlayController: OverlayController | null = null;
let ipcRegistered = false;
let mainWindowRef: BrowserWindow | null = null;

function pushMeters(event: AudioMetersEvent): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (window && !window.isDestroyed()) {
    window.webContents.send(IpcChannels.AUDIO_METERS, event);
  }
}

function pushWhisperStatus(event: WhisperEngineStatus): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(IpcChannels.WHISPER_STATUS, event);
}

function pushWhisperProgress(event: WhisperDownloadProgress): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(IpcChannels.WHISPER_PROGRESS, event);
}

function pushMeetingProcess(event: MeetingProcessEvent): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(IpcChannels.MEETING_PROCESS, event);
}

function pushSyncState(state: SyncState): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(IpcChannels.SYNC_EVENT, state);
}

function pushMeetingEvent(event: MeetingEvent): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(IpcChannels.MEETING_EVENT, event);
}

function pushLlmStatus(status: LlmEngineStatus): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(IpcChannels.LLM_STATUS_EVENT, status);
}

function pushLlmProgress(event: LlmDownloadProgress): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(IpcChannels.LLM_PROGRESS, event);
}

function pushOverlayEvent(event: OverlayEvent): void {
  const window = mainWindowRef ?? BrowserWindow.getAllWindows()[0];
  if (window && !window.isDestroyed()) {
    window.webContents.send(IpcChannels.OVERLAY_EVENT, event);
  }
}

function focusMainWindow(): void {
  const window = mainWindowRef ?? BrowserWindow.getAllWindows()[0];
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}

function createServices(): ApiClient {
  const config = loadDesktopConfig();
  const api = new ApiClient(config.backendUrl, createSessionStorage());

  audioService ??= new AudioService({
    settingsPath: join(app.getPath("userData"), "settings.json"),
    recordingsDir: join(app.getPath("userData"), "recordings"),
    sendMeters: pushMeters,
  });
  whisperService ??= new WhisperService({
    modelsDir: join(app.getPath("userData"), "models"),
    statePath: join(app.getPath("userData"), "models", "state.json"),
    sendStatus: pushWhisperStatus,
    sendProgress: pushWhisperProgress,
  });

  localStore ??= new LocalStore(join(app.getPath("userData"), "callnotes.db"));
  syncQueue ??= new SyncQueue({
    api,
    store: localStore,
    sendState: pushSyncState,
    // Suppress sync probes/pumps while a meeting records (text-only payloads,
    // but capture should not compete with network traffic mid-session).
    isMeetingActive: () => meetingService?.getActiveMeetingId() !== null,
  });
  syncQueue.start();
  meetingService ??= new MeetingService({
    store: localStore,
    queue: syncQueue,
    recordingsDir: join(app.getPath("userData"), "recordings"),
    whisper: whisperService,
    audio: audioService,
    sendMeeting: pushMeetingEvent,
    sendProcess: pushMeetingProcess,
    // Wired lazily (not a constructor dependency) to avoid a circular import
    // between MeetingService and LlmService.
    analyze: (meetingId) =>
      llmService ? llmService.analyzeMeeting(meetingId).then(() => undefined) : Promise.resolve(),
  });

  llmService ??= new LlmService({
    store: localStore,
    meeting: meetingService,
    settingsStore: new LlmSettingsStore(join(app.getPath("userData"), "llm.json")),
    sendStatus: pushLlmStatus,
    sendProgress: pushLlmProgress,
  });

  overlayController ??= new OverlayController({
    supported: process.platform === "win32",
    settings: new OverlaySettingsStore({ settingsPath: join(app.getPath("userData"), "overlay.json") }),
    getAddon: () => (nativeAvailable() ? loadNativeAddon() : null),
    isMeetingActive: () => meetingService?.getActiveMeetingId() !== null,
    startMeeting: (request) => {
      const meeting = meetingService;
      if (!meeting) return Promise.reject(new Error("Meeting service is not ready."));
      return meeting.start(request);
    },
    sendToApp: pushOverlayEvent,
    focusAppWindow: focusMainWindow,
  });

  if (!ipcRegistered) {
    registerIpc(config, api, audioService, whisperService, meetingService, syncQueue, llmService, overlayController);
    ipcRegistered = true;
  }
  return api;
}

void app.whenReady().then(() => {
  createServices();

  configureAutoUpdate((channel, payload) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    window?.webContents.send(channel, payload);
  });

  const mainWindow = createMainWindow(isDevelopment);
  mainWindowRef = mainWindow;
  mainWindow.on("closed", () => {
    mainWindowRef = null;
    // The hidden overlay must not keep the app alive once the app window is
    // gone; destroy it so `window-all-closed` fires normally.
    overlayController?.dispose();
  });
  app.on("browser-window-created", (_event, window) => {
    window.on("closed", () => {
      /* windows tracked individually if needed later */
    });
  });

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  meetingService?.abandonActive();
  meetingService = null;
  audioService?.dispose();
  audioService = null;
  void whisperService?.dispose();
  whisperService = null;
  syncQueue?.stop();
  syncQueue = null;
  localStore?.close();
  localStore = null;
  llmService?.dispose();
  llmService = null;
  overlayController?.dispose();
  overlayController = null;
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createServices();
    createMainWindow(isDevelopment);
  }
});