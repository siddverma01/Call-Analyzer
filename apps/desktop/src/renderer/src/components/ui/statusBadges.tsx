import type { JSX } from "react";
import type { MeetingStatus, SyncStatus } from "@callnotes/shared";
import { Badge } from "./Card";

const MEETING_STATUS: Record<MeetingStatus, { label: string; tone: "slate" | "indigo" | "emerald" | "amber" | "rose" | "sky" }> = {
  DRAFT: { label: "Draft", tone: "slate" },
  STARTING: { label: "Starting", tone: "sky" },
  RECORDING: { label: "Recording", tone: "rose" },
  PROCESSING: { label: "Processing", tone: "amber" },
  COMPLETED: { label: "Completed", tone: "emerald" },
  SYNC_PENDING: { label: "Sync pending", tone: "amber" },
  SYNCED: { label: "Synced", tone: "sky" },
  FAILED: { label: "Failed", tone: "rose" },
};

export function MeetingStatusBadge({ status }: { status: MeetingStatus }): JSX.Element {
  const meta = MEETING_STATUS[status] ?? { label: status, tone: "slate" as const };
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

const TASK_STATUS = {
  OPEN: { label: "Open", tone: "sky" as const },
  IN_PROGRESS: { label: "In progress", tone: "amber" as const },
  COMPLETED: { label: "Completed", tone: "emerald" as const },
};

export function TaskStatusBadge({ status }: { status: "OPEN" | "IN_PROGRESS" | "COMPLETED" }): JSX.Element {
  const meta = TASK_STATUS[status];
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

const SYNC_STATUS: Record<
  SyncStatus,
  { label: string; tone: "slate" | "indigo" | "emerald" | "amber" | "rose" | "sky" }
> = {
  OFFLINE: { label: "Offline", tone: "slate" },
  IDLE: { label: "Sync idle", tone: "slate" },
  PENDING_SYNC: { label: "Pending sync", tone: "amber" },
  SYNCING: { label: "Syncing…", tone: "sky" },
  SYNCED: { label: "Synced", tone: "emerald" },
  SYNC_FAILED: { label: "Sync failed", tone: "rose" },
};

export function SyncStatusBadge({ status, error }: { status: SyncStatus; error?: string | null }): JSX.Element {
  const meta = SYNC_STATUS[status] ?? { label: status, tone: "slate" as const };
  return (
    <span title={error ?? undefined}>
      <Badge tone={meta.tone} dot>
        {meta.label}
      </Badge>
    </span>
  );
}

const PRIORITY = {
  LOW: { label: "Low", tone: "slate" as const },
  MEDIUM: { label: "Medium", tone: "amber" as const },
  HIGH: { label: "High", tone: "rose" as const },
};

export function PriorityBadge({ priority }: { priority: "LOW" | "MEDIUM" | "HIGH" }): JSX.Element {
  const meta = PRIORITY[priority];
  return (
    <Badge tone={meta.tone}>
      {meta.label}
    </Badge>
  );
}