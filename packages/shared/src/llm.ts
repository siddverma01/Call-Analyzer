/**
 * Local AI meeting analysis contract shared by the renderer, the preload
 * bridge, and the Electron main process.
 *
 * Analysis runs against a local LLM runtime (Ollama or llama.cpp) - never a
 * cloud provider. The LLM receives only transcript text and produces validated
 * JSON; raw audio never leaves the machine. Everything here is runtime
 * agnostic so the renderer never has to know which backend is serving it.
 */

import { z } from "zod";
import { ACTION_ITEM_STATUSES, PRIORITIES } from "./enums.ts";
import type { LocalMeetingDetail } from "./sync.ts";

// ---------------------------------------------------------------------------
// Runtimes + engine status
// ---------------------------------------------------------------------------

export const LLM_RUNTIMES = ["ollama", "llamacpp"] as const;
export type LlmRuntimeKind = (typeof LLM_RUNTIMES)[number];

export const LLM_ENGINE_STATES = ["ready", "busy", "unavailable"] as const;
export type LlmEngineState = (typeof LLM_ENGINE_STATES)[number];

/** Failure codes surfaced by the local AI pipeline. */
export const LLM_ERROR_CODES = {
  RUNTIME_UNREACHABLE: "llm.runtime-unreachable",
  RUNTIME_UNSUPPORTED: "llm.runtime-unsupported",
  MODEL_MISSING: "llm.model-missing",
  EMPTY_TRANSCRIPT: "llm.empty-transcript",
  GENERATION_FAILED: "llm.generation-failed",
  INVALID_OUTPUT: "llm.invalid-output",
  DOWNLOAD_FAILED: "llm.download-failed",
  DELETE_FAILED: "llm.delete-failed",
  NOT_FOUND: "llm.not-found",
} as const;

export interface LlmModelInfo {
  /** Runtime model id, e.g. "llama3.2:3b" for Ollama. */
  id: string;
  name: string;
  sizeLabel: string;
  installed: boolean;
  isDefault: boolean;
  downloading: boolean;
  pulledPercent: number;
}

export interface LlmEngineStatus {
  state: LlmEngineState;
  runtime: LlmRuntimeKind;
  ollamaUrl: string;
  llamacppUrl: string;
  defaultModelId: string | null;
  models: LlmModelInfo[];
  error: { code: string; message: string } | null;
}

export interface LlmDownloadProgress {
  modelId: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number;
}

/** Renderer -> main: change runtime or endpoint, re-scan models. */
export interface LlmSetRuntimeRequest {
  runtime: LlmRuntimeKind;
  ollamaUrl?: string;
  llamacppUrl?: string;
}

// ---------------------------------------------------------------------------
// Structured analysis output (validated JSON from the local LLM)
// ---------------------------------------------------------------------------

export const analysisActionItemSchema = z.object({
  description: z.string().min(1).max(100_000),
  assignee: z.string().max(120).optional().default("Unknown"),
  /** ISO date string, or "Not specified"; mapped to null at save time. */
  dueDate: z.string().max(60).nullable().optional().default(null),
  priority: z.enum(PRIORITIES).optional().default("MEDIUM"),
  status: z.enum(ACTION_ITEM_STATUSES).optional().default("OPEN"),
  /** 1-based index into the numbered transcript the model was shown. */
  sourceSegmentNumber: z.number().int().positive().nullable().optional().default(null),
});

export type AnalysisActionItem = z.infer<typeof analysisActionItemSchema>;

export const analysisResultSchema = z.object({
  summary: z.string().min(1).max(100_000),
  discussionPoints: z.array(z.string()).optional().default([]),
  decisions: z.array(z.string()).optional().default([]),
  risks: z.array(z.string()).optional().default([]),
  openQuestions: z.array(z.string()).optional().default([]),
  blockers: z.array(z.string()).optional().default([]),
  followUps: z.array(z.string()).optional().default([]),
  importantDates: z.array(z.string()).optional().default([]),
  /** Only populated when the model is confident about a name. */
  participants: z.array(z.string()).optional().default([]),
  actionItems: z.array(analysisActionItemSchema).optional().default([]),
});

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

/** Result envelope for analyzing (and saving) one local meeting. */
export interface LlmAnalysisOutcome {
  ok: boolean;
  /** Fresh local meeting after saving generated notes, when ok. */
  meeting: LocalMeetingDetail | null;
  error: { code: string; message: string } | null;
}