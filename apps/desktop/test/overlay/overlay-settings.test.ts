import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OverlaySettingsStore,
  applyOverlayUpdate,
  defaultOverlaySettings,
  isSnoozed,
  toOverlayState,
} from "../../src/main/overlay/overlay-settings";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

describe("applyOverlayUpdate", () => {
  it("keeps defaults untouched when no fields are provided", () => {
    const next = applyOverlayUpdate(defaultOverlaySettings(), {}, NOW);
    expect(next).toEqual(defaultOverlaySettings());
  });

  it("toggles the master switch", () => {
    const next = applyOverlayUpdate(defaultOverlaySettings(), { enabled: true }, NOW);
    expect(next.enabled).toBe(true);
  });

  it("consent cannot enable detection for the first time (gating stays off)", () => {
    const next = applyOverlayUpdate(defaultOverlaySettings(), { detectionEnabled: true }, NOW);
    expect(next.detectionEnabled).toBe(false);
    expect(next.autoRecord).toBe(false);
  });

  it("granting consent records the acknowledgement timestamp once", () => {
    const next = applyOverlayUpdate(defaultOverlaySettings(), { consent: true }, NOW);
    expect(next.consent.given).toBe(true);
    expect(next.consent.acknowledgedAt).toBe(new Date(NOW).toISOString());
    const again = applyOverlayUpdate(next, { consent: true }, NOW + 1000);
    expect(again.consent.acknowledgedAt).toBe(new Date(NOW).toISOString());
  });

  it("detection requires consent and enable; autoRecord requires detection", () => {
    const base = applyOverlayUpdate(defaultOverlaySettings(), { consent: true, enabled: true }, NOW);
    expect(base.consent.given).toBe(true);
    const withDetection = applyOverlayUpdate(base, { detectionEnabled: true }, NOW);
    expect(withDetection.detectionEnabled).toBe(true);
    const withAuto = applyOverlayUpdate(withDetection, { autoRecord: true }, NOW);
    expect(withAuto.autoRecord).toBe(true);
    const backOff = applyOverlayUpdate(withAuto, { enabled: false }, NOW);
    expect(backOff.detectionEnabled).toBe(false);
    expect(backOff.autoRecord).toBe(false);
  });

  it("revoking consent disables detection and auto-record", () => {
    const base = applyOverlayUpdate(defaultOverlaySettings(), { consent: true, enabled: true, detectionEnabled: true }, NOW);
    const revoked = applyOverlayUpdate(applyOverlayUpdate(base, { autoRecord: true }, NOW), { consent: false }, NOW);
    expect(revoked.consent.given).toBe(false);
    expect(revoked.detectionEnabled).toBe(false);
    expect(revoked.autoRecord).toBe(false);
  });

  it("only accepts the allow-listed audio sources, deduplicated", () => {
    const next = applyOverlayUpdate(defaultOverlaySettings(), { sources: ["loopback", "microphone", "loopback"] }, NOW);
    expect(next.sources).toEqual(["loopback", "microphone"]);
    const junk = applyOverlayUpdate(defaultOverlaySettings(), { sources: ["microphone", "camera" as never] }, NOW);
    expect(junk.sources).toEqual(["microphone"]);
    const empty = applyOverlayUpdate(defaultOverlaySettings(), { sources: [] }, NOW);
    expect(empty.sources).toEqual(["microphone", "loopback"]);
  });

  it("stores a valid snooze timestamp and clears it with null", () => {
    const until = new Date(NOW + 60000).toISOString();
    const snoozed = applyOverlayUpdate(defaultOverlaySettings(), { snoozedUntil: until }, NOW);
    expect(snoozed.snoozedUntil).toBe(until);
    expect(isSnoozed(snoozed, NOW)).toBe(true);
    expect(isSnoozed(snoozed, NOW + 120000)).toBe(false);
    const cleared = applyOverlayUpdate(snoozed, { snoozedUntil: null }, NOW);
    expect(cleared.snoozedUntil).toBeNull();
  });
});

describe("toOverlayState", () => {
  it("flattens a snapshot without leaking the internal consent record", () => {
    const settings = applyOverlayUpdate(defaultOverlaySettings(), { consent: true, enabled: true, detectionEnabled: true }, NOW);
    const state = toOverlayState(settings, true, true);
    expect(state).toEqual({
      supported: true,
      enabled: true,
      consentGiven: true,
      detectionEnabled: true,
      autoRecord: false,
      sources: ["microphone", "loopback"],
      snoozedUntil: null,
      recording: true,
    });
  });
});

describe("OverlaySettingsStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips settings through disk and reads them back", () => {
    dir = mkdtempSync(join(tmpdir(), "callnotes-overlay-"));
    const path = join(dir, "overlay.json");
    const store = new OverlaySettingsStore({ settingsPath: path });
    store.update({ consent: true, enabled: true, detectionEnabled: true, autoRecord: true });

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).consent.given).toBe(true);

    const reloaded = new OverlaySettingsStore({ settingsPath: path });
    expect(reloaded.get().enabled).toBe(true);
    expect(reloaded.get().consent.given).toBe(true);
    expect(reloaded.get().detectionEnabled).toBe(true);
    expect(reloaded.get().autoRecord).toBe(true);
  });

  it("persists an explicit dragged position", () => {
    dir = mkdtempSync(join(tmpdir(), "callnotes-overlay-"));
    const store = new OverlaySettingsStore({ settingsPath: join(dir, "overlay.json") });
    store.replace({ ...store.get(), position: { x: 700, y: 120, displayId: 2 } });
    const reloaded = new OverlaySettingsStore({ settingsPath: join(dir, "overlay.json") });
    expect(reloaded.get().position).toEqual({ x: 700, y: 120, displayId: 2 });
  });
});