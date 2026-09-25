import { describe, expect, it } from "vitest";
import { SpeakingRateResampler, downmixToMono, measureLevels } from "../../src/main/audio/dsp/pcm";

describe("downmixToMono", () => {
  it("passes mono through unchanged", () => {
    const input = new Float32Array([0.1, -0.5, 0.2]);
    expect(downmixToMono(input, 1)).toEqual(input);
  });

  it("averages interleaved stereo", () => {
    const input = new Float32Array([1, 3, 5, 7]); // L,R,L,R
    const mono = downmixToMono(input, 2);
    expect(Array.from(mono)).toEqual([2, 6]);
  });

  it("handles empty input", () => {
    expect(downmixToMono(new Float32Array(0), 2).length).toBe(0);
  });
});

describe("SpeakingRateResampler", () => {
  it("leaves same-rate input intact", () => {
    const rs = new SpeakingRateResampler(16_000, 16_000);
    const input = new Float32Array([0.1, -0.2, 0.3]);
    const out = rs.process(input);
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
  });

  it("halves samples when downsampling 2:1", () => {
    const rs = new SpeakingRateResampler(48_000, 24_000);
    const input = new Float32Array([0, 1, 0, -1, 0, 1]);
    const out = rs.process(input);
    expect(out.length).toBe(3);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(0, 5);
  });

  it("preserves amplitude through upsample+downsample", () => {
    const input = new Float32Array(1_000);
    for (let i = 0; i < 1_000; i++) input[i] = Math.sin((i / 100) * Math.PI * 2);
    const up = new SpeakingRateResampler(16_000, 48_000).process(input);
    const back = new SpeakingRateResampler(48_000, 16_000).process(up);
    expect(up.length).toBeGreaterThan(input.length);
    expect(back.length).toBe(input.length);
    const rmsOut = measureLevels(back);
    const rmsIn = measureLevels(input);
    expect(rmsOut.rms).toBeGreaterThan(rmsIn.rms * 0.7);
    expect(rmsOut.rms).toBeLessThan(rmsIn.rms * 1.4);
  });

  it("keeps cohesion across chunk boundaries (no clicks)", () => {
    const rs = new SpeakingRateResampler(16_000, 48_000);
    const a = new Float32Array([0, 0.5]);
    const b = new Float32Array([0.5, 0]);
    const outA = rs.process(a);
    const mixed = rs.process(b);
    // first output of the second chunk should continue around the old level
    expect(Math.abs(mixed[0] - outA[outA.length - 1])).toBeLessThanOrEqual(0.6);
  });
});

describe("measureLevels", () => {
  it("reports silence", () => {
    const lv = measureLevels(new Float32Array(100));
    expect(lv.rms).toBe(0);
    expect(lv.peak).toBe(0);
    expect(lv.hasSignal).toBe(false);
  });

  it("computes rms/peak for a tone", () => {
    const data = new Float32Array(1_000);
    for (let i = 0; i < 1_000; i++) data[i] = Math.sin(i / 10) * 0.5;
    const lv = measureLevels(data);
    expect(lv.peak).toBeCloseTo(0.5, 5);
    expect(lv.rms).toBeCloseTo(0.5 / Math.sqrt(2), 2);
    expect(lv.hasSignal).toBe(true);
    expect(lv.db).toBeLessThan(0);
  });
});