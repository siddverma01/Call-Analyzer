import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { LLM_ERROR_CODES } from "@callnotes/shared";
import { LlmError } from "../../src/main/llm/runtime";
import { LlamacppRuntime } from "../../src/main/llm/llamacpp-runtime";

/**
 * llama.cpp's OpenAI-compatible server against a real loopback HTTP server.
 * Models are user-managed files, so pull/delete are unsupported - only
 * health, model listing, and JSON generation are exercised.
 */
let handle: (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseUrl: string;

async function start(): Promise<void> {
  server = createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function stop(): Promise<void> {
  return new Promise((resolve) => server?.close(() => resolve()));
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("LlamacppRuntime", () => {
  beforeEach(async () => {
    handle = (_req, res) => json(res, {});
    await start();
  });

  afterEach(async () => {
    await stop();
  });

  it("ping resolves when /health responds", async () => {
    handle = (_req, res) => json(res, { status: "ok" });
    await expect(new LlamacppRuntime(baseUrl, null).ping()).resolves.toBeUndefined();
  });

  it("listModels resolves the loaded model id or falls back to defaults", async () => {
    handle = (_req, res) =>
      json(res, { data: [{ id: "ggml-llama-3.2-3b.Q4_K_M.gguf", object: "model" }] });
    const listed = await new LlamacppRuntime(baseUrl, "fallback").listModels();
    expect(listed).toEqual([
      { id: "ggml-llama-3.2-3b.Q4_K_M.gguf", name: "ggml-llama-3.2-3b.Q4_K_M.gguf", sizeBytes: 0 },
    ]);

    handle = (_req, res) => json(res, { data: [] });
    const empty = await new LlamacppRuntime(baseUrl, "callnotes-local").listModels();
    expect(empty).toEqual([{ id: "callnotes-local", name: "callnotes-local", sizeBytes: 0 }]);
  });

  it("generateJson posts an OpenAI-compatible completion and returns the content", async () => {
    handle = (req, res) => {
      expect(req.url).toBe("/v1/chat/completions");
      expect(req.method).toBe("POST");
      let body = "";
      req.on("data", (chunk) => (body += String(chunk)));
      req.on("end", () => {
        const parsed = JSON.parse(body) as {
          model: string;
          messages: Array<{ role: string; content: string }>;
          response_format: { type: string };
          temperature: number;
          stream: boolean;
        };
        expect(parsed.model).toBe("ggml-llama.bin");
        expect(parsed.messages[0]).toEqual({ role: "system", content: "sys" });
        expect(parsed.messages[1]).toEqual({ role: "user", content: "user" });
        expect(parsed.response_format).toEqual({ type: "json_object" });
        expect(parsed.temperature).toBe(0.2);
        expect(parsed.stream).toBe(false);
        json(res, { choices: [{ message: { content: '{"summary":"ok"}' } }] });
      });
    };
    const text = await new LlamacppRuntime(baseUrl, null).generateJson({
      model: "ggml-llama.bin",
      system: "sys",
      user: "user",
    });
    expect(text).toBe('{"summary":"ok"}');
  });

  it("generateJson reports an empty completion as INVALID_OUTPUT", async () => {
    handle = (_req, res) => json(res, { choices: [{ message: { content: "" } }] });
    await expect(
      new LlamacppRuntime(baseUrl, null).generateJson({ model: "m", system: "s", user: "u" }),
    ).rejects.toMatchObject({ code: LLM_ERROR_CODES.INVALID_OUTPUT });
  });

  it("pull and delete are unsupported for file-based models", async () => {
    const runtime = new LlamacppRuntime(baseUrl, "m");
    await expect(runtime.pullModel("m", () => {})).rejects.toMatchObject({
      code: LLM_ERROR_CODES.RUNTIME_UNSUPPORTED,
    });
    await expect(runtime.deleteModel("m")).rejects.toMatchObject({
      code: LLM_ERROR_CODES.RUNTIME_UNSUPPORTED,
    });
  });
});