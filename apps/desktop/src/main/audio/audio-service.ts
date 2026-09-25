import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AudioCaptureKind,
  AudioInfoResponse,
  AudioLevels,
  AudioMetersEvent,
  MicStatus,
  MicTestResult,
  RecordingResult,
  RecordingStorageEstimate,
  RecordingStreamInfo,
  RecordingUsage,
  SystemAudioStatus,
} from "@callnotes/shared";
import { MEETING_ERROR_CODES } from "@callnotes/shared";
import { nativeAvailable, loadNativeAddon } from "./native-loader.js";
import { WindowsAudioCapture } from "./audio-capture.js";
import {
  buildRecordingSnapshot,
  finalizeRecording,
  getAvailableDiskBytes,
  hasRecordingDir,
  PcmChunkWriter,
  readManifest,
  removeRecordingDir,
  writeManifest,
} from "./dsp/pcm-chunks.js";
import { EnergyVad } from "./dsp/vad.js";
import { PcmRingBuffer } from "./dsp/ring-buffer.js";
import type { NativeDeviceInfo } from "./types.js";

export interface AudioServiceDeps {
  /** Persistent per-user preference store (device ids only, never audio). */
  settingsPath: string;
  /**
   * Root directory for temporary meeting capture files (userData/recordings).
   * Each meeting gets its own subdirectory that is deleted after successful
   * processing (and preserved for retry when processing fails).
   */
  recordingsDir: string;
  /** Push a meters event to the renderer (main -> window.send). */
  sendMeters: (event: AudioMetersEvent) => void;
  /** Test seam: how many bytes are free on the recording volume. */
  freeBytes?: (dir: string) => number;
}

/** Canonical rate for on-disk temporary capture files. */
export const TEMP_RECORDING_RATE = 16_000;

/** A raw float32 sample occupies 4 bytes on disk. */
const BYTES_PER_SAMPLE = 4;

/** Shortest meeting the disk preflight must always accommodate. */
export const MIN_RECORDING_SECONDS = 30 * 60;
/** Longest recording we plan temp storage for by default. */
export const MAX_RECORDING_SECONDS = 4 * 60 * 60;
/** Absolute free-space floor kept for the OS / other apps. */
const MIN_FREE_BYTES = 128 * 1024 * 1024;
/** Headroom recommended on top of the max-length estimate. */
const RECOMMENDED_FREE_BYTES = 256 * 1024 * 1024;

interface Settings {
  selectedMicDeviceId: string | null;
}

const DEFAULT_SETTINGS: Settings = { selectedMicDeviceId: null };

/** Frame consumer: receives processed mono PCM; used by the whisper engine. */
export type FrameConsumer = (frames: Float32Array) => void;

/** Thrown when the disk cannot hold even a minimum-length meeting capture. */
export class RecordingSpaceError extends Error {
  readonly code: string = MEETING_ERROR_CODES.INSUFFICIENT_DISK;
  constructor(readonly availableBytes: number, readonly requiredBytes: number) {
    super(
      `Not enough free disk space to record a meeting: ${formatBytes(requiredBytes)} needed, ` +
        `${formatBytes(availableBytes)} available. Free up space and try again.`,
    );
    this.name = "RecordingSpaceError";
  }
}

/** Local helper: normalize a thrown unknown into an Error instance. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Local helper: human-readable byte size for the disk-space error message. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

const MIC_TEST_SECONDS = 3;
const MIC_TEST_RATE = 16_000;
export const METERS_INTERVAL_MS = 100;

function isActive(candidates: NativeDeviceInfo[]): NativeDeviceInfo[] {
  return candidates.filter((d) => d.state === "active");
}

function sortDevices(devices: NativeDeviceInfo[]): NativeDeviceInfo[] {
  return [...devices].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.state !== b.state) return a.state === "active" ? -1 : b.state === "active" ? 1 : 0;
    return a.name.localeCompare(b.name);
  });
}

function toLevels(rms: number, peak: number, hasSignal: boolean): AudioLevels {
  const db = 20 * Math.log10(Math.max(rms, 1e-9));
  return { rms, peak, db, hasSignal };
}

/**
 * Owns all real capture in the main process. Bridges the raw WASAPI addon to
 * the typed IPC surface (getInfo / selectMic / micTest / monitoring meters).
 * While a meeting is active, processed PCM is routed through the frame
 * consumers into TEMPORARY on-disk chunk files (float32 mono, canonical rate)
 * under recordingsDir - one stream directory per source - with a per-meeting
 * manifest. Files are deleted only after successful processing and are never
 * uploaded (see docs/privacy.md). Mic tests and meters stay memory-only. On
 * startup, stray un-managed files are swept but real (manifested) recordings
 * are preserved so an interrupted meeting can be retried.
 */
