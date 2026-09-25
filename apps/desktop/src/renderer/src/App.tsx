import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { useSystemHealth } from "./components/SystemHealthCard";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Toasts } from "./components/Toasts";
import { Spinner } from "./components/ui/Button";
import { useSyncStore } from "./stores/syncStore";
import { useToastStore } from "./stores/toastStore";
import { AuthPage } from "./pages/AuthPage";
import { DashboardPage } from "./pages/DashboardPage";
import { NewMeetingPage } from "./pages/NewMeetingPage";
import { MeetingsPage } from "./pages/MeetingsPage";
import { TasksPage } from "./pages/TasksPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AdminDashboardPage } from "./pages/admin/AdminDashboardPage";
import { UsersPage } from "./pages/admin/UsersPage";
import { AllMeetingsPage } from "./pages/admin/AllMeetingsPage";
import { AuditLogsPage } from "./pages/admin/AuditLogsPage";
import { useAppStore, ADMIN_PAGES } from "./stores/appStore";
import { useAuthStore } from "./stores/authStore";
import { useDataStore } from "./stores/dataStore";
import { useOverlayStore } from "./stores/overlayStore";
import { applyAccent, getAccent } from "./lib/theme";
import { IconMic } from "./components/ui/Icons";

function BootScreen(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-slate-400">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg shadow-indigo-950/50 [background:linear-gradient(135deg,var(--accent-from),var(--accent-to))]">
        <IconMic className="text-2xl" />
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Spinner className="h-4 w-4" />
        Starting CallNotes AI…
      </div>
    </div>
  );
}

export function App(): JSX.Element {
  useSystemHealth();
  const phase = useAuthStore((s) => s.phase);
  const user = useAuthStore((s) => s.user);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const resetData = useDataStore((s) => s.reset);

  useEffect(() => {
    applyAccent(getAccent());
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    void useSyncStore.getState().subscribe();
  }, []);

  useEffect(() => {
    return window.callnotes.onUpdateStatus((status) => {
      if (status.phase === "error") {
        useToastStore.getState().push("error", `Update failed: ${status.message}`);
      } else if (status.phase === "ready") {
        useToastStore.getState().push("success", "Update downloaded — it will install when the app quits.");
      } else if (status.phase === "downloading") {
        const version = status.version ? ` v${status.version} ` : " ";
        useToastStore.getState().push("info", `Downloading update${version}(${Math.round(status.percent ?? 0)}%)`);
      }
    });
  }, []);

  const wasAuthenticated = useRef(false);
  useEffect(() => {
    if (wasAuthenticated.current && phase !== "authenticated") {
      resetData();
      setPage("dashboard");
    }
    wasAuthenticated.current = phase === "authenticated";
  }, [phase, resetData, setPage]);

  useEffect(() => {
    if (user && ADMIN_PAGES.has(page) && user.role !== "ADMIN") {
      setPage("dashboard");
    }
  }, [page, user, setPage]);

  // Actions triggered from the floating overlay (started a meeting, a nav
  // request). The app is brought forward by main before these arrive.
  useEffect(() => {
    return window.callnotes.onOverlayEvent((event) => {
      const toast = useToastStore.getState();
      switch (event.type) {
        case "navigate":
          setPage(event.page === "dashboard" ? "dashboard" : event.page);
          break;
        case "meeting-started":
          useOverlayStore.getState().setPendingMeeting(event.meetingId);
          setPage("new-meeting");
          toast.push("success", "AI meeting notes started.");
          break;
        case "meeting-failed":
          setPage("new-meeting");
          toast.push("error", `Couldn't start AI notes: ${event.error.message}`);
          break;
      }
    });
  }, [setPage]);

  if (phase === "booting") {
    return <BootScreen />;
  }

  if (phase !== "authenticated" || !user) {
    return (
      <>
        <AuthPage />
        <Toasts />
      </>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {page === "dashboard" && <DashboardPage />}
          {page === "new-meeting" && <NewMeetingPage />}
          {page === "meetings" && <MeetingsPage />}
          {page === "tasks" && <TasksPage />}
          {page === "templates" && <TemplatesPage />}
          {page === "settings" && <SettingsPage />}
          {page === "admin" && user.role === "ADMIN" && <AdminDashboardPage />}
          {page === "admin-users" && user.role === "ADMIN" && <UsersPage />}
          {page === "admin-meetings" && user.role === "ADMIN" && <AllMeetingsPage />}
          {page === "admin-audit" && user.role === "ADMIN" && <AuditLogsPage />}
        </div>
      </main>
      <Toasts />
    </div>
  );
}