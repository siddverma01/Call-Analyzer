import type { JSX } from "react";
import { useToastStore } from "../stores/toastStore";
import { IconAlertTriangle, IconCheck, IconX } from "./ui/Icons";

const KIND_STYLES = {
  success: { ring: "border-emerald-700/60", text: "text-emerald-300", Icon: IconCheck },
  error: { ring: "border-rose-800/60", text: "text-rose-300", Icon: IconAlertTriangle },
  info: { ring: "border-sky-800/60", text: "text-sky-300", Icon: IconCheck },
} as const;

export function Toasts(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((toast) => {
        const style = KIND_STYLES[toast.kind];
        const ToastIcon = style.Icon;
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border bg-slate-900/95 px-4 py-3 shadow-xl backdrop-blur ${style.ring}`}
            role="status"
          >
            <span className={`mt-0.5 ${style.text}`}>
              <ToastIcon />
            </span>
            <p className="min-w-0 flex-1 text-sm text-slate-200">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className="text-slate-500 hover:text-white"
            >
              <IconX />
            </button>
          </div>
        );
      })}
    </div>
  );
}