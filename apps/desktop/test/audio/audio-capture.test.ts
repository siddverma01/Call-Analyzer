import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { NativeAudioAddon, NativeSessionInfo } from "../../src/main/audio/types";

interface FakeSession {
  info: NativeSessionInfo;
  started: boolean;
  pull: (() => Float32Array | null) | null;
  released: boolean;
  failPullWith: Error | null;
}

const fake = vi.hoisted(() => {
  const sessions = new Map<number, FakeSession>();
  let nextId = 1;
  const addon: NativeAudioAddon = {
    enumerateDevices: (flow) =>
      flow === "input"
        ? [
            {
              id: "mic-1",
              name: "Fake Microphone",
              state: "active",
              isDefault: true,
              channels: 2,
              sampleRate: 48000,
            },
          ]
        : [
            {
              id: "out-1",
              name: "Fake Speakers",
              state: "active",
              isDefault: true,
              channels: 2,
              sampleRate: 48000,
            },
          ],
    createSession: (opts) => {
      const info: NativeSessionInfo = {
        id: nextId++,
        sampleRate: 48000,
        channels: 2,
        format: "f32",
        bufferMs: opts.bufferMs ?? 250,
      };
      sessions.set(info.id, { info, started: false, pull: null, released: false, failPullWith: null });
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
    sessionPull: defaultPull,
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
  const state = { addon, sessions, pullQueue: null as Float32Array | null, defaultPull };
  return state;
});

function defaultPull(id: number, _max: number): Float32Array | null {
  const s = fake.sessions.get(id);
  if (!s) throw new Error("session not found");
  if (s.failPullWith) throw s.failPullWith;
  if (!s.pull) return null;
  const result = s.pull();
  s.pull = null; // single realistic drain per test act
  return result;
}

function newSinePull(frames = 4800, channels = 2, amplitude = 0.5): Float32Array {
  const monoFrames = frames;
  const out = new Float32Array(monoFrames * channels);
  for (let f = 0; f < monoFrames; f++) {
    const v = Math.sin((2 * Math.PI * 440 * f) / 48000) * amplitude;
    for (let c = 0; c < channels; c++) out[f * channels + c] = v;
  }
  return out;
}

vi.mock("../../src/main/audio/native-loader.js", () => ({
  loadNativeAddon: () => fake.addon,
  nativeAvailable: () => true,
  nativeAddonPath: () => "fake.node",
  nativeSessionInfo: (id: number) => fake.addon.sessionInfo(id),
}));

import { WindowsAudioCapture } from "../../src/main/audio/audio-capture";

beforeEach(() => {
  fake.sessions.clear();
  fake.pullQueue = null;
  fake.addon.sessionPull = fake.defaultPull;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WindowsAudioCapture", () => {
  it("opens a session and reports native format", () => {
    const capture = new WindowsAudioCapture({
      kind: "microphone",
      callbacks: { onFrames: () => {}, onLevels: () => {}, onError: () => {} },
    });
    expect(capture.sampleRate).toBe(48000);
    expect(capture.channels).toBe(2);
    expect(capture.processingRate).toBe(16000);
    expect(capture.state).toBe("idle");
    capture.dispose();
    expect(fake.sessions.size).toBe(0);
  });

  it("streams canonical mono frames and live levels (real DSP)", async () => {
    fake.addon.sessionPull = (id: number) => {
      const s = fake.sessions.get(id);
      if (!s || !s.started) return null;
      if (!fake.pullQueue) return null;
      const chunk = fake.pullQueue;
      fake.pullQueue = null;
      return chunk;
    };
    const framesSeen: number[] = [];
    const levelsSeen: number[] = [];
    let frameCount = 0;
    const capture = new WindowsAudioCapture({
      kind: "microphone",
      callbacks: {
        onFrames: ({ frames }) => {
          frameCount += 1;
          framesSeen.push(frames.length);
        },
        onLevels: (levels) => levelsSeen.push(levels.rms),
        onError: () => {},
      },
    });

    fake.pullQueue = newSinePull(2400, 2, 0.5);
    capture.start();
    expect(capture.state).toBe("running");
    await vi.advanceTimersByTimeAsync(30);

    // 2400 interleaved stereo frames -> 2400 mono -> 16000/48000 -> 800 canonical
    expect(frameCount).toBe(1);
    expect(framesSeen[0]).toBe(800);
    expect(levelsSeen.length).toBeGreaterThan(0);
    expect(levelsSeen[0]).toBeGreaterThan(0.3);

    capture.dispose();
    expect(capture.state).toBe("stopped");
    expect(fake.sessions.size).toBe(0);
  });

  it("surfaces native pull errors through onError and halts", async () => {
    const errors: string[] = [];
    const capture = new WindowsAudioCapture({
      kind: "microphone",
      callbacks: { onFrames: () => {}, onLevels: () => {}, onError: (e) => errors.push(e.message) },
    });
    const created = [...fake.sessions.values()][0];
    if (created) created.failPullWith = new Error("AUDCLNT_E_DEVICE_INVALIDATED");

    capture.start();
    await vi.advanceTimersByTimeAsync(30);
    expect(errors).toEqual(["AUDCLNT_E_DEVICE_INVALIDATED"]);
    expect(capture.state).toBe("errored");
    capture.dispose();
  });
});