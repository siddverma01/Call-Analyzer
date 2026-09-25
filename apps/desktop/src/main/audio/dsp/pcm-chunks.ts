import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AudioCaptureKind, RecordingResult, RecordingStreamInfo } from "@callnotes/shared";

/**
 * Temporary meeting capture files. Each source stream is written as an ordered
 * sequence of raw little-endian float32 mono PCM chunks (16000 Hz canonical
 * rate), one file per fixed-length window, under `recordings/<meetingId>/<kind>`.
 * A `manifest.json` per meeting records which sources are captured and marks
 * the recording life-cycle state. Temporary files are deleted only after the
 * meeting has been processed successfully; failed meetings keep them on disk so
 * the user can retry or explicitly discard them (see docs/audio-capture.md).
 */

/** Per-chunk length in seconds of wall-clock audio. */
export const PCM_CHUNK_SECONDS = 60;

const CHUNK_NAME = /^\d{6}\.pcm$/;

/** Sorted, zero-padded `.pcm` chunk file names inside a stream directory. */
export function listChunkFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => CHUNK_NAME.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** Total float samples stored across every chunk file in a stream directory. */
export function recordingFrameCount(dir: string): number {
  let total = 0;
  for (const name of listChunkFiles(dir)) {
    total += Math.floor(statSync(join(dir, name)).size / 4);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Meeting recording manifest (crash recovery / retry / safe cleanup)
// ---------------------------------------------------------------------------

export const MANIFEST_FILE = "manifest.json";
const MANIFEST_VERSION = 1 as const;

/**
 * Per-meeting metadata written next to the chunk files. What the renderer and
 * the DB know as "the meeting", the filesystem tracks with this file so an
 * interrupted session can be recognized, preserved, re-transcribed, or
 * explicitly discarded - and so startup cleanup never deletes a real recording.
 */
export interface RecordingManifest {
  version: typeof MANIFEST_VERSION;
  meetingId: string;
  createdAt: number;
  sampleRate: number;
  sources: AudioCaptureKind[];
  /** "recording" while capture is active, "recorded" once finalized. */
  status: "recording" | "recorded";
}

export function writeManifest(dir: string, manifest: RecordingManifest): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, MANIFEST_FILE);
  // Write to a temp path then atomically rename so a crash mid-write never
  // leaves a truncated manifest (which would make the recording unreadable and
  // could let the startup sweep treat the meeting as unrecoverable garbage).
  writeFileSync(`${file}.tmp`, JSON.stringify(manifest));
  try {
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    rmSync(`${file}.tmp`, { force: true });
    throw error;
  }
}

/** null when the directory holds no recognizable meeting recording. */
export function readManifest(dir: string): RecordingManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as Partial<RecordingManifest>;
    if (
      raw.version !== MANIFEST_VERSION ||
      typeof raw.meetingId !== "string" ||
      typeof raw.sampleRate !== "number" ||
      raw.sampleRate <= 0 ||
      !Array.isArray(raw.sources) ||
      !raw.sources.every((s) => s === "microphone" || s === "loopback")
    ) {
      return null;
    }
    return {
      version: MANIFEST_VERSION,
      meetingId: raw.meetingId,
      createdAt: Number(raw.createdAt) || 0,
      sampleRate: raw.sampleRate,
      sources: raw.sources,
      status: raw.status === "recorded" ? "recorded" : "recording",
    };
  } catch {
    return null;
  }
}

/** True when `dir` holds a recognizable meeting recording (has a manifest). */
export function hasRecordingDir(dir: string): boolean {
  return readManifest(dir) !== null;
}

/** Mark the recording finalized (capture closed, awaiting processing/retry). */
export function finalizeRecording(dir: string): void {
  const manifest = readManifest(dir);
  if (manifest) writeManifest(dir, { ...manifest, status: "recorded" });
}

/**
 * Rebuild a transcribable snapshot of a preserved recording from its manifest +
 * chunk files. Returns null when the directory is not a recognizable recording.
 */
