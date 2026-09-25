/**
 * Real audio capture contract shared between the renderer, the preload bridge,
 * and the Electron main process.
 *
 * While a meeting is recording, captured audio is written to TEMPORARY files on
 * the user's own machine (mono float32 PCM chunks in userData/recordings) and
 * streams are kept physically separate (one directory per source). It never
 * leaves the device and never touches the backend; the temporary files are
 * deleted once the meeting has been processed successfully (see
 * docs/privacy.md). If processing fails, the recording is preserved on disk so
 * the user can retry it, and deleted only when they choose to (see
 * docs/audio-capture.md). No uploads, no cloud processing - nothing is stored
 * long-term.
 */

/** Raw devices reported by the native WASAPI layer. */
export type AudioDeviceState = "active" | "disabled" | "notpresent" | "unplugged";

export interface AudioDeviceInfo {
  id: string;
  name: string;
  state: AudioDeviceState;
  isDefault: boolean;
  channels: number;
  sampleRate: number;
}

export type AudioCaptureKind = "microphone" | "loopback";

/** Microphone availability: at least one ACTIVE capture endpoint exists. */
export type MicStatusState = "checking" | "connected" | "not-connected";

/** System (loopback) availability: a render endpoint actually initialized. */
export type SystemAudioStatusState = "checking" | "available" | "unavailable";

export interface MicStatus {
  state: MicStatusState;
  devices: AudioDeviceInfo[];
  selectedDeviceId: string | null;
}

export interface SystemAudioStatus {
  state: SystemAudioStatusState;
  devices: AudioDeviceInfo[];
}

export interface AudioInfoResponse {
  mic: MicStatus;
  systemAudio: SystemAudioStatus;
}

/** Short-window signal measurements (computed in main from real samples). */
export interface AudioLevels {
  rms: number;
  peak: number;
  db: number;
  hasSignal: boolean;
}

/** Pushed to the renderer while monitoring is active (~10 Hz). */
export interface AudioMetersEvent {
  mic: AudioLevels | null;
  systemAudio: AudioLevels | null;
}

export interface MicTestResult {
  heardVoice: boolean;
  rms: number;
  peak: number;
  durationSeconds: number;
}

/**
 * One temporary capture stream written to disk during a meeting. Each stream
 * is the canonical mono PCM (float32, 16000 Hz) stored as a sequence of chunk
 * files under `dir`, numbered in order (000000.pcm, 000001.pcm, ...).
 */
export interface RecordingStreamInfo {
  kind: AudioCaptureKind;
  /** Directory holding the numbered `.pcm` chunk files for this stream. */
  dir: string;
  /** Total number of samples captured across all chunks in this stream. */
  frameCount: number;
}

/** Snapshot returned when a meeting's capture is finalized (before deletion). */
export interface RecordingResult {
  sampleRate: number;
  streams: RecordingStreamInfo[];
}

/**
 * Disk-usage projection for a meeting recording. Lets the renderer show how
 * much temporary storage the selected sources will consume before the user
 * starts a meeting, and warn when there is not enough free space.
 */
/**
 * Live capture-to-disk stats for the BACKING meeting recording, polled by the
 * renderer while a meeting is in progress so the Active Meeting screen can show
 * real temporary-storage usage (never a simulated figure).
 */
export interface RecordingUsage {
  /** Total mono samples captured (before compression) across all streams. */
  frameCount: number;
  /** Approximate temporary bytes written to disk so far (4 bytes/sample). */
  bytesWritten: number;
  /** True while the meeting is paused (chunks are not being written). */
  paused: boolean;
  /** Per-source progress for capture status display. */
  streams: { kind: AudioCaptureKind; frameCount: number }[];
}

export interface RecordingStorageEstimate {
  /** Temporary bytes written per second of meeting for the chosen sources. */
  bytesPerSecond: number;
  /** Projected bytes for the requested maximum duration. */
  estimatedBytes: number;
  /** Free bytes on the volume that holds temporary recordings. */
  availableBytes: number;
  /** Free bytes required to start a meeting (short-meeting floor + margin). */
  minimumRequiredBytes: number;
  /** True when `availableBytes` can hold the max-duration estimate + headroom. */
  sufficient: boolean;
}