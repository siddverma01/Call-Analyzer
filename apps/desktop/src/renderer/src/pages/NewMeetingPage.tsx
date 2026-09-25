import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  type AudioCaptureKind,
  type AudioDeviceInfo,
  type AudioInfoResponse,
  type AudioMetersEvent,
  type MeetingProcessEvent,
  type MicTestResult,
  type RecordingStorageEstimate,
  type RecordingUsage,
  type WhisperEngineStatus,
  type WhisperModelId,
} from "@callnotes/shared";
import { useDataStore } from "../stores/dataStore";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { useOverlayStore } from "../stores/overlayStore";
import { formatBytes } from "../lib/format";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Toggle } from "../components/ui/Modal";
import { ErrorNote, Field, Input, Select } from "../components/ui/inputs";
import {
  IconAlertTriangle,
  IconCheck,
  IconCpu,
  IconMic,
  IconPause,
  IconPlay,
  IconSpeaker,
  IconSparkles,
  IconX,
  IconZap,
} from "../components/ui/Icons";

const LLM_PROVIDERS = ["Local (llama.cpp)", "Local (Ollama)", "OpenAI-compatible endpoint"];

const MEETING_START_ERRORS: Record<string, string> = {
  "meeting.mic-unavailable": "No active microphone was found. Plug one in and refresh before starting.",
  "meeting.system-audio-unavailable": "System audio capture is unavailable on this machine.",
  "meeting.engine-unavailable": "The Whisper engine is unavailable. Check Settings → Whisper.",
  "meeting.whisper-model-missing": "No Whisper model is installed yet. Download one in Settings → Whisper first.",
  "meeting.session-active": "A meeting is already recording.",
  "meeting.capture-failed": "Audio capture could not start on this machine.",
  "meeting.insufficient-disk":
    "There is not enough free disk space to record the meeting. Free up space and try again.",
};

type Phase = "idle" | "recording" | "processing";

