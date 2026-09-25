import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { NativeAudioAddon, NativeSessionInfo } from "../../src/main/audio/types";
import {
  hasRecordingDir,
  listChunkFiles,
  readManifest,
  recordingFrameCount,
  removeRecordingDir,
  writeManifest,
} from "../../src/main/audio/dsp/pcm-chunks";

interface FakeSession {
  info: NativeSessionInfo;
  started: boolean;
  released: boolean;
}

const fake = vi.hoisted(() => {
  const sessions = new Map<number, FakeSession>();
  let nextId = 1;
  let mode: "tone" | "silence" | "none" = "none";
  let emptyDevices = false;

  const addon: NativeAudioAddon = {
    enumerateDevices: (flow) => {
      if (emptyDevices) return [];
      return [
        {
          id: "mic-1",
          name: "Fake Microphone",
          state: "active",
          isDefault: true,
          channels: 1,
          sampleRate: 48000,
        },
        {
          id: "mic-2",
          name: "Fake Mic (disabled)",
          state: "disabled",
          isDefault: false,
          channels: 0,
          sampleRate: 0,
        },
      ];
    },
    createSession: (opts) => {
      const info: NativeSessionInfo = {
        id: nextId++,
        sampleRate: 48000,
        channels: 1,
        format: "f32",
        bufferMs: opts.bufferMs ?? 250,
      };
      sessions.set(info.id, { info, started: false, released: false });
      return info;
    },
    sessionStart: (id) => {
      const s = sessions.get(id);
      if (!s) throw new Error("session not found");
      s.started = true;
      return false;
    },
    sessionStop: (id) => {
      const s = sessions.get(id);
      if (!s) throw new Error("session not found");
      s.started = false;
      return true;
    },
    sessionPull: (id, max) => {
      const s = sessions.get(id);
      if (!s || !s.started) return null;
      if (mode === "none") return null;
      const frames = Math.min(max || 4800, 4800);
      const out = new Float32Array(frames);
      if (mode === "tone") {
        for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.4;
      }
      return out;
    },
    sessionRelease: (id) => {
      const s = sessions.get(id);
      if (!s) throw new Error("session not found");
      s.released = true;
      sessions.delete(id);
      return true;
    },
    sessionInfo: (id) => {
      const s = sessions.get(id);
      if (!s) throw new Error("session not found");
      return s.info;
    },
  };

  return {
    addon,
    sessions,
    get mode() {
      return mode;
    },
    setMode: (m: "tone" | "silence" | "none") => {
      mode = m;
    },
    setEmptyDevices: (value: boolean) => {
      emptyDevices = value;
    },
  };
});

vi.mock("../../src/main/audio/native-loader.js", () => ({
  loadNativeAddon: () => fake.addon,
  nativeAvailable: () => true,
  nativeAddonPath: () => "fake.node",
  nativeSessionInfo: (id: number) => fake.addon.sessionInfo(id),
}));

import { AudioService } from "../../src/main/audio/audio-service";

let settingsDir: string;
let recordingsDir: string;

beforeAll(() => {
  settingsDir = mkdtempSync(join(tmpdir(), "callnotes-audio-test-"));
  recordingsDir = join(settingsDir, "recordings");
});

beforeEach(() => {
  fake.sessions.clear();
  fake.setMode("none");
  fake.setEmptyDevices(false);
  vi.useFakeTimers();
});

describe("AudioService.info()", () => {
  it("reports connected mic and available system audio from real devices", () => {
    const sendMeters = vi.fn();
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters });
    const info = service.info();
    expect(info.mic.state).toBe("connected");
    expect(info.mic.devices.some((d) => d.id === "mic-1" && d.isDefault)).toBe(true);
    expect(info.systemAudio.state).toBe("available");
    expect(sendMeters).not.toHaveBeenCalled();
  });

  it("reports not-connected when the system has no active endpoints", () => {
    fake.setEmptyDevices(true);
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters: vi.fn() });
    const info = service.info();
    expect(info.mic.state).toBe("not-connected");
    expect(info.systemAudio.state).toBe("unavailable");
  });
});

describe("AudioService.selectMic()", () => {
  it("persists the chosen device id to disk (preferences only, never audio)", () => {
    const settingsPath = join(settingsDir, `settings-${Date.now()}.json`);
    const service = new AudioService({ settingsPath, recordingsDir, sendMeters: vi.fn() });
    const info = service.selectMic("mic-1");
    expect(info.mic.selectedDeviceId).toBe("mic-1");
    const persisted = JSON.parse(readFileSync(settingsPath, "utf8")) as { selectedMicDeviceId: string | null };
    expect(persisted.selectedMicDeviceId).toBe("mic-1");
  });

  it("accepts null to fall back to the OS default", () => {
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters: vi.fn() });
    expect(service.selectMic(null).mic.selectedDeviceId).toBeNull();
  });
});

