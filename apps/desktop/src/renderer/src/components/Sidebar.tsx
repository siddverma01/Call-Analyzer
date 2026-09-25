import type { JSX } from "react";
import { useAppStore, ADMIN_PAGES, type PageId } from "../stores/appStore";
import { useAuthStore } from "../stores/authStore";
import { SystemHealthCard } from "./SystemHealthCard";
import { initials } from "../lib/format";
import {
  IconAudioLines,
  IconCheckSquare,
  IconGrid,
  IconLayoutTemplate,
  IconLogOut,
  IconMic,
  IconScrollText,
  IconServer,
  IconSettings,
  IconShield,
  IconUsers,
  IconPlus,
} from "./ui/Icons";

interface NavEntry {
  id: PageId;
  label: string;
  icon: (props: { className?: string }) => JSX.Element;
}

const MAIN_NAV: NavEntry[] = [
  { id: "dashboard", label: "Dashboard", icon: IconGrid },
  { id: "new-meeting", label: "New meeting", icon: IconPlus },
  { id: "meetings", label: "Meetings", icon: IconAudioLines },
  { id: "tasks", label: "Tasks", icon: IconCheckSquare },
  { id: "templates", label: "Templates", icon: IconLayoutTemplate },
  { id: "settings", label: "Settings", icon: IconSettings },
];

const ADMIN_NAV: NavEntry[] = [
  { id: "admin", label: "Admin dashboard", icon: IconShield },
  { id: "admin-users", label: "Users", icon: IconUsers },
  { id: "admin-meetings", label: "All meetings", icon: IconServer },
  { id: "admin-audit", label: "Audit logs", icon: IconScrollText },
];

function NavButton({ entry, active, onClick }: { entry: NavEntry; active: boolean; onClick: () => void }): JSX.Element {
  const Icon = entry.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
        active ? "bg-indigo-500/15 text-indigo-300" : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-100"
      }`}
    >
      <Icon className="shrink-0 text-base text-current opacity-90" />
      {entry.label}
    </button>
  );
}

export function Sidebar(): JSX.Element {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const isAdmin = user?.role === "ADMIN";

  const navigate = (target: PageId): void => {
    if (ADMIN_PAGES.has(target) && !isAdmin) return;
    setPage(target);
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900/60">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold text-white shadow-lg shadow-indigo-950/40 [background:linear-gradient(135deg,var(--accent-from),var(--accent-to))]">
          <IconMic className="text-lg" />
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight text-white">CallNotes AI</div>
          <div className="text-xs text-slate-500">Local meeting notes</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2" aria-label="Main navigation">
        <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Workspace</p>
        {MAIN_NAV.map((entry) => (
          <div key={entry.id} className="mb-0.5">
            <NavButton entry={entry} active={page === entry.id} onClick={() => navigate(entry.id)} />
          </div>
        ))}

        {isAdmin && (
          <>
            <p className="px-3 pb-1.5 pt-5 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
              Administration
            </p>
            {ADMIN_NAV.map((entry) => (
              <div key={entry.id} className="mb-0.5">
                <NavButton entry={entry} active={page === entry.id} onClick={() => navigate(entry.id)} />
              </div>
            ))}
          </>
        )}
      </nav>

      <div className="border-t border-slate-800 px-5 py-4">
        <SystemHealthCard />
      </div>

      <div className="border-t border-slate-800 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-white">
            {user ? initials(user.name) : "?"}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-100">{user?.name ?? "Signed out"}</p>
            <p className="truncate text-xs text-slate-500">{user?.email ?? ""}</p>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            title="Sign out"
            aria-label="Sign out"
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <IconLogOut />
          </button>
        </div>
      </div>
    </aside>
  );
}