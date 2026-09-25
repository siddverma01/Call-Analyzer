import { cpus } from "node:os";
import type {
  HardwareInfo,
  RecordingStreamInfo,
  WhisperDownloadProgress,
  WhisperEngineStatus,
  WhisperModelId,
  WhisperSegment,
  WhisperTestResult,
} from "@callnotes/shared";
import { WHISPER_ERROR_CODES, WHISPER_MODEL_IDS } from "@callnotes/shared";
import { readPcmWindow } from "../audio/dsp/pcm-chunks.js";
import { MODEL_BY_ID } from "./catalog.js";
import { detectHardware } from "./hardware.js";
import { WhisperCppEngine } from "./engine.js";
import type { ITranscriber } from "./engine.js";
import { WhisperError } from "./errors.js";
import { WhisperModelManager } from "./model-manager.js";
import { whisperAddonPath, whisperNativeAvailable } from "./native-loader.js";

export interface WhisperServiceDeps {
  modelsDir: string;
  statePath: string;
  sendStatus: (status: WhisperEngineStatus) => void;
  sendProgress: (event: WhisperDownloadProgress) => void;
  /** Test seam: returns a fake ITranscriber instead of spawning a worker. */
  createTranscriber?: () => ITranscriber;
}

/** Input for transcribing a finished meeting's temporary capture files. */
export interface WhisperRecordingInput {
  sampleRate: number;
  streams: RecordingStreamInfo[];
  diarization: boolean;
  language: string | null;
  /** Called with 0..1 as windows across all streams are transcribed. */
  onProgress?: (fraction: number) => void;
}

export interface WhisperRecordingResult {
  segments: WhisperSegment[];
}

const SAMPLE_RATE = 16_000;
const MAX_COMPUTE_THREADS = 8;

/** Each stream is transcribed in fixed-length windows to bound memory. */
const TRANSCRIBE_WINDOW_MS = 30_000;
/** Overlap between consecutive windows so audio at the boundary is not lost. */
const TRANSCRIBE_OVERLAP_MS = 1_500;
/** Discard a window's leading segments that duplicate the previous window. */
const TRANSCRIBE_DEDUPE_MS = 600;
const DIARIZATION_SPEAKER_COUNT = 4;

/**
 * Owns the local whisper.cpp transcription pipeline. Runs entirely after a
 * meeting ends: the temp PCM chunk files are transcribed window-by-window in
 * the main process, produce WhisperSegments for the meeting transcript, and
 * are then deleted by the meeting service. Everything is on-device; no cloud
 * fallback exists anywhere in this service.
 */
export class WhisperService {
  private readonly modelManager: WhisperModelManager;
  private transcriber: ITranscriber | null = null;
  private activeModelId: WhisperModelId | null = null;
  private lastError: { code: string; message: string } | null = null;
  private hardwarePromise: Promise<HardwareInfo> | null = null;
  private recommendedModelId: WhisperModelId | null = null;
  private shutdown = false;
  private busy = false;

  constructor(private readonly deps: WhisperServiceDeps) {
    this.modelManager = new WhisperModelManager({
      modelsDir: deps.modelsDir,
      statePath: deps.statePath,
    });
    this.modelManager.onDownloadProgress = (event) => {
      if (this.shutdown) return;
      this.deps.sendProgress(event);
      this.pushStatus();
    };
  }

  // -------------------------------------------------------------------------
  // Status / hardware
  // -------------------------------------------------------------------------

  status(): WhisperEngineStatus {
    return this.buildStatus();
  }

  async hardware(): Promise<HardwareInfo> {
    this.hardwarePromise ??= detectHardware().then((info) => {
      this.recommendedModelId = info.recommendedModelId;
      return info;
    });
    return this.hardwarePromise;
  }

  // -------------------------------------------------------------------------
  // Model management
  // -------------------------------------------------------------------------

  async download(modelId: WhisperModelId): Promise<WhisperEngineStatus> {
    this.assertModelId(modelId);
    await this.modelManager.download(modelId);
    if (!this.modelManager.defaultModelId) this.modelManager.setDefault(modelId);
    this.pushStatus();
    return this.buildStatus();
  }

  abortDownload(): Promise<void> {
    return this.modelManager.abortDownload();
  }

  deleteModel(modelId: WhisperModelId): WhisperEngineStatus {
    this.assertModelId(modelId);
    const touchesEngine = this.activeModelId === modelId || this.modelManager.defaultModelId === modelId;
    this.modelManager.deleteModel(modelId);
    if (touchesEngine) void this.unloadEngine();
    this.pushStatus();
    return this.buildStatus();
  }