describe("AudioService.micTest()", () => {
  it("hears a tone and reports measured levels", async () => {
    fake.setMode("tone");
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters: vi.fn() });
    const promise = service.micTest(null);
    await vi.advanceTimersByTimeAsync(3_200);
    const result = await promise;
    expect(result.heardVoice).toBe(true);
    expect(result.rms).toBeGreaterThan(0);
    expect(result.durationSeconds).toBe(3);
    // all sessions (probe + test) must be released afterwards
    expect(fake.sessions.size).toBe(0);
  });

  it("reports no voice on silence", async () => {
    fake.setMode("silence");
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters: vi.fn() });
    const promise = service.micTest(null);
    await vi.advanceTimersByTimeAsync(3_200);
    const result = await promise;
    expect(result.heardVoice).toBe(false);
    expect(result.rms).toBe(0);
  });
});

describe("AudioService monitoring", () => {
  it("pushes live meter events while monitoring and clears them on stop", async () => {
    fake.setMode("tone");
    const sendMeters = vi.fn();
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters });

    service.startMonitoring();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sendMeters).toHaveBeenCalled();
    const withSignal = sendMeters.mock.calls.map(([e]) => e).filter((e) => e.mic?.hasSignal);
    expect(withSignal.length).toBeGreaterThan(0);

    const activeSessions = fake.sessions.size;
    expect(activeSessions).toBe(2); // mic + loopback

    service.stopMonitoring();
    expect(fake.sessions.size).toBe(0);
    const last = sendMeters.mock.calls.at(-1)?.[0];
    expect(last.mic).toBeNull();
    expect(last.systemAudio).toBeNull();
  });

  it("switching the device restarts monitoring on the new session", async () => {
    fake.setMode("tone");
    const sendMeters = vi.fn();
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters });
    service.selectMic("mic-1");
    service.startMonitoring();
    await vi.advanceTimersByTimeAsync(500);
    service.selectMic("mic-2");
    expect(fake.sessions.size).toBe(2);
    service.stopMonitoring();
  });
});

