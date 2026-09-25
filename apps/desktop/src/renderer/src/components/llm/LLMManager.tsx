import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { LlmDownloadProgress, LlmEngineStatus, LlmRuntimeKind } from "@callnotes/shared";
import { Button } from "../ui/Button";
import { ErrorNote, Field, Input, Select } from "../ui/inputs";
import { IconCheck, IconDownload, IconTrash } from "../ui/Icons";

/**
 * Local AI model manager (Settings → Local AI). Pick an on-device runtime
 * (Ollama or llama.cpp), point it at a local endpoint, and manage analysis
 * models. Downloads are always user-initiated - the app never pulls a model
 * without confirmation.
 */
export function LLMManager(): JSX.Element {
  const [status, setStatus] = useState<LlmEngineStatus | null>(null);
  const [runtime, setRuntime] = useState<LlmRuntimeKind>("ollama");
  const [ollamaUrl, setOllamaUrl] = useState("http://127.0.0.1:11434");
  const [llamacppUrl, setLlmacppUrl] = useState("http://127.0.0.1:8080");
  const [newModel, setNewModel] = useState("");
  const [progress, setProgress] = useState<LlmDownloadProgress | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = (next: LlmEngineStatus | null): void => {
    setStatus(next);
    if (next) {
      setRuntime(next.runtime);
      setOllamaUrl(next.ollamaUrl);
      setLlmacppUrl(next.llamacppUrl);
    }
  };

  const refresh = (): void => {
    window.callnotes
      .llmStatus()
      .then(applyStatus)
      .catch((reason: unknown) => setError(toMessage(reason)));
  };

  useEffect(() => {
    refresh();
    const unsubProgress = window.callnotes.onLlmProgress((event) => {
      setProgress(event);
      if (event.percent >= 100) refresh();
    });
    const unsubStatus = window.callnotes.onLlmStatus(applyStatus);
    return () => {
      unsubProgress();
      unsubStatus();
    };
  }, []);

  const run = async (action: () => Promise<LlmEngineStatus>, id: string): Promise<void> => {
    setError(null);
    setBusyId(id);
    try {
      applyStatus(await action());
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusyId(null);
    }
  };

  const connected = status?.state !== "unavailable";
  const downloading = progress !== null && progress.percent < 100;
  const isOllama = runtime === "ollama";
  const currentUrl = isOllama ? ollamaUrl : llamacppUrl;

  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1 capitalize">
          <span
            className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-rose-400"}`}
          />
          {runtime} · {connected ? "connected" : "not reachable"}
        </span>
        {status?.defaultModelId && (
          <>
            <span className="text-slate-700">·</span>
            <span>
              Default model: <span className="font-medium text-slate-300">{status.defaultModelId}</span>
            </span>
          </>
        )}
      </p>

      {error && <ErrorNote message={error} />}
      {status?.error && <ErrorNote message={`${status.error.message} (${status.error.code})`} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Runtime">
          <Select
            value={runtime}
            onChange={(e) => setRuntime(e.target.value as LlmRuntimeKind)}
            aria-label="Local AI runtime"
          >
            <option value="ollama">Ollama</option>
            <option value="llamacpp">llama.cpp server</option>
          </Select>
        </Field>
        <Field
          label="Endpoint URL"
          hint={isOllama ? "Default: http://127.0.0.1:11434" : "Default: http://127.0.0.1:8080"}
        >
          <Input
            value={currentUrl}
            onChange={(e) => (isOllama ? setOllamaUrl(e.target.value) : setLlmacppUrl(e.target.value))}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </Field>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          loading={busyId === "runtime"}
          onClick={() =>
            void run(
              () =>
                window.callnotes.llmSetRuntime({
                  runtime,
                  ollamaUrl,
                  llamacppUrl,
                }),
              "runtime",
            )
          }
        >
          <IconCheck className="text-sm" />
          Apply runtime
        </Button>
      </div>

      <div className="space-y-2">
        {(status?.models ?? []).map((model) => {
          const modelProgress = progress?.modelId === model.id ? progress : null;
          const percent = model.downloading && modelProgress ? modelProgress.percent : model.pulledPercent;
          return (
            <li
              key={model.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-slate-200">{model.name}</p>
                  {model.isDefault && <ModelBadge>Default</ModelBadge>}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {model.sizeLabel}
                  {model.downloading && ` · downloading ${Math.round(percent)}%`}
                </p>
                {model.downloading && (
                  <div className="mt-1.5 h-1 w-48 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-indigo-400 transition-[width] duration-150"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {model.installed && !model.isDefault && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busyId === model.id}
                    disabled={!connected}
                    onClick={() => void run(() => window.callnotes.llmSetDefault(model.id), model.id)}
                  >
                    <IconCheck className="text-sm" />
                    Use
                  </Button>
                )}
                {model.installed && !model.isDefault && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!connected || !isOllama}
                    onClick={() => void run(() => window.callnotes.llmDelete(model.id), model.id)}
                    aria-label={`Delete ${model.name}`}
                  >
                    <IconTrash className="text-sm text-rose-400" />
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </div>

      {isOllama && (
        <div className="flex items-end gap-2">
          <Field label="Download a model" hint='For example "llama3.2:3b". Ollama pulls it locally.'>
            <Input
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              placeholder="llama3.2:3b"
              spellCheck={false}
            />
          </Field>
          <Button
            loading={busyId === "pull"}
            disabled={!connected || newModel.trim().length === 0 || downloading}
            onClick={() =>
              void run(() => window.callnotes.llmPull(newModel.trim()), "pull").then(() => setNewModel(""))
            }
          >
            <IconDownload className="text-sm" />
            Download
          </Button>
        </div>
      )}

      <p className="text-xs text-slate-500">
        Analysis runs on a local AI runtime on this machine. Only transcript text is sent to it — raw audio never leaves
        the device, and transcripts are never uploaded to a cloud AI provider. Models are only downloaded when you click
        Download.
      </p>
    </div>
  );
}

function ModelBadge({ children }: { children: string }): JSX.Element {
  return (
    <span className="inline-flex items-center rounded-full bg-indigo-500/15 px-2 py-0.5 text-[10px] font-medium text-indigo-300">
      {children}
    </span>
  );
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}