import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LlmDownloadProgress,
  LlmEngineStatus,
  LlmRuntimeModel,
  LocalMeetingDetail,
  MeetingSyncActionItem,
  MeetingSyncSummary,
} from "@callnotes/shared";
import { LLM_ERROR_CODES } from "@callnotes/shared";
import { LocalStore } from "../../src/main/db/local-db";
import { LlmService } from "../../src/main/llm/llm-service";
import { LlmSettingsStore } from "../../src/main/llm/llm-settings";
import { LlmError } from "../../src/main/llm/runtime";
import type { LlmRuntime, PullProgress } from "../../src/main/llm/runtime";

const MODEL_ID = "llama3.2:3b";
const MEETING_ID = "m1";

const VALID_RESULT_JSON = JSON.stringify({
  summary: "We agreed to ship the fix.",
  discussionPoints: ["Redesign is approved"],
  decisions: ["Ship the fix"],
  risks: [],
  openQuestions: [],
  blockers: ["Review still pending"],
  followUps: ["Schedule the retro"],
  importantDates: [],
  participants: ["Alice", "Bob"],
  actionItems: [
    {
      description: "Open the PR",
      assignee: "Not specified",
      dueDate: "Not specified",
      priority: "HIGH",
      status: "OPEN",
      sourceSegmentNumber: 2,
    },
  ],
});

class FakeRuntime implements LlmRuntime {
  readonly kind = "ollama" as const;
  ping = vi.fn(async () => {});
  listModels = vi.fn(async (): Promise<LlmRuntimeModel[]> => this.models);
  pullModel = vi.fn(async (_id: string, _on: (p: PullProgress) => void): Promise<void> => {});
  deleteModel = vi.fn(async (_id: string): Promise<void> => {});
  generateJson = vi.fn(
    async (_input: { model: string; system: string; user: string }): Promise<string> => VALID_RESULT_JSON,
  );
  models: LlmRuntimeModel[] = [{ id: MODEL_ID, name: `${MODEL_ID} (3B)`, sizeBytes: 2_000_000_000 }];
}

let clock = 1000;
const now = () => clock;
const dirs: string[] = [];

interface Harness {
  store: LocalStore;
  settings: LlmSettingsStore;
  runtime: FakeRuntime;
  service: LlmService;
  statuses: LlmEngineStatus[];
  progress: LlmDownloadProgress[];
  setNotes: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function makeDetail(id: string): LocalMeetingDetail {
  return {
    id,
    title: "Standup",
    templateId: null,
    startedAt: "2026-01-01T10:00:00Z",
    endedAt: null,
    durationSeconds: 60,
    status: "COMPLETED",
    segmentCount: 2,
    summaryPreview: null,
    createdAt: "2026-01-01T10:00:00Z",
    updatedAt: "2026-01-01T10:00:00Z",
    syncStatus: "PENDING_SYNC",
    syncError: null,
    segments: [],
    summary: null,
    actionItems: [],
  };
}

function harness(overrides: { defaultModel?: string | null } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "lt-llm-"));
  dirs.push(dir);

  const store = new LocalStore(join(dir, "callnotes.db"), now);
  store.createMeeting({ id: MEETING_ID, title: "Standup", templateId: null, status: "SYNC_PENDING", startedAt: clock });
  store.upsertSegments(MEETING_ID, [
    { clientSegmentId: "s1", speaker: "Alice", startMs: 0, endMs: 1200, text: "Hello everyone", confidence: 0.9 },
    { clientSegmentId: "s2", speaker: "Bob", startMs: 1300, endMs: 2400, text: "Ship the fix today", confidence: 0.9 },
  ]);
  store.createMeeting({ id: "m2", title: "Empty", templateId: null, status: "SYNC_PENDING", startedAt: clock });

  const settings = new LlmSettingsStore(join(dir, "llm.json"));
  settings.save({
    runtime: "ollama",
    ollamaUrl: "http://127.0.0.1:11434",
    llamacppUrl: "http://127.0.0.1:8080",
    defaultModel: overrides.defaultModel === undefined ? MODEL_ID : overrides.defaultModel,
  });

  const runtime = new FakeRuntime();
  const statuses: LlmEngineStatus[] = [];
  const progress: LlmDownloadProgress[] = [];
  const setNotes = vi.fn(async () => {});
  const get = vi.fn((id: string): LocalMeetingDetail | null => (id === MEETING_ID ? makeDetail(id) : null));

  const service = new LlmService({
    store,
    meeting: { setNotes, get },
    settingsStore: settings,
    sendStatus: (s) => statuses.push(s),
    sendProgress: (p) => progress.push(p),
    createRuntime: () => runtime,
    now,
    newId: () => "item-1",
  });

  return { store, settings, runtime, service, statuses, progress, setNotes, get };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      const { rmSync } = require("node:fs") as typeof import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures on Windows
    }
  }
});

