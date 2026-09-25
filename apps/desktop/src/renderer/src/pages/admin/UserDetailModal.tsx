import type { JSX } from "react";
import { useDataStore } from "../../stores/dataStore";
import { Badge, Card } from "../../components/ui/Card";
import { Modal } from "../../components/ui/Modal";
import { Spinner } from "../../components/ui/Button";
import { formatDate, formatDateTime, formatDuration } from "../../lib/format";
import { IconCalendar, IconClock, IconCheckSquare, IconGrid, IconServer, IconUsers } from "../../components/ui/Icons";

const ROLE_TONE = { USER: "slate", ADMIN: "indigo" } as const;
const STATUS_TONE = { ACTIVE: "emerald", DISABLED: "rose" } as const;
const TASK_STATUS_TONE = { OPEN: "slate", IN_PROGRESS: "amber", COMPLETED: "emerald" } as const;
const PRIORITY_TONE = { LOW: "slate", MEDIUM: "amber", HIGH: "rose" } as const;

export function UserDetailModal({
  userId,
  onClose,
}: {
  userId: string | null;
  onClose: () => void;
}): JSX.Element | null {
  const detail = useDataStore((s) => s.adminDetail);
  const loading = useDataStore((s) => s.adminDetailLoading);

  if (!userId) return null;

  const open = Boolean(detail && detail.user.id === userId);

  return (
    <Modal open={open} title="User details" onClose={onClose} width="max-w-3xl">
      {loading && !open ? (
        <div className="flex justify-center py-16 text-slate-500">
          <Spinner className="h-6 w-6" />
        </div>
      ) : detail && detail.user.id === userId ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <IconUsers className="text-2xl text-slate-400" />
                <h3 className="text-lg font-semibold text-white">{detail.user.name}</h3>
              </div>
              <p className="mt-1 text-sm text-slate-400">{detail.user.email}</p>
              <p className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <IconCalendar className="text-sm" /> Joined {formatDate(detail.user.createdAt)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <IconGrid className="text-sm" /> {detail.user.id}
                </span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={ROLE_TONE[detail.user.role]}>{detail.user.role.toLowerCase()}</Badge>
              <Badge tone={STATUS_TONE[detail.user.status]} dot>
                {detail.user.status.toLowerCase()}
              </Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Meetings", value: String(detail.stats.meetingCount), icon: <IconServer className="text-xl text-slate-500" /> },
              { label: "Tasks", value: String(detail.stats.actionItemCount), icon: <IconCheckSquare className="text-xl text-slate-500" /> },
              { label: "Time transcribed", value: formatDuration(detail.stats.totalDurationSeconds), icon: <IconClock className="text-xl text-slate-500" /> },
              { label: "Last activity", value: detail.stats.lastActivityAt ? formatDate(detail.stats.lastActivityAt) : "—", icon: <IconCalendar className="text-xl text-slate-500" /> },
            ].map((stat) => (
              <Card key={stat.label} className="p-4">
                {stat.icon}
                <p className="mt-2 truncate text-lg font-semibold text-white" title={stat.value}>
                  {stat.value}
                </p>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{stat.label}</p>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <h4 className="text-sm font-semibold text-slate-100">Meetings ({detail.meetings.length})</h4>
              {detail.meetings.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">No meetings recorded.</p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {detail.meetings.map((meeting) => (
                    <li key={meeting.id} className="rounded-lg border border-slate-800 px-3 py-2">
                      <p className="truncate text-sm font-medium text-slate-100">{meeting.title}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                        <span>{formatDateTime(meeting.startedAt)}</span>
                        <span>·</span>
                        <span>{formatDuration(meeting.durationSeconds)}</span>
                        <span>·</span>
                        <Badge tone="slate">{meeting.status.toLowerCase()}</Badge>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-4">
              <h4 className="text-sm font-semibold text-slate-100">Tasks ({detail.actionItems.length})</h4>
              {detail.actionItems.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">No action items.</p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {detail.actionItems.map((item) => (
                    <li key={item.id} className="rounded-lg border border-slate-800 px-3 py-2">
                      <p className="text-sm text-slate-200">{item.description}</p>
                      <p className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                        <Badge tone={TASK_STATUS_TONE[item.status]}>{item.status.replace("_", " ").toLowerCase()}</Badge>
                        <Badge tone={PRIORITY_TONE[item.priority]}>{item.priority.toLowerCase()}</Badge>
                        {item.meetingTitle && <span className="truncate">{item.meetingTitle}</span>}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      ) : (
        <p className="py-16 text-center text-sm text-slate-500">Could not load user details.</p>
      )}
    </Modal>
  );
}