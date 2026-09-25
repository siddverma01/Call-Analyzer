import type {
  AnalysisActionItem,
  LlmAnalysisOutcome,
  LlmDownloadProgress,
  LlmEngineState,
  LlmEngineStatus,
  LlmModelInfo,
  LlmRuntimeKind,
  LlmSetRuntimeRequest,
  MeetingSyncActionItem,
  MeetingSyncSummary,
} from "@callnotes/shared";
import { LLM_ERROR_CODES } from "@callnotes/shared";
import type { LocalStore } from "../db/local-db.js";
import type { MeetingService } from "../meeting/meeting-service.js";
import { formatBytes, LlmError } from "./runtime.js";
import type { LlmRuntime, LlmRuntimeModel } from "./runtime.js";
import { OllamaRuntime } from "./ollama-runtime.js";
import { LlamacppRuntime } from "./llamacpp-runtime.js";
import { AnalysisEngine, formatNumberedTranscript, truncateTranscript } from "./analysis.js";
import type { AnalysisResult } from "@callnotes/shared";
import type { LlmSettings, LlmSettingsStore } from "./llm-settings.js";

export interface LlmServiceDeps {
  store: LocalStore;
  meeting: Pick<MeetingService, "setNotes" | "get">;
  settingsStore: LlmSettingsStore;
  sendStatus: (status: LlmEngineStatus) => void;
  sendProgress: (event: LlmDownloadProgress) => void;
  /** Test seam: construct the runtime instead of touching the network. */
  createRuntime?: (kind: LlmRuntimeKind, url: string, defaultModel: string | null) => LlmRuntime;
  now?: () => number;
  newId?: () => string;
}

export function createLlmRuntime(kind: LlmRuntimeKind, url: string, defaultModel: string | null): LlmRuntime {
  return kind === "ollama" ? new OllamaRuntime(url) : new LlamacppRuntime(url, defaultModel);
}

/**
 * Owns the local AI analysis pipeline in the Electron main process: runtime
 * selection (Ollama / llama.cpp), model discovery / download / default, and
 * transcript analysis. Everything runs against a local endpoint - the model
 * receives transcript text only, and generated notes are saved locally before
 * being included in the ordinary text-only sync payload.
 */
export class LlmService {
  private readonly store: LocalStore;
  private readonly meeting: Pick<MeetingService, "setNotes" | "get">;
  private readonly settingsStore: LlmSettingsStore;
  private readonly sendStatus: (status: LlmEngineStatus) => void;
  private readonly sendProgress: (event: LlmDownloadProgress) => void;
  private readonly createRuntime: (kind: LlmRuntimeKind, url: string, defaultModel: string | null) => LlmRuntime;
  private readonly now: () => number;
  private readonly newId: () => string;

  private runtime: LlmRuntime | null = null;
  private installedModels: LlmRuntimeModel[] = [];
  private runtimeError: { code: string; message: string } | null = null;
  private readonly downloading = new Map<string, number>();
  private analyzing = false;

  constructor(deps: LlmServiceDeps) {
    this.store = deps.store;
    this.meeting = deps.meeting;
    this.settingsStore = deps.settingsStore;
    this.sendStatus = deps.sendStatus;
    this.sendProgress = deps.sendProgress;
    this.createRuntime = deps.createRuntime ?? createLlmRuntime;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  }

  // -------------------------------------------------------------------------
  // Status + runtime selection
  // -------------------------------------------------------------------------

  async status(): Promise<LlmEngineStatus> {
    return this.refresh();
  }

  async setRuntime(input: LlmSetRuntimeRequest): Promise<LlmEngineStatus> {
    const settings = this.settingsStore.load();
    const runtime: LlmRuntimeKind = input.runtime === "llamacpp" ? "llamacpp" : "ollama";
    const next: LlmSettings = {
      runtime,
      ollamaUrl: sanitizeEndpoint(input.ollamaUrl, settings.ollamaUrl),
      llamacppUrl: sanitizeEndpoint(input.llamacppUrl, settings.llamacppUrl),
      defaultModel: runtime === settings.runtime ? settings.defaultModel : null,
    };
    this.settingsStore.save(next);
    this.runtime = null;
    this.runtimeError = null;
    this.installedModels = [];
    return this.refresh();
  }

  // -------------------------------------------------------------------------
  // Model management (user-initiated only - the app never auto-downloads)
  // -------------------------------------------------------------------------