  async setDefault(modelId: WhisperModelId): Promise<WhisperEngineStatus> {
    this.assertModelId(modelId);
    this.modelManager.setDefault(modelId);
    this.pushStatus();
    return this.buildStatus();
  }

  // -------------------------------------------------------------------------
  // Engine verification
  // -------------------------------------------------------------------------

  async testModel(modelId?: WhisperModelId): Promise<WhisperTestResult> {
    try {
      const id = modelId ?? (await this.ensureAvailableModel());
      const { transcriber } = await this.ensureEngineLoaded(id);
      const samples = buildTestSignal();
      try {
        const result = await transcriber.transcribe(samples, { offsetMs: 0, language: null });
        this.modelManager.reportVerification(id, true);
        this.lastError = null;
        this.pushStatus();
        return {
          ok: true,
          modelId: id,
          sampleDurationMs: (samples.length / SAMPLE_RATE) * 1000,
          text: result.text || null,
          error: null,
        };
      } catch (error) {
        const whisperError = toWhisperError(error);
        this.modelManager.reportVerification(id, false);
        this.fail(whisperError);
        return {
          ok: false,
          modelId: id,
          sampleDurationMs: (samples.length / SAMPLE_RATE) * 1000,
          text: null,
          error: { code: whisperError.code, message: whisperError.message },
        };
      }
    } catch (error) {
      const whisperError = toWhisperError(error);
      this.fail(whisperError);
      return {
        ok: false,
        modelId: modelId ?? "tiny",
        sampleDurationMs: 0,
        text: null,
        error: { code: whisperError.code, message: whisperError.message },
      };
    }
  }

  // -------------------------------------------------------------------------
  // After-meeting transcription
  // -------------------------------------------------------------------------

