import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  type HardwareInfo,
  type WhisperDownloadProgress,
  type WhisperEngineStatus,
} from "@callnotes/shared";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/inputs";
import { IconCheck, IconDownload, IconTrash, IconX } from "../ui/Icons";

/**
 * Local whisper.cpp model manager: lists the four official models, drives
 * downloads with live progress + SHA-1 verification, and lets the user pick
 * the default / delete non-default models. Everything is on-device.
 */
export function WhisperManager(): JSX.Element {
  const [status, setStatus] = useState<WhisperEngineStatus | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [progress, setProgress] = useState<WhisperDownloadProgress | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.callnotes
      .whisperStatus()
      .then(setStatus)
      .catch((reason: unknown) => setError(toMessage(reason)));
  }, []);

  useEffect(() => {
    refresh();
    void window.callnotes
      .whisperHardware()
      .then(setHardware)
      .catch(() => {});
    const unsubProgress = window.callnotes.onWhisperProgress((event) => {
      setProgress(event);
      if (event.percent >= 100) refresh();
    });
    const unsubStatus = window.callnotes.onWhisperStatus(() => refresh());
    return () => {
      unsubProgress();
      unsubStatus();
    };
  }, [refresh]);

  const run = async (action: () => Promise<WhisperEngineStatus>, id: string): Promise<void> => {
    setError(null);
    setBusyId(id);
    try {
      setStatus(await action());
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusyId(null);
    }
  };

  const engineAvailable = status?.state !== "unavailable";
  const anyDownloading = status?.models.some((m) => m.downloading) ?? false;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {status?.error && (
        <ErrorNote message={`${status.error.message} (${status.error.code})`} />
      )}

      {hardware && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-950/60 px-3 py-2 text-xs text-slate-500">
          <span>Recommended model: <span className="font-medium capitalize text-slate-300">{hardware.recommendedModelId}</span> for this device</span>
          <span className="text-slate-700">·</span>
          <span title={hardware.cpuModel}>{hardware.cores} threads CPU</span>
          <span className="text-slate-700">·</span>
          <span>{(hardware.ramBytes / 1024 / 1024 / 1024).toFixed(1)} GB RAM</span>
          {hardware.gpu && (
            <>
              <span className="text-slate-700">·</span>
              <span className="text-slate-400">{hardware.gpu.name}</span>
            </>
          )}
        </p>
      )}

      {!engineAvailable && (
        <ErrorNote message="The on-device whisper engine is not available on this machine. Builds that include the native addon are required for transcription." />
      )}

      <ul className="space-y-2">
        {(status?.models ?? []).map((model) => {
          const downloading = progress?.modelId === model.id && model.downloading;
          const percent = downloading ? progress?.percent ?? 0 : model.downloadedBytes > 0 ? 100 : 0;
          return (
            <li
              key={model.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium capitalize text-slate-200">{model.name}</p>
                  {model.isDefault && <ModelBadge>Default</ModelBadge>}
                  {model.recommended && !model.isDefault && <ModelBadge>Tuned for your PC</ModelBadge>}
                  {model.corrupt && <ModelBadge tone="rose">Corrupt</ModelBadge>}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {model.sizeLabel}{downloading && ` · downloading ${percent}%`}
                  {model.installed && !downloading && (model.verified ? " · verified" : " · file on disk")}
                </p>
                {downloading && (
                  <div className="mt-1.5 h-1 w-48 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-indigo-400 transition-[width] duration-150"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!model.installed && !model.downloading && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void run(() => window.callnotes.whisperDownload(model.id), model.id)}
                    disabled={!engineAvailable || anyDownloading}
                  >
                    <IconDownload className="text-sm" />
                    Download
                  </Button>
                )}
                {model.downloading && (
                  <Button variant="ghost" size="sm" onClick={() => void window.callnotes.whisperAbortDownload()}>
                    <IconX className="text-sm" />
                    Stop
                  </Button>
                )}
                {model.installed && !model.isDefault && !model.downloading && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busyId === model.id}
                    disabled={!engineAvailable}
                    onClick={() => void run(() => window.callnotes.whisperSetDefault(model.id), model.id)}
                  >
                    <IconCheck className="text-sm" />
                    Use
                  </Button>
                )}
                {model.installed && !model.isDefault && !model.downloading && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!engineAvailable}
                    onClick={() => void run(() => window.callnotes.whisperDelete(model.id), model.id)}
                    aria-label={`Delete ${model.name}`}
                  >
                    <IconTrash className="text-sm text-rose-400" />
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-slate-500">
        Models download once and are verified with SHA-1 before use. Whisper runs entirely on your machine — audio and
        transcripts never leave this computer.
      </p>
    </div>
  );
}

function ModelBadge({ tone = "indigo", children }: { tone?: "indigo" | "rose"; children: string }): JSX.Element {
  const styles =
    tone === "rose"
      ? "bg-rose-500/15 text-rose-300"
      : "bg-indigo-500/15 text-indigo-300";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${styles}`}>
      {children}
    </span>
  );
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}