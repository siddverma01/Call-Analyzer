import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { APP_ERROR_CODES, type AppErrorCode } from "@callnotes/shared";

/** Maps shared error codes to HTTP status codes. */
export function codeToHttpStatus(code: AppErrorCode): number {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "SERVICE_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

export class AppError extends Error {
  override readonly name: string = "AppError";
  readonly code: AppErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Validate a request body with zod; throws VALIDATION_ERROR on failure. */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError("VALIDATION_ERROR", "Invalid request", { issues: result.error.issues });
  }
  return result.data;
}

/** Standardized error handler for the whole API. Never leaks stack traces. */
export function onError(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  request.log.error({ err: error }, "request failed");

  if (error instanceof AppError) {
    void reply.status(codeToHttpStatus(error.code)).send({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  if (error instanceof z.ZodError) {
    void reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: "Invalid request", details: { issues: error.issues } },
    });
    return;
  }

  // @fastify/rate-limit throws the errorResponseBuilder payload directly.
  const rateLimited = (error as { error?: { code?: string; message?: string } })?.error;
  if (rateLimited?.code === "RATE_LIMITED") {
    void reply.status(429).send({
      error: { code: "RATE_LIMITED", message: rateLimited.message ?? "Too many requests. Please retry later." },
    });
    return;
  }

  void reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
}

export { APP_ERROR_CODES };