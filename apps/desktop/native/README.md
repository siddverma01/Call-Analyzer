# @callnotes/wasapi-native

Real Windows audio capture as a Node-API (NAPI) addon, no cloud, no bots, no
browser extensions.

- **Microphone capture** — any WASAPI capture endpoint (USB, internal array,
  Bluetooth hands-free, Stereo Mix, ...) via `IMMDevice` / `IAudioClient`.
- **System audio (loopback)** — anything rendered to an output endpoint via
  `AUDCLNT_STREAMFLAGS_LOOPBACK` (works whether the output is speakers or a
  Bluetooth headset).

## Privacy guarantee

This addon **never writes audio to disk** and **never sends audio anywhere**.
Samples are delivered to the caller as JavaScript `Float32Array`s held in
memory only. See `docs/privacy.md` at the repo root.

## Build

Requires a Windows host and the [Zig](https://ziglang.org) toolchain
(`winget install zig.zig`). The addon is pure N-API (ABI-stable), so the same
`.node` binary loads in both Node.js and Electron.

```
npm run build:wasapi   # from the repo root (or: cd apps/desktop/native && node build.mjs)
```

Outputs:
- `prebuilds/callnotes-wasapi-<platform>-<arch>.node` (WASAPI audio capture)
- `prebuilds/callnotes-whisper-<platform>-<arch>.node` (whisper.cpp CPU inference)

(64-bit only; a DLL import library for `electron.exe` / `node.exe` is synthesized at build time
from the runtime executable via `zig dlltool`, and the N-API headers bundled
in `deps/` are used — the build is hermetic and offline).

## API

Called via `napi_define_properties` (see `src/wasapi_addon.c`). All methods
are synchronous and return JavaScript values; errors are thrown as
`Error` objects with a descriptive WASAPI HRESULT message.

### `enumerateDevices(dataFlow: 'input' | 'output') -> AudioDeviceInfo[]`

```ts
interface AudioDeviceInfo {
  id: string;            // WASAPI endpoint id (stable across sessions)
  name: string;          // friendly device name (PKEY_Device_FriendlyName)
  state: 'active' | 'disabled' | 'notpresent' | 'unplugged';
  isDefault: boolean;
  channels: number;      // 0 for non-active devices
  sampleRate: number;    // 0 for non-active devices
}
```

### `createSession(options) -> SessionInfo`

```ts
interface SessionOptions {
  kind: 'microphone' | 'loopback'; // loopback => system audio
  deviceId?: string;               // omit for the OS default endpoint
  bufferMs?: number;               // ring buffer depth, clamped to [20, 1000]
}

interface SessionInfo {
  id: number;
  sampleRate: number;  // native device rate (e.g. 48000 Hz)
  channels: number;    // native interleaved channels
  format: 'f32' | 'i16' | 'i24' | 'i32' | 'i8';
  bufferMs: number;
}
```

The device is opened and the stream configured immediately; a worker thread
owns ALL COM/WASAPI objects so the JS thread is never blocked by audio. If the
endpoint cannot be opened (e.g. `AUDCLNT_E_DEVICE_INVALIDATED`,
`AUDCLNT_E_SERVICE_NOT_RUNNING`) the call **throws**.

> Loopback on a render endpoint is intentionally *event driven*: while nothing
> is being rendered the event never fires, so `sessionPull` returns `null`
> (silence). As soon as audio flows, real interleaved samples are returned.
> Microphone sessions always pull buffered samples.

### `sessionStart(id) -> boolean`
Starts capture. Resolves immediately (starting is async in the worker).
Returns `true` if the session was already running/stopping.

### `sessionStop(id) -> boolean`
Stops capture. Already-buffered samples remain drainable via `sessionPull`.

### `sessionPull(id, maxFrames?) -> Float32Array | null`
Returns the next available interleaved audio as `Float32Array` (in-memory,
RawArrayBuffer copy). `maxFrames` truncates (0/omitted = up to the buffer
depth). Returns `null` when no new samples are available. Never blocks; never
over-allocates.

### `sessionRelease(id) -> boolean`
Stops the worker, frees the worker-thread state and removes the session from
the registry. Releases the session id.

### `sessionInfo(id) -> SessionInfo`
Live format/running state for a session.

## Testing

`node -e` scripts in `prebuilds` manual smoke; vitest integration lives in
`apps/desktop/test/audio/`.