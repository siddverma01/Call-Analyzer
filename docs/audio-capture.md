# Audio capture — Windows WASAPI pipeline

This document describes how CallNotes captures microphone and system audio on
Windows, how that audio is held temporarily on disk and then deleted, and how
to build and test the capture path.

## Source of truth

- Native addon: `apps/desktop/native/src/wasapi_addon.c`
- TS pipeline: `apps/desktop/src/main/audio/`
- Shared contract: `packages/shared/src/audio.ts` + IPC channels in `packages/shared/src/ipc.ts`

## Architecture

```
WASAPI (COM)            main process                       renderer
──────────              ───────────────                    ─────────
IMMDeviceEnumerator     WindowsAudioCapture (30ms pull)    NewMeetingPage
  ├─ microphone  ──►    ┌→ downmix → resample → 16 kHz     ├─ status badges
  └─ loopback    ──►    │  mono canonical frames           ├─ device select
    (real devices)      │→ PcmChunkWriter → temp .pcm      ├─ LevelMeter (dB)
    event-driven        │   chunks (disk, 60s each)        ├─ storage estimate
                        └→ meters (100ms) ──IPC──►         └─ mic Test button
                          temp audio only ever lives under
                          userData/recordings/<meetingId>
```

- WASAPI capture sessions run on the addon's own worker thread (COM apartment);
  the addon owns a fixed-size ring buffer of raw interleaved float PCM.
- `WindowsAudioCapture` drains it every 30 ms, downmixes to mono
  (`dsp/pcm.ts`), resamples to a canonical 16 kHz stream, and emits:
  - `onFrames` — canonical mono PCM (for the chunk writer)
  - `onLevels` — rms/peak/dB from `measureLevels` (UI meters)
- `AudioService` (main process) owns the streams, writes the canonical mono PCM to
  **temporary chunk files** while a meeting is active (`userData/recordings/<meetingId>/<kind>/NNNNNN.pcm`,
  one file per 60 s of audio, float32 little-endian, via `dsp/pcm-chunks.ts`), and
  additionally persists **only** the selected micro-device preference
  (`userData/settings.json`). Meters are pushed over `AUDIO_METERS` every 100 ms
  while monitoring.
- `EnergyVad` (`dsp/vad.ts`) gates the 3-second mic test ("heard a voice?") using
  a decaying noise floor and requires 2 consecutive qualifying windows so one-off
  clicks do not register as speech.

## Meeting capture lifecycle

- `AudioService.startMeeting(id, sources)` verifies free disk space first (a
  meeting must always fit at least 30 minutes of capture: `16 kHz × 4 B × #sources ×
  1800 s + 128 MiB` floor), writes a `manifest.json` per meeting, installs one
  chunk writer per enabled source as a frame consumer, and starts the streams.
  A failed preflight throws before capture begins and the app shows the
  "not enough free disk space" error.
- `estimateRecordingSpace(sources, maxDurationSeconds)` projects temporary disk
  usage for the New Meeting page (bytes/sec, a 4 h projection, free space, and a
  `sufficient` flag used to show an amber warning; headroom is 256 MiB).
- `pauseMeeting()`/`resumeMeeting()` stop writing audio to disk without tearing
  down the capture streams, so pause/resume is instant and the meters stay live.
- `finishMeeting()` flushes every writer, marks the manifest `recorded`, stops the
  streams, and returns the `RecordingResult` snapshot for transcription.
- If a chunk write fails mid-recording (e.g. the disk fills up), capture is
  stopped and whatever was written is preserved and finalized; the meeting is
  failed via the `onError` callback so the user can retry after freeing space.

## Temporary capture files, cleanup, and recovery

- While a meeting is recording, each enabled source is written as numbered
  `.pcm` chunk files under `recordingsDir/<meetingId>/<kind>` (see
  `apps/desktop/src/main/audio/dsp/pcm-chunks.ts`). Chunking keeps per-file size
  bounded during long meetings; each meeting also carries a `manifest.json`
  recording its sources, sample rate, and life-cycle state.