  async pull(modelId: string): Promise<LlmEngineStatus> {
    const settings = this.settingsStore.load();
    const runtime = this.getRuntime(settings);
    this.downloading.set(modelId, 0);
    this.pushStatus();
    try {
      await runtime.pullModel(modelId, (progress) => {
        this.downloading.set(modelId, progress.percent);
        this.sendProgress({
          modelId,
          downloadedBytes: progress.downloadedBytes,
          totalBytes: progress.totalBytes,
          percent: progress.percent,
        });
        this.pushStatus();
      });
      this.downloading.delete(modelId);
      this.runtimeError = null;
      if (!settings.defaultModel) {
        this.settingsStore.save({ ...settings, defaultModel: modelId });
      }
    } catch (error) {
      this.downloading.delete(modelId);
      const llmError = toLlmError(error);
      this.runtimeError = llmError;
      this.pushStatus();
      throw llmError;
    }
    return this.refresh();
  }

  async deleteModel(modelId: string): Promise<LlmEngineStatus> {
    const settings = this.settingsStore.load();
    if (settings.defaultModel === modelId) {
      throw new LlmError(LLM_ERROR_CODES.DELETE_FAILED, "The default model cannot be deleted. Choose another default first.");
    }
    const runtime = this.getRuntime(settings);
    try {
      await runtime.deleteModel(modelId);
      this.runtimeError = null;
    } catch (error) {
      const llmError = toLlmError(error);
      this.runtimeError = llmError;
      this.pushStatus();
      throw llmError;
    }
    return this.refresh();
  }

  async setDefault(modelId: string): Promise<LlmEngineStatus> {
    const settings = this.settingsStore.load();
    const runtime = this.getRuntime(settings);
    let installed: LlmRuntimeModel[];
    try {
      await runtime.ping();
      installed = await runtime.listModels();
      this.runtimeError = null;
    } catch (error) {
      const llmError = toLlmError(error);
      this.runtimeError = llmError;
      this.pushStatus();
      throw llmError;
    }
    if (!installed.some((model) => model.id === modelId)) {
      throw new LlmError(LLM_ERROR_CODES.MODEL_MISSING, `Model "${modelId}" is not present in the local AI runtime.`);
    }
    this.installedModels = installed;
    this.settingsStore.save({ ...settings, defaultModel: modelId });
    this.pushStatus();
    return this.buildStatus();
  }

  // -------------------------------------------------------------------------
  // Meeting analysis
  // -------------------------------------------------------------------------

  async analyzeMeeting(meetingId: string): Promise<LlmAnalysisOutcome> {
    const row = this.store.getMeeting(meetingId);
    if (!row) {
      return failOutcome(LLM_ERROR_CODES.NOT_FOUND, "The meeting could not be found on this device.");
    }

    const segments = this.store.listSegments(meetingId);
    const transcript = truncateTranscript(
      formatNumberedTranscript(segments.map((segment) => ({ speaker: segment.speaker, text: segment.text }))),
    );
    if (!transcript.trim()) {
      return failOutcome(
        LLM_ERROR_CODES.EMPTY_TRANSCRIPT,
        "There is no transcript to analyze. Start a meeting and record something first.",
      );
    }

    const settings = this.settingsStore.load();
    const runtime = this.getRuntime(settings);

    try {
      await runtime.ping();
    } catch {
      return failOutcome(
        LLM_ERROR_CODES.RUNTIME_UNREACHABLE,
        "Summary generation unavailable. Make sure your local AI runtime is running, then retry.",
      );
    }

    const model = settings.defaultModel;
    if (!model) {
      return failOutcome(
        LLM_ERROR_CODES.MODEL_MISSING,
        "Summary generation unavailable. Select an analysis model in Settings → Local AI first.",
      );
    }

    try {
      const installed = await runtime.listModels();
      if (!installed.some((entry) => entry.id === model)) {
        return failOutcome(LLM_ERROR_CODES.MODEL_MISSING, `Model "${model}" is not present in the local AI runtime.`);
      }
    } catch {
      return failOutcome(
        LLM_ERROR_CODES.RUNTIME_UNREACHABLE,
        "Summary generation unavailable. Make sure your local AI runtime is running, then retry.",
      );
    }

    this.analyzing = true;
    this.pushStatus();
    try {
      const engine = new AnalysisEngine((input) => runtime.generateJson(input), model);
      const result = await engine.analyze(transcript);
      const summary = toSyncSummary(result, model, settings.runtime);
      const actionItems = buildActionItems(
        result.actionItems,
        segments,
        this.store.getActionItems(meetingId),
        this.newId,
      );
      await this.meeting.setNotes(meetingId, { summary, actionItems });
      return { ok: true, meeting: this.meeting.get(meetingId), error: null };
    } catch (error) {
      const llmError = toLlmError(error);
      return failOutcome(llmError.code, llmError.message);
    } finally {
      this.analyzing = false;
      this.pushStatus();
    }
  }

