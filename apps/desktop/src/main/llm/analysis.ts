import {
  analysisResultSchema,
  LLM_ERROR_CODES,
  type AnalysisActionItem,
  type AnalysisResult,
} from "@callnotes/shared";
import type { ZodError } from "zod";
import { LlmError } from "./runtime.js";

/** Hard cap on the transcript text sent to the model (roughly 30k-50k tokens). */
export const MAX_TRANSCRIPT_CHARS = 200_000;

/** System prompt: the model returns ONLY a raw JSON object matching the schema. */
export const ANALYSIS_SYSTEM_PROMPT = [
  "You are CallNotes' local meeting analyst. You read a meeting transcript and return a single JSON object summarizing it.",
  "",
  "Rules:",
  '- Base everything strictly on the transcript text. Never invent facts, attendees, deadlines, or commitments.',
  '- If an assignee was not mentioned, use "Unknown".',
  '- If a due date was not mentioned, use "Not specified".',
  '- "participants": list only people whose names are stated confidently in the transcript.',
  '- Every action item must include the 1-based source segment number it came from ("sourceSegmentNumber").',
  '- If there are no action items or no items for a category, use an empty array.',
  '- Respond with the raw JSON object only - no markdown fences, no commentary, no trailing text.',
  "",
  'JSON shape:',
  '{',
  '  "summary": "2-4 sentence recap",',
  '  "discussionPoints": ["string"],',
  '  "decisions": ["string"],',
  '  "risks": ["string"],',
  '  "openQuestions": ["string"],',
  '  "blockers": ["string"],',
  '  "followUps": ["string"],',
  '  "importantDates": ["string"],',
  '  "participants": ["string"],',
  '  "actionItems": [',
  '    {',
  '      "description": "string",',
  '      "assignee": "string",',
  '      "dueDate": "string or Not specified",',
  '      "priority": "LOW | MEDIUM | HIGH",',
  '      "status": "OPEN | IN_PROGRESS | COMPLETED",',
  '      "sourceSegmentNumber": 1',
  '    }',
  '  ]',
  '}',
].join("\n");

export interface NumberedSegment {
  speaker: string;
  text: string;
}

/** Build the numbered "[n] Speaker: text" transcript shown to the model. */
export function formatNumberedTranscript(segments: NumberedSegment[]): string {
  return segments
    .map((segment, index) => `${index + 1}. ${segment.speaker || "Speaker"}: ${segment.text}`)
    .join("\n");
}

/** Keep the start and end of a very long transcript (decisions often land late). */
export function truncateTranscript(text: string, maxChars = MAX_TRANSCRIPT_CHARS): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  return `${head}\n\n[TRANSCRIPT TRUNCATED - middle omitted]\n\n${tail}`;
}

export function buildAnalysisUserPrompt(transcript: string, correction: string | null = null): string {
  const parts = [
    "Analyze the following meeting transcript. Segments are numbered so action items can reference their source segment.",
    "",
    transcript,
  ];
  if (correction) {
    parts.push("", "Your previous response failed JSON validation for these reasons:", correction);
    parts.push("", "Return ONLY the corrected raw JSON object now.");
  }
  return parts.join("\n");
}

export type ParseOutcome = { ok: true; value: AnalysisResult } | { ok: false; issues: string };

/** Parse+validate raw model output: strips fences, parses, zod-checks. */
export function parseAnalysisText(raw: string): ParseOutcome {
  const cleaned = stripCodeFences(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned) as unknown;
  } catch (error) {
    return { ok: false, issues: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = analysisResultSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, issues: formatZodIssues(result.error) };
  }
  return { ok: true, value: normalize(result.data) };
}

/**
 * Runs a local LLM over a transcript and returns validated structured JSON.
 * Invalid output triggers one automatic correction retry; failing that, the
 * failure is reported safely (INVALID_OUTPUT) so the transcript is preserved.
 */
export class AnalysisEngine {
  constructor(
    private readonly generate: (input: { model: string; system: string; user: string }) => Promise<string>,
    private readonly model: string,
  ) {}

  async analyze(transcript: string): Promise<AnalysisResult> {
    const text = truncateTranscript(transcript.trim());
    if (!text.trim()) {
      throw new LlmError(LLM_ERROR_CODES.EMPTY_TRANSCRIPT, "There is no transcript to analyze.");
    }

    const first = parseAnalysisText(await this.invoke(text, null));
    if (first.ok) return first.value;

    const corrected = parseAnalysisText(await this.invoke(text, first.issues));
    if (corrected.ok) return corrected.value;

    throw new LlmError(
      LLM_ERROR_CODES.INVALID_OUTPUT,
      "The local model returned output that is not valid structured JSON, even after a correction attempt.",
    );
  }

  private async invoke(transcript: string, correction: string | null): Promise<string> {
    try {
      return await this.generate({
        model: this.model,
        system: ANALYSIS_SYSTEM_PROMPT,
        user: buildAnalysisUserPrompt(transcript, correction),
      });
    } catch (error) {
      if (error instanceof LlmError) throw error;
      throw new LlmError(
        LLM_ERROR_CODES.GENERATION_FAILED,
        error instanceof Error ? error.message : "The local model could not generate a response.",
      );
    }
  }
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\s*/, "");
    const endIndex = withoutOpen.lastIndexOf("```");
    return endIndex >= 0 ? withoutOpen.slice(0, endIndex) : withoutOpen;
  }
  return raw;
}

function formatZodIssues(error: ZodError): string {
  const details = error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
  return `${error.issues.length} validation error(s) - ${details}`;
}

/** Clean up model output into the stable shape we persist. */
function normalize(result: AnalysisResult): AnalysisResult {
  return {
    ...result,
    summary: result.summary.trim(),
    discussionPoints: cleanList(result.discussionPoints),
    decisions: cleanList(result.decisions),
    risks: cleanList(result.risks),
    openQuestions: cleanList(result.openQuestions),
    blockers: cleanList(result.blockers),
    followUps: cleanList(result.followUps),
    importantDates: cleanList(result.importantDates),
    participants: dedupeCleanList(result.participants),
    actionItems: normalizeActionItems(result.actionItems),
  };
}

function cleanList(items: string[]): string[] {
  return items
    .map((item) => item.trim().replace(/^[-•]\s+/, ""))
    .filter((item) => item.length > 0);
}

function dedupeCleanList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of cleanList(items)) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function normalizeActionItems(items: AnalysisActionItem[]): AnalysisActionItem[] {
  return items
    .map((item) => ({
      ...item,
      description: item.description.trim(),
      assignee: cleanAssignee(item.assignee),
      dueDate: cleanDueDate(item.dueDate),
    }))
    .filter((item) => item.description.length > 0);
}

function cleanAssignee(assignee: string): string {
  const value = assignee.trim();
  if (!value) return "Unknown";
  if (/^(unknown|not specified|n\/a)$/i.test(value)) return "Unknown";
  return value;
}

function cleanDueDate(dueDate: string | null): string | null {
  if (dueDate == null) return null;
  const value = dueDate.trim();
  if (!value || /^(not specified|unknown|n\/a|none)$/i.test(value)) return null;
  return value;
}