/**
 * Live integration test against the real WASAPI addon.
 * Runs ONLY when `RUN_LIVE_AUDIO=1` on a Windows host with the addon built
 * (`npm run build:wasapi`). Exercises real device enumeration, microphone
 * capture, loopback capture, and the AudioService end-to-end. Uses the real
 * machine's devices - audio stays in memory, nothing is recorded to disk.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "C:/DATA/coding/Live Transcribe",
  },
}));

const liveEligible = process.platform === "win32" && process.env["RUN_LIVE_AUDIO"] === "1";

describe.skipIf(!liveEligible)("live WASAPI audio (RUN_LIVE_AUDIO=1)", () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const settingsDir = mkdtempSync(join(tmpdir(), "callnotes-live-audio-"));
  const recordingsDir = mkdtempSync(join(tmpdir(), "callnotes-live-audio-rec-"));

  afterAll(() => {
    try {
      rmSync(settingsDir, { recursive: true, force: true });
      rmSync(recordingsDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("loads the native addon and enumerates real devices", async () => {
    const { loadNativeAddon } = await import("../../src/main/audio/native-loader");
    const addon = loadNativeAddon();
    const inputs = addon.enumerateDevices("input");
    const outputs = addon.enumerateDevices("output");
    expect(inputs.length).toBeGreaterThan(0);
    expect(outputs.length).toBeGreaterThan(0);
    const activeInput = inputs.find((d) => d.state === "active");
    if (activeInput) {
      expect(activeInput.sampleRate).toBeGreaterThan(0);
      expect(activeInput.channels).toBeGreaterThan(0);
    }
  });

  it("captures real microphone audio into the canonical pipeline", async () => {
    const { loadNativeAddon } = await import("../../src/main/audio/native-loader");
    const addon = loadNativeAddon();
    const mic = addon.enumerateDevices("input").find((d) => d.state === "active");
    if (!mic) return; // no physical mic on this machine

    const frames: number[] = [];
    const levels: number[] = [];
    const { WindowsAudioCapture } = await import("../../src/main/audio/audio-capture");
    const capture = new WindowsAudioCapture({
      kind: "microphone",
      deviceId: mic.id,
      processingRate: 16_000,
      callbacks: {
        onFrames: ({ frames: f }) => frames.push(f.length),
        onLevels: (l) => levels.push(l.rms),
        onError: (e) => {
          throw e;
        },
      },
    });
    capture.start();
    await sleep(1_000);
    capture.dispose();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toBeGreaterThan(0);
    expect(levels.length).toBeGreaterThan(0);
  });

  it("captures real system audio loopback end-to-end through AudioService monitoring", async () => {
    const { AudioService } = await import("../../src/main/audio/audio-service");
    const settingsPath = join(settingsDir, "settings.json");
    const meters: unknown[] = [];
    const service = new AudioService({
      settingsPath,
      recordingsDir,
      sendMeters: (event) => meters.push(event),
    });

    const info = service.info();
    expect(info.mic.state).toBe("connected");
    expect(info.systemAudio.state).toBe("available");

    service.startMonitoring();
    await sleep(1_500);
    service.stopMonitoring();
    expect(meters.length).toBeGreaterThan(0);
  });

  it("runs a real 3s mic test without persisting audio", async () => {
    const { AudioService } = await import("../../src/main/audio/audio-service");
    const service = new AudioService({
      settingsPath: join(settingsDir, "settings.json"),
      recordingsDir,
      sendMeters: () => {},
    });

    const result = await service.micTest(null);
    expect(result.rms).toBeGreaterThanOrEqual(0);
    expect(result.peak).toBeGreaterThanOrEqual(0);

    // micTest persists nothing (only selectMic writes device preferences), and
    // no audio artifacts are produced anywhere under the settings dir
    expect(readdirSync(settingsDir)).toEqual([]);
  });
});

describe.skipIf(liveEligible)("live WASAPI instrumentation", () => {
  it("is skipped unless RUN_LIVE_AUDIO=1 on Windows", () => {
    expect.anything();
  });
});