export function NewMeetingPage(): JSX.Element {
  const templates = useDataStore((s) => s.templates);
  const templatesLoading = useDataStore((s) => s.templatesLoading);
  const loadTemplates = useDataStore((s) => s.loadTemplates);
  const setPage = useAppStore((s) => s.setPage);
  const pushToast = useToastStore((s) => s.push);

  const [title, setTitle] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [micEnabled, setMicEnabled] = useState(true);
  const [systemAudio, setSystemAudio] = useState(false);
  const [localAi, setLocalAi] = useState(false);
  const [diarization, setDiarization] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [audio, setAudio] = useState<AudioInfoResponse | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [meters, setMeters] = useState<AudioMetersEvent | null>(null);
  const [testingMic, setTestingMic] = useState(false);
  const [micTest, setMicTest] = useState<MicTestResult | null>(null);

  const [whisperStatus, setWhisperStatus] = useState<WhisperEngineStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [processEvent, setProcessEvent] = useState<MeetingProcessEvent | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [storageEstimate, setStorageEstimate] = useState<RecordingStorageEstimate | null>(null);
  const [usage, setUsage] = useState<RecordingUsage | null>(null);
  const [activeTitle, setActiveTitle] = useState("Meeting");

  useEffect(() => {
    if (!templates && !templatesLoading) void loadTemplates();
  }, [templates, templatesLoading, loadTemplates]);

  // Live monitoring: subscribe to meters and refresh device availability while
  // this page is mounted. Meters are in-memory only; the temporary capture
  // files written during a meeting are deleted after transcription.
  useEffect(() => {
    let cancelled = false;
    void window.callnotes
      .audioInfo()
      .then((info) => {
        if (!cancelled) setAudio(info);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setAudioError(toMessage(reason));
      });
    void window.callnotes
      .audioMonitorStart()
      .then((info) => {
        if (!cancelled) setAudio(info);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setAudioError(toMessage(reason));
      });
    const unsubscribe = window.callnotes.onAudioMeters((event) => {
      if (!cancelled) setMeters(event);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      void window.callnotes.audioMonitorStop();
    };
  }, []);

  // Storage projection for the selected audio sources: shows how much
  // temporary disk space a meeting will use and warns when space is low.
  useEffect(() => {
    if (phase !== "idle") return;
    let cancelled = false;
    const sources = selectedSources(micEnabled, systemAudio);
    void window.callnotes
      .meetingStorageEstimate(sources)
      .then((estimate) => {
        if (!cancelled) setStorageEstimate(estimate);
      })
      .catch(() => {
        if (!cancelled) setStorageEstimate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [micEnabled, systemAudio, phase]);

  // Local whisper engine: status only. Transcription runs after the meeting
  // stops, driven by MeetingProcessEvent pushes.
  useEffect(() => {
    let mounted = true;
    void window.callnotes
      .whisperStatus()
      .then((status) => {
        if (mounted) setWhisperStatus(status);
      })
      .catch(() => {});
    const unsubStatus = window.callnotes.onWhisperStatus((status: WhisperEngineStatus) => {
      if (mounted) setWhisperStatus(status);
    });
    return () => {
      mounted = false;
      unsubStatus();
    };
  }, []);

  // Adopt a meeting that the floating overlay started in main: enter the
  // recording phase directly instead of calling start() again.
  useEffect(() => {
    let mounted = true;

    const adoptActive = async (): Promise<void> => {
      if (!mounted || phaseRef.current !== "idle") return;
      if (useOverlayStore.getState().pendingMeetingId) {
        useOverlayStore.getState().consumePendingMeeting();
      }
      try {
        const rows = await window.callnotes.meetingListLocal();
        if (!mounted || phaseRef.current !== "idle") return;
        const active = rows.find((r) => r.status === "RECORDING");
        if (active) {
          recordingRef.current = true;
          setActiveTitle(active.title);
          setPhase("recording");
          void window.callnotes.meetingRecordingUsage().then((next) => {
            if (mounted) setUsage(next);
          });
        }
      } catch {
        // stays on the setup screen; the user can start manually
      }
    };

    const unsub = useOverlayStore.subscribe((state) => {
      if (state.pendingMeetingId) void adoptActive();
    });
    void adoptActive(); // cover a meeting that is already recording on mount

    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  // Post-meeting processing progress: finalize -> transcribe -> analyze ->
  // save -> sync -> clean. On success, hand off to the meetings list; on
  // failure, stay here and show the error (the preserved audio can be retried
  // from the meetings page).
  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.callnotes.onMeetingProcess((event: MeetingProcessEvent) => {
      if (!mounted) return;
      setProcessEvent(event);
      if (event.type === "complete") {
        setPhase("idle");
        pushToast("success", "Meeting saved and processed locally.");
        setPage("meetings");
      } else if (event.type === "failed") {
        setPhase("processing");
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [pushToast, setPage]);

  // Real temporary-storage usage while recording: polled from the main
  // process, not simulated from wall-clock time.
  useEffect(() => {
    if (phase !== "recording") return;
    let cancelled = false;
    const poll = (): void => {
      void window.callnotes
        .meetingRecordingUsage()
        .then((next) => {
          if (!cancelled) setUsage(next);
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase]);

  // Elapsed-time ticker while a meeting is recording (client-side only). The
  // timer does not run on the real microphone timeline; paused intervals are
  // excluded from the elapsed figure shown here.
  const pausedMsRef = useRef(0);
  const pausedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    pausedMsRef.current = 0;
    pausedAtRef.current = null;
    setElapsedMs(0);
    const timer = setInterval(() => {
      const pausedMs =
        pausedAtRef.current !== null ? pausedMsRef.current + (Date.now() - pausedAtRef.current) : pausedMsRef.current;
      setElapsedMs(Math.max(0, Date.now() - startedAt - pausedMs));
    }, 500);
    return () => clearInterval(timer);
  }, [phase]);

  // Track the boundaries of a paused interval so the ticker can exclude it.
  useEffect(() => {
    if (paused && pausedAtRef.current === null && phase === "recording") {
      pausedAtRef.current = Date.now();
    } else if (!paused && pausedAtRef.current !== null) {
      pausedMsRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }
  }, [paused, phase]);

  // Make sure a stray recording is finished if the user leaves mid-meeting.
  const recordingRef = useRef(false);
  useEffect(() => {
    return () => {
      if (recordingRef.current) void window.callnotes.meetingStop();
    };
  }, []);

  const selectMic = async (deviceId: string): Promise<void> => {
    try {
      setAudio(await window.callnotes.audioSelectMic(deviceId === "" ? null : deviceId));
    } catch (reason) {
      setAudioError(toMessage(reason));
    }
  };

  const runMicTest = async (): Promise<void> => {
    setTestingMic(true);
    setMicTest(null);
    try {
      const result = await window.callnotes.audioMicTest(null);
      setMicTest(result);
    } catch (reason) {
      setAudioError(toMessage(reason));
    } finally {
      setTestingMic(false);
    }
  };

  const activeMics = (audio?.mic.devices ?? []).filter((d) => d.state === "active");
  const selectedMic = audio?.mic.selectedDeviceId ?? "";
  const micConnected = audio?.mic.state === "connected";
  const systemAvailable = audio?.systemAudio.state === "available";
  const controlsDisabled = phase !== "idle";

  const start = async (): Promise<void> => {
    setError(null);
    const sources = selectedSources(micEnabled, systemAudio);
    if (sources.length === 0) {
      setError("Select at least one audio source (microphone or system audio).");
      return;
    }
    setCreating(true);
    const result = await window.callnotes.meetingStart({
      title: title.trim() || undefined,
      templateId: templateId || undefined,
      sources,
      diarization,
    });
    setCreating(false);
    if (!result.ok) {
      setError(
        MEETING_START_ERRORS[result.error?.code ?? ""] ??
          result.error?.message ??
          "Could not start the meeting.",
      );
      return;
    }
    recordingRef.current = true;
    setActiveTitle(title.trim() || "Untitled meeting");
    setUsage(null);
    setPhase("recording");
    pushToast("success", "Meeting started — recording locally. Transcription runs when you stop it.");
  };

  const stopAndFinish = async (): Promise<void> => {
    if (phase !== "recording") return;
    recordingRef.current = false;
    setPaused(false);
    setPhase("processing");
    setProcessEvent(null);
    void window.callnotes.meetingStop();
  };

  const togglePause = async (): Promise<void> => {
    const next = !paused;
    setPaused(next);
    try {
      if (next) await window.callnotes.meetingPause();
      else await window.callnotes.meetingResume();
    } catch (reason) {
      setError(toMessage(reason));
      setPaused(!next);
    }
  };

  const selectWhisperModel = async (modelId: string): Promise<void> => {
    if (!modelId) return;
    try {
      setWhisperStatus(await window.callnotes.whisperSetDefault(modelId as WhisperModelId));
    } catch (reason) {
      setError(toMessage(reason));
    }
  };

  const leaveFailedMeeting = (): void => {
    setPhase("idle");
    setPage("meetings");
  };

  if (phase === "recording") {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Card className="p-6">
          <h2 className="flex items-center justify-between text-base font-semibold text-white">
            <span className="flex items-center gap-2">
              <IconCpu className="text-indigo-300" />
              Active meeting
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                paused ? "bg-amber-500/15 text-amber-300" : "bg-rose-500/15 text-rose-300"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-amber-400" : "animate-pulse bg-rose-400"}`}
                aria-hidden
              />
              {paused ? "Paused" : "Recording"}
            </span>
          </h2>
          <p className="mt-1 text-sm font-medium text-white">{activeTitle}</p>
          <p className="text-xs text-slate-500">{formatElapsed(elapsedMs)} elapsed</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <CaptureStatusRow
              icon={<IconMic />}
              label="Microphone"
              status={!micEnabled ? "Off" : micConnected ? "Capturing" : "Not connected"}
              active={micEnabled && micConnected}
            />
            <CaptureStatusRow
              icon={<IconSpeaker />}
              label="System audio"
              status={!systemAudio ? "Off" : systemAvailable ? "Capturing" : "Unavailable"}
              active={systemAudio && systemAvailable}
            />
          </div>

          {usage && (
            <div className="mt-4 rounded-lg bg-slate-950/60 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-4 text-slate-400">
                <span>{paused ? "Capture paused — not writing to disk" : "Writing to temporary local files"}</span>
                <span className="font-medium text-slate-300">{formatBytes(usage.bytesWritten)}</span>
              </div>
              {usage.streams.map((s) => (
                <div key={s.kind} className="mt-1 flex items-center justify-between gap-4 text-slate-500">
                  <span className="capitalize">{s.kind}</span>
                  <span className="tabular-nums">{formatBytes(s.frameCount * 4)}</span>
                </div>
              ))}
            </div>
          )}

          {audioError && (
            <div className="mt-4">
              <ErrorNote message={audioError} />
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" variant={paused ? "primary" : "ghost"} onClick={() => void togglePause()}>
              {paused ? (
                <>
                  <IconPlay className="text-sm" />
                  Resume
                </>
              ) : (
                <>
                  <IconPause className="text-sm" />
                  Pause
                </>
              )}
            </Button>
            <Button size="sm" variant="danger" onClick={() => void stopAndFinish()} className="ml-auto">
              <IconX className="text-sm" />
              Stop meeting
            </Button>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Nothing is transcribed while recording — processing (transcribe, notes, cleanup) runs on-device after you
            stop the meeting.
          </p>
        </Card>

        {error && <ErrorNote message={error} />}
      </div>
    );
  }

  if (phase === "processing") {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Card className="p-6">
          <h2 className="flex items-center justify-between text-base font-semibold text-white">
            <span className="flex items-center gap-2">
              <IconCpu className="text-indigo-300" />
              Processing {activeTitle}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-xs font-medium text-indigo-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" aria-hidden />
              On-device
            </span>
          </h2>
          <ProcessingSteps event={processEvent} />
          {processEvent?.type === "failed" && (
            <div className="mt-4 space-y-3">
              <ErrorNote message={`Processing failed: ${processEvent.error.message}`} />
              <p className="text-xs text-slate-500">
                The captured audio is preserved on this machine so you can retry it from the Meetings page.
              </p>
              <div className="flex items-center justify-end gap-3">
                <Button variant="ghost" onClick={() => setPage("meetings")}>
                  To meetings
                </Button>
                <Button onClick={() => void leaveFailedMeeting()}>
                  Review in meetings
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Card className="p-6">
        <h2 className="text-base font-semibold text-white">Meeting details</h2>
        <div className="mt-4 grid gap-4">
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Weekly standup"
              maxLength={200}
              disabled={controlsDisabled}
            />
          </Field>
          <Field label="Template" hint="Structures the generated notes.">
            <Select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={templatesLoading || controlsDisabled}
            >
              <option value="">Default</option>
              {(templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.description ? ` — ${t.description}` : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="text-base font-semibold text-white">Audio sources</h2>
        {audioError && <ErrorNote message={audioError} />}
        <div className="mt-4 space-y-5">
          <AudioSourceRow
            icon={<IconMic />}
            label="Microphone"
            description="Capture your own voice."
            status={
              !micEnabled
                ? { tone: "sky", label: "Off" }
                : audio
                  ? micConnected
                    ? { tone: "emerald", label: "Connected" }
                    : { tone: "rose", label: "Not connected" }
                  : { tone: "sky", label: "Checking…" }
            }
            meter={micEnabled ? (meters?.mic ?? null) : null}
            control={
              <div className="flex items-center gap-3">
                <Toggle checked={micEnabled} onChange={setMicEnabled} label="Microphone" disabled={controlsDisabled} />
                <Select
                  value={selectedMic}
                  onChange={(e) => void selectMic(e.target.value)}
                  disabled={!micConnected || !micEnabled || controlsDisabled}
                  className="w-56"
                  aria-label="Microphone device"
                >
                  <option value="">Default</option>
                  {activeMics.map((d) => (
                    <option key={d.id} value={d.id}>
                      {deviceLabel(d)}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="ghost"
                  onClick={() => void runMicTest()}
                  loading={testingMic}
                  disabled={!micConnected || !micEnabled || controlsDisabled}
                >
                  Test
                </Button>
              </div>
            }
          />
          {micEnabled && micTest &&
            (micTest.heardVoice ? (
              <MicTestNotice tone="ok">
                <IconCheck className="mt-0.5 shrink-0" />
                Heard your voice — peak {db(micTest.peak)} over {micTest.durationSeconds}s.
              </MicTestNotice>
            ) : (
              <MicTestNotice tone="warn">
                <IconX className="mt-0.5 shrink-0" />
                No voice detected in {micTest.durationSeconds}s.
              </MicTestNotice>
            ))}
          {micEnabled && audio && !micConnected && (
            <MicTestNotice tone="warn">
              <IconAlertTriangle className="mt-0.5 shrink-0" />
              No active microphone found on this device. Plug one in or enable it in Windows sound settings, then
              refresh.
            </MicTestNotice>
          )}

          <AudioSourceRow
            icon={<IconSpeaker />}
            label="System audio"
            description="Capture other participants’ audio coming from this device."
            status={
              audio
                ? systemAvailable
                  ? { tone: "emerald", label: "Available" }
                  : { tone: "rose", label: "Unavailable" }
                : { tone: "sky", label: "Checking…" }
            }
            meter={meters?.systemAudio ?? null}
            control={
              <Toggle checked={systemAudio} onChange={setSystemAudio} label="System audio" disabled={controlsDisabled} />
            }
          />
          {audio && systemAudio && !systemAvailable && (
            <MicTestNotice tone="warn">
              <IconAlertTriangle className="mt-0.5 shrink-0" />
              WASAPI loopback could not initialize on an output device — system audio capture is unavailable.
            </MicTestNotice>
          )}

          {storageEstimate && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
              <span>
                Recording uses ≈{" "}
                <span className="font-medium text-slate-300">
                  {formatBytes(storageEstimate.bytesPerSecond * 3600)}/hour
                </span>
              </span>
              <span>
                ≈{" "}
                <span className="font-medium text-slate-300">{formatBytes(storageEstimate.estimatedBytes)}</span> for a
                4h meeting
              </span>
              <span>
                Free: <span className="font-medium text-slate-300">{formatBytes(storageEstimate.availableBytes)}</span>
              </span>
              {!storageEstimate.sufficient && (
                <span className="flex items-center gap-1 text-amber-300">
                  <IconAlertTriangle className="text-sm" />
                  Not enough free space for a long meeting — recordings stop if the disk fills up.
                </span>
              )}
            </div>
          )}
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Audio is captured to temporary files on this machine when you start a meeting, and those files are deleted
          after transcription. If transcription fails, the audio is kept on disk so you can retry it — nothing is ever
          uploaded.
        </p>
      </Card>

      <Card className="p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold text-white">
          <IconSparkles className="text-indigo-300" />
          Transcription
        </h2>
        <div className="mt-4 space-y-4">
          <div>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-200">Local Whisper model</p>
                <p className="text-xs text-slate-500">Used after the meeting stops — offline, no cloud.</p>
              </div>
              <span className="shrink-0">
                <WhisperModelBadge status={whisperStatus} />
              </span>
            </div>
            <Select
              value={whisperStatus?.defaultModelId ?? ""}
              onChange={(e) => void selectWhisperModel(e.target.value)}
              disabled={controlsDisabled}
              className="mt-2"
            >
              <option value="">Select a model…</option>
              {(whisperStatus?.models ?? []).map((m) => (
                <option key={m.id} value={m.id} disabled={!m.installed || m.corrupt}>
                  {m.name} —{" "}
                  {m.installed
                    ? m.corrupt
                      ? "corrupt, re-download"
                      : m.isDefault
                        ? "default"
                        : "downloaded"
                    : `not installed (${m.sizeLabel})`}
                </option>
              ))}
            </Select>
            {whisperStatus && !whisperStatus.models.some((m) => m.installed) && (
              <MicTestNotice tone="warn">
                <IconAlertTriangle className="mt-0.5 shrink-0" />
                No Whisper model is installed yet. Download one in Settings → Whisper first; meetings cannot be
                transcribed until then.
              </MicTestNotice>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-200">Speaker detection</p>
              <p className="text-xs text-slate-500">Label separate speakers in the transcript (when supported).</p>
            </div>
            <Toggle
              checked={diarization}
              onChange={setDiarization}
              label="Speaker detection"
              disabled={controlsDisabled}
            />
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold text-white">
          <IconCpu className="text-indigo-300" />
          Local AI notes
        </h2>
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-200">Generate summaries with a local LLM</p>
              <p className="text-xs text-slate-500">Turn transcripts into summaries and action items on-device.</p>
            </div>
            <Toggle checked={localAi} onChange={setLocalAi} label="Local AI" disabled={controlsDisabled} />
          </div>
          {localAi && (
            <div>
              <Field label="Provider">
                <Select defaultValue={LLM_PROVIDERS[0]} disabled>
                  {LLM_PROVIDERS.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </Select>
              </Field>
              <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                <IconZap className="mt-0.5 shrink-0" />
                Local AI is not configured yet. Configure a provider in Settings to enable note generation.
              </p>
            </div>
          )}
        </div>
      </Card>

      {error && <ErrorNote message={error} />}

      <div className="flex items-center justify-end gap-3 pb-4">
        <Button variant="ghost" onClick={() => setPage("dashboard")}>
          Cancel
        </Button>
        <Button
          onClick={() => void start()}
          loading={creating}
          disabled={!((micEnabled && micConnected) || (systemAudio && systemAvailable))}
        >
          <IconMic className="text-sm" />
          Start meeting
        </Button>
      </div>
    </div>
  );
}

type MeterTone = "emerald" | "rose" | "sky";

function selectedSources(micEnabled: boolean, systemAudio: boolean): AudioCaptureKind[] {
  const sources: AudioCaptureKind[] = [];
  if (micEnabled) sources.push("microphone");
  if (systemAudio) sources.push("loopback");
  return sources;
}

function CaptureStatusRow({
  icon,
  label,
  status,
  active,
}: {
  icon: JSX.Element;
  label: string;
  status: string;
  active: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-slate-950/60 px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-slate-400">{icon}</span>
        <p className="text-sm font-medium text-slate-200">{label}</p>
      </div>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
          active ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400"
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full bg-current ${active ? "animate-pulse" : ""}`} aria-hidden />
        {status}
      </span>
    </div>
  );
}

function AudioSourceRow({
  icon,
  label,
  description,
  status,
  meter,
  control,
}: {
  icon: JSX.Element;
  label: string;
  description: string;
  status: { tone: MeterTone; label: string };
  meter: AudioMetersEvent["mic"] | null;
  control: JSX.Element;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 text-slate-400">{icon}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-slate-200">{label}</p>
            <SourceBadge tone={status.tone}>{status.label}</SourceBadge>
          </div>
          <p className="text-xs text-slate-500">{description}</p>
          <LevelMeter meter={meter} className="mt-2 h-1.5 w-40" />
        </div>
      </div>
      {control}
    </div>
  );
}

const SOURCE_TONES: Record<MeterTone, string> = {
  emerald: "bg-emerald-500/15 text-emerald-300",
  rose: "bg-rose-500/15 text-rose-300",
  sky: "bg-sky-500/15 text-sky-300",
};

function SourceBadge({ tone, children }: { tone: MeterTone; children: string }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        SOURCE_TONES[tone]
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

function LevelMeter({ meter, className }: { meter: AudioMetersEvent["mic"] | null; className: string }): JSX.Element {
  // Log-mapped fill level; -60 dBFS floor keeps idle silence visually quiet.
  const fill = meter && meter.hasSignal ? Math.min(1, (meter.db + 60) / 40) : 0;
  const level = meter ? `${db(meter.peak)} peak` : "no signal";
  return (
    <div className="flex items-center gap-2" aria-label={`live level: ${level}`}>
      <div className={`overflow-hidden rounded-full bg-slate-800 ${className}`}>
        <div
          className="h-full rounded-full transition-[width] duration-100"
          style={{
            width: `${Math.round(fill * 100)}%`,
            backgroundColor: fill < 0.5 ? "#34d399" : fill < 0.75 ? "#fbbf24" : "#fb7185",
          }}
        />
      </div>
      <span className="w-24 shrink-0 text-[10px] tabular-nums text-slate-500">{level}</span>
    </div>
  );
}

function MicTestNotice({ tone, children }: { tone: "ok" | "warn"; children: ReactNode }): JSX.Element {
  const styles =
    tone === "ok"
      ? "border-emerald-800/40 bg-emerald-950/20 text-emerald-300"
      : "border-amber-800/40 bg-amber-950/20 text-amber-300";
  return (
    <p className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${styles}`}>{children}</p>
  );
}

/**
 * The post-meeting pipeline shown after the user stops a meeting. Each stage
 * maps to a real MeetingProcessEvent pushed from the main process — no
 * simulated progress.
 */
const PROCESS_STEPS: { key: string; label: string; detail: string }[] = [
  { key: "finalizing", label: "Finalizing audio", detail: "Flushing the temporary capture files" },
  { key: "transcribing", label: "Transcribing locally", detail: "On-device Whisper engine" },
  { key: "analyzing", label: "Analyzing transcript", detail: "Local LLM reading the transcript" },
  { key: "notes", label: "Generating meeting notes", detail: "Summary, decisions and action items" },
  { key: "saving", label: "Saving results", detail: "Storing transcript text locally" },
  { key: "syncing", label: "Syncing text", detail: "Offline-first queue — retries when online" },
  { key: "cleaning", label: "Cleaning up temporary audio", detail: "Deleting temp files off the device" },
];

function ProcessingSteps({ event }: { event: MeetingProcessEvent | null }): JSX.Element {
  let activeIndices = new Set<number>();
  let percent: number | null = null;
  if (event) {
    if (event.type === "finalizing") activeIndices = new Set([0]);
    else if (event.type === "transcribing") {
      activeIndices = new Set([1]);
      if (typeof event.percent === "number") percent = event.percent;
    } else if (event.type === "analyzing") activeIndices = new Set([2, 3]);
    else if (event.type === "saving") activeIndices = new Set([4]);
    else if (event.type === "syncing") activeIndices = new Set([5]);
    else if (event.type === "cleaning") activeIndices = new Set([6]);
    else if (event.type === "complete") activeIndices = new Set(Array.from({ length: PROCESS_STEPS.length }, (_, i) => i));
  }
  const earliestActive = activeIndices.size > 0 ? Math.min(...activeIndices) : -1;
  return (
    <div className="mt-4 space-y-2.5">
      <ol className="space-y-2.5">
        {PROCESS_STEPS.map((step, index) => {
          const done = earliestActive > index;
          const active = activeIndices.has(index);
          return (
            <li key={step.key} className="flex items-start gap-3 rounded-lg bg-slate-950/60 px-3 py-2">
              <span className="mt-0.5 w-5 shrink-0">
                {done ? (
                  <IconCheck className="h-4 w-4 text-emerald-400" aria-label="done" />
                ) : active ? (
                  <Spinner />
                ) : (
                  <span className="mt-1.5 block h-2 w-2 rounded-full bg-slate-700" aria-hidden />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm font-medium ${
                    active ? "text-white" : done ? "text-slate-200" : "text-slate-500"
                  }`}
                >
                  {step.label}
                </p>
                <p className="text-xs text-slate-500">{step.detail}</p>
              </div>
              {active && index === 1 && percent !== null && (
                <span className="shrink-0 text-xs tabular-nums text-indigo-300">{percent}%</span>
              )}
            </li>
          );
        })}
      </ol>
      {earliestActive < 0 && (
        <p className="rounded-lg bg-slate-950/60 px-3 py-4 text-center text-sm text-slate-500">
          Finalizing the recording…
        </p>
      )}
    </div>
  );
}

function Spinner(): JSX.Element {
  return (
    <span
      className="mt-0.5 block h-4 w-4 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent"
      role="status"
      aria-label="working"
    />
  );
}

function deviceLabel(d: AudioDeviceInfo): string {
  const flags: string[] = [];
  if (d.isDefault) flags.push("default");
  if (d.channels > 0) flags.push(`${d.channels}ch`);
  if (d.sampleRate > 0) flags.push(`${(d.sampleRate / 1000).toFixed(1)}kHz`);
  return flags.length > 0 ? `${d.name} (${flags.join(", ")})` : d.name;
}

function db(value: number): string {
  return `${Math.round(20 * Math.log10(Math.max(value, 1e-9)))} dB`;
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function WhisperModelBadge({ status }: { status: WhisperEngineStatus | null }): JSX.Element {
  if (!status) {
    return (
      <span className="inline-flex items-center rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-medium text-sky-300">
        Checking…
      </span>
    );
  }
  if (status.state === "unavailable") {
    return (
      <span className="inline-flex items-center rounded-full bg-rose-500/15 px-2.5 py-0.5 text-xs font-medium text-rose-300">
        Engine unavailable
      </span>
    );
  }
  if (status.state === "busy") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300">
        Transcribing…
      </span>
    );
  }
  const defaultModel = status.models.find((m) => m.isDefault);
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
      {defaultModel ? `${defaultModel.name} ready` : "No model"}
    </span>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}