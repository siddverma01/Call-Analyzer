import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_OVERLAY_SOURCES,
  type AudioCaptureKind,
  type OverlayConsent,
  type OverlaySettings,
  type OverlaySettingsUpdate,
  type OverlayState,
} from "@callnotes/shared";

/** Mutable parts of a stored position (used by drag + defaults). */
export interface OverlayPosition {
  x: number;
  y: number;
  displayId: number;
}

export function defaultOverlaySettings(): OverlaySettings {
  return {
    enabled: false,
    consent: { given: false, acknowledgedAt: null },
    detectionEnabled: false,
    autoRecord: false,
    sources: [...DEFAULT_OVERLAY_SOURCES],
    snoozedUntil: null,
    position: null,
  };
}

/** True when a stored snooze timestamp is still in the future. */
export function isSnoozed(settings: OverlaySettings, now: number): boolean {
  if (!settings.snoozedUntil) return false;
  const at = Date.parse(settings.snoozedUntil);
  if (Number.isNaN(at)) return false;
  return at > now;
}

/**
 * Applies a renderer-supplied settings patch, dropping anything that is
 * malformed or not part of the allow-list. Never trusts the renderer blindly.
 */
export function applyOverlayUpdate(
  current: OverlaySettings,
  patch: OverlaySettingsUpdate,
  now: number,
): OverlaySettings {
  const next: OverlaySettings = {
    ...current,
    sources: [...current.sources],
  };

  if (typeof patch.enabled === "boolean") {
    next.enabled = patch.enabled;
    if (!next.enabled) {
      next.detectionEnabled = false;
      next.autoRecord = false;
    }
  }

  if (patch.consent !== undefined) {
    const consent: OverlayConsent = current.consent
      ? { ...current.consent }
      : { given: false, acknowledgedAt: null };
    if (patch.consent === true && !consent.given) {
      consent.given = true;
      consent.acknowledgedAt = new Date(now).toISOString();
    } else if (patch.consent === false) {
      // Consent can be revoked: disabling also stops detection.
      consent.given = false;
      consent.acknowledgedAt = null;
    }
    next.consent = consent;
    if (!next.consent.given) {
      next.detectionEnabled = false;
      next.autoRecord = false;
    }
  }

  if (typeof patch.detectionEnabled === "boolean") {
    next.detectionEnabled = patch.detectionEnabled && next.consent.given && next.enabled;
    if (!next.detectionEnabled) next.autoRecord = false;
  }
  if (typeof patch.autoRecord === "boolean") {
    next.autoRecord = patch.autoRecord && next.detectionEnabled;
  }

  if (Array.isArray(patch.sources)) {
    const allowed = new Set<AudioCaptureKind>(["microphone", "loopback"]);
    const deduped = Array.from(new Set(patch.sources.filter((s): s is AudioCaptureKind => allowed.has(s))));
    next.sources = deduped.length > 0 ? deduped : [...DEFAULT_OVERLAY_SOURCES];
  }

  if (patch.snoozedUntil === null || typeof patch.snoozedUntil === "string") {
    next.snoozedUntil = patch.snoozedUntil;
  }

  return next;
}

/** Flattens settings into the read-only snapshot the renderer can see. */
export function toOverlayState(settings: OverlaySettings, supported: boolean, recording: boolean): OverlayState {
  return {
    supported,
    enabled: settings.enabled,
    consentGiven: settings.consent?.given ?? false,
    detectionEnabled: settings.detectionEnabled,
    autoRecord: settings.autoRecord,
    sources: settings.sources,
    snoozedUntil: settings.snoozedUntil,
    recording,
  };
}

export interface OverlaySettingsStoreDeps {
  settingsPath: string;
}

/** Loads + persists overlay preferences as JSON in userData. */
export class OverlaySettingsStore {
  private settings: OverlaySettings;

  constructor(private readonly deps: OverlaySettingsStoreDeps) {
    this.settings = { ...defaultOverlaySettings(), ...this.read() };
  }

  get(): OverlaySettings {
    return this.settings;
  }

  update(patch: OverlaySettingsUpdate): OverlaySettings {
    this.settings = applyOverlayUpdate(this.settings, patch, Date.now());
    this.persist();
    return this.settings;
  }

  /** Replace wholesale (used to persist the dragged position). */
  replace(next: OverlaySettings): void {
    this.settings = { ...defaultOverlaySettings(), ...next };
    this.persist();
  }

  private read(): Partial<OverlaySettings> {
    try {
      if (!existsSync(this.deps.settingsPath)) return {};
      const raw = JSON.parse(readFileSync(this.deps.settingsPath, "utf8")) as Partial<OverlaySettings>;
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.deps.settingsPath), { recursive: true });
      writeFileSync(this.deps.settingsPath, JSON.stringify(this.settings, null, 2), "utf8");
    } catch {
      // preferences persistence is best-effort; never fail the IPC on it
    }
  }
}