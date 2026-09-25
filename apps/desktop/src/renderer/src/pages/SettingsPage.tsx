import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { OverlaySettingsUpdate, OverlayState } from "@callnotes/shared";
import { useAuthStore } from "../stores/authStore";
import { useToastStore } from "../stores/toastStore";
import { useAppStore } from "../stores/appStore";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Modal, Toggle } from "../components/ui/Modal";
import { ErrorNote, Field, Input, Select } from "../components/ui/inputs";
import {
  IconAlertTriangle,
  IconCpu,
  IconMic,
  IconMonitor,
  IconShield,
  IconSparkles,
  IconSpeaker,
  IconZap,
} from "../components/ui/Icons";
import { WhisperManager } from "../components/whisper/WhisperManager";
import { LLMManager } from "../components/llm/LLMManager";
import { getAccent, setAccent, type Accent } from "../lib/theme";

function toMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "Something went wrong.";
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-slate-400">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{description}</p>
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </Card>
  );
}

function NotConfiguredNote(): JSX.Element {
  return (
    <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
      <IconAlertTriangle className="mt-0.5 shrink-0" />
      Not configured yet. This section will become available when the capture and AI services ship in a later phase.
    </p>
  );
}

export function SettingsPage(): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const busy = useAuthStore((s) => s.busy);
  const changePassword = useAuthStore((s) => s.changePassword);
  const pushToast = useToastStore((s) => s.push);
  const apiUrl = useAppStore((s) => s.apiUrl);
  const backendStatus = useAppStore((s) => s.backendStatus);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [accent, setAccentValue] = useState<Accent>(() => getAccent());

  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [showConsent, setShowConsent] = useState(false);

  useEffect(() => {
    setAccent(accent);
  }, [accent]);

  useEffect(() => {
    let mounted = true;
    void window.callnotes
      .overlayState()
      .then((snapshot) => {
        if (mounted) setOverlay(snapshot);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const updateOverlay = async (patch: OverlaySettingsUpdate): Promise<void> => {
    try {
      setOverlay(await window.callnotes.overlayUpdateSettings(patch));
      setOverlayError(null);
    } catch (reason) {
      setOverlayError(toMessage(reason));
    }
  };

  const toggleOverlayEnabled = (): void => {
    if (overlay?.consentGiven) {
      void updateOverlay({ enabled: !overlay.enabled });
    } else if (!overlay?.enabled) {
      setShowConsent(true);
    }
  };

  const submitPassword = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setPwError(null);
    if (newPassword.length < 10) {
      setPwError("The new password must be at least 10 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setPwError("The new passwords do not match.");
      return;
    }
    const okChange = await changePassword(currentPassword, newPassword);
    if (okChange) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      pushToast("success", "Password updated");
    } else {
      setPwError("Could not update the password. Check your current password and try again.");
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Section
        icon={<IconShield />}
        title="Account"
        description="Your identity on this device and session security."
      >
        <dl className="mb-5 grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg bg-slate-950/60 p-3">
            <dt className="text-xs text-slate-500">Name</dt>
            <dd className="mt-0.5 font-medium text-slate-200">{user?.name ?? "—"}</dd>
          </div>
          <div className="rounded-lg bg-slate-950/60 p-3">
            <dt className="text-xs text-slate-500">Email</dt>
            <dd className="mt-0.5 font-medium text-slate-200">{user?.email ?? "—"}</dd>
          </div>
          <div className="rounded-lg bg-slate-950/60 p-3">
            <dt className="text-xs text-slate-500">Role</dt>
            <dd className="mt-0.5 capitalize text-slate-200">{user?.role.toLowerCase()}</dd>
          </div>
          <div className="rounded-lg bg-slate-950/60 p-3">
            <dt className="text-xs text-slate-500">Backend</dt>
            <dd className="mt-0.5 font-mono text-xs text-slate-300">{apiUrl || "—"}</dd>
          </div>
        </dl>

        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Change password</h3>
        <form onSubmit={(e) => void submitPassword(e)} className="space-y-3">
          <Field label="Current password">
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New password" hint="At least 10 characters.">
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>
            <Field label="Confirm new password">
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>
          </div>
          {pwError && <ErrorNote message={pwError} />}
          <Button type="submit" loading={busy}>
            Update password
          </Button>
        </form>
      </Section>

      <Section icon={<IconMic />} title="Audio" description="Default capture devices.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Microphone">
            <Select disabled defaultValue="">
              <option value="">No device configured</option>
            </Select>
          </Field>
          <Field label="System audio">
            <Select disabled defaultValue="">
              <option value="">No device configured</option>
            </Select>
          </Field>
        </div>
        <NotConfiguredNote />
      </Section>

      <Section icon={<IconZap />} title="Whisper" description="Local speech recognition model — runs fully on this device.">
        <WhisperManager />
      </Section>

      <Section icon={<IconCpu />} title="Local AI" description="On-device LLM for summaries and action items.">
        <LLMManager />
      </Section>

      <Section icon={<IconShield />} title="Privacy" description="What gets recorded and how long it stays.">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-200">Show recording indicator</p>
              <p className="text-xs text-slate-500">Display a visible badge while capturing audio.</p>
            </div>
            <Toggle checked={false} onChange={() => undefined} disabled label="Recording indicator" />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-200">Auto-delete old transcripts</p>
              <p className="text-xs text-slate-500">Remove transcripts after a retention window.</p>
            </div>
            <Toggle checked={false} onChange={() => undefined} disabled label="Auto-delete transcripts" />
          </div>
        </div>
        <NotConfiguredNote />
      </Section>

      <Section icon={<IconSpeaker />} title="Sync" description="Keep notes in sync across devices.">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-200">Sync meetings to the cloud</p>
            <p className="text-xs text-slate-500">Requires a cloud account and is disabled by default.</p>
          </div>
          <Toggle checked={false} onChange={() => undefined} disabled label="Sync meetings" />
        </div>
        <NotConfiguredNote />
      </Section>

      <Section
        icon={<IconSparkles />}
        title="AI assistant overlay"
        description="A floating assistant that appears over other apps when it hears call-like sound - only with your consent."
      >
        {!overlay ? (
          <p className="text-sm text-slate-500">Loading overlay settings…</p>
        ) : overlay.supported ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-200">Show the floating assistant</p>
                <p className="text-xs text-slate-500">
                  Always-on-top pill you can drag anywhere. Starts AI meeting notes from any app.
                </p>
              </div>
              <Toggle
                checked={overlay.enabled}
                onChange={toggleOverlayEnabled}
                label="Enable assistant overlay"
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-200">Automatic detection</p>
                <p className="text-xs text-slate-500">
                  Appear automatically when call-like sound is playing. Uses only system-audio sound levels (RMS) -
                  nothing is recorded.
                </p>
              </div>
              <Toggle
                checked={overlay.detectionEnabled}
                onChange={(next) => void updateOverlay({ detectionEnabled: next })}
                disabled={!overlay.enabled || !overlay.consentGiven}
                label="Automatic call detection"
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-200">Auto-record meetings</p>
                <p className="text-xs text-slate-500">
                  Start AI meeting notes automatically when a call is detected. Detection must be on.
                </p>
              </div>
              <Toggle
                checked={overlay.autoRecord}
                onChange={(next) => void updateOverlay({ autoRecord: next })}
                disabled={!overlay.detectionEnabled}
                label="Auto-record meetings"
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-200">Consent to capture</p>
                <p className="text-xs text-slate-500">
                  {overlay.consentGiven
                    ? "Granted: microphone + system audio may be used. Meeting notes start only via an explicit action (or auto-record, if you turn it on)."
                    : "Not granted yet. The assistant cannot listen until you enable it and agree."}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowConsent(true)}>
                Review consent
              </Button>
            </div>

            <p className="flex items-start gap-2 rounded-lg bg-slate-950/60 px-3 py-2 text-xs text-slate-500">
              <IconShield className="mt-0.5 shrink-0" />
              Meetings started from the overlay capture {overlay.sources.join(" + ")}. Detection watches sound levels
              only; the Whisper / LLM engines never load just because the pill appears.
            </p>
            {overlayError && <ErrorNote message={overlayError} />}
          </div>
        ) : (
          <p className="flex items-start gap-2 rounded-lg bg-slate-950/60 px-3 py-2 text-xs text-slate-500">
            <IconAlertTriangle className="mt-0.5 shrink-0" />
            The assistant overlay is only available on Windows.
          </p>
        )}

        <Modal
          open={showConsent}
          title="Enable the CallNotes AI assistant?"
          onClose={() => setShowConsent(false)}
        >
          <div className="space-y-4 text-sm text-slate-300">
            <p>
              The assistant floats over the current app and can start AI meeting notes for you. Making that work means
              CallNotes AI may listen to audio on this device:
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <span className="font-medium text-slate-100">Microphone audio</span> - used to capture your voice for
                meeting notes.
              </li>
              <li>
                <span className="font-medium text-slate-100">System audio</span> - used to detect call-like sound and to
                capture playback for meeting notes.
              </li>
            </ul>
            <p>
              Nothing is recorded, transcribed, or analyzed until you explicitly start a meeting - the assistant only
              watches sound levels to decide when to appear. Audio stays on this device and is deleted after processing.
            </p>
          </div>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowConsent(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setShowConsent(false);
                // First grant turns detection on; reviewing consent later never
                // silently re-enables detection the user switched off.
                const alreadyConsented = overlay?.consentGiven ?? false;
                void updateOverlay({
                  consent: true,
                  enabled: true,
                  detectionEnabled: alreadyConsented ? undefined : true,
                });
              }}
            >
              I understand and enable
            </Button>
          </div>
        </Modal>
      </Section>

      <Section
        icon={<IconMonitor />}
        title="Appearance"
        description="Personalize how the app looks on your screen."
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Theme" hint="Dark is the designed default.">
            <Select disabled defaultValue="dark">
              <option value="dark">Dark</option>
            </Select>
          </Field>
          <Field label="Accent color">
            <div className="flex items-center gap-2 pt-1">
              {(["indigo", "violet", "emerald", "amber", "rose"] as Accent[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAccentValue(a)}
                  aria-label={`${a} accent`}
                  title={`${a} accent`}
                  className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                    accent === a ? "border-white" : "border-transparent"
                  }`}
                  style={{
                    background: `linear-gradient(135deg, ${
                      a === "indigo" ? "#6366f1" : a === "violet" ? "#8b5cf6" : a === "emerald" ? "#10b981" : a === "amber" ? "#f59e0b" : "#f43f5e"
                    }, ${
                      a === "indigo" ? "#7c3aed" : a === "violet" ? "#a855f7" : a === "emerald" ? "#14b8a6" : a === "amber" ? "#f97316" : "#e11d48"
                    })`,
                  }}
                />
              ))}
            </div>
          </Field>
        </div>
        <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-950/60 px-3 py-2 text-xs text-slate-500">
          <IconAlertTriangle className="mt-0.5 shrink-0" />
          Backend status: {backendStatus === "online" ? "online" : backendStatus === "offline" ? "offline" : "checking"} —
          layout adapts to common Windows resolutions automatically.
        </p>
      </Section>
    </div>
  );
}