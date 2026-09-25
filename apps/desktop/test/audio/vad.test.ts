import { describe, expect, it } from "vitest";
import { EnergyVad } from "../../src/main/audio/dsp/vad";

function silence(seconds: number, sampleRate = 16_000): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    out[i] = (Math.random() - 0.5) * 1e-4; // tiny noise floor
  }
  return out;
}

function tone(seconds: number, freq = 440, amplitude = 0.3, sampleRate = 16_000): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude;
  }
  return out;
}

function silenceWithTone(at = 1, duration = 0.4, sampleRate = 16_000): Float32Array {
  const out = silence(2, sampleRate);
  const start = Math.floor(at * sampleRate);
  const toneLen = Math.floor(duration * sampleRate);
  let peak = 0.25;
  for (let i = 0; i < toneLen && start + i < out.length; i++) {
    if (i > toneLen / 2) peak = 0.05;
    out[start + i] = Math.sin((2 * Math.PI * 300 * i) / sampleRate) * peak;
  }
  return out;
}

describe("EnergyVad", () => {
  it("does not trigger on pure silence", () => {
    const vad = new EnergyVad();
    const result = vad.analyze(silence(1.5), 16_000);
    expect(result.detected).toBe(false);
  });

  it("detects a continuous tone", () => {
    const vad = new EnergyVad();
    const result = vad.analyze(tone(1), 16_000);
    expect(result.detected).toBe(true);
  });

  it("detects a tone embedded in an idle recording", () => {
    const vad = new EnergyVad();
    const result = vad.analyze(silenceWithTone(), 16_000);
    expect(result.detected).toBe(true);
  });

  it("stays quiet for short-duration noise bursts", () => {
    const vad = new EnergyVad();
    const quiet = silence(1);
    quiet[100] = 0.9; // single-sample click should not flag speech
    const result = vad.analyze(quiet, 16_000);
    expect(result.detected).toBe(false);
  });
});