import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WHISPER_ERROR_CODES } from "@callnotes/shared";
import { WhisperError } from "../../src/main/whisper/errors";
import type { WhisperModelInfo } from "@callnotes/shared";

// Craft a tiny catalog so download/verify logic runs without 75 MB fixtures.
// vi.hoisted keeps the payload reachable from the mock factory (hoisted above
// every top-level definition).
const fix = vi.hoisted(() => {
  const PAYLOAD = new Uint8Array(Array.from({ length: 16 }, (_, i) => i + 1));
  // SHA-1 of [1,2,...,16] (precomputed; imports are not available in vi.hoisted).
  const PAYLOAD_SHA1 = "2cc429832452134629f1f6d296ec8aefb4e4d8a9";
  return { PAYLOAD, PAYLOAD_SHA1 };
});
const { PAYLOAD } = fix;

vi.mock("../../src/main/whisper/catalog.js", () => {
  const p = fix;
  const make = (id: "tiny" | "base" | "small" | "medium") => ({
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    file: `ggml-${id}.bin`,
    sizeBytes: p.PAYLOAD.byteLength,
    sizeLabel: "16 B",
    memoryBytes: 100,
    sha1: p.PAYLOAD_SHA1,
    tier: id === "tiny" ? 0 : id === "base" ? 1 : id === "small" ? 2 : 3,
  });
  const ids = ["tiny", "base", "small", "medium"] as const;
  return {
    WHISPER_MODEL_CATALOG: ids.map(make),
    MODEL_BY_ID: Object.fromEntries(ids.map((id) => [id, make(id)])),
    modelUrl: () => "https://fake/ggml-tiny.bin",
  };
});

import { WhisperModelManager, installedModelFiles } from "../../src/main/whisper/model-manager";

function streamPayload(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(PAYLOAD.slice());
      controller.close();
    },
  });
}

function streamChunk(chunk: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

function fetchOk(streamFactory: () => ReadableStream<Uint8Array>) {
  return vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    body: streamFactory(),
  }));
}

