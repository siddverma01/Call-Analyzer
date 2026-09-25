import type { ApiResult } from "@callnotes/shared";

/** Error raised from a non-`ok` bridge result, ready for the stores to surface. */
export class BridgeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
  }
}

/** Unwraps a bridge result or throws a user-friendly BridgeError. */
export function requireOk<T>(result: ApiResult<T>): T {
  if (result.ok) return result.data;
  throw new BridgeError(result.error.code, result.error.message, result.error.status);
}

/** Human-readable message for a bridge failure. */
export function messageFor(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  return result.error.message || "Something went wrong";
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof BridgeError && (error.status === 401 || error.code === "UNAUTHORIZED");
}