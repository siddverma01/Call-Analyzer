import { useEffect } from "react";
import type { JSX } from "react";
import { useDataStore } from "../stores/dataStore";
import { useAppStore } from "../stores/appStore";
import { useAuthStore } from "../stores/authStore";
import { EmptyState } from "../components/ui/Card";
import { Button, Spinner } from "../components/ui/Button";
import { MeetingStatusBadge } from "../components/ui/statusBadges";
import {
  IconAudioLines,
  IconCheckSquare,
  IconClock,
  IconGrid,
  IconPlus,
} from "../components/ui/Icons";
import { firstName, formatDuration, formatRelative, greeting, truncate } from "../lib/format";
import type { SerializedMeetingListItem } from "@callnotes/shared";

function StatCard({ icon, label, value }: { icon: JSX.Element; label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center gap-2 text-slate-400">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}

export function DashboardPage(): JSX.Element {
  const dashboard = useDataStore((s) => s.dashboard);
  const loading = useDataStore((s) => s.dashboardLoading);
  const loadDashboard = useDataStore((s) => s.loadDashboard);
  const user = useAuthStore((s) => s.user);
  const backendStatus = useAppStore((s) => s.backendStatus);
  const setPage = useAppStore((s) => s.setPage);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  if (loading && !dashboard) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const name = user?.name ? firstName(user.name) : "there";
  const recent = dashboard?.recentMeetings ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">{greeting()}, {name}</h2>
          <p className="text-sm text-slate-400">Here’s what’s happening across your workspace.</p>
        </div>
        <Button onClick={() => setPage("new-meeting")}>
          <IconPlus className="text-sm" />
          Start a meeting
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard icon={<IconGrid />} label="Total meetings" value={String(dashboard?.totalMeetings ?? 0)} />
        <StatCard
          icon={<IconClock />}
          label="Time transcribed"
          value={formatDuration(dashboard?.totalTimeSeconds ?? 0)}
        />
        <StatCard
          icon={<IconCheckSquare />}
          label="Open action items"
          value={String(dashboard?.openActionItems ?? 0)}
        />
      </div>

      {backendStatus === "offline" && (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
          Can’t reach the backend right now. Data shown may be stale — start the backend and it will reconnect
          automatically.
        </div>
      )}

      {recent.length === 0 ? (
        <EmptyState
          icon={<IconAudioLines className="text-3xl" />}
          title="No meetings yet"
          message="Start your first meeting and the transcript, summary, and action items will appear here."
          action={
            <Button variant="secondary" onClick={() => setPage("new-meeting")}>
              Create a meeting
            </Button>
          }
        />
      ) : (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Recent meetings</h3>
            <button
              type="button"
              onClick={() => setPage("meetings")}
              className="text-sm font-medium text-indigo-300 hover:text-indigo-200"
            >
              View all
            </button>
          </div>
          <div className="space-y-2">
            {recent.map((meeting) => (
              <RecentMeetingRow key={meeting.id} meeting={meeting} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function RecentMeetingRow({ meeting }: { meeting: SerializedMeetingListItem }): JSX.Element {
  const setPage = useAppStore((s) => s.setPage);
  return (
    <button
      type="button"
      onClick={() => setPage("meetings")}
      className="flex w-full items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/60 px-5 py-4 text-left transition-colors hover:bg-slate-800/60"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-slate-400">
        <IconAudioLines />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-100">{meeting.title}</p>
        <p className="mt-0.5 truncate text-xs text-slate-500">
          {formatRelative(meeting.startedAt ?? meeting.createdAt)}
          {meeting.templateName ? ` · ${meeting.templateName}` : ""}
        </p>
      </div>
      <div className="hidden shrink-0 items-center gap-2 sm:flex">
        {meeting.summaryPreview && (
          <span className="hidden max-w-[16rem] truncate text-xs text-slate-500 lg:inline">
            {truncate(meeting.summaryPreview, 90)}
          </span>
        )}
        <MeetingStatusBadge status={meeting.status} />
        <span className="w-14 text-right text-xs text-slate-400">{formatDuration(meeting.durationSeconds)}</span>
      </div>
    </button>
  );
}