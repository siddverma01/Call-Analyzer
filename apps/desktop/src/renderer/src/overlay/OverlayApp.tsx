import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { OVERLAY_PILL_HEIGHT, type OverlayAction, type OverlayState } from "@callnotes/shared";
import { Spinner } from "../components/ui/Button";
import {
  IconChevronDown,
  IconClock,
  IconMic,
  IconSettings,
  IconSparkles,
  IconX,
} from "../components/ui/Icons";

/**
 * The floating "AI assistant" pillar. Shown over whatever the user is doing
 * (including other applications) when Windows loopback audio suggests a call.
 * This window only issues overlay actions via the secure preload bridge - it
 * never captures audio itself, and starting a meeting always goes through the
 * real meeting flow in main (which requires the user's consent).
 */
export function OverlayApp(): JSX.Element {
  const [state, setState] = useState<OverlayState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.callnotes
      .overlayState()
      .then((snapshot) => {
        if (mounted) setState(snapshot);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const runAction = async (action: OverlayAction): Promise<void> => {
    if (action === "start-meeting") setBusy(true);
    setError(null);
    const result = await window.callnotes.overlayAction(action);
    if (action === "start-meeting") {
      setBusy(false);
      if (!result.ok && result.error) setError(result.error);
      else setMenuOpen(false);
    } else {
      setMenuOpen(false);
    }
  };

  return (
    <div className="relative h-full w-full">
      <div
        className="drag-region absolute inset-x-0 top-0 flex items-center gap-2.5 rounded-2xl border border-slate-700/80 bg-slate-900/95 px-3 shadow-[0_10px_34px_rgba(0,0,0,0.55)]"
        style={{ height: OVERLAY_PILL_HEIGHT }}
      >
        <div className="no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
          <IconSparkles className="h-[18px] w-[18px]" />
        </div>

        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13px] font-semibold text-slate-50">Write down call notes</div>
          <div className="truncate text-[11px] text-slate-400">CallNotes AI • on any screen</div>
        </div>

        <button
          type="button"
          onClick={() => void runAction("start-meeting")}
          disabled={busy}
          className="no-drag inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-indigo-500 px-2.5 text-xs font-medium text-white transition-colors hover:bg-indigo-400 disabled:cursor-wait disabled:opacity-70"
        >
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <IconMic className="h-3.5 w-3.5" />}
          {busy ? "Starting…" : "Start Notes"}
        </button>

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="More options"
          className={`no-drag inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-slate-700/80 hover:text-white ${
            menuOpen ? "bg-slate-700/80 text-white" : ""
          }`}
        >
          <IconChevronDown className={`h-4 w-4 transition-transform ${menuOpen ? "rotate-180" : ""}`} />
        </button>
      </div>

      {menuOpen && (
        <div
          className="absolute inset-x-0 flex flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-900/95 pb-2 shadow-[0_16px_48px_rgba(0,0,0,0.6)] backdrop-blur"
          style={{ top: OVERLAY_PILL_HEIGHT + 6, bottom: 0 }}
        >
          <div className="px-2 pt-2">
            <MenuItem
              icon={<IconMic className="h-4 w-4" />}
              label="Start AI Meeting Notes"
              description="Mic + system audio, transcribed locally"
              accent
              loading={busy}
              onClick={() => void runAction("start-meeting")}
            />
          </div>
          <div className="mx-2 my-1.5 border-t border-slate-800" />

          <MenuItem
            icon={<IconClock className="h-4 w-4" />}
            label="Snooze for 30 minutes"
            onClick={() => void runAction("snooze")}
          />
          <MenuItem
            icon={<IconX className="h-4 w-4" />}
            label="Don't show again"
            description="Turns automatic call detection off"
            onClick={() => void runAction("detection-off")}
          />
          <MenuItem
            icon={<IconSparkles className="h-4 w-4" />}
            label="Open CallNotes AI"
            onClick={() => void runAction("open-app")}
          />
          <MenuItem
            icon={<IconSettings className="h-4 w-4" />}
            label="Settings"
            onClick={() => void runAction("settings")}
          />

          <div className="px-3 pt-1.5">
            {error ? (
              <p className="text-[10px] leading-snug text-rose-400">{error}</p>
            ) : (
              <p className="text-[10px] leading-snug text-slate-500">
                {state?.recording ? "A meeting is already recording." : "Sound levels only - nothing is recorded until you start."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface MenuItemProps {
  icon: ReactNode;
  label: string;
  description?: string;
  accent?: boolean;
  loading?: boolean;
  onClick: () => void;
}

function MenuItem({ icon, label, description, accent = false, loading = false, onClick }: MenuItemProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="no-drag flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-slate-800/80 disabled:opacity-60"
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          accent ? "bg-indigo-500/20 text-indigo-400" : "bg-slate-800 text-slate-400"
        }`}
      >
        {loading ? <Spinner className="h-4 w-4" /> : icon}
      </span>
      <span className="min-w-0 leading-tight">
        <span className={`block truncate text-[13px] font-medium ${accent ? "text-indigo-300" : "text-slate-200"}`}>
          {label}
        </span>
        {description && <span className="block truncate text-[11px] text-slate-500">{description}</span>}
      </span>
    </button>
  );
}