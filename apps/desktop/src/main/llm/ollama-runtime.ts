import { fetchJson, LlmError, toGenerateTimeout, trimBaseUrl } from "./runtime.js";
import type { LlmRuntime, LlmRuntimeModel, PullProgress } from "./runtime.js";
import { LLM_ERROR_CODES } from "@callnotes/shared";

interface OllamaModel {
  name: string;
  size?: number;
  details?: { parameter_size?: string };
}

interface OllamaPullEntry {
  status?: string;
  completed?: number;
  total?: number;
}

interface OllamaGenerateResponse {
  response?: string;
}

/**
 * Ollama's REST API (default http://127.0.0.1:11434). Handles tags/version
 * (status + model list), pull (streaming progress), delete, and JSON-mode
 * generation. All request bodies are plain prompt text.
 */
export class OllamaRuntime implements LlmRuntime {
  readonly kind = "ollama" as const;

  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${trimBaseUrl(this.baseUrl)}${path}`;
  }

  async ping(): Promise<void> {
    await fetchJson<{ version?: string }>(this.url("/api/version"));
  }

  async listModels(): Promise<LlmRuntimeModel[]> {
    const data = await fetchJson<{ models?: OllamaModel[] }>(this.url("/api/tags"));
    return (data.models ?? []).map((model) => ({
      id: model.name,
      name: model.details?.parameter_size ? `${model.name} (${model.details.parameter_size})` : model.name,
      sizeBytes: model.size ?? 0,
    }));
  }

  async pullModel(modelId: string, onProgress: (p: PullProgress) => void): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.url("/api/pull"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId, stream: true }),
      });
    } catch {
      throw new LlmError(LLM_ERROR_CODES.DOWNLOAD_FAILED, `Could not reach the local AI runtime to download "${modelId}".`);
    }
    if (!response.ok || !response.body) {
      throw new LlmError(LLM_ERROR_CODES.DOWNLOAD_FAILED, `The local AI runtime could not start the download for "${modelId}".`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completedBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: OllamaPullEntry;
        try {
          entry = JSON.parse(trimmed) as OllamaPullEntry;
        } catch {
          continue;
        }
        if (typeof entry.completed === "number" && typeof entry.total === "number" && entry.total > 0) {
          completedBytes = entry.completed;
          const percent = Math.min(100, (entry.completed / entry.total) * 100);
          onProgress({ downloadedBytes: entry.completed, totalBytes: entry.total, percent });
        }
      }
    }
    onProgress({ downloadedBytes: completedBytes, totalBytes: null, percent: 100 });
  }

  async deleteModel(modelId: string): Promise<void> {
    await fetchJson<{ status?: string }>(this.url("/api/delete"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId }),
    });
  }

  async generateJson(input: { model: string; system: string; user: string }): Promise<string> {
    const data = await fetchJson<OllamaGenerateResponse>(
      this.url("/api/generate"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: input.model,
          system: input.system,
          prompt: input.user,
          format: "json",
          stream: false,
          options: { temperature: 0.2 },
        }),
      },
      toGenerateTimeout(),
    );
    const text = (data.response ?? "").trim();
    if (!text) throw new LlmError(LLM_ERROR_CODES.INVALID_OUTPUT, "The local model returned an empty response.");
    return text;
  }
}