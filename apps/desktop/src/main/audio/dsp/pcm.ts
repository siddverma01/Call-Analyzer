import type { RawLevels } from "../types.js";

export const EPSILON = 1e-9;

/**
 * Downmixes interleaved multi-channel samples to mono by simple averaging.
 * Safe on aliased input (the native addon transfers a copy).
 */
export function downmixToMono(interleaved: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return interleaved.slice();
  const frames = Math.floor(interleaved.length / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += interleaved[f * channels + c] ?? 0;
    out[f] = sum / channels;
  }
  return out;
}

/**
 * Streaming linear-interpolation resampler. Keeps one tail sample so PCM
 * across chunk boundaries stays continuous.
 */
export class SpeakingRateResampler {
  private pos = 0;
  private lastOutSample = 0;

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
  ) {}

  process(input: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return input.slice();
    const outLen = Math.floor((input.length * this.toRate) / this.fromRate);
    const out = new Float32Array(outLen);
    const step = this.fromRate / this.toRate;
    let target = this.pos;
    for (let i = 0; i < outLen; i++) {
      const idx = Math.floor(target);
      const frac = target - idx;
      const a = input[idx] ?? (idx > 0 ? (input[idx - 1] ?? this.lastOutSample) : this.lastOutSample);
      const b = input[idx + 1] ?? a;
      out[i] = a + (b - a) * frac;
      target += step;
    }
    this.pos = target;
    // input chunks are 0-based: consume the chunk we just read so the next
    // call re-aligns to its own start (only the fractional remainder carries)
    while (this.pos >= input.length) this.pos -= input.length;
    this.lastOutSample = input[input.length - 1] ?? this.lastOutSample;
    return out;
  }
}

/** Monolithic helper: raw pull -> canonical mono Float32Array. */
export function toCanonicalMono(
  interleaved: Float32Array,
  channels: number,
  nativeRate: number,
  canonicalRate: number,
  resampler?: SpeakingRateResampler,
): Float32Array {
  const mono = downmixToMono(interleaved, channels);
  const rs = resampler ?? new SpeakingRateResampler(nativeRate, canonicalRate);
  return rs.process(mono);
}

/** RMS/peak/dBFS over a mono buffer. */
export function measureLevels(mono: Float32Array): RawLevels {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i] ?? 0;
    sum += v * v;
    const abs = v < 0 ? -v : v;
    if (abs > peak) peak = abs;
  }
  const rms = mono.length > 0 ? Math.sqrt(sum / mono.length) : 0;
  const db = 20 * Math.log10(Math.max(rms, EPSILON));
  return { rms, peak, db, hasSignal: rms > 0.0005 || peak > 0.002 };
}