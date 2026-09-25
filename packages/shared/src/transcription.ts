/**
 * Local transcription (whisper.cpp) contract shared by the renderer, the
 * preload bridge, and the Electron main process.
 *
 * Transcription runs 100% on-device with whisper.cpp and only ever happens
 * AFTER a meeting ends. During the meeting the app captures microphone and
 * system audio into temporary local files; once the meeting stops those are
 * transcribed, the text is saved, and the temporary audio is deleted. Raw
 * audio never leaves the machine and never touches the backend (see
 * docs/privacy.md). No cloud transcription fallback ever exists.
 */

export const WHISPER_MODEL_IDS = ["tiny", "base", "small", "medium"] as const;
export type WhisperModelId = (typeof WHISPER_MODEL_IDS)[number];

export interface WhisperModelInfo {
  id: WhisperModelId;
  /** Display name, e.g. "Tiny". */
  name: string;
  /** File name on disk, e.g. ggml-tiny.bin. */
  file: string;
  sizeBytes: number;
  sizeLabel: string;
  /** True when hardware detection recommended this model. */
  recommended: boolean;
  installed: boolean;
  isDefault: boolean;
  /** True after the model passed an engine load + decode verification. */
  verified: boolean | null;
  /** True when the engine failed to load this model (corrupt/truncated). */
  corrupt: boolean;
  downloading: boolean;
  downloadedBytes: number;
}

export type WhisperEngineState = "unavailable" | "ready" | "busy" | "error";

export interface WhisperEngineStatus {
  /** "us"-level state of the local whisper.cpp engine. */
  state: WhisperEngineState;
  backend: "whisper.cpp";
  /** Native system info string (threads, SIMD) when the addon is loaded. */
  systemInfo: string | null;
  defaultModelId: WhisperModelId | null;
  models: WhisperModelInfo[];
  error: { code: string; message: string } | null;
}

export interface HardwareInfo {
  cpuModel: string;
  cores: number;
  threads: number;
  ramBytes: number;
  /** GPU + VRAM when a driver reported it (nvidia-smi), else null. */
  gpu: { name: string; vramBytes: number } | null;
  platform: string;
  arch: string;
  recommendedModelId: WhisperModelId;
}

export interface WhisperDownloadProgress {
  modelId: WhisperModelId;
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
}

/** One transcript line produced for a finished meeting. `id` is a stable clientSegmentId for dedupe. */
export interface WhisperSegment {
  id: string;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  /** Mean token probability (0..1) from whisper_full; -1 when unavailable. */
  confidence: number;
}

export interface WhisperTestResult {
  ok: boolean;
  modelId: WhisperModelId;
  sampleDurationMs: number;
  text: string | null;
  error: { code: string; message: string } | null;
}

/** Machine-parseable engine error codes surfaced to the UI. */
export const WHISPER_ERROR_CODES = {
  ENGINE_MISSING: "whisper.engine-missing",
  ENGINE_BUSY: "whisper.engine-busy",
  MODEL_MISSING: "whisper.model-missing",
  MODEL_CORRUPT: "whisper.model-corrupt",
  MODEL_DOWNLOAD_FAILED: "whisper.model-download-failed",
  MODEL_VERIFY_FAILED: "whisper.model-verify-failed",
  MODEL_IN_USE: "whisper.model-in-use",
  INSUFFICIENT_RAM: "whisper.insufficient-ram",
  INSUFFICIENT_DISK: "whisper.insufficient-disk",
  GPU_UNAVAILABLE: "whisper.gpu-unavailable",
  WHISPER_FAILED: "whisper.failed",
  AUDIO_FAILED: "whisper.audio-failed",
  CANCELLED: "whisper.cancelled",
} as const;