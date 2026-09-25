import { describe, expect, it, vi } from "vitest";
import type { WhisperWorkerLike } from "../../src/main/whisper/engine";
import { WhisperCppEngine } from "../../src/main/whisper/engine";
import type { WhisperWorkerRequest, WhisperWorkerResponse } from "../../src/main/whisper/worker";

interface FakeAddon {
  systemInfo: () => string;
  createContext: (modelPath: string, threads: number) => number;
  transcribe: (
    ctx: number,
    samples: Float32Array,
    offsetMs: number,
    language: string | null,
  ) => { text: string; segments: { start: number; end: number; text: string; confidence: number }[]; elapsedMs: number };
  freeContext: (ctx: number) => boolean;
}

const state = vi.hoisted(() => ({
  modelPath: "none",
  context: 0,
  freeCount: 0,
  terminated: false,
  unrefCalled: false,
  messages: [] as WhisperWorkerRequest[],
  listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
}));

function makeAddon(): FakeAddon {
  return {
    systemInfo: () => "whisper fake 1.7.4",
    createContext: (_modelPath, _threads) => 1,
    transcribe: (ctx, samples, offsetMs) => {
      if (ctx !== 1 || samples.length === 0 || offsetMs < 0) throw new Error("bad transcribe args");
      return {
        text: "hello world",
        segments: [
          { start: 50, end: 400, text: "hello world", confidence: 0.95 },
          { start: 500, end: 900, text: "again", confidence: 0.9 },
        ],
        elapsedMs: 32,
      };
    },
    freeContext: () => true,
  };
}

function FakeWorkerFactory(): WhisperWorkerLike {
  state.modelPath = "none";
  state.context = 0;
  state.freeCount = 0;
  state.terminated = false;
  state.unrefCalled = false;
  state.messages = [];
  state.listeners.clear();
  const addon = makeAddon();

  return {
    on(event, listener) {
      const list = state.listeners.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      state.listeners.set(event, list);
    },
    once(event, listener) {
      const key = `once:${event}`;
      const list = state.listeners.get(key) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      state.listeners.set(key, list);
    },
    postMessage(message, _transferList) {
      state.messages.push(message);
      const respond = (response: WhisperWorkerResponse): void => {
        state.listeners.get("message")?.forEach((cb) => cb(response));
      };
      switch (message.req) {
        case "load": {
          state.context = addon.createContext(message.modelPath, message.threads);
          respond({ req: "load", id: message.id, ok: true, systemInfo: addon.systemInfo() });
          break;
        }
        case "transcribe": {
          if (state.context === 0) {
            respond({ req: "transcribe", id: message.id, ok: false, error: "model not loaded" });
            return;
          }
          try {
            const result = addon.transcribe(state.context, message.samples, message.offsetMs, message.language);
            respond({ req: "transcribe", id: message.id, ok: true, result });
          } catch (error) {
            respond({
              req: "transcribe",
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }
        case "unload": {
          addon.freeContext(state.context);
          state.freeCount += 1;
          state.context = 0;
          respond({ req: "unload", id: message.id, ok: true });
          break;
        }
        case "quit": {
          respond({ req: "quit", id: message.id, ok: true });
          break;
        }
      }
    },
    terminate() {
      state.terminated = true;
      state.listeners.get("once:exit")?.forEach((cb) => cb(0));
      return Promise.resolve(0);
    },
    unref() {
      state.unrefCalled = true;
    },
  };
}

describe("WhisperCppEngine", () => {
  it("loads a model (progress + system info) then transcribes with the worker protocol", async () => {
    const engine = new WhisperCppEngine(FakeWorkerFactory);
    const progress: number[] = [];
    await engine.loadModel({
      addonPath: "/fake/callnotes-whisper.node",
      modelPath: "/models/ggml-tiny.bin",
      threads: 4,
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toEqual([0.1, 0.6, 1]);
    expect(engine.systemInfo).toBe("whisper fake 1.7.4");
    expect(engine.isLoaded).toBe(true);
    expect(state.unrefCalled).toBe(true);
    expect(state.messages.some((m) => m.req === "load" && m.threads === 4)).toBe(true);

    const samples = new Float32Array([0.1, -0.2, 0.3]);
    const before = samples.slice();
    const result = await engine.transcribe(samples, { offsetMs: 1234, language: null });
    expect(result.text).toBe("hello world");
    expect(result.segments.map((s) => s.text)).toEqual(["hello world", "again"]);
    expect(result.segments[0]?.start).toBe(50);
    expect(result.segments[0]?.confidence).toBe(0.95);
    expect(samples).toEqual(before); // caller's buffer is never transferred

    await engine.unload();
    expect(state.terminated).toBe(true); // teardown is a worker terminate, not an addon free
  });

  it("rejects transcription before a model is loaded", async () => {
    const engine = new WhisperCppEngine(FakeWorkerFactory);
    await expect(engine.transcribe(new Float32Array(8), { offsetMs: 0, language: null })).rejects.toMatchObject({
      code: "whisper.model-missing",
    });
  });

  it("propagates a worker transcribe error", async () => {
    const engine = new WhisperCppEngine(FakeWorkerFactory);
    await engine.loadModel({
      addonPath: "/fake/callnotes-whisper.node",
      modelPath: "/models/ggml-tiny.bin",
      threads: 2,
    });
    // Force the worker to fail the next transcribe (as a real addon error does).
    state.context = 0;
    await expect(engine.transcribe(new Float32Array(8), { offsetMs: 0, language: null })).rejects.toMatchObject({
      code: "whisper.failed",
    });
  });

  it("rejects transcription when the worker exits unexpectedly", async () => {
    const engine = new WhisperCppEngine(FakeWorkerFactory);
    await engine.loadModel({
      addonPath: "/fake/callnotes-whisper.node",
      modelPath: "/models/ggml-tiny.bin",
      threads: 2,
    });
    state.listeners.get("once:exit")?.forEach((cb) => cb(0));
    await expect(engine.transcribe(new Float32Array(8), { offsetMs: 0, language: null })).rejects.toMatchObject({
      code: "whisper.model-missing",
    });
  });
});