export function buildRecordingSnapshot(dir: string, sources?: AudioCaptureKind[]): RecordingResult | null {
  const manifest = readManifest(dir);
  if (!manifest) return null;
  const kinds = sources && sources.length > 0 ? sources : manifest.sources;
  const streams: RecordingStreamInfo[] = kinds.map((kind) => {
    const streamDir = join(dir, kind);
    return { kind, dir: streamDir, frameCount: recordingFrameCount(streamDir) };
  });
  return { sampleRate: manifest.sampleRate, streams };
}

/** Free bytes on the volume holding `dir`. Returns Infinity when unknown. */
export function getAvailableDiskBytes(dir: string): number {
  try {
    mkdirSync(dir, { recursive: true });
    const stats = statfsSync(dir);
    const available = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(available) && available > 0 ? available : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Read a contiguous range of the canonical mono stream as float32 samples,
 * spanning whatever chunk files it overlaps. Requests past the end of the
 * recording are zero-padded.
 */
export function readPcmWindow(dir: string, startFrame: number, length: number): Float32Array {
  const out = new Float32Array(length);
  let streamFrame = 0;
  for (const name of listChunkFiles(dir)) {
    const path = join(dir, name);
    const fileFrames = Math.floor(statSync(path).size / 4);
    const chunkStart = streamFrame;
    const chunkEnd = streamFrame + fileFrames;
    streamFrame = chunkEnd;

    const overlapStart = Math.max(startFrame, chunkStart);
    const overlapEnd = Math.min(startFrame + length, chunkEnd);
    if (overlapEnd <= overlapStart) continue;

    const from = overlapStart - chunkStart;
    const count = overlapEnd - overlapStart;
    const outOffset = overlapStart - startFrame;
    const buf = readFileSync(path);
    // raw little-endian float32; x86/ARM Windows are always little-endian
    const view = new Float32Array(buf.buffer, buf.byteOffset + from * 4, count);
    out.set(view, outOffset);
  }
  return out;
}

/** Recursively remove a meeting's temporary capture directory. */
export function removeRecordingDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Buffers canonical mono frames and flushes them to numbered chunk files so
 * disk usage stays bounded during long meetings. `close()` flushes the final
 * (possibly partial) chunk. Nothing here is kept after the recording directory
 * is removed.
 */
export class PcmChunkWriter {
  readonly dir: string;
  private readonly chunkSamples: number;
  private buffer: Float32Array;
  private buffered = 0;
  private chunkIndex = 0;
  private captured = 0;

  constructor(rate: number, dir: string, chunkSeconds: number = PCM_CHUNK_SECONDS) {
    this.dir = dir;
    this.chunkSamples = Math.max(1, Math.round(rate * chunkSeconds));
    this.buffer = new Float32Array(this.chunkSamples);
    mkdirSync(dir, { recursive: true });
  }

  /** Total frames written since construction (flushed or still buffered). */
  get capturedFrames(): number {
    return this.captured;
  }

  write(frames: Float32Array): void {
    if (frames.length === 0) return;
    this.captured += frames.length;
    let offset = 0;
    while (offset < frames.length) {
      const take = Math.min(this.chunkSamples - this.buffered, frames.length - offset);
      this.buffer.set(frames.subarray(offset, offset + take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === this.chunkSamples) {
        this.flush();
      }
    }
  }

  /** Flush any remaining buffered samples as the final (partial) chunk. */
  close(): void {
    if (this.buffered > 0) this.flush();
  }

  private flush(): void {
    const samples = this.buffered;
    const name = `${String(this.chunkIndex++).padStart(6, "0")}.pcm`;
    // raw little-endian float32; share the same memory instead of copying
    const bytes = Buffer.from(this.buffer.buffer, this.buffer.byteOffset, samples * 4);
    writeFileSync(join(this.dir, name), bytes);
    this.buffered = 0;
  }
}