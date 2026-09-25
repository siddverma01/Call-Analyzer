import { describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_SYSTEM_PROMPT,
  AnalysisEngine,
  buildAnalysisUserPrompt,
  formatNumberedTranscript,
  MAX_TRANSCRIPT_CHARS,
  parseAnalysisText,
  truncateTranscript,
} from "../../src/main/llm/analysis";
import { LlmError } from "../../src/main/llm/runtime";
import { LLM_ERROR_CODES } from "@callnotes/shared";

const TRANSCRIPT = "1. Alice: hello\n2. Bob: ship it";

const VALID_JSON = JSON.stringify({
  summary: "  The team planned the Q1 launch.  ",
  discussionPoints: ["- Timeline is tight", "Budget was approved"],
  decisions: ["Launch scope locked"],
  risks: ["Staffing gap"],
  openQuestions: [],
  blockers: ["Awaiting legal review"],
  followUps: ["Share the deck"],
  importantDates: ["2026-03-01"],
  participants: ["Alice", "alice", "Bob"],
  actionItems: [
    { description: "  Send the deck  ", priority: "HIGH" },
    { description: "   ", assignee: "Bob", dueDate: "Not specified", sourceSegmentNumber: 2 },
  ],
});

describe("formatNumberedTranscript", () => {
  it("numbers segments 1-based and falls back to a default speaker", () => {
    expect(formatNumberedTranscript([{ speaker: "Alice", text: "hi" }, { speaker: "", text: "yo" }])).toBe(
      "1. Alice: hi\n2. Speaker: yo",
    );
  });
});

describe("truncateTranscript", () => {
  it("keeps the head and tail of an oversized transcript with a clear marker", () => {
    const head = "HEAD".repeat(20);
    const tail = "TAIL".repeat(20);
    const text = `${head}${"x".repeat(MAX_TRANSCRIPT_CHARS + 5_000)}${tail}`;
    const out = truncateTranscript(text);
    expect(out.length).toBeLessThan(text.length);
    expect(out.length).toBeGreaterThan(MAX_TRANSCRIPT_CHARS);
    expect(out.length).toBeLessThan(MAX_TRANSCRIPT_CHARS + 64);
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toContain("[TRANSCRIPT TRUNCATED");
  });

  it("passes short transcripts through unchanged", () => {
    expect(truncateTranscript("short")).toBe("short");
  });
});