function fetchAborting() {
  return vi.fn().mockImplementation(
    (_url: string, opts: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
}

describe("WhisperModelManager", () => {
  let dir: string;
  let modelsDir: string;
  let manager: WhisperModelManager;
  let fetchMock: ReturnType<typeof vi.fn>;
  const progress: { percent: number; downloadedBytes: number; totalBytes: number }[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cn-models-"));
    modelsDir = join(dir, "models");
    manager = new WhisperModelManager({ modelsDir, statePath: join(dir, "state.json") });
    manager.onDownloadProgress = (event) => {
      progress.push({ percent: event.percent, downloadedBytes: event.downloadedBytes, totalBytes: event.totalBytes });
    };
    fetchMock = fetchOk(streamPayload);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    progress.length = 0;
  });

  it("lists an empty catalog with no default", () => {
    const status = manager.status();
    expect(status.defaultModelId).toBeNull();
    expect(status.models).toHaveLength(4);
    expect(status.models.every((m) => !m.installed && !m.verified && !m.corrupt)).toBe(true);
    expect(status.models[0]?.recommended).toBe(true); // first entry is the fallback recommendation
  });

  it("downloads, verifies (SHA-1), and atomically renames a model", async () => {
    await manager.download("tiny");
    const tiny = manager.list().find((m) => m.id === "tiny");
    expect(tiny?.installed).toBe(true);
    expect(tiny?.verified).toBe(true);
    expect(tiny?.corrupt).toBe(false);
    expect(existsSync(join(modelsDir, "ggml-tiny.bin"))).toBe(true);
    expect(existsSync(join(modelsDir, "ggml-tiny.bin.part"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(progress.at(-1)?.percent).toBe(100);
    expect(progress.at(-1)?.downloadedBytes).toBe(PAYLOAD.byteLength);

    // An existing valid file short-circuits (fetch not called again).
    await manager.download("tiny");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a size-mismatched response and discards the partial file", async () => {
    vi.stubGlobal("fetch", fetchOk(() => streamChunk(new Uint8Array(3))));
    await expect(manager.download("tiny")).rejects.toMatchObject({
      code: WHISPER_ERROR_CODES.MODEL_VERIFY_FAILED,
    });
    expect(existsSync(join(modelsDir, "ggml-tiny.bin"))).toBe(false);
    expect(existsSync(join(modelsDir, "ggml-tiny.bin.part"))).toBe(false);
  });

  it("classifies an aborted download as cancelled", async () => {
    vi.stubGlobal("fetch", fetchAborting());
    const pending = manager.download("tiny");
    await manager.abortDownload();
    await expect(pending).rejects.toMatchObject({ code: WHISPER_ERROR_CODES.CANCELLED });
    expect(existsSync(join(modelsDir, "ggml-tiny.bin.part"))).toBe(false);
  });

  it("rejects a second download while one is in flight", async () => {
    vi.stubGlobal("fetch", fetchAborting());
    const pending = manager.download("tiny");
    await expect(manager.download("base")).rejects.toMatchObject({ code: WHISPER_ERROR_CODES.ENGINE_BUSY });
    await manager.abortDownload();
    await expect(pending).rejects.toMatchObject({ code: WHISPER_ERROR_CODES.CANCELLED });
  });

  it("setDefault requires the file on disk and persists across restarts", () => {
    expect(() => manager.setDefault("base")).toThrowError(WhisperError);
    writeFileSync(join(modelsDir, "ggml-base.bin"), PAYLOAD);
    manager.setDefault("base");
    expect(manager.defaultModelId).toBe("base");
    expect(manager.list().find((m) => m.id === "base")?.isDefault).toBe(true);

    const reloaded = new WhisperModelManager({ modelsDir, statePath: join(dir, "state.json") });
    expect(reloaded.defaultModelId).toBe("base");
  });

  it("blocks deleting the default model and deletes others", () => {
    writeFileSync(join(modelsDir, "ggml-base.bin"), PAYLOAD);
    writeFileSync(join(modelsDir, "ggml-tiny.bin"), PAYLOAD);
    manager.setDefault("base");
    expect(() => manager.deleteModel("base")).toThrowError(WhisperError);

    manager.deleteModel("tiny");
    expect(existsSync(join(modelsDir, "ggml-tiny.bin"))).toBe(false);
    expect(existsSync(join(modelsDir, "ggml-base.bin"))).toBe(true);
  });

  it("preferredModel honours default over heavier installed models and skips corrupt files", () => {
    writeFileSync(join(modelsDir, "ggml-tiny.bin"), PAYLOAD);
    manager.setDefault("tiny");
    expect(manager.preferredModel()).toBe("tiny");

    // Mark it corrupt -> falls back to heaviest non-corrupt installed (none).
    manager.reportVerification("tiny", false);
    expect(manager.preferredModel()).toBeNull();
    expect(manager.list().find((m) => m.id === "tiny")?.corrupt).toBe(true);
    expect(manager.list().find((m) => m.id === "tiny")?.verified).toBe(false);

    // Adding a valid small model lets us recover after un-corrupting tiny.
    writeFileSync(join(modelsDir, "ggml-small.bin"), PAYLOAD);
    expect(manager.preferredModel()).toBe("small");
    manager.reportVerification("tiny", true);
    expect(manager.preferredModel()).toBe("tiny"); // default returns
  });

  it("resolveVerifiedModel requires verified state and an existing file", () => {
    writeFileSync(join(modelsDir, "ggml-tiny.bin"), PAYLOAD);
    expect(manager.resolveVerifiedModel("tiny")).toBeNull(); // downloaded, never verified
    manager.reportVerification("tiny", true);
    expect(manager.resolveVerifiedModel("tiny")).toBe(join(modelsDir, "ggml-tiny.bin"));
  });

  it("installedModelFiles reports what is on disk", () => {
    expect(installedModelFiles(modelsDir)).toEqual([]);
    writeFileSync(join(modelsDir, "ggml-tiny.bin"), PAYLOAD);
    writeFileSync(join(modelsDir, "junk.txt"), new Uint8Array(4));
    expect(installedModelFiles(modelsDir)).toEqual(["ggml-tiny.bin"]);
    expect(readdirSync(modelsDir).sort()).toEqual(["ggml-tiny.bin", "junk.txt"].sort());
  });

  it("list reports downloading state via progress order", async () => {
    await manager.download("base");
    const models: WhisperModelInfo[] = manager.list();
    const base = models.find((m) => m.id === "base");
    expect(base?.sizeBytes).toBe(PAYLOAD.byteLength);
  });
});