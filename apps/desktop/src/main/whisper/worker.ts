/**
 * whisper.cpp compute worker. Runs the blocking native addon calls on a
 * worker thread so the Electron main process never blocks on transcription.
 * One context (model) is created per load and reused across transcribes until
 * the worker is unloaded; the worker serializes requests naturally.
 */
import { createRequire } from "node:module";
import { isMainThread, parentPort } from "node:worker_threads";
import type { WhisperNativeAddon, WhisperNativeResult } from "./types.js";

export type WhisperWorkerRequest =
  | { req: "load"; id: number; addonPath: string; modelPath: string; threads: number }
  | { req: "transcribe"; id: number; samples: Float32Array; offsetMs: number; language: string | null }
  | { req: "unload"; id: number }
  | { req: "quit"; id: number };

export type WhisperWorkerResponse =
  | { req: "load"; id: number; ok: true; systemInfo: string }
  | { req: "load"; id: number; ok: false; error: string }
  | { req: "transcribe"; id: number; ok: true; result: WhisperNativeResult }
  | { req: "transcribe"; id: number; ok: false; error: string }
  | { req: "unload"; id: number; ok: true }
  | { req: "unload"; id: number; ok: false; error: string }
  | { req: "quit"; id: number; ok: true };

const require = createRequire(import.meta.url);

let addon: WhisperNativeAddon | null = null;
let context: number | null = null;

function run(): void {
  const port = parentPort;
  if (isMainThread || !port) return;

  port.on("message", (message: WhisperWorkerRequest) => {
    void handle(port, message).catch((error: unknown) => {
      port.postMessage({
        req: "load",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WhisperWorkerResponse);
    });
  });
}

async function handle(port: NonNullable<typeof parentPort>, message: WhisperWorkerRequest): Promise<void> {
  switch (message.req) {
    case "load": {
      try {
        if (!addon) {
          addon = require(message.addonPath) as WhisperNativeAddon;
        }
        context = addon.createContext(message.modelPath, message.threads);
        port.postMessage({
          req: "load",
          id: message.id,
          ok: true,
          systemInfo: addon.systemInfo(),
        } satisfies WhisperWorkerResponse);
      } catch (error) {
        addon = null;
        context = null;
        port.postMessage({
          req: "load",
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WhisperWorkerResponse);
      }
      return;
    }
    case "transcribe": {
      if (!addon || context === null) {
        port.postMessage({
          req: "transcribe",
          id: message.id,
          ok: false,
          error: "model not loaded",
        } satisfies WhisperWorkerResponse);
        return;
      }
      try {
        const result = addon.transcribe(context, message.samples, message.offsetMs, message.language);
        port.postMessage({
          req: "transcribe",
          id: message.id,
          ok: true,
          result,
        } satisfies WhisperWorkerResponse);
      } catch (error) {
        port.postMessage({
          req: "transcribe",
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WhisperWorkerResponse);
      }
      return;
    }
    case "unload": {
      try {
        if (context !== null && addon) addon.freeContext(context);
      } catch {
        // context best-effort release
      }
      context = null;
      addon = null;
      port.postMessage({ req: "unload", id: message.id, ok: true } satisfies WhisperWorkerResponse);
      return;
    }
    case "quit": {
      port.postMessage({ req: "quit", id: message.id, ok: true } satisfies WhisperWorkerResponse);
      return;
    }
  }
}

run();