describe("parseAnalysisText", () => {
  it("parses and normalizes a valid structured response", () => {
    const outcome = parseAnalysisText(VALID_JSON);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.summary).toBe("The team planned the Q1 launch.");
    expect(outcome.value.discussionPoints).toEqual(["Timeline is tight", "Budget was approved"]);
    expect(outcome.value.participants).toEqual(["Alice", "Bob"]);
    expect(outcome.value.actionItems).toEqual([
      {
        description: "Send the deck",
        assignee: "Unknown",
        dueDate: null,
        priority: "HIGH",
        status: "OPEN",
        sourceSegmentNumber: null,
      },
    ]);
  });

  it("strips markdown code fences before parsing", () => {
    const outcome = parseAnalysisText("```json\n" + VALID_JSON + "\n```");
    expect(outcome.ok).toBe(true);
  });

  it("rejects output that is not valid JSON", () => {
    const outcome = parseAnalysisText("certainly not json");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toContain("Not valid JSON");
  });

  it("rejects JSON that violates the schema", () => {
    const outcome = parseAnalysisText(JSON.stringify({ decisions: ["no summary field"] , discussionPoints: "not-an-array" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toContain("validation error");
    expect(outcome.issues).toContain("summary");
  });

  it("rejects an invalid priority enum value", () => {
    const outcome = parseAnalysisText(
      JSON.stringify({ summary: "ok", actionItems: [{ description: "x", priority: "URGENT" }] }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues).toContain("priority");
  });
});

describe("AnalysisEngine", () => {
  it("invokes the model once and returns the validated result", async () => {
    const generate = vi.fn(async () => VALID_JSON);
    const engine = new AnalysisEngine(generate, "llama3.2:3b");
    const result = await engine.analyze(TRANSCRIPT);
    expect(result.summary).toBe("The team planned the Q1 launch.");
    expect(generate).toHaveBeenCalledTimes(1);
    const input = generate.mock.calls[0]![0];
    expect(input.model).toBe("llama3.2:3b");
    expect(input.system).toBe(ANALYSIS_SYSTEM_PROMPT);
    expect(input.user).toContain("2. Bob: ship it");
  });

  it("retries once with the validation error when the first attempt is invalid", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce(VALID_JSON);
    const engine = new AnalysisEngine(generate, "m");
    const result = await engine.analyze(TRANSCRIPT);
    expect(result.summary).toBe("The team planned the Q1 launch.");
    expect(generate).toHaveBeenCalledTimes(2);
    const second = generate.mock.calls[1]![0];
    expect(second.user).toContain("failed JSON validation");
    expect(second.user).toContain("Not valid JSON");
  });

  it("gives up with INVALID_OUTPUT when both attempts fail validation", async () => {
    const generate = vi.fn(async () => "still not json");
    const engine = new AnalysisEngine(generate, "m");
    await expect(engine.analyze(TRANSCRIPT)).rejects.toMatchObject({
      code: LLM_ERROR_CODES.INVALID_OUTPUT,
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty transcript without calling the model", async () => {
    const generate = vi.fn(async () => VALID_JSON);
    const engine = new AnalysisEngine(generate, "m");
    await expect(engine.analyze("   ")).rejects.toMatchObject({ code: LLM_ERROR_CODES.EMPTY_TRANSCRIPT });
    expect(generate).not.toHaveBeenCalled();
  });

  it("wraps generator failures as GENERATION_FAILED", async () => {
    const generate = vi.fn(async () => {
      throw new Error("OOM in llama.cpp");
    });
    const engine = new AnalysisEngine(generate, "m");
    await expect(engine.analyze(TRANSCRIPT)).rejects.toMatchObject({
      code: LLM_ERROR_CODES.GENERATION_FAILED,
      message: "OOM in llama.cpp",
    });
  });

  it("propagates runtime LlmErrors without wrapping", async () => {
    const generate = vi.fn(async () => {
      throw new LlmError(LLM_ERROR_CODES.RUNTIME_UNREACHABLE, "runtime offline");
    });
    const engine = new AnalysisEngine(generate, "m");
    await expect(engine.analyze(TRANSCRIPT)).rejects.toBeInstanceOf(LlmError);
    await expect(engine.analyze(TRANSCRIPT)).rejects.toMatchObject({ code: LLM_ERROR_CODES.RUNTIME_UNREACHABLE });
  });

  it("truncates an oversized transcript before sending it to the model", async () => {
    const generate = vi.fn(async () => VALID_JSON);
    const engine = new AnalysisEngine(generate, "m");
    const oversized = `START${"z".repeat(MAX_TRANSCRIPT_CHARS + 1_000)}END`;
    const result = await engine.analyze(oversized);
    expect(result.summary).toBeTruthy();
    const user = generate.mock.calls[0]![0].user;
    expect(user).toContain("[TRANSCRIPT TRUNCATED");
    expect(user.startsWith("Analyze the following meeting transcript.")).toBe(true);
    expect(user).toContain("START");
    expect(user.endsWith("END")).toBe(true); // trimmed + truncated transcript is the prompt tail
    expect(user).toContain("END"); // tail is preserved
  });
});

describe("buildAnalysisUserPrompt", () => {
  it("embeds the transcript and appends correction context", () => {
    expect(buildAnalysisUserPrompt("t", null)).toContain("t");
    const corrected = buildAnalysisUserPrompt("t", "summary: required");
    expect(corrected).toContain("failed JSON validation");
    expect(corrected).toContain("summary: required");
  });
});