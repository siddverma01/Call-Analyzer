import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import {
  OVERLAY_DISMISS_COOLDOWN_MS,
  OVERLAY_EXPANDED_HEIGHT,
  OVERLAY_PILL_HEIGHT,
  OVERLAY_PILL_WIDTH,
  OVERLAY_SNOOZE_MS,
  type MeetingActionResult,
  type MeetingStartRequest,
  type OverlayAction,
  type OverlayEvent,
  type OverlaySettingsUpdate,
  type OverlayState,
  type DetectionState,
} from "@callnotes/shared";
import type { NativeAudioAddon } from "../audio/types.js";
import { WindowsAudioSessionProvider } from "./detection-provider";
import type { OverlaySettingsStore } from "./overlay-settings.js";
import { isSnoozed, toOverlayState } from "./overlay-settings.js";
import {
  defaultOverlaySpot,
  dragOverlay,
  overlayPillSize,
  type Point,
  type Rect,
  type WorkArea,
} from "./overlay-position.js";

export interface OverlayControllerDeps {
  /** Only feature-gated when consent + detection are on AND Windows. */
  supported: boolean;
  settings: OverlaySettingsStore;
  getAddon: () => NativeAudioAddon | null;
  isMeetingActive: () => boolean;
  startMeeting: (request: MeetingStartRequest) => Promise<MeetingActionResult>;
  /** Push a navigation/meeting-started event to the MAIN renderer. */
  sendToApp: (event: OverlayEvent) => void;
  /** Bring the main CallNotes window forward. */
  focusAppWindow: () => void;
  now?: () => number;
}

const MIN_SHOW_GAP_MS = 5000;

/**
 * Owns the floating overlay: its BrowserWindow, the Windows loopback activity
 * detector that decides when to surface it, drag/position persistence, and the
 * routing of overlay actions into the real meeting + navigation flow.
 */
export class OverlayController {
  private window: BrowserWindow | null = null;
  private provider: WindowsAudioSessionProvider | null = null;
  private readonly now: () => number;
  private readonly size: { width: number; height: number };