describe("AudioService meeting capture", () => {
  it("writes chunk files and a recording manifest, then finalizes it", async () => {
    fake.setMode("tone");
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters: vi.fn() });
    const meetingDir = join(recordingsDir, "m-1");

    service.startMeeting("m-1", ["microphone", "loopback"]);
    expect(hasRecordingDir(meetingDir)).toBe(true);
    const writing = readManifest(meetingDir)!;
    expect(writing.meetingId).toBe("m-1");
    expect(writing.sources).toEqual(["microphone", "loopback"]);
    expect(writing.status).toBe("recording");

    await vi.advanceTimersByTimeAsync(40_000);
    const micDir = join(meetingDir, "microphone");
    const loopDir = join(meetingDir, "loopback");
    // 16 kHz * 60 s = 960000 samples per chunk; a full chunk flushes every 18 s
    expect(recordingFrameCount(micDir)).toBeGreaterThan(0);
    expect(recordingFrameCount(loopDir)).toBeGreaterThan(0);
    expect(listChunkFiles(micDir).length).toBeGreaterThanOrEqual(2);

    const snapshot = service.finishMeeting();
    expect(snapshot).not.toBeNull();
    const micStream = snapshot!.streams.find((s) => s.kind === "microphone");
    expect(micStream!.frameCount).toBeGreaterThan(0);
    expect(readManifest(meetingDir)!.status).toBe("recorded");
    expect(service.monitoring).toBe(false);

    removeRecordingDir(meetingDir);
  });

  it("throws recording-space errors before capture when the disk is too full", () => {
    const service = new AudioService({
      settingsPath: join(settingsDir, "settings.json"),
      recordingsDir,
      sendMeters: vi.fn(),
      freeBytes: () => 10 * 1024,
    });
    expect(() => service.startMeeting("m-full", ["microphone"])).toThrow(/Not enough free disk space/);
    expect(service.finishMeeting()).toBeNull();
    expect(service.monitoring).toBe(false);
  });

  it("projects temporary disk usage for the selected sources", () => {
    const service = new AudioService({
      settingsPath: join(settingsDir, "settings.json"),
      recordingsDir,
      sendMeters: vi.fn(),
      freeBytes: () => 8 * 1024 ** 3,
    });
    const est = service.estimateRecordingSpace(["microphone", "loopback"], 4 * 60 * 60);
    expect(est.bytesPerSecond).toBe(16_000 * 4 * 2);
    expect(est.estimatedBytes).toBe(16_000 * 4 * 2 * 14_400);
    expect(est.availableBytes).toBe(8 * 1024 ** 3);
    expect(est.minimumRequiredBytes).toBe(16_000 * 4 * 2 * 1_800 + 128 * 1024 * 1024);
    expect(est.sufficient).toBe(true);
  });

  it("drops frames while paused but keeps the capture streams warm", async () => {
    fake.setMode("tone");
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters: vi.fn() });
    const micDir = join(recordingsDir, "m-pause", "microphone");

    service.startMeeting("m-pause", ["microphone"]);
    // one chunk flushes after 18 s of captures; pause must stop further writes
    await vi.advanceTimersByTimeAsync(19_000);
    const before = recordingFrameCount(micDir);
    expect(before).toBeGreaterThan(0);

    service.pauseMeeting();
    await vi.advanceTimersByTimeAsync(5_000);
    const during = recordingFrameCount(micDir);
    expect(during).toBe(before);
    // capture streams stay warm while paused (mic + loopback sessions)
    expect(fake.sessions.size).toBe(2);

    service.resumeMeeting();
    await vi.advanceTimersByTimeAsync(19_000);
    const after = recordingFrameCount(micDir);
    expect(after).toBeGreaterThan(during);

    removeRecordingDir(join(recordingsDir, "m-pause"));
  });

  it("reports real live usage while recording and null when idle", async () => {
    fake.setMode("tone");
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters: vi.fn() });
    expect(service.recordingUsage()).toBeNull();

    service.startMeeting("m-usage", ["microphone", "loopback"]);
    await vi.advanceTimersByTimeAsync(5_000);
    const usage = service.recordingUsage();
    expect(usage).not.toBeNull();
    // 16 kHz mono float32: each sample equals 4 bytes on disk
    expect(usage!.frameCount).toBeGreaterThan(0);
    expect(usage!.bytesWritten).toBe(usage!.frameCount * 4);
    expect(usage!.paused).toBe(false);
    expect(usage!.streams.map((s) => s.kind).sort()).toEqual(["loopback", "microphone"]);
    expect(usage!.streams.every((s) => s.frameCount > 0)).toBe(true);

    service.pauseMeeting();
    const before = service.recordingUsage()!.frameCount;
    await vi.advanceTimersByTimeAsync(2_000);
    const during = service.recordingUsage()!;
    expect(during.paused).toBe(true);
    expect(during.frameCount).toBe(before);

    service.resumeMeeting();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(service.recordingUsage()!.frameCount).toBeGreaterThan(during.frameCount);

    service.finishMeeting();
    expect(service.recordingUsage()).toBeNull();
    removeRecordingDir(join(recordingsDir, "m-usage"));
  });

  it("aborts capture and reports the error when a chunk write fails", async () => {
    fake.setMode("tone");
    const onError = vi.fn();
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters: vi.fn() });
    // A directory squatting on the first chunk name forces the flush to fail.
    const streamDir = join(recordingsDir, "m-fail", "microphone");
    mkdirSync(streamDir, { recursive: true });
    mkdirSync(join(streamDir, "000000.pcm"));

    service.startMeeting("m-fail", ["microphone"], { onError });
    // the first chunk flushes after 18 s of captures and hits the squatting dir
    await vi.advanceTimersByTimeAsync(19_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    // capture was aborted and the recording finalized (files preserved for retry)
    expect(service.finishMeeting()).toBeNull();
    expect(service.monitoring).toBe(false);

    removeRecordingDir(join(recordingsDir, "m-fail"));
  });

  it("starts the next meeting unpaused even when the previous session was paused", () => {
    fake.setMode("tone");
    const service = new AudioService({ settingsPath: join(settingsDir, "settings.json"), recordingsDir, sendMeters: vi.fn() });

    service.startMeeting("m-paused-first", ["microphone"]);
    service.pauseMeeting();
    expect(service.recordingUsage()!.paused).toBe(true);
    service.finishMeeting();
    removeRecordingDir(join(recordingsDir, "m-paused-first"));

    // A fresh meeting must not inherit the previous session's paused state.
    service.startMeeting("m-paused-next", ["microphone"]);
    expect(service.recordingUsage()).not.toBeNull();
    expect(service.recordingUsage()!.paused).toBe(false);
    service.finishMeeting();
    removeRecordingDir(join(recordingsDir, "m-paused-next"));
  });

  it("sweeps stray files at startup but preserves real recordings", () => {
    const sweepRoot = join(settingsDir, "sweep-only");
    const recordings = join(sweepRoot, "recordings");
    mkdirSync(recordings, { recursive: true });
    const keepDir = join(recordings, "keep");
    writeManifest(keepDir, {
      version: 1,
      meetingId: "keep",
      createdAt: Date.now(),
      sampleRate: 16_000,
      sources: ["microphone"],
      status: "recorded",
    });
    mkdirSync(join(keepDir, "microphone"), { recursive: true });
    writeFileSync(join(keepDir, "microphone", "000000.pcm"), Buffer.alloc(16 * 4));
    mkdirSync(join(recordings, "stray-orphan"));
    writeFileSync(join(recordings, "stray-orphan", "000000.pcm"), Buffer.alloc(16 * 4));
    writeFileSync(join(recordings, "loose.bin"), Buffer.alloc(16));

    const service = new AudioService({ settingsPath: join(sweepRoot, "settings.json"), recordingsDir: recordings, sendMeters: vi.fn() });
    expect(hasRecordingDir(keepDir)).toBe(true);
    expect(recordingFrameCount(join(keepDir, "microphone"))).toBeGreaterThan(0);
    expect(hasRecordingDir(join(recordings, "stray-orphan"))).toBe(false);
    expect(existsSync(join(recordings, "loose.bin"))).toBe(false);
    service.dispose();
  });
});