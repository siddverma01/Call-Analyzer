import { useEffect } from "react";
import { useAppStore } from "../stores/appStore";
import type { JSX } from "react";

export function SystemHealthCard(): JSX.Element {
  const status = useAppStore((s) => s.backendStatus);
  const apiUrl = useAppStore((s) => s.apiUrl);

  const label =
    status === "online" ? "Backend online" : status === "offline" ? "Backend offline" : "Checking backend…";

  const dotClass =
    status === "online"
      ? "bg-emerald-400"
      : status === "offline"
        ? "bg-rose-400"
        : "bg-amber-400 animate-pulse";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
      <div className="min-w-0">
        <p className="truncate text-slate-300">{label}</p>
        {apiUrl && <p className="truncate text-slate-500">{apiUrl}</p>}
      </div>
    </div>
  );
}

/** Boots IPC calls once per app session - safe to mount multiple times. */
export function useSystemHealth(): void {
  const setBackendStatus = useAppStore((s) => s.setBackendStatus);
  const setApiUrl = useAppStore((s) => s.setApiUrl);

  useEffect(() => {
    let disposed = false;

    async function refresh(): Promise<void> {
      try {
        const info = await window.callnotes.appInfo();
        if (disposed) return;
        setApiUrl(info.backendUrl);

        const result = await window.callnotes.backendHealth();
        if (disposed) return;
        setBackendStatus(result.ok && result.health?.status === "ok" ? "online" : "offline");
      } catch {
        if (!disposed) setBackendStatus("offline");
      }
    }

    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [setBackendStatus, setApiUrl]);
}