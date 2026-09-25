import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WHISPER_ERROR_CODES } from "@callnotes/shared";
import type { AudioCaptureKind, RecordingStreamInfo } from "@callnotes/shared";
import { PcmChunkWriter } from "../../src/main/audio/dsp/pcm-chunks";
import type { ITranscriber, TranscribeResult } from "../../src/main/whisper/engine";
import { WhisperService } from "../../src/main/whisper/whisper-service";
import type { WhisperServiceDeps, WhisperRecordingInput } from "../../src/main/whisper/whisper-service";

const native = vi.hoisted(() => ({
  available: true,
  addonPath: "/fake/callnotes-whisper-win32-x64.node",
  segment: (samples: Float32Array): { start: number; end: number; text: string; confidence: number } => ({
    start: 0,
    end: Math.round((samples.length / 16_000) * 1000),
    text: "lab test",
    confidence: 0.92,
  }),
}));

vi.mock("../../src/main/whisper/native-loader.js", () => ({
  whisperNativeAvailable: () => native.available,
  whisperAddonPath: () => native.addonPath,
  loadWhisperAddon: () => ({}),
  resolveWhisperAddonPath: () => native.addonPath,
  whisperAddonPathExists: () => true,
}));

class ScriptedTranscriber implements ITranscriber {
  systemInfo = "scripted 1.7.4";
  loadCalls = 0;
  transcribeCalls = 0;
  failTranscribe = false;

  async loadModel(): Promise<void> {
    this.loadCalls += 1;
  }

  async transcribe(samples: Float32Array, _options: { offsetMs: number }): Promise<TranscribeResult> {
    this.transcribeCalls += 1;
    if (this.failTranscribe) throw new Error("boom");
    return {
      text: "lab test",
      segments: [native.segment(samples)],
      elapsedMs: 10,
    };
  }

  async unload(): Promise<void> {}
}

/** Write `seconds` of canonical-rate samples to a temporary stream dir. */
function writeStream(
  rootDir: string,
  kind: AudioCaptureKind,
  seconds: number,
): RecordingStreamInfo {
  const writer = new PcmChunkWriter(16_000, join(rootDir, kind));
  const total = Math.max(1, Math.round(seconds * 16_000));
  const block = new Float32Array(4_800).fill(0.1);
  let written = 0;
  while (written < total) {
    writer.write(block);
    written += block.length;
  }
  writer.close();
  return { kind, dir: writer.dir, frameCount: writer.capturedFrames };
}