- On `MeetingService.stop()`, capture stops, chunk writers flush, and
  `WhisperService.transcribeRecording` reads each stream back in ~30 s windows
  (with overlap + de-dup), anchoring segment timestamps into the full timeline.
- Temporary files are deleted **only after a meeting has been processed
  successfully**. A failed transcription or a session interrupted by a crash /
  force-quit / quit with a recording active keeps the audio on disk so the user
  can `retry()` it or explicitly delete it (see below). On startup,
  `reconcileAbandoned()` marks interrupted meetings FAILED in the local DB while
  preserving their files, and `sweepUnmanaged()` removes only stray directories
  that carry no manifest — a real (manifested) recording is never auto-deleted.
- The Meetings page marks failed meetings that still have audio on disk with an
  "Audio on disk" badge and offers **Retry** (re-transcribe from the preserved
  files, deleting them only on success) and **Delete audio** (an explicit
  user-confirmed discard that keeps the meeting row). Pausing/wall-clock time is
  not subtracted from the meeting duration.
- Mic tests and monitoring without an active meeting never touch disk.

## Privacy invariants (see also `docs/privacy.md`)

- Captured audio exists only as temporary PCM chunks in
  `userData/recordings/<meetingId>` and is deleted automatically after a
  successful transcription. Failed/interrupted meetings keep them for retry until
  the user retries or explicitly discards them.
- Nothing is uploaded, synced, or persisted long-term — only the transcript text.
- `AudioService` durable persistence is limited to `selectedMicDeviceId` in
  `settings.json`; everything under `recordings/` is transient.

## States are real, never fabricated

- Mic **Connected** ⇒ ≥ 1 active input endpoint enumerated by WASAPI.
- System Audio **Available** ⇒ a real loopback probe (`createSession` +
  `sessionRelease` on the default render endpoint) succeeds.
- Loopback is event-driven: it yields silence (empty pulls) while nothing is
  being played on the machine and real samples the moment audio flows.

## Native addon

- Hermetic build with Zig (win32 x64, `-target x86_64-windows-gnu`), N-API v8,
  headers vendored at `apps/desktop/native/deps/node-headers/include/node/`.
- Import lib for `node.exe` is synthesized at build time by `build.mjs`
  (PE export parse + `zig dlltool`), cached under `.build-cache/`.
- Requires Zig ≥ 0.16 on PATH (or discoverable under the winget install dir).
  `npm run build:wasapi` (root) or `npm run build -w @callnotes/wasapi-native`.

### API

| function | behavior |
| --- | --- |
| `enumerateDevices(flow)` | input/output endpoints, format, state, `isDefault` (compared by endpoint id string) |
| `createSession({kind, deviceId, bufferMs})` | returns `{id, sampleRate, channels, format, bufferMs}`; bufferMs clamped to [20, 1000] |
| `sessionStart / sessionStop / sessionPull / sessionRelease` | lifecycle + ring drain |
| `sessionInfo(id)` | session metadata |

Errors are surfaced as N-API `Error`s with WASAPI hresult strings when available.

## Tests

- Unit: `apps/desktop/test/audio/{pcm,ring-buffer,vad,audio-capture,audio-service}.test.ts`
  (run with `npm run test -w @callnotes/desktop`; no hardware needed).
- Live integration (real devices): `apps/desktop/test/audio/live.test.ts`, gated on
  `RUN_LIVE_AUDIO=1` and win32. Exercises real enumeration, mic capture,
  loopback monitoring through `AudioService`, and a real 3 s mic test:

  ```powershell
  $env:RUN_LIVE_AUDIO = "1"; npm run build:wasapi; npx vitest run test/audio/live.test.ts -w @callnotes/desktop
  ```

  Requires an active microphone; system sounds will produce loopback levels.