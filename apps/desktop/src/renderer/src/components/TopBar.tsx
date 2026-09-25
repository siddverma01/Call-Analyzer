import type { JSX } from "react";
import { useAppStore, type PageId } from "../stores/appStore";
import { useSyncStore } from "../stores/syncStore";
import { Button } from "./ui/Button";
import { IconPlus, IconRefresh } from "./ui/Icons";
import { SyncStatusBadge } from "./ui/statusBadges";

const PAGE_META: Record<PageId, { title: string; subtitle: string }> = {
  dashboard: { title: "Dashboard", subtitle: "Your meeting overview" },
  "new-meeting": { title: "New meeting", subtitle: "Start recording and transcribing" },
  meetings: { title: "Meetings", subtitle: "Meeting history and notes" },
  tasks: { title: "Tasks", subtitle: "Action items pulled from your meetings" },
  templates: { title: "Templates", subtitle: "Structured notes templates" },
  settings: { title: "Settings", subtitle: "Application preferences" },
  admin: { title: "Admin dashboard", subtitle: "System overview and health" },
  "admin-users": { title: "Users", subtitle: "Manage accounts and roles" },
  "admin-meetings": { title: "All meetings", subtitle: "Every meeting in the system" },
  "admin-audit": { title: "Audit logs", subtitle: "Security and account activity" },
};

export function TopBar(): JSX.Element {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const meta = PAGE_META[page];
  const syncState = useSyncStore((s) => s.state);
  const syncNow = useSyncStore((s) => s.syncNow);

  return (
    <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900/40 px-6 py-4">
      <div>
        <h1 className="text-lg font-semibold text-white">{meta.title}</h1>
        <p className="text-sm text-slate-400">{meta.subtitle}</p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void syncNow()}
          title="Sync now"
          aria-label="Sync now"
          className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <IconRefresh className="text-sm" />
        </button>
        <SyncStatusBadge status={syncState?.status ?? "IDLE"} error={syncState?.lastError} />
        {page !== "new-meeting" && (
          <Button size="sm" onClick={() => setPage("new-meeting")}>
            <IconPlus className="text-sm" />
            New meeting
          </Button>
        )}
      </div>
    </header>
  );
}