describe("LlmService - status and runtime selection", () => {
  it("reports ready with discovered models when the runtime is reachable", async () => {
    const h = harness();
    const status = await h.service.status();
    expect(status.state).toBe("ready");
    expect(status.runtime).toBe("ollama");
    expect(status.defaultModelId).toBe(MODEL_ID);
    expect(status.models).toHaveLength(1);
    expect(status.models[0]).toMatchObject({
      id: MODEL_ID,
      installed: true,
      isDefault: true,
      downloading: false,
    });
    expect(status.error).toBeNull();
    expect(h.statuses[h.statuses.length - 1]?.state).toBe("ready");
  });

  it("reports unavailable with the runtime error when ping fails", async () => {
    const h = harness();
    h.runtime.ping.mockRejectedValue(new LlmError(LLM_ERROR_CODES.RUNTIME_UNREACHABLE, "connection refused"));
    const status = await h.service.status();
    expect(status.state).toBe("unavailable");
    expect(status.models).toEqual([]);
    expect(status.error?.code).toBe(LLM_ERROR_CODES.RUNTIME_UNREACHABLE);
  });

  it("setRuntime switches runtimes and clears the default model", async () => {
    const h = harness();
    const status = await h.service.setRuntime({
      runtime: "llamacpp",
      ollamaUrl: "http://127.0.0.1:11434",
      llamacppUrl: "http://127.0.0.1:18080",
    });
    expect(status.runtime).toBe("llamacpp");
    expect(status.defaultModelId).toBeNull();
    expect(h.settings.load().llamacppUrl).toBe("http://127.0.0.1:18080");
  });

  it("setRuntime falls back to previous URLs when given invalid endpoints", async () => {
    const h = harness();
    await h.service.setRuntime({
      runtime: "ollama",
      ollamaUrl: "ftp://bad",
      llamacppUrl: "not-a-url",
    });
    const settings = h.settings.load();
    expect(settings.ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(settings.llamacppUrl).toBe("http://127.0.0.1:8080");
    expect(settings.defaultModel).toBe(MODEL_ID);
  });
});

describe("LlmService - model management (user-initiated only)", () => {
  it("pulls a model, streams progress, and auto-sets it as default when none is set", async () => {
    const h = harness({ defaultModel: null });
    const status = await h.service.pull("qwen2.5:7b");
    expect(h.runtime.pullModel).toHaveBeenCalledWith("qwen2.5:7b", expect.any(Function));
    expect(h.settings.load().defaultModel).toBe("qwen2.5:7b");
    expect(h.progress.map((p) => p.percent)).toEqual([]); // fake runtime reports nothing
    expect(status.defaultModelId).toBe("qwen2.5:7b");
  });

  it("does not overwrite an existing default model after a pull", async () => {
    const h = harness();
    await h.service.pull("qwen2.5:7b");
    expect(h.settings.load().defaultModel).toBe(MODEL_ID);
  });

  it("surfaces pull failures and keeps the default model untouched", async () => {
    const h = harness();
    h.runtime.pullModel.mockRejectedValue(new LlmError(LLM_ERROR_CODES.DOWNLOAD_FAILED, "disk full"));
    await expect(h.service.pull("qwen2.5:7b")).rejects.toBeInstanceOf(LlmError);
    expect(h.settings.load().defaultModel).toBe(MODEL_ID);
    expect(h.statuses[h.statuses.length - 1]?.state).toBe("unavailable");
  });

  it("refuses to delete the default model", async () => {
    const h = harness();
    await expect(h.service.deleteModel(MODEL_ID)).rejects.toMatchObject({
      code: LLM_ERROR_CODES.DELETE_FAILED,
    });
    expect(h.runtime.deleteModel).not.toHaveBeenCalled();
  });

  it("deletes a non-default model", async () => {
    const h = harness();
    await h.service.deleteModel("qwen2.5:7b");
    expect(h.runtime.deleteModel).toHaveBeenCalledWith("qwen2.5:7b");
  });

  it("setDefault rejects a model the runtime does not have", async () => {
    const h = harness();
    await expect(h.service.setDefault("does-not-exist")).rejects.toMatchObject({
      code: LLM_ERROR_CODES.MODEL_MISSING,
    });
    expect(h.settings.load().defaultModel).toBe(MODEL_ID);
  });

  it("setDefault persists the selected model", async () => {
    const h = harness({ defaultModel: null });
    h.runtime.models = [
      { id: MODEL_ID, name: MODEL_ID, sizeBytes: 1 },
      { id: "qwen2.5:7b", name: "qwen2.5:7b", sizeBytes: 2 },
    ];
    const status = await h.service.setDefault("qwen2.5:7b");
    expect(h.settings.load().defaultModel).toBe("qwen2.5:7b");
    expect(status.defaultModelId).toBe("qwen2.5:7b");
  });
});

describe("LlmService - meeting analysis", () => {
  it("returns NOT_FOUND for a meeting that is not stored locally", async () => {
    const h = harness();
    const outcome = await h.service.analyzeMeeting("nope");
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe(LLM_ERROR_CODES.NOT_FOUND);
    expect(h.runtime.generateJson).not.toHaveBeenCalled();
  });

  it("returns EMPTY_TRANSCRIPT for a meeting with no transcript", async () => {
    const h = harness();
    const outcome = await h.service.analyzeMeeting("m2");
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe(LLM_ERROR_CODES.EMPTY_TRANSCRIPT);
    expect(h.runtime.generateJson).not.toHaveBeenCalled();
  });

  it("fails gracefully when the runtime is unreachable", async () => {
    const h = harness();
    h.runtime.ping.mockRejectedValue(new Error("connection refused"));
    const outcome = await h.service.analyzeMeeting(MEETING_ID);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe(LLM_ERROR_CODES.RUNTIME_UNREACHABLE);
    expect(outcome.error?.message).toContain("Summary generation unavailable.");
    expect(h.setNotes).not.toHaveBeenCalled();
  });

  it("requires a selected default model", async () => {
    const h = harness({ defaultModel: null });
    const outcome = await h.service.analyzeMeeting(MEETING_ID);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe(LLM_ERROR_CODES.MODEL_MISSING);
    expect(outcome.error?.message).toContain("Select an analysis model");
  });

  it("rejects a default model the runtime does not have installed", async () => {
    const h = harness();
    h.runtime.models = [];
    const outcome = await h.service.analyzeMeeting(MEETING_ID);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe(LLM_ERROR_CODES.MODEL_MISSING);
    expect(outcome.error?.message).toContain("not present");
  });

  it("analyzes a meeting, saves notes locally, and maps action items to segments", async () => {
    const h = harness();
    const outcome = await h.service.analyzeMeeting(MEETING_ID);
    expect(outcome.ok).toBe(true);
    expect(outcome.meeting?.id).toBe(MEETING_ID);

    expect(h.runtime.generateJson).toHaveBeenCalledTimes(1);
    const prompt = h.runtime.generateJson.mock.calls[0]![0];
    expect(prompt.model).toBe(MODEL_ID);
    expect(prompt.system).toContain("local meeting analyst");
    expect(prompt.user).toContain("1. Alice: Hello everyone");
    expect(prompt.user).toContain("2. Bob: Ship the fix today");

    expect(h.setNotes).toHaveBeenCalledTimes(1);
    const { summary, actionItems } = h.setNotes.mock.calls[0]![1] as {
      summary: MeetingSyncSummary;
      actionItems: MeetingSyncActionItem[];
    };
    expect(summary.summary).toBe("We agreed to ship the fix.");
    expect(summary.participants).toEqual(["Alice", "Bob"]);
    expect(summary.blockers).toEqual(["Review still pending"]);
    expect(summary.aiModel).toBe(MODEL_ID);
    expect(summary.aiProvider).toBe("ollama");
    expect(actionItems).toHaveLength(1);
    expect(actionItems[0]).toMatchObject({
      clientItemId: "item-1",
      description: "Open the PR",
      assignee: "Unknown",
      dueDate: null,
      priority: "HIGH",
      sourceSegmentId: "s2",
    });
  });

  it("keeps the transcript intact when the model output is invalid", async () => {
    const h = harness();
    h.runtime.generateJson.mockResolvedValue("not structured json at all");
    const outcome = await h.service.analyzeMeeting(MEETING_ID);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe(LLM_ERROR_CODES.INVALID_OUTPUT);
    expect(h.runtime.generateJson).toHaveBeenCalledTimes(2); // one correction retry
    expect(h.setNotes).not.toHaveBeenCalled();
    // The transcript and meeting metadata are preserved locally.
    expect(h.store.getMeeting(MEETING_ID)).not.toBeNull();
    expect(h.store.listSegments(MEETING_ID)).toHaveLength(2);
    expect(h.store.getSummaryDetails(MEETING_ID)).toBeNull();
  });

  it("keeps clientItemId stable across repeated analyses for the same description", async () => {
    const h = harness();
    h.store.setActionItems(MEETING_ID, [
      { description: "Open the PR", status: "OPEN", clientItemId: "existing-1" },
    ]);
    await h.service.analyzeMeeting(MEETING_ID);
    const { actionItems } = h.setNotes.mock.calls[0]![1] as { actionItems: MeetingSyncActionItem[] };
    expect(actionItems[0]?.clientItemId).toBe("existing-1");
    expect(actionItems[0]?.description).toBe("Open the PR");
  });

  it("recovers when the runtime comes back after a failure (retry path)", async () => {
    const h = harness();
    h.runtime.ping.mockRejectedValueOnce(new Error("connection refused"));

    const first = await h.service.analyzeMeeting(MEETING_ID);
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe(LLM_ERROR_CODES.RUNTIME_UNREACHABLE);

    // Runtime back up: the retry succeeds and notes are saved.
    const second = await h.service.analyzeMeeting(MEETING_ID);
    expect(second.ok).toBe(true);
    expect(h.setNotes).toHaveBeenCalledTimes(1);
  });

  it("reports busy status while an analysis is in flight", async () => {
    const h = harness();
    let release: ((value: string) => void) | null = null;
    h.runtime.generateJson.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = h.service.analyzeMeeting(MEETING_ID);
    await vi.waitFor(() => {
      expect(h.statuses[h.statuses.length - 1]?.state).toBe("busy");
    });

    release?.(VALID_RESULT_JSON);
    await pending;
    expect(h.statuses[h.statuses.length - 1]?.state).toBe("ready");
  });
});