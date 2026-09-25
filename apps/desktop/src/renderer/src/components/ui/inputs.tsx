import type { InputHTMLAttributes, JSX, ReactNode, SelectHTMLAttributes } from "react";

const BASE = "w-full rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60";

export function Input(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input {...props} className={`${BASE} ${props.className ?? ""}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea {...props} className={`${BASE} resize-y ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return <select {...props} className={`${BASE} appearance-none ${props.className ?? ""}`} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ message }: { message: string }): JSX.Element {
  return (
    <div
      className="rounded-lg border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-300"
      role="alert"
    >
      {message}
    </div>
  );
}