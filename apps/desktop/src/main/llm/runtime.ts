import { LLM_ERROR_CODES } from "@callnotes/shared";
import type { LlmRuntimeKind } from "@callnotes/shared";

/** A model listed by a local LLM runtime (Ollama or llama.cpp). */
export interface LlmRuntimeModel {
  id: string;
  name: string;
  sizeBytes: number;
}

/** Progress reported while a model is downloading. */
export interface PullProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number;
}

/**
 * A local LLM runtime. Implementations talk to trusted local endpoints only -
 * no cloud provider is ever contacted, and the only payload sent is prompt
 * text (never audio).
 */
export interface LlmRuntime {
  readonly kind: LlmRuntimeKind;
  /** Returns once the runtime responds; throws LlmError when unreachable. */
  ping(): Promise<void>;
  listModels(): Promise<LlmRuntimeModel[]>;
  pullModel(modelId: string, onProgress: (p: PullProgress) => void): Promise<void>;
  deleteModel(modelId: string): Promise<void>;
  /** Ask the runtime for a raw completion; must return the response text. */
  generateJson(input: { model: string; system: string; user: string }): Promise<string>;
}

export class LlmError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const GENERATE_TIMEOUT_MS = 300_000;

/** Shared JSON HTTP client for local LLM runtimes (always a loopback LAN URL). */
export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new LlmError(LLM_ERROR_CODES.RUNTIME_UNREACHABLE, "The local AI runtime did not respond in time.");
    }
    throw new LlmError(
      LLM_ERROR_CODES.RUNTIME_UNREACHABLE,
      `Cannot reach the local AI runtime at ${describeUrl(url)}.`,
    );
  }
  if (!response.ok) {
    throw new LlmError(
      statusErrorCode(response.status),
      `The local AI runtime responded with HTTP ${response.status}${response.status === 404 ? ` (not found at ${describeUrl(url)})` : "."}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export function toGenerateTimeout(): number {
  return GENERATE_TIMEOUT_MS;
}

function statusErrorCode(status: number): string {
  if (status === 404) return LLM_ERROR_CODES.NOT_FOUND;
  return LLM_ERROR_CODES.RUNTIME_UNREACHABLE;
}

function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return url;
  }
}

export function trimBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}