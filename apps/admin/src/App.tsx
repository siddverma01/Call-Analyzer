import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { AdminStats, MeResponse } from "@callnotes/shared";

type SectionId = "dashboard" | "users" | "meetings" | "audit";

const NAV: { id: SectionId; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "users", label: "Users" },
  { id: "meetings", label: "Meetings" },
  { id: "audit", label: "Audit Logs" },
];

type GateState =
  | { state: "loading" }
  | { state: "anonymous" }
  | { state: "authenticated"; user: MeResponse };

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: { message: string } }).error?.message ?? "request failed")
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

const STAT_CARDS: { label: string; key: keyof AdminStats; hint: string }[] = [
  { label: "Total users", key: "totalUsers", hint: "Every registered account" },
  { label: "Active users", key: "activeUsers", hint: "Currently enabled accounts" },
  { label: "Total meetings", key: "totalMeetings", hint: "All meetings in the system" },
  { label: "Minutes transcribed", key: "totalTranscribedMinutes", hint: "Across all meetings" },
  { label: "Action items", key: "totalActionItems", hint: "Tasks across all meetings" },
];

export function App(): JSX.Element {
  const [gate, setGate] = useState<GateState>({ state: "loading" });
  const [section, setSection] = useState<SectionId>("dashboard");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const loadSession = useCallback(async (): Promise<void> => {
    try {
      const user = await fetchJson<MeResponse>("/api/me");
      setGate({ state: "authenticated", user });
    } catch {
      setGate({ state: "anonymous" });
    }
  }, []);

  const loadStats = useCallback(async (): Promise<void> => {
    setStatsError(null);
    try {
      setStats(await fetchJson<AdminStats>("/api/admin/stats"));
    } catch (error) {
      setStatsError(error instanceof Error ? error.message : "Could not load statistics");
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (gate.state === "authenticated" && gate.user.role === "ADMIN") {
      void loadStats();
    }
  }, [gate, loadStats]);

  const submitLogin = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      await fetchJson("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      await loadSession();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Sign-in failed");
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await fetchJson("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setGate({ state: "anonymous" });
    setStats(null);
  };

  if (gate.state === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">Checking session…</div>
    );
  }

  if (gate.state === "anonymous") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h1 className="text-lg font-semibold text-white">CallNotes AI Admin</h1>
          <p className="mt-1 text-sm text-slate-400">Sign in with an administrator account.</p>
          <form onSubmit={(e) => void submitLogin(e)} className="mt-5 space-y-3">
            <div>
              <label htmlFor="email" className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            {authError && <p className="text-sm text-rose-400">{authError}</p>}
            <button
              type="submit"
              disabled={authBusy}
              className="w-full rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
            >
              {authBusy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (gate.user.role !== "ADMIN") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-center">
          <h1 className="text-lg font-semibold text-white">Administrator access only</h1>
          <p className="mt-2 text-sm text-slate-400">
            Signed in as {gate.user.email}, which does not have the ADMIN role. This console is restricted to
            administrators.
          </p>
          <button
            onClick={() => void logout()}
            className="mt-4 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const isAdmin = gate.user.role === "ADMIN";

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900/60">
        <div className="px-5 py-5">
          <div className="text-sm font-semibold text-white">CallNotes AI</div>
          <div className="text-xs text-slate-400">Admin Console</div>
        </div>
        <nav className="flex-1 space-y-1 px-3" aria-label="Admin navigation">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm font-medium ${
                section === item.id ? "bg-indigo-500/15 text-indigo-300" : "text-slate-300 hover:bg-slate-800/70"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="border-t border-slate-800 px-5 py-4 text-xs text-slate-500">
          <p className="truncate">{gate.user.email}</p>
          <button onClick={() => void logout()} className="text-indigo-300 hover:underline">
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto px-8 py-8">
        <h1 className="text-xl font-semibold text-white">{NAV.find((n) => n.id === section)?.label}</h1>

        {section === "dashboard" && isAdmin && (
          <>
            {statsError && (
              <div className="mt-4 rounded-lg border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-300">
                {statsError}
              </div>
            )}
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {STAT_CARDS.map((card) => (
                <div key={card.key} className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{card.label}</p>
                  <p className="mt-2 text-3xl font-semibold text-white">{stats ? String(stats[card.key]) : "…"}</p>
                  <p className="mt-1 text-xs text-slate-500">{card.hint}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {section !== "dashboard" && (
          <section className="mt-8 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="rounded-lg border border-dashed border-slate-800 py-16 text-center">
              <p className="text-sm text-slate-400">
                {section === "users" && "Full user management (roles, status, usage) is available in the desktop admin console."}
                {section === "meetings" && "All-user meeting oversight is available in the desktop admin console."}
                {section === "audit" && "Audit log review is available in the desktop admin console."}
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}