import { BrowserWindow, Tray, nativeImage, Menu, nativePlatform } from "electron";
import { join } from "node:path";
import type {
  AudioService,
  MeetingService,
  MeetingStartRequest,
  MeetingActionResult,
  OverlayState,
} from "@callnotes/shared";
import type { OverlaySettingsStore } from "./overlay-settings.js";
import { MEETING_ERROR_CODES } from "@callnotes/shared";

/**
 * Background service that owns the meeting lifecycle completely independent of the UI.
 * It is instantiated once in the Electron main process and exposed through a small
 * trusted IPC surface.  The React renderer only ever sends commands; the service
 * drives audio capture, chunk writing, Whisper/LLM execution and cleanup.
 */
export class BackgroundMeetingService {
  private audio: AudioService;
  private meeting: MeetingService | null = null;
  private meetingId: string | null = null;
  private recording = false;
  private tray: Tray | null = null;
  private readonly onStateChange: (state: {
    recording: boolean;
    meetingId: string | null;
    status: "idle" | "recording" | "processing" | "completed" | "failed";
  }) => void;

  /** Create the service.
   *  @param audio       The shared AudioService instance (mic + loopback capture).
   *  @param meeting     The shared MeetingService instance (DB, Whisper, LLM).
   *  @param sendEvent   Callback invoked whenever the recording state changes.
   */
  constructor(
    audio: AudioService,
    meeting: MeetingService,
    onStateChange: (state: {
      recording: boolean;
      meetingId: string | null;
      status: "idle" | "recording" | "processing" | "completed" | "failed";
    }) => void,
  ) {
    this.audio = audio;
    this.meeting = meeting;
    this.onStateChange = onStateChange;
    this.initTray();
  }

  // -------------------------------------------------------------------------
  // Public API – called from the overlay controller / IPC
  // -------------------------------------------------------------------------

  /** Start a new meeting.  called after the user clicks "Start AI Meeting Notes". */
  async startMeeting(): Promise<{ ok: boolean; error: string | null }> {
    // If a meeting is already running, do nothing.
    if (this.recording) return { ok: true, error: null };

    // 1️⃣ Create a fresh meeting record locally.
    const newId = Math.random().toString(36).substring(2, 16) + Date.now().toString(36);
    this.meetingId = newId;

    // 2️⃣ Persist a lightweight row so the UI can query "recording" status.
    //    (The actual capture starts later via audio.startMeeting.)
    //    We use the meetingService's store to create the row.
    //    The MeetingServiceDeps store is already available via this.meeting.store.
    try {
      this.meeting!.store.createMeeting({
        id: this.meetingId,
        title: "CallNotes AI meeting",
        templateId: null,
        status: "STARTING",
        startedAt: Date.now(),
        sources: ["microphone", "loopback"] as const,
        diarization: true,
        language: null,
      });
    } catch (_e) {
      // Best‑effort; if the DB is missing we still try to start capture.
    }

    // 3️⃣ Initialise microphone + WASAPI loopback capture.
    try {
      this.audio.startMeeting(this.meetingId, ["microphone", "loopback"], {
        onError: (err: Error) => this.onRecordingError(err),
      });
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : "Audio capture could not start.";
      this.onRecordingError(new Error(msg));
      return { ok: false, error: msg };
    }

    this.recording = true;
    this.onStateChange({
      recording: true,
      meetingId: this.meetingId,
      status: "recording",
    });

    // 4️⃣ Update tray (if available) to show "Recording active".
    this.updateTray("Recording active");

    return { ok: true, error: null };
  }

  /** Stop the current meeting and run post‑processing (Whisper + LLM). */
  async stopMeeting(): Promise<{ ok: boolean; error: string | null }> {
    if (!this.recording || !this.meetingId) return { ok: true, error: null };

    this.recording = false;
    this.updateTray("CallNotes AI");

    // 1️⃣ Tell the audio service to stop capture and flush chunks.
    this.audio.finishMeeting();

    // 2️⃣ Run the post‑meeting pipeline (Whisper → LLM → notes → sync).
    try {
      const result = await this.meeting!.stop();

      // 3️⃣ Update DB status to completed/failed based on result.
      if (result.ok) {
        this.onStateChange({
          recording: false,
          meetingId: this.meetingId,
          status: "completed",
        });
        this.updateTray("CallNotes AI");
        // Optional: sync to cloud later – the MeetingService already handles it.
        return { ok: true, error: null };
      } else {
        this.onStateChange({
          recording: false,
          meetingId: this.meetingId,
          status: "failed",
        });
        this.updateTray("CallNotes AI");
        return { ok: false, error: result.error?.message ?? "Stop failed" };
      }
    } catch (e: any) {
      // Preserve the temporary audio so the user can retry later.
      this.onStateChange({
        recording: false,
        meetingId: this.meetingId,
        status: "failed",
      });
      this.updateTray("CallNotes AI");
      return { ok: false, error: e.message };
    } finally {
      this.meetingId = null;
    }
  }

  /** Pause the ongoing recording (audio capture stops writing to disk). */
  pauseMeeting(): void {
    if (!this.recording) return;
    this.audio.pauseMeeting();
    // State stays "recording"; we just note the pause in the UI if desired.
  }

  /** Resume a paused recording. */
  resumeMeeting(): void {
    if (!this.recording) return;
    this.audio.resumeMeeting();
  }

  /** Current recording status – for the renderer / tray. */
  getStatus() {
    return {
      recording: this.recording,
      meetingId: this.meetingId,
      status:
        this.recording || this.meetingId != null ? "recording" :
        this.meetingId != null && this.meeting!.store.getMeeting(this.meetingId)?.status === "processing"
          ? "processing"
          : "idle",
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private initTray(): void {
    if (nativePlatform() !== "win32") return;
    const icon = nativeImage.createFromPath(
      join(__dirname, "../../../../native/prebuilds/callnotes-win32-x64.ico")
    );
    if (!icon.isEmpty()) {
      this.tray = new Tray(icon);
      this.tray.setToolTip("CallNotes AI – idle");
      const contextMenu = Menu.buildFromTemplate([
        { label: "Recording active", enabled: false },
        { type: "separator" },
        { label: "Stop Meeting", click: () => this.stopMeeting().then(() => this.onStateChange(this.getStatus())) },
        { label: "Open CallNotes AI", click: () => this.openMainWindow() },
        { label: "Settings", click: () => this.openSettings() },
        { type: "separator" },
        { label: "Exit", click: () => { /* electron.app.quit() */ } },
      ]);
      this.tray.setContextMenu(contextMenu);
    }
  }

  private updateTray(text: string): void {
    if (!this.tray) return;
    this.tray.setToolTip(text);
    // Optional: update the menu item label
    // (not implemented for brevity)
  }

  private openMainWindow(): void {
    // The main Window is accessed via the global mainWindowRef; for this demo
    // we just fire an IPC that the renderer can handle.
    // In a real app you would forward focus to the existing BrowserWindow.
  }

  private openSettings(): void {
    // Same as above – forward to the settings page.
  }

  /** Called by AudioService when a chunk write fails mid‑recording. */
  private onRecordingError(error: Error): void {
    const msg = error.message ?? "Audio capture failed during recording.";
    this.meeting!.onRecordingError(this.meetingId ?? "", error);
    this.onStateChange({
      recording: false,
      meetingId: this.meetingId,
      status: "failed",
    });
    this.updateTray("CallNotes AI – error");
    this.meetingId = null;
    this.recording = false;
  }
}