  /**
   * Transcribe a finished meeting's temporary capture files into a canonical
   * sequence of WhisperSegments. Each stream (mic, loopback) is read in fixed
   * windows with a small overlap; duplicates from the overlap are dropped per
   * stream, then all segments are merged chronologically. Microphone speech is
   * labeled "Speaker 1"; system audio rotates "Speaker 2..N" when diarization
   * is on, otherwise it is all "Speaker 2".
   */
  async transcribeRecording(input: WhisperRecordingInput): Promise<WhisperRecordingResult> {
    const modelId = await this.ensureAvailableModel();
    const { transcriber } = await this.ensureEngineLoaded(modelId);
    this.modelManager.reportVerification(modelId, true);
    this.lastError = null;

    const windowSamples = Math.round((input.sampleRate * TRANSCRIBE_WINDOW_MS) / 1000);
    const overlapSamples = Math.round((input.sampleRate * TRANSCRIBE_OVERLAP_MS) / 1000);
    const perStreamLastEnd = new Map<number, number>();
    const segments: WhisperSegment[] = [];

    let totalWindows = 0;
    for (const stream of input.streams) {
      totalWindows += stream.frameCount > 0 ? Math.ceil(stream.frameCount / windowSamples) : 0;
    }
    let windowsDone = 0;
    let sequence = 0;
    const loopbackSpeakerCounter = { next: 2 };

    this.busy = true;
    this.pushStatus();
    try {
      for (let streamIndex = 0; streamIndex < input.streams.length; streamIndex++) {
        const stream = input.streams[streamIndex]!;
        if (stream.frameCount <= 0) continue;

        let frameOffset = 0;
        while (frameOffset < stream.frameCount) {
          const windowLength = Math.min(windowSamples + overlapSamples, stream.frameCount - frameOffset);
          const samples = readPcmWindow(stream.dir, frameOffset, windowLength);
          const windowStartMs = Math.round((frameOffset / input.sampleRate) * 1000);

          let result;
          try {
            // The native engine reports timestamps relative to the samples it
            // was given, so anchor them back into the full timeline here.
            result = await transcriber.transcribe(samples, { offsetMs: 0, language: input.language });
          } catch (error) {
            throw toWhisperError(error);
          }

          const lastEmittedEnd = perStreamLastEnd.get(streamIndex) ?? -1;
          for (const raw of result.segments) {
            const text = raw.text.trim();
            if (!text) continue;
            const startMs = windowStartMs + raw.start;
            const endMs = windowStartMs + raw.end;
            if (lastEmittedEnd >= 0 && startMs < lastEmittedEnd - TRANSCRIBE_DEDUPE_MS) continue;
            segments.push({
              id: `${stream.kind}:${startMs}-${sequence++}`,
              startMs,
              endMs,
              speaker: speakerFor(stream.kind, input.diarization, loopbackSpeakerCounter),
              text,
              confidence: raw.confidence,
            });
            perStreamLastEnd.set(streamIndex, Math.max(lastEmittedEnd, endMs));
          }

          frameOffset += windowSamples;
          windowsDone += 1;
          const fraction = totalWindows > 0 ? windowsDone / totalWindows : 1;
          input.onProgress?.(fraction);
        }
      }
    } finally {
      this.busy = false;
      this.pushStatus();
    }

    segments.sort((a, b) => a.startMs - b.startMs);
    return { segments };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.shutdown = true;
    await this.unloadEngine();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async ensureAvailableModel(): Promise<WhisperModelId> {
    if (!whisperNativeAvailable()) {
      throw new WhisperError(
        WHISPER_ERROR_CODES.ENGINE_MISSING,
        "The local whisper engine is not installed on this machine.",
      );
    }
    const recommended = (await this.hardware()).recommendedModelId;
    const preferred = this.modelManager.preferredModel();
    if (!preferred) {
      const entry = MODEL_BY_ID[recommended];
      throw new WhisperError(
        WHISPER_ERROR_CODES.MODEL_MISSING,
        `No transcription model is installed yet. Download the recommended ${entry.name} model (${entry.sizeLabel}) first.`,
      );
    }
    return preferred;
  }

  private async ensureEngineLoaded(modelId: WhisperModelId): Promise<{ transcriber: ITranscriber }> {
    if (this.transcriber && this.activeModelId === modelId) {
      return { transcriber: this.transcriber };
    }
    await this.unloadEngine();

    const modelPath = this.modelManager.resolveModelFile(modelId);
    if (!modelPath) {
      throw new WhisperError(
        WHISPER_ERROR_CODES.MODEL_MISSING,
        `Model "${MODEL_BY_ID[modelId].name}" is not installed.`,
      );
    }

    this.pushStatus();
    const transcriber = (this.deps.createTranscriber ?? (() => new WhisperCppEngine()))();
    try {
      await transcriber.loadModel({
        addonPath: whisperAddonPath() ?? "",
        modelPath,
        threads: computeThreads(),
      });
    } catch (error) {
      throw toWhisperError(error);
    }
    this.transcriber = transcriber;
    this.activeModelId = modelId;
    this.lastError = null;
    this.pushStatus();
    return { transcriber };
  }

  private async unloadEngine(): Promise<void> {
    const transcriber = this.transcriber;
    this.transcriber = null;
    this.activeModelId = null;
    if (transcriber) await transcriber.unload();
  }

  private fail(error: WhisperError): void {
    this.lastError = { code: error.code, message: error.message };
    this.pushStatus();
  }

  private pushStatus(): void {
    if (this.shutdown) return;
    this.deps.sendStatus(this.buildStatus());
  }

  private buildStatus(): WhisperEngineStatus {
    const available = whisperNativeAvailable();
    const models = this.modelManager.list(this.recommendedModelId);
    let state: WhisperEngineStatus["state"] = available ? "ready" : "unavailable";
    let error = this.lastError;
    if (available && this.busy) state = "busy";
    if (!available && !error) {
      error = {
        code: WHISPER_ERROR_CODES.ENGINE_MISSING,
        message: "The on-device transcription engine is not available on this machine.",
      };
    }
    return {
      state,
      backend: "whisper.cpp",
      systemInfo: this.transcriber?.systemInfo ?? null,
      defaultModelId: this.modelManager.defaultModelId,
      models,
      error,
    };
  }

  private assertModelId(modelId: WhisperModelId): void {
    if (!WHISPER_MODEL_IDS.includes(modelId)) {
      throw new WhisperError(WHISPER_ERROR_CODES.WHISPER_FAILED, `Unknown model id: ${String(modelId)}`);
    }
  }
}

/** ~1.2s of a quiet 220 Hz sine = deterministic engine/decode verification. */
function buildTestSignal(): Float32Array {
  const len = Math.round(SAMPLE_RATE * 1.2);
  const samples = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.05;
  }
  return samples;
}

function computeThreads(): number {
  return Math.max(2, Math.min(MAX_COMPUTE_THREADS, Math.max(2, cpus().length - 1)));
}

function speakerFor(
  kind: RecordingStreamInfo["kind"],
  diarization: boolean,
  counter: { next: number },
): string {
  if (kind === "microphone") return "Speaker 1";
  if (!diarization) return "Speaker 2";
  const speaker = `Speaker ${counter.next}`;
  counter.next = counter.next < 2 + DIARIZATION_SPEAKER_COUNT - 1 ? counter.next + 1 : 2;
  return speaker;
}

function toWhisperError(error: unknown): WhisperError {
  return error instanceof WhisperError
    ? error
    : new WhisperError("whisper.failed", error instanceof Error ? error.message : String(error));
}