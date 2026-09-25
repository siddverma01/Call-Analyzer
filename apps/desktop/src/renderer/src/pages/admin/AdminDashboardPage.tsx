import { useEffect } from "react";
import type { JSX } from "react";
import { useDataStore } from "../../stores/dataStore";
import { useAppStore } from "../../stores/appStore";
import { Card } from "../../components/ui/Card";
import { Spinner } from "../../components/ui/Button";
import {
  IconCheckSquare,
  IconClock,
  IconGrid,
  IconServer,
  IconUsers,
} from "../../components/ui/Icons";

type AdminPage = "admin-users" | "admin-meetings" | "admin-audit";

export function AdminDashboardPage(): JSX.Element {
  const stats = useDataStore((s) => s.adminStats);
  const statsLoading = useDataStore((s) => s.adminStatsLoading);
  const meetings = useDataStore((s) => s.adminMeetings);
  const audit = useDataStore((s) => s.adminAudit);
  const loadStats = useDataStore((s) => s.loadAdminStats);
  const loadUsers = useDataStore((s) => s.loadAdminUsers);
  const loadMeetings = useDataStore((s) => s.loadAdminMeetings);
  const loadAudit = useDataStore((s) => s.loadAdminAudit);
  const setPage = useAppStore((s) => s.setPage);

  useEffect(() => {
    void Promise.all([loadStats(), loadUsers(), loadMeetings(), loadAudit()]);
  }, [loadStats, loadUsers, loadMeetings, loadAudit]);

  if (statsLoading && !stats) {
    return (
      <div className="flex justify-center py-20 text-slate-500">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const statCards: { label: string; value: string; page?: AdminPage; icon: JSX.Element }[] = [
    { label: "Total users", value: String(stats?.totalUsers ?? 0), page: "admin-users", icon: <IconUsers /> },
    { label: "Active users", value: String(stats?.activeUsers ?? 0), page: "admin-users", icon: <IconUsers /> },
    { label: "Total meetings", value: String(stats?.totalMeetings ?? 0), page: "admin-meetings", icon: <IconServer /> },
    { label: "Minutes transcribed", value: String(stats?.totalTranscribedMinutes ?? 0), page: "admin-meetings", icon: <IconClock /> },
    { label: "Action items", value: String(stats?.totalActionItems ?? 0), icon: <IconCheckSquare /> },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {statCards.map((stat) =>
          stat.page ? (
            <button
              key={stat.label}
              type="button"
              onClick={() => setPage(stat.page as AdminPage)}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-left transition-colors hover:border-slate-700"
            >
              <div className="flex items-center gap-2 text-slate-400">
                {stat.icon}
                <span className="text-xs font-medium uppercase tracking-wide">{stat.label}</span>
              </div>
              <div className="mt-2 text-2xl font-semibold text-white">{stat.value}</div>
            </button>
          ) : (
            <div key={stat.label} className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
              <div className="flex items-center gap-2 text-slate-400">
                {stat.icon}
                <span className="text-xs font-medium uppercase tracking-wide">{stat.label}</span>
              </div>
              <div className="mt-2 text-2xl font-semibold text-white">{stat.value}</div>
            </div>
          ),
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-100">Most recent audit events</h3>
          <ul className="mt-3 space-y-2">
            {(audit?.items ?? []).slice(0, 5).map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-mono text-xs text-slate-300">{entry.action}</span>
                <span className="shrink-0 text-xs text-slate-500">{entry.actor?.email ?? "system"}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-100">Latest meetings</h3>
          <ul className="mt-3 space-y-2">
            {(meetings?.items ?? []).slice(0, 5).map((meeting) => (
              <li key={meeting.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-slate-200">{meeting.title}</span>
                <span className="shrink-0 text-xs text-slate-500">{meeting.ownerEmail}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-500">
        <IconGrid className="text-sm" />
        System statistics come from the admin stats endpoint; account activity is read from live backend data.
      </div>
    </div>
  );
}