  dispose(): void {
    this.runtime = null;
    this.downloading.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private getRuntime(settings: LlmSettings): LlmRuntime {
    if (!this.runtime) {
      this.runtime = this.createRuntime(
        settings.runtime,
        settings.runtime === "ollama" ? settings.ollamaUrl : settings.llamacppUrl,
        settings.defaultModel,
      );
    }
    return this.runtime;
  }

  private async refresh(): Promise<LlmEngineStatus> {
    const settings = this.settingsStore.load();
    const runtime = this.getRuntime(settings);
    try {
      await runtime.ping();
      this.installedModels = await runtime.listModels();
      this.runtimeError = null;
    } catch (error) {
      this.installedModels = [];
      this.runtimeError = toLlmError(error);
    }
    const status = this.buildStatus();
    this.sendStatus(status);
    return status;
  }

  private buildStatus(): LlmEngineStatus {
    const settings = this.settingsStore.load();
    const state: LlmEngineState =
      this.runtimeError !== null ? "unavailable" : this.analyzing || this.downloading.size > 0 ? "busy" : "ready";
    const models: LlmModelInfo[] = this.installedModels.map((model) => {
      const percent = this.downloading.get(model.id);
      return {
        id: model.id,
        name: model.name,
        sizeLabel: formatBytes(model.sizeBytes),
        installed: true,
        isDefault: model.id === settings.defaultModel,
        downloading: percent !== undefined,
        pulledPercent: percent ?? 0,
      };
    });
    return {
      state,
      runtime: settings.runtime,
      ollamaUrl: settings.ollamaUrl,
      llamacppUrl: settings.llamacppUrl,
      defaultModelId: settings.defaultModel,
      models,
      error: this.runtimeError,
    };
  }

  private pushStatus(): void {
    this.sendStatus(this.buildStatus());
  }
}

function failOutcome(code: string, message: string): LlmAnalysisOutcome {
  return { ok: false, meeting: null, error: { code, message } };
}

function toLlmError(error: unknown): LlmError {
  return error instanceof LlmError ? error : new LlmError(LLM_ERROR_CODES.GENERATION_FAILED, error instanceof Error ? error.message : String(error));
}

function sanitizeEndpoint(value: string | undefined, fallback: string): string {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return fallback;
  return value.trim();
}

function toSyncSummary(result: AnalysisResult, model: string, provider: string): MeetingSyncSummary {
  return {
    summary: result.summary,
    discussionPoints: result.discussionPoints,
    decisions: result.decisions,
    risks: result.risks,
    openQuestions: result.openQuestions,
    blockers: result.blockers,
    followUps: result.followUps,
    importantDates: result.importantDates,
    participants: result.participants,
    aiModel: model,
    aiProvider: provider,
  };
}

function buildActionItems(
  items: AnalysisActionItem[],
  segments: ReadonlyArray<{ clientSegmentId: string }>,
  existing: MeetingSyncActionItem[],
  newId: () => string,
): MeetingSyncActionItem[] {
  const byDescription = new Map<string, MeetingSyncActionItem>();
  for (const item of existing) {
    if (item.description) byDescription.set(item.description.trim().toLowerCase(), item);
  }

  return items.map((item) => {
    const previous = byDescription.get(item.description.trim().toLowerCase());
    const index = item.sourceSegmentNumber ?? null;
    const source =
      index !== null && index >= 1 && index <= segments.length ? segments[index - 1] : null;
    return {
      clientItemId: previous?.clientItemId ?? newId(),
      description: item.description,
      assignee: item.assignee === "Unknown" ? "Unknown" : (item.assignee?.trim() || null),
      dueDate: parseDueDate(item.dueDate),
      priority: item.priority,
      status: item.status,
      sourceSegmentId: source?.clientSegmentId ?? null,
    };
  });
}

function parseDueDate(value: string | null): Date | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}