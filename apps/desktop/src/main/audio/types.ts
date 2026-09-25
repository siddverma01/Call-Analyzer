import type { AudioCaptureKind, AudioDeviceState } from "@callnotes/shared";

/** Native sample formats reported by the WASAPI addon. */
export type NativeSampleFormat = "f32" | "i16" | "i24" | "i32" | "i8";

export interface NativeDeviceInfo {
  id: string;
  name: string;
  state: AudioDeviceState;
  isDefault: boolean;
  channels: number;
  sampleRate: number;
}

export interface NativeSessionOptions {
  kind: AudioCaptureKind;
  deviceId?: string;
  bufferMs?: number;
}

export interface NativeSessionInfo {
  id: number;
  sampleRate: number;
  channels: number;
  format: NativeSampleFormat;
  bufferMs: number;
}

/** The exact surface exported by `callnotes-wasapi-*.node`. */
export interface NativeAudioAddon {
  enumerateDevices(flow: "input" | "output"): NativeDeviceInfo[];
  createSession(options: NativeSessionOptions): NativeSessionInfo;
  sessionStart(id: number): boolean;
  sessionStop(id: number): boolean;
  sessionPull(id: number, maxFrames?: number): Float32Array | null;
  sessionRelease(id: number): boolean;
  sessionInfo(id: number): NativeSessionInfo;
}

/** Signal measurements for one pull of raw interleaved samples. */
export interface RawLevels {
  rms: number;
  peak: number;
  db: number;
  hasSignal: boolean;
}

/** A discrete chunk of processed audio delivered to consumers. */
export interface ProcessedFrames {
  /** Canonical mono float32 at the configured processing rate. */
  frames: Float32Array;
  sampleRate: number;
}