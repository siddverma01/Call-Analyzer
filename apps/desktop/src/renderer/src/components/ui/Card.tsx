import type { JSX, ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`rounded-xl border border-slate-800 bg-slate-900/60 ${className}`}>{children}</div>
  );
}

type BadgeTone = "slate" | "indigo" | "emerald" | "amber" | "rose" | "sky";

const TONES: Record<BadgeTone, string> = {
  slate: "bg-slate-800 text-slate-300",
  indigo: "bg-indigo-500/15 text-indigo-300",
  emerald: "bg-emerald-500/15 text-emerald-300",
  amber: "bg-amber-500/15 text-amber-300",
  rose: "bg-rose-500/15 text-rose-300",
  sky: "bg-sky-500/15 text-sky-300",
};

export function Badge({
  children,
  tone = "slate",
  dot = false,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 px-6 py-16 text-center">
      {icon && <div className="mb-3 text-3xl text-slate-600">{icon}</div>}
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      {message && <p className="mt-1 max-w-sm text-sm text-slate-400">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}