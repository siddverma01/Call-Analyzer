import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { LLM_ERROR_CODES } from "@callnotes/shared";
import { LlmError } from "../../src/main/llm/runtime";
import type { PullProgress } from "../../src/main/llm/runtime";
import { OllamaRuntime } from "../../src/main/llm/ollama-runtime";

/**
 * Ollama REST API against a real loopback HTTP server. Confirms the runtime
 * maps version/tags/pull/delete/generate to Ollama's wire format and surfaces
 * failures as LlmError with stable codes.
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => resolve(body));
  });
}

describe("OllamaRuntime", () => {
  beforeEach(async () => {
    handle = (_req, res) => json(res, {});
    await start();
  });

  afterEach(async () => {
    await stop();
  });

  it("ping resolves when /api/version responds", async () => {
    handle = (_req, res) => json(res, { version: "0.5.0" });
    await expect(new OllamaRuntime(baseUrl).ping()).resolves.toBeUndefined();
  });

  it("listModels maps tags to runtime models", async () => {
    handle = (_req, res) =>
      json(res, {
        models: [
          { name: "llama3.2:3b", size: 2_000_000_000, details: { parameter_size: "3B" } },
          { name: "qwen2.5:7b", size: 4_500_000_000, details: {} },
        ],
      });
    const models = await new OllamaRuntime(baseUrl).listModels();
    expect(models).toEqual([
      { id: "llama3.2:3b", name: "llama3.2:3b (3B)", sizeBytes: 2_000_000_000 },
      { id: "qwen2.5:7b", name: "qwen2.5:7b", sizeBytes: 4_500_000_000 },
    ]);
  });

  it("pullModel streams progress and finishes at 100%", async () => {
    handle = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
      res.write(JSON.stringify({ status: "downloading", completed: 25_000_000, total: 100_000_000 }) + "\n");
      res.write(JSON.stringify({ status: "downloading", completed: 80_000_000, total: 100_000_000 }) + "\n");
      res.end();
    };
    const progress: PullProgress[] = [];
    await new OllamaRuntime(baseUrl).pullModel("llama3.2:3b", (p) => progress.push(p));
    const percents = progress.map((p) => p.percent);
    expect(percents).toEqual([25, 80, 100]);
    expect(progress[progress.length - 1]?.totalBytes).toBeNull();
    expect(progress[progress.length - 1]?.downloadedBytes).toBe(80_000_000);
  });

  it("generateJson posts a JSON-mode request and returns the raw response text", async () => {
    handle = async (req, res) => {
      expect(req.url).toBe("/api/generate");
      expect(req.method).toBe("POST");
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      expect(body.model).toBe("llama3.2:3b");
      expect(body.format).toBe("json");
      expect(body.stream).toBe(false);
      expect(body.options).toEqual({ temperature: 0.2 });
      expect(typeof body.prompt).toBe("string");
      json(res, { response: '{"summary":"ok"}' });
    };
    const text = await new OllamaRuntime(baseUrl).generateJson({
      model: "llama3.2:3b",
      system: "sys",
      user: "user",
    });
    expect(text).toBe('{"summary":"ok"}');
  });

  it("generateJson reports an empty response as INVALID_OUTPUT", async () => {
    handle = (_req, res) => json(res, { response: "  " });
    await expect(
      new OllamaRuntime(baseUrl).generateJson({ model: "m", system: "s", user: "u" }),
    ).rejects.toMatchObject({ code: LLM_ERROR_CODES.INVALID_OUTPUT });
  });

  it("deleteModel sends a DELETE with the model body", async () => {
    handle = async (req, res) => {
      expect(req.method).toBe("DELETE");
      expect(req.url).toBe("/api/delete");
      expect(JSON.parse(await readBody(req))).toEqual({ model: "llama3.2:3b" });
      json(res, { status: "success" });
    };
    await expect(new OllamaRuntime(baseUrl).deleteModel("llama3.2:3b")).resolves.toBeUndefined();
  });

  it("surfaces a non-OK response as an LlmError with the runtime's status code", async () => {
    handle = (_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown endpoint" }));
    };
    const error = await new OllamaRuntime(baseUrl).ping().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe(LLM_ERROR_CODES.NOT_FOUND);
    expect((error as LlmError).status).toBe(404);
  });
});

describe("OllamaRuntime - unreachable endpoint", () => {
  it("report RUNTIME_UNREACHABLE when nothing is listening", async () => {
    const error = await new OllamaRuntime("http://127.0.0.1:1").ping().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe(LLM_ERROR_CODES.RUNTIME_UNREACHABLE);
  });
});