describe("WhisperService", () => {
  let dir: string;
  let modelsDir: string;
  let recDir: string;
  let sendStatus: ReturnType<typeof vi.fn>;
  let transcriber: ScriptedTranscriber;

  function makeDeps(): WhisperServiceDeps {
    return {
      modelsDir,
      statePath: join(dir, "state.json"),
      sendStatus,
      sendProgress: vi.fn(),
      createTranscriber: () => transcriber,
    };
  }

  function installModel(): void {
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, "ggml-tiny.bin"), new Uint8Array(16));
  }

  function recordingInput(seconds: number, overflow = 0): WhisperRecordingInput {
    const mic = writeStream(recDir, "microphone", seconds);
    const loopback = writeStream(recDir, "loopback", seconds + overflow);
    return { sampleRate: 16_000, streams: [mic, loopback], diarization: true, language: null };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cn-whisper-"));
    modelsDir = join(dir, "models");
    recDir = join(dir, "recording");
    mkdirSync(recDir, { recursive: true });
    sendStatus = vi.fn();
    transcriber = new ScriptedTranscriber();
    native.available = true;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports unavailable state when the native addon is missing", async () => {
    native.available = false;
    const service = new WhisperService(makeDeps());
    const status = service.status();
    expect(status.state).toBe("unavailable");
    expect(status.backend).toBe("whisper.cpp");
    expect(status.error?.code).toBe(WHISPER_ERROR_CODES.ENGINE_MISSING);
    expect(service.status().models).toHaveLength(4);
    await service.dispose();
  });

  it("rejects transcription when no model is installed", async () => {
    const service = new WhisperService(makeDeps());
    await expect(service.transcribeRecording(recordingInput(1))).rejects.toMatchObject({
      code: WHISPER_ERROR_CODES.MODEL_MISSING,
    });
    expect(transcriber.loadCalls).toBe(0);
    await service.dispose();
  });

  it("anchors windowed segments into the full timeline and labels speakers", async () => {
    installModel();
    native.segment = (_samples) => ({ start: 1000, end: 4000, text: "lab test", confidence: 0.9 });
    const service = new WhisperService(makeDeps());
    const onProgress = vi.fn();

    // ~31.6s spans two 30s windows (24000-sample overlap window).
    const input = recordingInput(31.6);
    const result = await service.transcribeRecording({ ...input, onProgress });

    // Two windows per stream; each window's segment is re-anchored by windowStartMs.
    expect(transcriber.transcribeCalls).toBe(4);
    const micStarts = result.segments.filter((s) => s.speaker === "Speaker 1").map((s) => s.startMs);
    expect(micStarts).toEqual([1000, 31000]);
    // Loopback rotates speakers when diarization is on.
    const loopbackSpeakers = result.segments.filter((s) => s.speaker !== "Speaker 1").map((s) => s.speaker);
    expect(loopbackSpeakers).toEqual(["Speaker 2", "Speaker 3"]);
    // Segments are merged chronologically across streams.
    const starts = result.segments.map((s) => s.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // Progress reaches 100%.
    expect(onProgress.mock.calls.at(-1)?.[0]).toBe(1);
    await service.dispose();
  });

  it("drops duplicate segments from the window overlap", async () => {
    installModel();
    native.segment = (samples) => ({
      start: 0,
      end: Math.round((samples.length / 16_000) * 1000),
      text: "hello",
      confidence: 0.9,
    });
    const service = new WhisperService(makeDeps());

    // Each 1.5s-overlapping window fully covers the previous window's tail, so
    // only the first window's segment per stream survives.
    const result = await service.transcribeRecording(recordingInput(31.6));
    expect(transcriber.transcribeCalls).toBe(4);
    const micSegments = result.segments.filter((s) => s.speaker === "Speaker 1");
    expect(micSegments).toHaveLength(1);
    expect(micSegments[0]?.startMs).toBe(0);
    await service.dispose();
  });

  it("labels all system audio as Speaker 2 when diarization is off", async () => {
    installModel();
    const service = new WhisperService(makeDeps());
    const input = recordingInput(1);
    const result = await service.transcribeRecording({ ...input, diarization: false });
    const nonMic = result.segments.filter((s) => s.speaker !== "Speaker 1");
    expect(nonMic.length).toBeGreaterThan(0);
    expect(nonMic.every((s) => s.speaker === "Speaker 2")).toBe(true);
    await service.dispose();
  });

  it("reports a failed window as a transcription failure and resets to ready", async () => {
    installModel();
    transcriber.failTranscribe = true;
    const service = new WhisperService(makeDeps());
    await expect(service.transcribeRecording(recordingInput(1))).rejects.toThrow("boom");
    expect(service.status().state).toBe("ready");
    await service.dispose();
  });

  it("reuses the loaded engine across transcription runs", async () => {
    installModel();
    const service = new WhisperService(makeDeps());
    await service.transcribeRecording(recordingInput(1));
    await service.transcribeRecording(recordingInput(1));
    expect(transcriber.loadCalls).toBe(1);
    await service.dispose();
  });

  it("testModel verifies the installed model and reports text", async () => {
    installModel();
    native.segment = () => ({ start: 0, end: 480, text: "lab test", confidence: 0.92 });
    const service = new WhisperService(makeDeps());
    const result = await service.testModel("tiny");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("lab test");
    expect(result.sampleDurationMs).toBeCloseTo(1200, 0);
    expect(service.status().models.find((m) => m.id === "tiny")?.verified).toBe(true);
    await service.dispose();
  });

  it("testModel reports a failed decode as corruption", async () => {
    installModel();
    transcriber.failTranscribe = true;
    const service = new WhisperService(makeDeps());
    const result = await service.testModel("tiny");
    expect(result.ok).toBe(false);
    expect(service.status().models.find((m) => m.id === "tiny")?.corrupt).toBe(true);
    await service.dispose();
  });
});