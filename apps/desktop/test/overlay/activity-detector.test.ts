import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallActivityMonitor, SustainedActivityGate } from "../../src/main/overlay/activity-detector";
import type { NativeAudioAddon } from "../../src/main/audio/types";

describe("SustainedActivityGate", () => {
  function feed(gate: SustainedActivityGate, clock: { t: number }, count: number, rms: number, step = 250): void {
    for (let i = 0; i < count; i++) {
      gate.sample(rms, clock.t);
      clock.t += step;
    }
  }

  it("raises after sustained audible sound and stays raised while audible", () => {
    const gate = new SustainedActivityGate({ confirmMs: 2000, resetMs: 5000, thresholdRms: 0.004 });
    const clock = { t: 0 };

    // 1.5 s of audio: below the confirmation window.
    feed(gate, clock, 6, 0.5);
    expect(gate.isActive).toBe(false);

    // 1 s more: crosses 2 s sustained.
    feed(gate, clock, 4, 0.5);
    expect(gate.isActive).toBe(true);

    // Transient quiet (under the reset window) must not drop it.
    feed(gate, clock, 2, 0.0);
    expect(gate.isActive).toBe(true);

    // Sustained quiet drops it again.
    feed(gate, clock, 30, 0.0);
    expect(gate.isActive).toBe(false);
  });

  it("never raises on brief blips", () => {
    const gate = new SustainedActivityGate({ confirmMs: 2000, resetMs: 5000, thresholdRms: 0.004 });
    const now = { t: 0 };
    // 500 ms of loud audio, then silence, repeated.
    gate.sample(0.5, now.t);
    gate.sample(0.5, (now.t += 250));
    gate.sample(0.0, (now.t += 250));
    gate.sample(0.5, (now.t += 250));
    gate.sample(0.5, (now.t += 250));
    expect(gate.isActive).toBe(false);
  });

  it("reports exactly one transition even when the caller repeats the sample", () => {
    const gate = new SustainedActivityGate({ confirmMs: 1000, resetMs: 1000, thresholdRms: 0.004 });
    const seen: boolean[] = [];
    const t = 0;
    // audible, 1 s apart twice (second sample should not re-report)
    seen.push(gate.sample(0.5, t));
    seen.push(gate.sample(0.5, t + 1000)); // crosses confirm exactly here -> true
    seen.push(gate.sample(0.5, t + 2000));
    // quiet below reset -> no transition; quiet past reset -> false
    seen.push(gate.sample(0.0, t + 2500));
    seen.push(gate.sample(0.0, t + 3000));
    seen.push(gate.sample(0.0, t + 3501));

    expect(seen).toEqual([false, true, false, false, false, true]);
    expect(gate.isActive).toBe(false);
  });
});

describe("CallActivityMonitor", () => {
  let fakeAddon: NativeAudioAddon;
  let loud: boolean;
  let created: number;
  let released: number;

  beforeEach(() => {
    created = 0;
    released = 0;
    loud = true;
    fakeAddon = {
      enumerateDevices: () => [],
      createSession: () => {
        created++;
        return { id: 1, sampleRate: 48000, channels: 2, format: "f32", bufferMs: 100 };
      },
      sessionStart: () => true,
      sessionStop: () => true,
      sessionPull: () => {
        const buf = new Float32Array(64).fill(loud ? 0.4 : 0.0);
        return buf;
      },
      sessionRelease: () => {
        released++;
        return true;
      },
      sessionInfo: () => ({ id: 1, sampleRate: 48000, channels: 2, format: "f32", bufferMs: 100 }),
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises after sustained loopback sound and lowers after sustained quiet", () => {
    const onChange = vi.fn();
    const monitor = new CallActivityMonitor({
      addon: fakeAddon,
      onChange,
      pollMs: 250,
      gate: { confirmMs: 2000, resetMs: 5000, thresholdRms: 0.004 },
    });

    expect(monitor.start()).toBe(true);
    expect(created).toBe(1);

    vi.advanceTimersByTime(2250); // ~9 polls of loud audio
    expect(onChange).toHaveBeenCalledWith(true);

    loud = false;
    vi.advanceTimersByTime(5500); // ~22 polls of silence
    expect(onChange).toHaveBeenLastCalledWith(false);

    monitor.stop();
    expect(released).toBe(1);
  });

  it("returns false and opens nothing when the native addon is absent", () => {
    const monitor = new CallActivityMonitor({ addon: null, onChange: () => {} });
    expect(monitor.start()).toBe(false);
    expect(created).toBe(0);
  });
});