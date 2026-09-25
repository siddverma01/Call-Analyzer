/**
 * Lightweight energy-based voice-activity detection over mono PCM. Tracks a
 * decaying noise floor so the threshold adapts to microphone baseline hum.
 * Good enough for mic-test gating and status "heard a voice" hints; the
 * transcription pipeline performs its own acoustic modeling later.
 */
export interface VoiceAnalysis {
  /** RMS over the window. */
  rms: number;
  /** Peak over the window. */
  peak: number;
  /** True if any speech-like window was detected. */
  detected: boolean;
}

const FRAME_MS = 20;
const WINDOW_FRAMES = 5; // 100ms analysis windows
const ENERGY_THRESHOLD_DB = -34; // above the noise floor counts as speech-ish
const MIN_ABS_ENERGY = 1e-4;
const LATCH_WINDOWS = 2; // consecutive speech-like windows required (filters clicks)

export class EnergyVad {
  private noiseFloor = 0;
  private consecutive = 0;
  private detectedState = false;

  /** Analyze a mono buffer at `sampleRate`; returns per-window detection. */
  analyze(mono: Float32Array, sampleRate: number): VoiceAnalysis {
    if (mono.length === 0) return { rms: 0, peak: 0, detected: false };

    const windowLen = Math.max(1, Math.floor((sampleRate * WINDOW_FRAMES * FRAME_MS) / 1000));
    let consec = 0;
    let detected = false;
    let sum = 0;
    let peak = 0;

    for (let start = 0; start < mono.length; start += windowLen) {
      const end = Math.min(start + windowLen, mono.length);
      let winSum = 0;
      for (let i = start; i < end; i++) {
        const v = mono[i] ?? 0;
        winSum += v * v;
        sum += v * v;
        const abs = v < 0 ? -v : v;
        if (abs > peak) peak = abs;
      }
      const energy = winSum / Math.max(1, end - start);
      const floor = Math.max(this.noiseFloor, MIN_ABS_ENERGY);
      const marginDb = 10 * Math.log10(energy / floor);
      if (marginDb >= ENERGY_THRESHOLD_DB && energy > MIN_ABS_ENERGY) {
        consec += 1;
        if (consec >= LATCH_WINDOWS) detected = true;
      } else {
        consec = 0;
      }
      // Trailing noise floor: only climb when the window is clearly quiet.
      if (marginDb < ENERGY_THRESHOLD_DB) this.noiseFloor = this.noiseFloor * 0.99 + energy * 0.01;
    }

    return { rms: Math.sqrt(sum / mono.length), peak, detected };
  }

  /**
   * Streaming gate over individual capture chunks (same thresholds/latch as
   * analyze). Returns true once enough consecutive speech-like chunks have
   * been observed to consider speech started.
   */
  detectChunk(samples: Float32Array): boolean {
    if (samples.length === 0) return false;
    let winSum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] ?? 0;
      winSum += v * v;
    }
    const energy = winSum / samples.length;
    const floor = Math.max(this.noiseFloor, MIN_ABS_ENERGY);
    const marginDb = 10 * Math.log10(energy / floor);
    const spoken = marginDb >= ENERGY_THRESHOLD_DB && energy > MIN_ABS_ENERGY;

    if (spoken) {
      this.consecutive += 1;
      if (this.consecutive >= LATCH_WINDOWS) this.detectedState = true;
    } else {
      // A quiet window breaks the speech run immediately (no hangover false
      // positive on the very first silence chunk after speech).
      this.consecutive = 0;
      this.detectedState = false;
      this.noiseFloor = this.noiseFloor * 0.99 + energy * 0.01;
    }
    return this.detectedState;
  }

  /** True once `detectChunk` has latched onto speech (used for tests). */
  get latched(): boolean {
    return this.detectedState;
  }

  reset(): void {
    this.noiseFloor = 0;
    this.consecutive = 0;
    this.detectedState = false;
  }
}