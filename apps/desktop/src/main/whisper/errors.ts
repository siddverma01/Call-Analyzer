/** Typed failure for every whisper-layer error; `code` maps to shared codes. */
export class WhisperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WhisperError";
  }

  static is(error: unknown): error is WhisperError {
    return error instanceof WhisperError;
  }
}

export function asWhisperError(error: unknown): WhisperError {
  if (WhisperError.is(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WhisperError("whisper.failed", message);
}