  private detectActive = false;
  private suppressUntil = 0;
  private lastAutoShowAt = 0;
  private position: { pos: Point; displayId: number } | null;
  private menuOpen = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private snoozeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OverlayControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.size = overlayPillSize();
    const stored = deps.settings.get().position;
    this.position = stored ? { pos: { x: stored.x, y: stored.y }, displayId: stored.displayId } : null;
    this.provider = new WindowsAudioSessionProvider(
      deps.getAddon(),
      { confirmMs: 2000, resetMs: 5000, thresholdRms: 0.004 },
      (state: DetectionState) => this.onProviderStateChange(state)
    );
    this.syncDetection();
  }

  // -------------------------------------------------------------------------
  // Renderer-facing surface (overlay itself)
  // -------------------------------------------------------------------------

  getState(): OverlayState {
    return toOverlayState(this.deps.settings.get(), this.deps.supported, this.deps.isMeetingActive());
  }

  updateSettings(patch: OverlaySettingsUpdate): OverlayState {
    this.deps.settings.update(patch);
    this.syncDetection();
    return this.getState();
  }

  /** Toggle the menu (expands/shrinks the transparent window). */
  setMenuOpen(open: boolean): void {
    this.menuOpen = open;
    this.applyBounds();
    if (!open) this.schedulePersist();
  }

  async handleAction(action: OverlayAction): Promise<{ ok: boolean; error: string | null }> {
    switch (action) {
      case "start-meeting":
        return this.startMeetingFromOverlay();
      case "snooze":
        this.updateSettings({
          snoozedUntil: new Date(this.now() + OVERLAY_SNOOZE_MS).toISOString(),
        });
        this.hide();
        return { ok: true, error: null };
      case "disable":
        this.updateSettings({ enabled: false, detectionEnabled: false, autoRecord: false });
        this.hide();
        return { ok: true, error: null };
      case "detection-off":
        this.updateSettings({ detectionEnabled: false });
        this.hide();
        return { ok: true, error: null };
      case "dismiss":
        this.suppressUntil = this.now() + OVERLAY_DISMISS_COOLDOWN_MS;
        this.hide();
        return { ok: true, error: null };
      case "open-app":
        this.hide();
        this.deps.focusAppWindow();
        this.deps.sendToApp({ type: "navigate", page: "dashboard" });
        return { ok: true, error: null };
      case "settings":
        this.hide();
        this.deps.focusAppWindow();
        this.deps.sendToApp({ type: "navigate", page: "settings" });
        return { ok: true, error: null };
      default:
        return { ok: false, error: "Unknown overlay action." };
    }
  }

  // -------------------------------------------------------------------------
  // Detection + showing
  // -------------------------------------------------------------------------

  private canDetect(): boolean {
    const s = this.deps.settings.get();
    return (
      this.deps.supported &&
      s.enabled &&
      (s.consent?.given ?? false) &&
      s.detectionEnabled &&
      !isSnoozed(s, this.now())
    );
  }

  private canShow(): boolean {
    if (!this.canDetect()) return false;
    if (this.deps.isMeetingActive()) return false;
    if (this.now() < this.suppressUntil) return false;
    return this.now() - this.lastAutoShowAt >= MIN_SHOW_GAP_MS;
  }

  private onProviderStateChange(state: DetectionState): void {
    switch (state) {
      case "POSSIBLE_CALL":
        if (this.canShow()) this.show();
        break;
      case "CALL_ENDED":
        if (!this.menuOpen) this.hide();
        break;
      default:
        // IDLE or other states – keep the overlay hidden when we are not in a possible call
        if (!this.menuOpen) this.hide();
        break;
    }
  }

  // onActivityChanged is no longer used; kept for backward compatibility if any
  // external code still references it, but it does nothing now.
  private onActivityChanged(_active: boolean): void {
    // no-op – detection state is driven by the provider instead
  }

  private async raiseOnce(): Promise<void> {
    if (!this.canShow()) return;
    const settings = this.deps.settings.get();
    if (settings.autoRecord) {
      await this.startMeetingFromOverlay();
      return;
    }
    this.lastAutoShowAt = this.now();
    this.show();
  }

  /** Show the pill on the display nearest the cursor, at its saved spot. */
  private show(): void {
    const w = this.ensureWindow();
    if (!w) return;
    this.applyBounds();
    if (!w.isVisible()) w.showInactive();
  }

  hide(): void {
    this.menuOpen = false;
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) this.window.hide();
  }

  // -------------------------------------------------------------------------
  // Meeting start (sole entry point - goes through the real meeting service)
  // -------------------------------------------------------------------------

  private async startMeetingFromOverlay(): Promise<{ ok: boolean; error: string | null }> {
    const settings = this.deps.settings.get();
    this.hide();
    this.deps.focusAppWindow();
    const result = await this.deps.startMeeting({
      title: "CallNotes AI meeting",
      sources: settings.sources,
      diarization: true,
    });
    if (result.ok && result.meeting) {
      this.deps.sendToApp({ type: "meeting-started", meetingId: result.meeting.id });
      return { ok: true, error: null };
    }
    const error = result.error ?? { code: "meeting.capture-failed", message: "The meeting could not be started." };
    this.deps.sendToApp({ type: "meeting-failed", error });
    return { ok: false, error: error.message };
  }

  // -------------------------------------------------------------------------
  // Window management
  // -------------------------------------------------------------------------

  private ensureWindow(): BrowserWindow | null {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const w = new BrowserWindow({
      width: OVERLAY_PILL_WIDTH,
      height: OVERLAY_PILL_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      focusable: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    w.setAlwaysOnTop(true, "screen-saver");
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    // OS-native dragging (`-webkit-app-region: drag` in the overlay) moves the
    // window directly; capture the result so it can be re-clamped + persisted.
    w.on("move", () => {
      if (w.isDestroyed()) return;
      const bounds = w.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const clamped = dragOverlay(
        { pos: { x: bounds.x, y: bounds.y }, displayId: display.id },
        { dx: 0, dy: 0 },
        this.workAreas(),
        { width: bounds.width, height: bounds.height },
      );
      this.position = clamped;
      this.schedulePersist();
    });

    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl) {
      void w.loadURL(`${devUrl}/overlay.html`);
    } else {
      void w.loadFile(join(__dirname, "../renderer/overlay.html"));
    }
    this.window = w;
    return this.window;
  }

  private currentRect(): Rect {
    const p = this.position ?? this.resolveDefaultSpot();
    const height = this.menuOpen ? OVERLAY_EXPANDED_HEIGHT : OVERLAY_PILL_HEIGHT;
    return { x: p.pos.x, y: p.pos.y, width: this.size.width, height };
  }

  private resolveDefaultSpot(): { pos: Point; displayId: number } {
    const cursor = screen.getCursorScreenPoint();
    const spot = defaultOverlaySpot(this.workAreas(), { x: cursor.x, y: cursor.y }, this.size);
    this.position = { pos: spot.pos, displayId: spot.displayId };
    return this.position;
  }

  private applyBounds(): void {
    const w = this.window;
    if (!w || w.isDestroyed()) return;
    const p = this.position ?? this.resolveDefaultSpot();
    const height = this.menuOpen ? OVERLAY_EXPANDED_HEIGHT : OVERLAY_PILL_HEIGHT;
    const width = this.size.width;
    const display = this.workAreas().find((d) => d.displayId === p.displayId) ?? this.workAreas()[0];
    if (display) {
      // Re-clamp on every geometry change so hot-plugged/rotated displays
      // never leave the pill dangling outside a work area.
      const next = dragOverlay({ pos: p.pos, displayId: p.displayId }, { dx: 0, dy: 0 }, this.workAreas(), {
        width,
        height,
      });
      this.position = next;
      w.setBounds({
        x: next.pos.x,
        y: next.pos.y,
        width,
        height,
      });
      return;
    }
    w.setBounds({ x: p.pos.x, y: p.pos.y, width, height });
  }

  private workAreas(): WorkArea[] {
    return screen.getAllDisplays().map((d) => ({
      displayId: d.id,
      x: d.workArea.x,
      y: d.workArea.y,
      width: d.workArea.width,
      height: d.workArea.height,
    }));
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.position) return;
      const settings = this.deps.settings.get();
      this.deps.settings.replace({
        ...settings,
        position: { x: this.position.pos.x, y: this.position.pos.y, displayId: this.position.displayId },
      });
    }, 150);
  }

  // -------------------------------------------------------------------------
  // Detection lifecycle
  // -------------------------------------------------------------------------

  private syncDetection(): void {
    const shouldRun = this.canDetect();
    if (shouldRun && this.provider) {
      this.provider.start();
    } else if (!shouldRun && this.provider) {
      this.provider.stop();
      this.provider = null;
    }
    this.scheduleSnoozeWake();
  }

  /** Restart detection once a snooze expires (no event source otherwise). */
  private scheduleSnoozeWake(): void {
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
    this.snoozeTimer = null;
    const s = this.deps.settings.get();
    if (!s.snoozedUntil) return;
    const at = Date.parse(s.snoozedUntil);
    if (Number.isNaN(at)) return;
    const delay = Math.max(0, at - this.now());
    this.snoozeTimer = setTimeout(() => {
      this.snoozeTimer = null;
      this.syncDetection();
    }, Math.min(delay, 2147483647));
  }

  dispose(): void {
    this.provider?.stop();
    this.provider = null;
    this.detectActive = false;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
    this.hide();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}