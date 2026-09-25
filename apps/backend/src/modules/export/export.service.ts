import type { ActionItemDto, ExportPayload, MeetingDetailDto } from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import { MeetingsService } from "../meetings/meetings.service.ts";
import { renderPdf } from "./pdf.ts";

/** The subset of action-item data the exporters render. */
type ExportActionItem = Pick<ActionItemDto, "description" | "status" | "priority" | "assignee" | "dueDate">;

/** Formats an ISO timestamp for a portable export filename. */
function timestampPart(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "meeting";
}

function durationText(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatDate(date: Date | null | undefined): string {
  return date ? date.toISOString().replace("T", " ").slice(0, 16) : "—";
}

/** Turns a JSON value (string, string[] or object[]) into text lines. */
function jsonToLines(label: string, value: unknown): string[] {
  const lines: string[] = [];
  if (value === null || value === undefined) return lines;
  if (Array.isArray(value)) {
    const entries = value.filter((v) => v !== null && v !== undefined);
    if (entries.length === 0) return lines;
    lines.push(label);
    for (const entry of entries) {
      if (typeof entry === "string") {
        lines.push(`  - ${entry}`);
      } else if (typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const pairs = Object.entries(record)
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `  - ${k}: ${String(v)}`);
        lines.push(...(pairs.length > 0 ? pairs : [`  - ${JSON.stringify(record)}`]));
      } else {
        lines.push(`  - ${String(entry)}`);
      }
    }
    lines.push("");
  } else if (typeof value === "string") {
    lines.push(label, value, "");
  }
  return lines;
}

export class ExportService {
  constructor(private readonly db: Database) {}

  /** Renders one of the caller's own meetings into the requested format. */
  async exportMeeting(userId: string, meetingId: string, format: "markdown" | "txt" | "json" | "pdf"): Promise<ExportPayload> {
    const meetings = new MeetingsService(this.db);
    const detail = await meetings.getOwned(userId, meetingId);
    const actionItems = await this.db.client.actionItem.findMany({
      where: { meetingId, userId },
      orderBy: { createdAt: "asc" },
    });

    const base = `${timestampPart(detail.meeting.createdAt)}-${slugify(detail.meeting.title)}`;

    switch (format) {
      case "markdown":
        return {
          format,
          filename: `${base}.md`,
          contentType: "text/markdown; charset=utf-8",
          content: renderMarkdown(detail, actionItems),
        };
      case "txt":
        return {
          format,
          filename: `${base}.txt`,
          contentType: "text/plain; charset=utf-8",
          content: renderText(detail, actionItems),
        };
      case "json":
        return {
          format,
          filename: `${base}.json`,
          contentType: "application/json; charset=utf-8",
          content: renderJson(detail, actionItems),
        };
      case "pdf": {
        const lines = renderLines(detail, actionItems);
        const pdf = renderPdf(lines);
        return {
          format,
          filename: `${base}.pdf`,
          contentType: "application/pdf",
          content: pdf.toString("base64"),
        };
      }
    }
  }
}

function renderMarkdown(detail: MeetingDetailDto, actionItems: ExportActionItem[]): string {
  const { meeting, summary } = detail;
  const out: string[] = [];
  out.push(`# ${meeting.title}`, "");
  out.push(`- **Started**: ${formatDate(meeting.startedAt)}`);
  out.push(`- **Duration**: ${durationText(meeting.durationSeconds)}`);
  out.push(`- **Status**: ${meeting.status}`);
  out.push(`- **Exported**: ${new Date().toISOString().replace("T", " ").slice(0, 16)}`);
  out.push("");

  if (summary) {
    out.push("## Summary", "", summary.summary, "");
    for (const [key, label] of [
      ["discussionPoints", "Discussion points"],
      ["decisions", "Decisions"],
      ["risks", "Risks"],
      ["openQuestions", "Open questions"],
      ["blockers", "Blockers"],
      ["followUps", "Follow-ups"],
      ["importantDates", "Important dates"],
      ["participants", "Participants"],
    ] as const) {
      out.push(...jsonToLines(`## ${label}`, summary[key]));
    }
  }

  if (actionItems.length > 0) {
    out.push("## Action items", "");
    for (const item of actionItems) {
      const mark = item.status === "COMPLETED" ? "[x]" : "[ ]";
      const meta = [item.assignee ? `@${item.assignee}` : "", item.dueDate ? `due ${formatDate(item.dueDate)}` : `priority ${item.priority}`]
        .filter(Boolean)
        .join(" · ");
      out.push(`- ${mark} ${item.description}${meta ? ` (${meta})` : ""}`);
    }
    out.push("");
  }

  if (detail.segments.length > 0) {
    out.push("## Transcript", "");
    for (const segment of detail.segments) {
      out.push(`**${segment.speaker}**: ${segment.text}`);
    }
    out.push("");
  }

  return out.join("\n");
}

function renderText(detail: MeetingDetailDto, actionItems: ExportActionItem[]): string {
  const { meeting, summary } = detail;
  const out: string[] = [];
  out.push(meeting.title.toUpperCase(), "=".repeat(Math.min(60, meeting.title.length)));
  out.push(`Started:  ${formatDate(meeting.startedAt)}`);
  out.push(`Duration: ${durationText(meeting.durationSeconds)}`);
  out.push(`Status:   ${meeting.status}`);
  out.push("");

  if (summary) {
    out.push("SUMMARY", "-------", summary.summary, "");
    for (const [key] of [
      ["discussionPoints", "Discussion points"],
      ["decisions", "Decisions"],
      ["risks", "Risks"],
      ["openQuestions", "Open questions"],
      ["blockers", "Blockers"],
      ["followUps", "Follow-ups"],
      ["importantDates", "Important dates"],
      ["participants", "Participants"],
    ] as const) {
      out.push(...jsonToLines("", summary[key]).map((line) => line.replace(/^ {2}- /, "- ")));
    }
  }

  if (actionItems.length > 0) {
    out.push("ACTION ITEMS", "-----------");
    for (const item of actionItems) {
      const meta = [item.assignee ? `@${item.assignee}` : "", item.dueDate ? `due ${formatDate(item.dueDate)}` : `priority ${item.priority}`, item.status]
        .filter(Boolean)
        .join(" | ");
      out.push(`- [${item.status === "COMPLETED" ? "x" : " "}] ${item.description}${meta ? ` (${meta})` : ""}`);
    }
    out.push("");
  }

  if (detail.segments.length > 0) {
    out.push("TRANSCRIPT", "----------");
    for (const segment of detail.segments) {
      out.push(`${segment.speaker}: ${segment.text}`);
    }
  }

  return out.join("\n");
}

function renderJson(detail: MeetingDetailDto, actionItems: ExportActionItem[]): string {
  return JSON.stringify(
    {
      meta: {
        exportedAt: new Date().toISOString(),
        generator: "CallNotes AI",
      },
      meeting: detail.meeting,
      transcript: detail.segments,
      summary: detail.summary,
      actionItems,
    },
    null,
    2,
  );
}

function renderLines(detail: MeetingDetailDto, actionItems: ExportActionItem[]): string[] {
  return renderText(detail, actionItems).split("\n");
}