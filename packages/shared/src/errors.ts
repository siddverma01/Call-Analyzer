/** Application error model shared across client/server boundary. */

export const APP_ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: AppErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}