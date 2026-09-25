/** Structured segment emitted by the native whisper.cpp addon. */
export interface WhisperNativeSegment {
  start: number;
  end: number;
  text: string;
  /** Mean token probability from whisper_full (0..1); -1 when unavailable. */
  confidence: number;
}

export interface WhisperNativeResult {
  text: string;
  segments: WhisperNativeSegment[];
  elapsedMs: number;
}

/** The exact surface exported by `callnotes-whisper-*.node`. */
export interface WhisperNativeAddon {
  systemInfo(): string;
  /** Create a model context; returns a context handle id. */
  createContext(modelPath: string, threads: number): number;
  /** Synchronous (blocking) transcription of mono float32 at 16 kHz. */
  transcribe(
    ctx: number,
    samples: Float32Array,
    offsetMs: number,
    language: string | null,
  ): WhisperNativeResult;
  freeContext(ctx: number): boolean;
}