export class AudioService {
  private micCapture: WindowsAudioCapture | null = null;
  private loopbackCapture: WindowsAudioCapture | null = null;
  private settings: Settings;
  private metersTimer: NodeJS.Timeout | null = null;
  private lastMicLevels: AudioLevels | null = null;
  private lastLoopbackLevels: AudioLevels | null = null;
  private frameConsumers: { microphone: FrameConsumer | null; loopback: FrameConsumer | null } = {
    microphone: null,
    loopback: null,
  };
  private activeRecording: {
    dir: string;
    writers: Partial<Record<AudioCaptureKind, PcmChunkWriter>>;
  } | null = null;
  private paused = false;
  private recordingErrorHandler: ((error: Error) => void) | null = null;

  constructor(private readonly deps: AudioServiceDeps) {
    this.settings = { ...DEFAULT_SETTINGS, ...this.readSettings() };
    this.sweepUnmanaged();
  }

  // -------------------------------------------------------------------------
  // Public surface (used by IPC handlers)
  // -------------------------------------------------------------------------

  info(): AudioInfoResponse {
    if (!nativeAvailable()) {
      return {
        mic: { state: "not-connected", devices: [], selectedDeviceId: this.settings.selectedMicDeviceId },
        systemAudio: { state: "unavailable", devices: [] },
      };
    }

    const addon = loadNativeAddon();
    const inputs = sortDevices(addon.enumerateDevices("input"));
    const outputs = sortDevices(addon.enumerateDevices("output"));
    const activeInputs = isActive(inputs);
    const activeOutputs = isActive(outputs);

    const mic: MicStatus = {
      state: activeInputs.length > 0 ? "connected" : "not-connected",
      devices: inputs,
      selectedDeviceId: this.settings.selectedMicDeviceId,
    };

    const systemAudio: SystemAudioStatus = {
      state: this.probeLoopbackAvailable(addon, activeOutputs) ? "available" : "unavailable",
      devices: outputs,
    };

    return { mic, systemAudio };
  }

  selectMic(deviceId: string | null): AudioInfoResponse {
    this.settings.selectedMicDeviceId = deviceId;
    this.persistSettings();
    if (this.micCapture) {
      this.micCapture.dispose();
      this.micCapture = null;
      this.lastMicLevels = null;
    }
    if (this.metersTimer) this.restartMonitoring();
    return this.info();
  }

  async micTest(deviceId: string | null): Promise<MicTestResult> {
    const targetId = deviceId ?? this.settings.selectedMicDeviceId ?? undefined;
    const vad = new EnergyVad();
    const ring = new PcmRingBuffer(MIC_TEST_RATE * MIC_TEST_SECONDS);
    let lastError: Error | null = null;

    const capture = new WindowsAudioCapture({
      kind: "microphone",
      deviceId: targetId,
      bufferMs: 1000,
      processingRate: MIC_TEST_RATE,
      callbacks: {
        onFrames: ({ frames }) => ring.write(frames),
        onLevels: () => {},
        onError: (error) => {
          lastError = error;
        },
      },
    });

    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      capture.dispose();
    };

