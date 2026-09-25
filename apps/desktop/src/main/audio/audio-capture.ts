import type { AudioCaptureKind } from "@callnotes/shared";
import { loadNativeAddon } from "./native-loader.js";
import { SpeakingRateResampler, measureLevels, toCanonicalMono } from "./dsp/pcm.js";
import type { NativeSessionInfo, ProcessedFrames, RawLevels } from "./types.js";

export const DEFAULT_PROCESSING_RATE = 16_000;

export type AudioCaptureState = "idle" | "running" | "stopped" | "errored";

export interface AudioCaptureCallbacks {
  /** Canonical mono at processingRate (voice pipeline input). */
  onFrames: (frames: ProcessedFrames) => void;
  /** Level measurement of the most recent raw pull (UI meters). */
  onLevels: (levels: RawLevels) => void;
  onError: (error: Error) => void;
}

export interface AudioCaptureConfig {
  kind: AudioCaptureKind;
  deviceId?: string;
  bufferMs?: number;
  processingRate?: number;
  callbacks: AudioCaptureCallbacks;
}

/**
 * Platform abstraction for a single in-progress audio capture stream.
 * Only `start()`/`stop()`/`dispose()` belong on the contract; configuration is
 * intentionally constructor-injected so future macOS/Linux implementations can
 * share the same shape.
 */
export interface IAudioCapture {
  readonly kind: AudioCaptureKind;
  readonly deviceId: string | null;
  readonly sampleRate: number;
  readonly channels: number;
  readonly processingRate: number;
  readonly state: AudioCaptureState;
  start(): void;
  stop(): void;
  dispose(): void;
}

const PULL_INTERVAL_MS = 30;
const MAX_PULL_FRAMES = 4800; // safe cap on per-interval native pulls

/**
 * WASAPI-backed capture via the native addon. The addon owns the COM/WASAPI
 * worker thread and its internal ring buffer; this class drains it on a timer,
 * downmixes, resamples to the processing rate, and forwards canonical mono PCM
 * plus live level measurements. All audio stays in memory.
 */
export class WindowsAudioCapture implements IAudioCapture {
  readonly kind: AudioCaptureKind;
  readonly deviceId: string | null;
  readonly sampleRate: number;
  readonly channels: number;
  readonly processingRate: number;
  state: AudioCaptureState = "idle";

  private readonly addon = loadNativeAddon();
  private readonly session: NativeSessionInfo;
  private readonly callbacks: AudioCaptureCallbacks;
  private readonly resampler: SpeakingRateResampler;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private lastError: Error | null = null;

  constructor(config: AudioCaptureConfig) {
    this.kind = config.kind;
    this.deviceId = config.deviceId ?? null;
    this.processingRate = config.processingRate ?? DEFAULT_PROCESSING_RATE;
    this.callbacks = config.callbacks;
    this.session = this.addon.createSession({
      kind: config.kind,
      deviceId: config.deviceId,
      bufferMs: config.bufferMs,
    });
    this.sampleRate = this.session.sampleRate;
    this.channels = this.session.channels;
    this.resampler = new SpeakingRateResampler(this.sampleRate, this.processingRate);
  }

  start(): void {
    if (this.started || this.lastError || this.state !== "idle") {
      if (this.lastError) this.state = "errored";
      return;
    }
    try {
      this.addon.sessionStart(this.session.id);
      this.started = true;
      this.state = "running";
      this.timer = setInterval(() => this.pull(), PULL_INTERVAL_MS);
    } catch (error) {
      const e = asError(error);
      this.lastError = e;
      this.state = "errored";
      this.callbacks.onError(e);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.started) {
      try {
        this.addon.sessionStop(this.session.id);
      } catch (error) {
        this.callbacks.onError(asError(error));
      }
      this.started = false;
    }
    this.state = "stopped";
  }

  dispose(): void {
    this.stop();
    try {
      this.addon.sessionRelease(this.session.id);
    } catch (error) {
      this.callbacks.onError(asError(error));
    }
  }

  /** Drains available samples from the native ring and fans them out. */
  private pull(): void {
    if (!this.started) return;
    let raw: Float32Array | null = null;
    try {
      raw = this.addon.sessionPull(this.session.id, MAX_PULL_FRAMES);
    } catch (error) {
      const e = asError(error);
      this.lastError = e;
      this.state = "errored";
      this.callbacks.onError(e);
      return;
    }
    if (!raw || raw.length === 0) return;

    const frames = toCanonicalMono(raw, this.channels, this.sampleRate, this.processingRate, this.resampler);
    this.callbacks.onLevels(measureLevels(frames));
    this.callbacks.onFrames({ frames, sampleRate: this.processingRate });
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}