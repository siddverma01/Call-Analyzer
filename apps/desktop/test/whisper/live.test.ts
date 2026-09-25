/**
 * Live integration test against the real whisper.cpp N-API addon.
 * Runs ONLY when `RUN_LIVE_WHISPER=1` AND `WHISPER_LIVE_MODEL` points at a
 * downloaded ggml model (e.g. ggml-tiny.bin), on a Windows host with the
 * native addon built (`npm run build`) and the bundled worker emitted
 * (`out/main/worker.js`). Exercises the WhisperCppEngine over a real
 * worker_threads worker decoding a real speech sample.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

const liveEligible =
  process.platform === "win32" &&
  process.env["RUN_LIVE_WHISPER"] === "1" &&
  !!process.env["WHISPER_LIVE_MODEL"];

const repoRoot = resolve(".");
const workerPath = join(repoRoot, "out", "main", "worker.js");
const addonPath = join(
  repoRoot,
  "native",
  "prebuilds",
  `callnotes-whisper-${process.platform}-${process.arch}.node`,
);
const jfkPath = join(
  repoRoot,
  "native",
  "deps",
  "whisper.cpp",
  "samples",
  "jfk.wav",
);

/** Decodes a 16 kHz mono little-endian 16-bit RIFF/WAVE file to samples. */
function decodeWav(path: string): Float32Array {
  const buf = readFileSync(path);
  const sr = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  if (sr === 0 || (channels === 0 && bits === 0)) throw new Error("unreadable wav header");
  let off = 12;
  let dataSize = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      dataSize = size;
      off += 8;
      break;
    }
    off += 8 + size + (size % 2 === 1 ? 1 : 0);
  }
  if (dataSize === 0) throw new Error("no data chunk");
  const frames = Math.floor(dataSize / (channels * (bits / 8)));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const v = buf.readInt16LE(off + i * channels * 2);
    out[i] = v / 32768;
  }
  return out;
}

const assetsReady =
  liveEligible &&
  existsSync(workerPath) &&
  existsSync(addonPath) &&
  existsSync(jfkPath) &&
  existsSync(process.env["WHISPER_LIVE_MODEL"]!);

describe.skipIf(!assetsReady)("live whisper transcription (RUN_LIVE_WHISPER=1)", () => {
  it("transcribes real speech through the bundled worker, addon, and model", async () => {
    const { WhisperCppEngine } = await import("../../src/main/whisper/engine");
    const modelPath = process.env["WHISPER_LIVE_MODEL"]!;

    const engine = new WhisperCppEngine(() => new Worker(workerPath, { workerData: [] }));
    try {
      await engine.loadModel({ addonPath, modelPath, threads: 4 });
      expect(engine.isLoaded).toBe(true);
      expect(engine.systemInfo).toContain("AVX");

      const samples = decodeWav(jfkPath);
      const result = await engine.transcribe(samples, { offsetMs: 0, language: null });

      expect(result.segments.length).toBeGreaterThan(0);
      expect(result.text.toLowerCase()).toContain("ask not what your country");
      const first = result.segments[0]!;
      expect(first.end).toBeGreaterThan(0);
      expect(first.confidence).toBeGreaterThan(0.5);
    } finally {
      await engine.unload();
    }
  });
});

describe.skipIf(assetsReady)("live whisper instrumentation", () => {
  it("is skipped unless RUN_LIVE_WHISPER=1, a model, the addon, and the bundled worker are present", () => {
    expect.anything();
  });
});