    return await new Promise((resolve) => {
      capture.start();
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (disposed) return;
        const elapsed = (Date.now() - startedAt) / 1000;
        const done = elapsed >= MIC_TEST_SECONDS;
        if (lastError) {
          clearInterval(timer);
          dispose();
          resolve({ heardVoice: false, rms: 0, peak: 0, durationSeconds: 0 });
          return;
        }
        if (done) {
          clearInterval(timer);
          dispose();
          const analysis = vad.analyze(ring.peek(ring.size), MIC_TEST_RATE);
          resolve({
            heardVoice: analysis.detected,
            rms: analysis.rms,
            peak: analysis.peak,
            durationSeconds: MIC_TEST_SECONDS,
          });
        }
      }, 50);
    });
  }

  startMonitoring(): AudioInfoResponse {
    if (!nativeAvailable() || this.micCapture || this.loopbackCapture) return this.info();
    const micId = this.settings.selectedMicDeviceId ?? undefined;

    if (!this.micCapture) {
      try {
        this.micCapture = new WindowsAudioCapture({
          kind: "microphone",
          deviceId: micId,
          bufferMs: 250,
          callbacks: {
            onFrames: (frames) => this.frameConsumers.microphone?.(frames.frames),
            onLevels: (levels) => {
              this.lastMicLevels = toLevels(levels.rms, levels.peak, levels.hasSignal);
            },
            onError: () => {
              this.lastMicLevels = null;
            },
          },
        });
        this.micCapture.start();
      } catch {
        this.micCapture = null;
      }
    }

    if (!this.loopbackCapture) {
      try {
        this.loopbackCapture = new WindowsAudioCapture({
          kind: "loopback",
          bufferMs: 250,
          callbacks: {
            onFrames: (frames) => this.frameConsumers.loopback?.(frames.frames),
            onLevels: (levels) => {
              this.lastLoopbackLevels = toLevels(levels.rms, levels.peak, levels.hasSignal);
            },
            onError: () => {
              this.lastLoopbackLevels = null;
            },
          },
        });
        this.loopbackCapture.start();
      } catch {
        this.loopbackCapture = null;
      }
    }

    if (!this.metersTimer) {
      this.metersTimer = setInterval(() => this.emitMeters(), METERS_INTERVAL_MS);
    }
    return this.info();
  }

  stopMonitoring(): void {
    if (this.metersTimer) {
      clearInterval(this.metersTimer);
      this.metersTimer = null;
    }
    if (this.micCapture) {
      this.micCapture.dispose();
      this.micCapture = null;
    }
    if (this.loopbackCapture) {
      this.loopbackCapture.dispose();
      this.loopbackCapture = null;
    }
    this.lastMicLevels = null;
    this.lastLoopbackLevels = null;
    this.deps.sendMeters({ mic: null, systemAudio: null });
  }

  /** Attach/detach a processed-PCM consumer for one capture kind. */
  setFrameConsumer(kind: AudioCaptureKind, consumer: FrameConsumer | null): void {
    this.frameConsumers[kind] = consumer;
  }

  /**
   * Begin capture-to-disk for a meeting: verifies free disk space, installs
   * per-source chunk writers as frame consumers, writes the meeting manifest,
   * and starts the capture streams + meters. Throws when the native addon is
   * unavailable or when the disk cannot hold a recording; the caller aborts the
   * meeting in both cases. `onError` fires if a chunk write fails mid-recording
   * (e.g. the disk fills up); the caller should fail the meeting.
   */
  startMeeting(
    meetingId: string,
    sources: AudioCaptureKind[],
    opts?: { onError?: (error: Error) => void },
  ): void {
    if (this.activeRecording) return;
    if (!nativeAvailable()) throw new Error("Native audio addon is not available");

    const estimate = this.estimateRecordingSpace(sources, MIN_RECORDING_SECONDS);
    const available = this.getFreeBytes();
    if (available < estimate.minimumRequiredBytes) {
      throw new RecordingSpaceError(available, estimate.minimumRequiredBytes);
    }

    const dir = join(this.deps.recordingsDir, meetingId);
    const writers: Partial<Record<AudioCaptureKind, PcmChunkWriter>> = {};
    for (const kind of sources) {
      writers[kind] = new PcmChunkWriter(TEMP_RECORDING_RATE, join(dir, kind));
    }
    // Activate capture transactionally: the manifest is written before the
    // frame consumers, active recording and error handler are installed, so a
    // failed write leaves no partial capture state behind (which would make a
    // later retry silently stall).
    writeManifest(dir, {
      version: 1,
      meetingId,
      createdAt: Date.now(),
      sampleRate: TEMP_RECORDING_RATE,
      sources,
      status: "recording",
    });
    this.recordingErrorHandler = opts?.onError ?? null;
    for (const kind of sources) {
      const writer = writers[kind] as PcmChunkWriter;
      this.setFrameConsumer(kind, (frames) => this.recordFrames(kind, writer, frames));
    }
    // A paused session from a previous meeting must not leak into the new one.
    this.paused = false;
    this.activeRecording = { dir, writers };
    this.startMonitoring();
  }

  /**
   * Stop capture, flush all chunk writers, finalize the manifest, and return
   * the recording snapshot for transcription. After this call the temporary
   * files still exist; the caller is responsible for deleting them after the
   * meeting has been processed (or preserving them when processing fails).
   */
  finishMeeting(): RecordingResult | null {
    const recording = this.activeRecording;
    if (!recording) return null;
    this.stopMonitoring();
    try {
      const streams: RecordingStreamInfo[] = [];
      for (const kind of ["microphone", "loopback"] as const) {
        const writer = recording.writers[kind];
        if (writer) {
          // best-effort: keep whatever was captured even if the final flush fails
          try {
            writer.close();
          } catch {
            /* partial recording is still preserved below */
          }
          streams.push({ kind, dir: writer.dir, frameCount: writer.capturedFrames });
        }
      }
      finalizeRecording(recording.dir);
      return { sampleRate: TEMP_RECORDING_RATE, streams };
    } finally {
      this.setFrameConsumer("microphone", null);
      this.setFrameConsumer("loopback", null);
      this.recordingErrorHandler = null;
      if (this.activeRecording === recording) this.activeRecording = null;
    }
  }

  /**
   * Abort path: stop capture and delete any temporary files written so far
   * (used when a session is explicitly abandoned). No snapshot is returned.
   */
  discardMeeting(): void {
    const recording = this.activeRecording;
    this.finishMeeting();
    if (recording) removeRecordingDir(recording.dir);
  }

  /** Stop writing audio to disk but keep the capture streams warm. */
  pauseMeeting(): void {
    this.paused = true;
  }

  /** Resume writing audio to disk after a pause. */
  resumeMeeting(): void {
    this.paused = false;
  }

  /** True between pauseMeeting() and resumeMeeting(). */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Live capture-to-disk stats for the meeting that is currently recording, or
   * null when idle. Powering the Active Meeting screen's temporary-storage
   * readout; the values come from the chunk writers' real sample counts.
   */
  recordingUsage(): RecordingUsage | null {
    const recording = this.activeRecording;
    if (!recording) return null;
    let frameCount = 0;
    const streams: RecordingUsage["streams"] = [];
    for (const kind of ["microphone", "loopback"] as const) {
      const writer = recording.writers[kind];
      if (writer) {
        frameCount += writer.capturedFrames;
        streams.push({ kind, frameCount: writer.capturedFrames });
      }
    }
    return {
      frameCount,
      bytesWritten: frameCount * BYTES_PER_SAMPLE,
      paused: this.paused,
      streams,
    };
  }

  /**
   * Project temporary disk usage for a meeting with the given sources. Used by
   * the renderer before a meeting starts to show expected storage and warn
   * about low free space; also drives the preflight in startMeeting().
   */
  estimateRecordingSpace(
    sources: AudioCaptureKind[],
    maxDurationSeconds: number = MAX_RECORDING_SECONDS,
  ): RecordingStorageEstimate {
    const kinds = sources.length > 0 ? sources : (["microphone"] as AudioCaptureKind[]);
    const bytesPerSecond = TEMP_RECORDING_RATE * BYTES_PER_SAMPLE * kinds.length;
    const estimatedBytes = bytesPerSecond * Math.max(0, maxDurationSeconds);
    const availableBytes = this.getFreeBytes();
    const minimumRequiredBytes = bytesPerSecond * MIN_RECORDING_SECONDS + MIN_FREE_BYTES;
    return {
      bytesPerSecond,
      estimatedBytes,
      availableBytes,
      minimumRequiredBytes,
      sufficient: availableBytes >= estimatedBytes + RECOMMENDED_FREE_BYTES,
    };
  }

  /** True when a previous meeting's temporary capture is still on disk. */
  recordingExists(meetingId: string): boolean {
    return hasRecordingDir(join(this.deps.recordingsDir, meetingId));
  }

  /** Rebuild a transcribable snapshot from preserved capture files. */
  recordingSnapshot(meetingId: string, sources: AudioCaptureKind[]): RecordingResult | null {
    return buildRecordingSnapshot(join(this.deps.recordingsDir, meetingId), sources);
  }

  /** Manifest of a preserved capture, or null. */
  recordingManifest(meetingId: string) {
    return readManifest(join(this.deps.recordingsDir, meetingId));
  }

  dispose(): void {
    this.discardMeeting();
    this.stopMonitoring();
  }

  /** True when capture streams are actually running. */
  get monitoring(): boolean {
    return this.micCapture !== null || this.loopbackCapture !== null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private getFreeBytes(): number {
    return this.deps.freeBytes
      ? this.deps.freeBytes(this.deps.recordingsDir)
      : getAvailableDiskBytes(this.deps.recordingsDir);
  }

  /** Route one processed frame block into its chunk writer (unless paused). */
  private recordFrames(kind: AudioCaptureKind, writer: PcmChunkWriter, frames: Float32Array): void {
    if (this.paused) return;
    try {
      writer.write(frames);
    } catch (error) {
      this.failRecording(asError(error));
    }
  }

  /**
   * A chunk write failed mid-recording (e.g. disk full). Finalize whatever was
   * captured (files are preserved for retry), stop capture, and surface the
   * error to the meeting service so it can fail the meeting cleanly.
   */
  private failRecording(error: Error): void {
    const handler = this.recordingErrorHandler;
    this.finishMeeting();
    if (handler) {
      this.recordingErrorHandler = null;
      handler(error);
    }
  }

  /**
   * Remove stray files at startup but NEVER delete a real (manifested)
   * recording: an interrupted session is preserved so the user can retry it.
   * Only directories without a manifest (unmanaged leftovers) are removed.
   */
  private sweepUnmanaged(): void {
    try {
      mkdirSync(this.deps.recordingsDir, { recursive: true });
      for (const name of readdirSync(this.deps.recordingsDir)) {
        const candidate = join(this.deps.recordingsDir, name);
        let stat;
        try {
          stat = statSync(candidate);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (!hasRecordingDir(candidate)) removeRecordingDir(candidate);
        } else {
          rmSync(candidate, { force: true });
        }
      }
    } catch {
      // best-effort only; never block startup on cleanup
    }
  }

  private restartMonitoring(): void {
    this.stopMonitoring();
    this.startMonitoring();
  }

  private emitMeters(): void {
    this.deps.sendMeters({ mic: this.lastMicLevels, systemAudio: this.lastLoopbackLevels });
  }

  /** Real loopback availability probe: create + release on the default render. */
  private probeLoopbackAvailable(addon: ReturnType<typeof loadNativeAddon>, activeOutputs: NativeDeviceInfo[]): boolean {
    if (activeOutputs.length === 0) return false;
    try {
      const session = addon.createSession({ kind: "loopback", bufferMs: 100 });
      addon.sessionRelease(session.id);
      return true;
    } catch {
      return false;
    }
  }

  private readSettings(): Partial<Settings> {
    try {
      if (!existsSync(this.deps.settingsPath)) return {};
      const raw = JSON.parse(readFileSync(this.deps.settingsPath, "utf8")) as Partial<Settings>;
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  private persistSettings(): void {
    try {
      mkdirSync(dirname(this.deps.settingsPath), { recursive: true });
      writeFileSync(this.deps.settingsPath, JSON.stringify(this.settings, null, 2), "utf8");
    } catch {
      // preferences persistence is best-effort; never fail the IPC on it
    }
  }
}