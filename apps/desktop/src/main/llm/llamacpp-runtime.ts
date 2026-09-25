import { fetchJson, LlmError, toGenerateTimeout, trimBaseUrl } from "./runtime.js";
import type { LlmRuntime, LlmRuntimeModel, PullProgress } from "./runtime.js";
import { LLM_ERROR_CODES } from "@callnotes/shared";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface ModelsResponse {
  data?: Array<{ id?: string; name?: string }>;
}

/**
 * llama.cpp's OpenAI-compatible server (llama-server, default
 * http://127.0.0.1:8080). Models are files the user manages themselves, so
 * download/delete are unsupported here; the runtime only generates JSON.
 */
export class LlamacppRuntime implements LlmRuntime {
  readonly kind = "llamacpp" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly defaultModel: string | null,
  ) {}

  private url(path: string): string {
    return `${trimBaseUrl(this.baseUrl)}${path}`;
  }

  async ping(): Promise<void> {
    await fetchJson<{ status?: string }>(this.url("/health"));
  }

  async listModels(): Promise<LlmRuntimeModel[]> {
    const data = await fetchJson<ModelsResponse>(this.url("/v1/models"));
    const listed = data.data ?? [];
    const id = listed[0]?.id ?? listed[0]?.name ?? this.defaultModel ?? "callnotes-local";
    return [{ id, name: id, sizeBytes: 0 }];
  }

  async pullModel(_modelId: string, _onProgress: (p: PullProgress) => void): Promise<void> {
    throw new LlmError(
      LLM_ERROR_CODES.RUNTIME_UNSUPPORTED,
      "llama.cpp models are managed as files on disk. Add a model file to the server and rescan instead of downloading.",
    );
  }

  async deleteModel(_modelId: string): Promise<void> {
    throw new LlmError(
      LLM_ERROR_CODES.RUNTIME_UNSUPPORTED,
      "llama.cpp models are files on disk; delete them outside the app.",
    );
  }

  async generateJson(input: { model: string; system: string; user: string }): Promise<string> {
    const data = await fetchJson<ChatCompletionResponse>(
      this.url("/v1/chat/completions"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: input.model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
          stream: false,
        }),
      },
      toGenerateTimeout(),
    );
    const text = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new LlmError(LLM_ERROR_CODES.INVALID_OUTPUT, "The local model returned an empty response.");
    return text;
  }
}