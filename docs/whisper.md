# Whisper — local, offline transcription

CallNotes AI transcribes meeting audio **on-device** with a packaged
`whisper.cpp` build. There is no cloud transcription API, no audio upload, and
no model in the installer — models are downloaded on demand from Hugging Face
and verified by SHA-1.

## Source of truth

- Engine catalog + checksums: `apps/desktop/src/main/whisper/catalog.ts`
- Downloads / verification / state: `apps/desktop/src/main/whisper/model-manager.ts`
- Inference: `apps/desktop/src/main/whisper/engine.ts` + `worker.ts` (N-API addon)
- Hardware detection + recommendation: `apps/desktop/src/main/whisper/hardware.ts`
- Orchestration + IPC: `apps/desktop/src/main/whisper/whisper-service.ts`
- Addon build/loading: `apps/desktop/src/main/whisper/native-loader.ts`
- Shared contract: `packages/shared/src/transcription.ts`

## Model catalog

Official whisper.cpp multilingual GGML models (sizes and SHA-1 match
`ggml-org/whisper.cpp` models README; files are served from
`huggingface.co/ggerganov/whisper.cpp`):

| id | file | size on disk | peak RAM/VRAM | 
| --- | --- | --- | --- |
| `tiny` | `ggml-tiny.bin` | 75 MB | ~273 MB |
| `base` | `ggml-base.bin` | 142 MB | ~388 MB |
| `small` | `ggml-small.bin` | 466 MB | ~852 MB |
| `medium` | `ggml-medium.bin` | 1.5 GB | ~2.1 GB |

- Nothing is bundled into the installer; each model is a separate user action.
- Models live under Electron `userData/models` (e.g.
  `%APPDATA%\CallNotes AI\models`), never in the repo and never uploaded.

## Download, verification, and state

`WhisperModelManager` enforces these rules:

1. **Streamed SHA-1 + exact size check** while writing to a `<model>.part` file;
   the digest is computed incrementally — nothing is trusted mid-stream.
2. **Atomic rename** to the final name only after the full file passes
   `sizeBytes` and `sha1` checks. A mismatched/partial download is discarded.
3. **Disk-space pre-flight** (`statfs`) refuses to start when free space < 1.1×
   the model size.
4. **State file** (`userData/models/state.json`) records `defaultModelId`,
   `verified`, and `corrupt` flags; a model that fails to load is flagged corrupt
   and will not be re-selected automatically.
5. Downloads are **abortable**; cancellation deletes the partial file. A second
   download while one is active throws `ENGINE_BUSY`.
6. The current **default model cannot be deleted** (`MODEL_IN_USE`).

## Inference path

- Transcription runs **only after a meeting stops**. The temporary PCM chunks
  captured during the meeting are read back in **fixed 30-second windows** (with
  a short overlap that is de-duplicated), so memory stays bounded for long
  meetings. Each window is transcribed inside the **whisper worker thread**
  (`src/main/whisper/worker.ts`, built as `out/main/worker.js` so
  `new Worker(new URL("./worker.js", import.meta.url))` resolves in the packaged
  app), keeping the main and UI threads responsive.
- The meeting service drives this via `WhisperService.transcribeRecording(input)`
  (`src/main/whisper/whisper-service.ts`), which reads the per-stream chunk files
  (see `docs/audio-capture.md`), re-anchors the relative segment timestamps into
  the full timeline, merges microphone + system-audio streams chronologically, and
  labels speakers ("Speaker 1" for the microphone, rotating "Speaker 2..N" for
  system audio when diarization is on).
- Engine selection (CPU + optional NVIDIA VRAM via `nvidia-smi`) feeds
  `recommendModel()`: heavier machine → higher tier, weak cores → one tier down.
  The recommendation is shown in the UI and is **never auto-installed**.
- The engine is loaded lazily at stop time (a model must be installed before the
  meeting starts). `whisperTest` probes verify the engine with a short
  generated/silence buffer.

## Native addon

Two N-API addons are prebuilt for `win32-x64` and shipped in the installer
(`resources/app.asar.unpacked/native/prebuilds/`):

- `callnotes-whisper-win32-x64.node` — whisper.cpp inference
- `callnotes-wasapi-win32-x64.node` — WASAPI capture (see `docs/audio-capture.md`)

`native-loader.ts` resolves them through `require.resolve` so it works both in
source (dev) and packaged (asar.unpacked) layouts. `npmRebuild` is **off** in
the electron-builder config — addons are never recompiled at install time; the
prebuilt binaries ship as-is.

## Tests

- Unit: `apps/desktop/test/whisper/*.test.ts` (catalog integrity, sha1,
  model-manager, native-loader, whisper-service) — run with
  `npm run test -w @callnotes/desktop`; no model downloads required.
- Live engine test is gated behind `RUN_LIVE_WHISPER=1` and needs a downloaded
  model; it exercises real decoding through the addon.