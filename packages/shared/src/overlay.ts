/**
 * Contract for the floating "CallNotes AI assistant" overlay.
 *
 * The overlay is a separate, always-on-top, transparent Electron window that is
 * shown over the current application when the WASAPI loopback capture hears
 * sustained call-like sound (or once the user has explicitly asked to start AI
 * meeting notes). It is only a launcher: it never captures, transcribes, or
 * analyzes audio itself, and it never loads the Whisper/LLM engines. Starting
 * a meeting routes through the same meeting flow as the app, with the user's
 * explicit consent and an explicit user action (no silent capture).
 */

import type { AudioCaptureKind } from "./audio.js";

/** Tracks the microphone + system-audio consent given by the user. */
export interface OverlayConsent {
  /** True once the user has acknowledged mic + system-audio capture. */
  given: boolean;
  /** ISO timestamp of the first acknowledgement. */
  acknowledgedAt: string | null;
}

/** Persisted overlay preferences (main process only). */
export interface OverlaySettings {
  /** Master switch for the overlay feature. */
  enabled: boolean;
  /** Whether the user has consented to mic + system-audio capture. */
  consent: OverlayConsent;
  /** Whether automatic call-detection is on (still requires consent + enable). */
  detectionEnabled: boolean;
  /** When true, a detected call starts a meeting immediately (explicit opt-in). */
  autoRecord: boolean;
  /** Sources used when starting AI meeting notes from the overlay. */
  sources: AudioCaptureKind[];
  /** ISO timestamp until which the overlay stays hidden, or null. */
  snoozedUntil: string | null;
  /** Last drag position (display-local DIPs); null to use the default spot. */
  position: { x: number; y: number; displayId: number } | null;
}

/** Read-only snapshot pushed to the renderer whenever settings change. */
export interface OverlayState {
  supported: boolean;
  enabled: boolean;
  consentGiven: boolean;
  detectionEnabled: boolean;
  autoRecord: boolean;
  sources: AudioCaptureKind[];
  snoozedUntil: string | null;
  /** True while a meeting is recording (the overlay is suppressed then). */
  recording: boolean;
}

/** Aggregated flags the detector UI / logic can rely on. */
export interface OverlayFlags {
  enabled: boolean;
  consentGiven: boolean;
  detectionEnabled: boolean;
  snoozedUntil: string | null;
  /** True while a meeting is recording. */
  recording: boolean;
}

/**
 * Settings fields the renderer is allowed to patch. Every field is optional -
 * a partial patch only touches the keys it carries; `consent` revokes or
 * grants the capture acknowledgement.
 */
export type OverlaySettingsUpdate = Partial<
  Pick<OverlaySettings, "enabled" | "detectionEnabled" | "autoRecord" | "sources" | "snoozedUntil">
> & {
  consent?: boolean;
};

/** User actions the floating overlay can issue. */
export type OverlayAction =
  | "start-meeting"
  | "snooze"
  | "disable"
  | "detection-off"
  | "dismiss"
  | "open-app"
  | "settings";

/** Events pushed from main to the main renderer about overlay-triggered work. */
export type OverlayEvent =
  | { type: "meeting-started"; meetingId: string }
  | { type: "meeting-failed"; error: { code: string; message: string } }
  | { type: "navigate"; page: "new-meeting" | "settings" | "dashboard" };

/** Fixed content-area size of the collapsed floating pill (CSS px = DIPs). */
export const OVERLAY_PILL_WIDTH = 352;
export const OVERLAY_PILL_HEIGHT = 58;

/** Height of the expanded window (pill + menu rows + footer padding). */
export const OVERLAY_EXPANDED_HEIGHT = 348;

/** How close to a display edge the pill can sit (DIPs). */
export const OVERLAY_EDGE_MARGIN = 16;

export const DEFAULT_OVERLAY_SOURCES: AudioCaptureKind[] = ["microphone", "loopback"];

export const OVERLAY_SNOOZE_MS = 30 * 60 * 1000;
export const OVERLAY_DISMISS_COOLDOWN_MS = 2 * 60 * 1000;