import { Worker } from "node:worker_threads";
import { WHISPER_ERROR_CODES } from "@callnotes/shared";
import { WhisperError } from "./errors.js";
import type { WhisperWorkerRequest, WhisperWorkerResponse } from "./worker.js";

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export interface TranscribeResult {
  text: string;
  segments: TranscribeSegment[];
  elapsedMs: number;
}

export interface TranscribeOptions {
  offsetMs: number;
  language: string | null;
}

export interface LoadModelOptions {
  addonPath: string;
  modelPath: string;
  threads: number;
  /** Called with progress 0..1 while the model warms up (context creation). */
  onProgress?: (progress: number) => void;
}

/** Only ArrayBuffers are ever transferred into the worker. */
type Transferable = ArrayBuffer;

/**
 * Minimal worker-thread contract so the engine can be unit-tested with an
 * in-process fake that layers the same (request/response, transferables)
 * protocol.
 */
export interface WhisperWorkerLike {
  postMessage(message: WhisperWorkerRequest, transferList?: Transferable[]): void;
  on(event: "message", listener: (message: unknown) => void): void;
  once(event: "exit", listener: (code: number) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  terminate(): Promise<number>;
  unref(): void;
}

/** Sink for the transcription engine: what the pipeline talks to. */
export interface ITranscriber {
  readonly systemInfo: string | null;
  loadModel(options: LoadModelOptions): Promise<void>;
  transcribe(samples: Float32Array, options: TranscribeOptions): Promise<TranscribeResult>;
  unload(): Promise<void>;
}

interface PendingEntry {
  resolve: (response: WhisperWorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Native whisper.cpp transcription engine. All blocking native calls happen on
 * a dedicated worker thread (see worker.ts); the engine serializes JSON-safe
 * request/response pairs keyed by id. `transcribe` copies the caller's buffer
 * into the worker via a transfer so the PCM never rides IPC twice.
 */
export class WhisperCppEngine implements ITranscriber {
  private worker: WhisperWorkerLike | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private broken = false;
  private loaded = false;
  private engineInfo: string | null = null;

  constructor(private readonly createWorker: () => WhisperWorkerLike = defaultCreateWorker) {}

  get systemInfo(): string | null {
    return this.engineInfo;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  async loadModel(options: LoadModelOptions): Promise<void> {
    options.onProgress?.(0.1);
    this.ensureWorker();
    const id = this.nextUniqueId();
    const response = await this.request(id, {
      req: "load",
      id,
      addonPath: options.addonPath,
      modelPath: options.modelPath,
      threads: options.threads,
    });
    options.onProgress?.(0.6);
    if (response.req !== "load" || !response.ok) {
      this.broken = true;
      throw new WhisperError(
        WHISPER_ERROR_CODES.WHISPER_FAILED,
        response.req === "load" ? response.error : "Unexpected worker response during model load.",
      );
    }
    this.engineInfo = response.systemInfo;
    this.loaded = true;
    options.onProgress?.(1);
  }

  transcribe(samples: Float32Array, options: TranscribeOptions): Promise<TranscribeResult> {
    if (!this.worker || !this.loaded || this.broken) {
      return Promise.reject(new WhisperError(WHISPER_ERROR_CODES.MODEL_MISSING, "No transcription model is loaded."));
    }
    const id = this.nextUniqueId();
    const transfer = new ArrayBuffer(samples.buffer.byteLength);
    // copy into a fresh buffer so the caller's array stays reusable
    new Float32Array(transfer).set(samples);
    const requestPayload: WhisperWorkerRequest = {
      req: "transcribe",
      id,
      samples: new Float32Array(transfer),
      offsetMs: options.offsetMs,
      language: options.language,
    };
    return this.request(id, requestPayload, [transfer]).then((response) => {
      if (response.req !== "transcribe" || !response.ok) {
        throw new WhisperError(
          WHISPER_ERROR_CODES.WHISPER_FAILED,
          response.req === "transcribe" ? response.error : "Unexpected worker response during transcription.",
        );
      }
      return {
        text: response.result.text,
        segments: response.result.segments,
        elapsedMs: response.result.elapsedMs,
      };
    });
  }

  async unload(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.loaded = false;
    this.engineInfo = null;
    this.broken = false;
    if (!worker) return;
    try {
      await worker.terminate();
    } catch {
      // best-effort teardown
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensureWorker(): void {
    if (this.worker) return;
    const worker = this.createWorker();
    worker.unref();
    worker.on("message", (message: unknown) => this.onMessage(message));
    worker.on("error", (error: Error) => this.onWorkerError(error));
    worker.once("exit", (code: number) => this.onWorkerExit(code));
    this.worker = worker;
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const response = message as WhisperWorkerResponse;
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) {
      entry.resolve(response);
    } else {
      entry.reject(new WhisperError(WHISPER_ERROR_CODES.WHISPER_FAILED, "error" in response ? response.error : "Unknown whisper error"));
    }
  }

  private onWorkerError(error: Error): void {
    this.broken = true;
    this.loaded = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.worker = null;
  }

  private onWorkerExit(_code: number): void {
    this.broken = true;
    this.loaded = false;
    const error = new WhisperError(WHISPER_ERROR_CODES.WHISPER_FAILED, "Whisper worker exited unexpectedly.");
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.worker = null;
  }

  private nextUniqueId(): number {
    return this.nextId++;
  }

  private request(
    id: number,
    payload: WhisperWorkerRequest,
    transferList?: Transferable[],
  ): Promise<WhisperWorkerResponse> {
    if (!this.worker) {
      return Promise.reject(new WhisperError(WHISPER_ERROR_CODES.ENGINE_MISSING, "Whisper worker is not running."));
    }
    if (this.broken) {
      return Promise.reject(new WhisperError(WHISPER_ERROR_CODES.WHISPER_FAILED, "Whisper engine is unavailable."));
    }
    const worker = this.worker;
    return new Promise<WhisperWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WhisperError(WHISPER_ERROR_CODES.WHISPER_FAILED, "Whisper request timed out."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage(payload, transferList);
    });
  }
}

function defaultCreateWorker(): WhisperWorkerLike {
  return new Worker(new URL("./worker.js", import.meta.url), { workerData: [] });
}