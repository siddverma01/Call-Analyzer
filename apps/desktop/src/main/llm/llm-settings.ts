import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LlmRuntimeKind } from "@callnotes/shared";

/**
 * On-device LLM configuration: which runtime to use, where it lives, and the
 * user's chosen analysis model. Persisted as a small JSON file in userData.
 * Nothing here is shared with the backend or any cloud service.
 */
export interface LlmSettings {
  runtime: LlmRuntimeKind;
  ollamaUrl: string;
  llamacppUrl: string;
  defaultModel: string | null;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  runtime: "ollama",
  ollamaUrl: "http://127.0.0.1:11434",
  llamacppUrl: "http://127.0.0.1:8080",
  defaultModel: null,
};

export class LlmSettingsStore {
  constructor(private readonly path: string) {}

  load(): LlmSettings {
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LlmSettings>;
        return normalize(parsed);
      }
    } catch {
      // Unreadable/corrupt settings fall back to defaults rather than crashing.
    }
    return { ...DEFAULT_LLM_SETTINGS };
  }

  save(settings: LlmSettings): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(settings, null, 2), "utf8");
  }
}

function normalize(partial: Partial<LlmSettings>): LlmSettings {
  const runtime: LlmRuntimeKind = partial.runtime === "llamacpp" ? "llamacpp" : "ollama";
  return {
    runtime,
    ollamaUrl: sanitizeUrl(partial.ollamaUrl, DEFAULT_LLM_SETTINGS.ollamaUrl),
    llamacppUrl: sanitizeUrl(partial.llamacppUrl, DEFAULT_LLM_SETTINGS.llamacppUrl),
    defaultModel:
      typeof partial.defaultModel === "string" && partial.defaultModel.trim().length > 0
        ? partial.defaultModel.trim()
        : null,
  };
}

function sanitizeUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return fallback;
  return trimmed;
}