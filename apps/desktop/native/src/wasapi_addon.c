/*
 * CallNotes AI - native Windows WASAPI capture addon.
 *
 * A Node-API only (ABI-stable) addon that performs real Windows audio capture:
 *
 *   - Microphone capture via WASAPI shared-mode, event-driven capture on an
 *     input endpoint.
 *   - System audio capture via WASAPI loopback capture on a render endpoint.
 *
 * Privacy invariants enforced here:
 *   - Captured audio lives ONLY in an in-memory ring buffer, capped at
 *     `bufferMs` of audio. Overflow drops the OLDEST audio (never writes to
 *     disk, never uploads).
 *   - `sessionRelease` frees every byte of captured audio.
 *
 * Each capture session owns one dedicated worker thread. All WASAPI/COM work
 * (device activation, Initialize, Start, GetBuffer/ReleaseBuffer, Stop) happens
 * on that thread, which keeps COM apartment rules satisfied and never blocks
 * the JavaScript event loop on audio I/O.
 *
 * GUID constants are defined locally so the build does not require the
 * Microsoft Windows SDK import libraries.
 */

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601 /* Windows 7+ */
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <node_api.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <propkeydef.h>
#include <propidl.h>

/* ------------------------------------------------------------------------- *
 * Locally defined GUIDs (avoids needing the Windows SDK uuid/ole32 GUIDs)
 * ------------------------------------------------------------------------- */

static const GUID G_CLSID_MMDEVICE_ENUMERATOR = {0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}};
static const GUID G_IID_IMMDEVICE_ENUMERATOR = {0xA95664D2, 0x9614, 0x4F35, {0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}};
static const GUID G_IID_IAUDIO_CLIENT = {0x1CB9AD4C, 0xDBFA, 0x4C32, {0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}};
static const GUID G_IID_IAUDIO_CAPTURE_CLIENT = {0xC8ADBD64, 0xE71E, 0x48A0, {0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}};
static const GUID G_SUBTYPE_PCM = {0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};
static const GUID G_SUBTYPE_IEEE_FLOAT = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};

/* PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, pid 14 */
static const PROPERTYKEY G_PKEY_FRIENDLY_NAME = {
    {0xA45C254E, 0xDF1C, 0x4EFD, {0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0}}, 14};

/* DEVICE_STATE_* flags (not all are defined by the bundled headers) */
#define G_DEVICE_STATE_ACTIVE 0x00000001
#define G_DEVICE_STATE_DISABLED 0x00000002
#define G_DEVICE_STATE_NOTPRESENT 0x00000004
#define G_DEVICE_STATE_UNPLUGGED 0x00000008
#define G_DEVICE_STATE_ALL 0x0000000F

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

static const char *hr_text(HRESULT hr) {
  switch (hr) {
    case AUDCLNT_E_DEVICE_INVALIDATED:
      return "device was removed or disabled during capture (AUDCLNT_E_DEVICE_INVALIDATED)";
    case AUDCLNT_E_NOT_INITIALIZED:
      return "audio client not initialized (AUDCLNT_E_NOT_INITIALIZED)";
    case AUDCLNT_E_ALREADY_INITIALIZED:
      return "audio client already initialized (AUDCLNT_E_ALREADY_INITIALIZED)";
    case AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED:
      return "buffer size not aligned (AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED)";
    case AUDCLNT_E_UNSUPPORTED_FORMAT:
      return "unsupported audio format (AUDCLNT_E_UNSUPPORTED_FORMAT)";
    case AUDCLNT_E_ENDPOINT_CREATE_FAILED:
      return "endpoint create failed (AUDCLNT_E_ENDPOINT_CREATE_FAILED)";
    case AUDCLNT_E_SERVICE_NOT_RUNNING:
      return "Windows Audio service is not running (AUDCLNT_E_SERVICE_NOT_RUNNING)";
    case E_NOINTERFACE:
      return "required COM interface is unavailable (E_NOINTERFACE)";
    case CO_E_NOTINITIALIZED:
      return "COM not initialized (CO_E_NOTINITIALIZED)";
    case REGDB_E_CLASSNOTREG:
      return "MMDevice enumerator is not registered (REGDB_E_CLASSNOTREG)";
    case 0x80070005L:
      return "E_ACCESSDENIED";
    case E_OUTOFMEMORY:
      return "E_OUTOFMEMORY";
    case E_INVALIDARG:
      return "E_INVALIDARG";
    default:
      return NULL;
  }
}

static void throw_code(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
}

/* ------------------------------------------------------------------------- *
 * COM enter / exit for short read-only JS-thread work. The MMDevice API
 * interfaces used here (enumerator, device, collection, property store) are
 * free-threaded per the Windows Core Audio documentation. Heavy sessions do
 * all COM work on their own worker thread instead.
 * ------------------------------------------------------------------------- */

static HRESULT com_enter(int *init_here) {
  HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (hr == S_FALSE || hr == RPC_E_CHANGED_MODE) {
    *init_here = 0;
    return S_OK;
  }
  *init_here = 1;
  return hr;
}

static void com_exit(int init_here) {
  if (init_here) CoUninitialize();
}

/* ------------------------------------------------------------------------- *
 * Ring buffer of interleaved float32 PCM frames
 * ------------------------------------------------------------------------- */

typedef struct ring_t {
  float *data;
  size_t capacity_frames;
  size_t channels;
  size_t head;   /* frame index of oldest sample */
  size_t tail;   /* frame index one past the newest sample; == head when empty */
  size_t dropped_frames;
  int overflowed;
} ring_t;

static void ring_init(ring_t *r, size_t capacity_frames, size_t channels) {
  r->data = (capacity_frames > 0 && channels > 0) ? malloc(capacity_frames * channels * sizeof(float)) : NULL;
  r->capacity_frames = capacity_frames;
  r->channels = channels;
  r->head = 0;
  r->tail = 0;
  r->dropped_frames = 0;
  r->overflowed = 0;
}

static void ring_destroy(ring_t *r) {
  free(r->data);
  r->data = NULL;
  r->capacity_frames = 0;
  r->head = 0;
  r->tail = 0;
}

static size_t ring_frames(const ring_t *r) {
  return r->tail - r->head;
}

static void ring_drop(ring_t *r, size_t n) {
  size_t have = ring_frames(r);
  if (n >= have) {
    r->dropped_frames += have;
    r->head = r->tail;
    return;
  }
  r->head += n;
  r->dropped_frames += n;
}

static void ring_write(ring_t *r, const float *src, size_t frames) {
  if (r->capacity_frames == 0) return;
  size_t free_frames = r->capacity_frames - ring_frames(r);
  if (frames > free_frames) {
    ring_drop(r, frames - free_frames);
    r->overflowed = 1;
  }
  size_t total = frames * r->channels;
  size_t start = (r->tail % r->capacity_frames) * r->channels;
  size_t first = total;
  if (start + total > r->capacity_frames * r->channels) {
    first = r->capacity_frames * r->channels - start;
  }
  memcpy(r->data + start, src, first * sizeof(float));
  if (first < total) memcpy(r->data, src + first, (total - first) * sizeof(float));
  r->tail += frames;
}

static void ring_write_silence(ring_t *r, size_t frames) {
  if (r->capacity_frames == 0) return;
  size_t free_frames = r->capacity_frames - ring_frames(r);
  if (frames > free_frames) {
    ring_drop(r, frames - free_frames);
    r->overflowed = 1;
  }
  size_t total = frames * r->channels;
  size_t start = (r->tail % r->capacity_frames) * r->channels;
  size_t first = total;
  if (start + total > r->capacity_frames * r->channels) {
    first = r->capacity_frames * r->channels - start;
  }
  memset(r->data + start, 0, first * sizeof(float));
  if (first < total) memset(r->data, 0, (total - first) * sizeof(float));
  r->tail += frames;
}

static size_t ring_read(ring_t *r, float *dst, size_t frames) {
  size_t have = ring_frames(r);
  if (have == 0 || frames == 0) return 0;
  if (frames > have) frames = have;
  size_t total = frames * r->channels;
  size_t start = (r->head % r->capacity_frames) * r->channels;
  size_t first = total;
  if (start + total > r->capacity_frames * r->channels) {
    first = r->capacity_frames * r->channels - start;
  }
  memcpy(dst, r->data + start, first * sizeof(float));
  if (first < total) memcpy(dst + first, r->data, (total - first) * sizeof(float));
  r->head += frames;
  return frames;
}

/* ------------------------------------------------------------------------- *
 * Format identification
 * ------------------------------------------------------------------------- */

typedef enum fmt_id_t { FMT_NONE = 0, FMT_F32, FMT_I16, FMT_I24, FMT_I32, FMT_I8 } fmt_id_t;

typedef struct audio_format_t {
  uint32_t sample_rate;
  uint16_t channels;
  fmt_id_t format;
  uint16_t bytes_per_sample; /* container bytes per single sample */
} audio_format_t;

static fmt_id_t format_from_wave(const WAVEFORMATEX *wf) {
  uint16_t bits = wf->wBitsPerSample;
  if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    const WAVEFORMATEXTENSIBLE *ext = (const WAVEFORMATEXTENSIBLE *)wf;
    if (IsEqualGUID(&ext->SubFormat, &G_SUBTYPE_IEEE_FLOAT)) return FMT_F32;
    if (IsEqualGUID(&ext->SubFormat, &G_SUBTYPE_PCM)) {
      if (bits == 16) return FMT_I16;
      if (bits == 24) return FMT_I24;
      if (bits == 32) return FMT_I32;
      if (bits == 8) return FMT_I8;
    }
    return FMT_NONE;
  }
  if (wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT && bits == 32) return FMT_F32;
  if (wf->wFormatTag == WAVE_FORMAT_PCM && bits == 16) return FMT_I16;
  if (wf->wFormatTag == WAVE_FORMAT_PCM && bits == 24) return FMT_I24;
  if (wf->wFormatTag == WAVE_FORMAT_PCM && bits == 32) return FMT_I32;
  if (wf->wFormatTag == WAVE_FORMAT_PCM && bits == 8) return FMT_I8;
  return FMT_NONE;
}

static const char *fmt_name(fmt_id_t f) {
  switch (f) {
    case FMT_F32: return "f32";
    case FMT_I16: return "i16";
    case FMT_I24: return "i24";
    case FMT_I32: return "i32";
    case FMT_I8: return "i8";
    default: return "unknown";
  }
}

static float sample_to_float(fmt_id_t fmt, const BYTE *p, uint16_t bytes_per_sample) {
  switch (fmt) {
    case FMT_F32: {
      float v;
      memcpy(&v, p, sizeof(float));
      return v;
    }
    case FMT_I16: {
      int16_t v;
      memcpy(&v, p, sizeof(int16_t));
      return (float)v * (1.0f / 32768.0f);
    }
    case FMT_I32: {
      int32_t v;
      memcpy(&v, p, sizeof(int32_t));
      return (float)v * (1.0f / 2147483648.0f);
    }
    case FMT_I24: {
      int32_t v = 0;
      if (bytes_per_sample >= 4) {
        memcpy(&v, p, 4);
        v >>= 8; /* 24 valid bits are carried left-justified in a 32-bit container */
      } else {
        v = (int32_t)(p[0]) | ((int32_t)(p[1]) << 8) | ((int32_t)((int8_t)p[2]) << 16);
      }
      return (float)v * (1.0f / 8388608.0f);
    }
    case FMT_I8:
      return ((float)(int32_t)*p - 128.0f) / 128.0f;
    default:
      return 0.0f;
  }
}

/* ------------------------------------------------------------------------- *
 * Capture sessions
 * ------------------------------------------------------------------------- */

typedef struct session_t session_t;

struct session_t {
  uint32_t id;
  int loopback;

  CRITICAL_SECTION ctrl_cs;  /* protects control flags */
  int start_requested;
  int stop_requested;
  int started;
  int release_requested;

  CRITICAL_SECTION ring_cs;  /* protects ring buffer */
  ring_t ring;

  /* results set by worker before setup_event */
  audio_format_t fmt;
  uint32_t buffer_ms;
  HRESULT setup_hr;
  HRESULT start_hr;
  HRESULT fatal_hr;
  ULONGLONG total_frames;
  ULONGLONG silent_frames;

  char device_id[512];

  /* worker plumbing */
  HANDLE thread;
  HANDLE setup_event;   /* auto-reset: signaled once setup finishes */
  HANDLE exit_event;    /* manual-reset: signaled when worker fully exits */

  /* COM objects owned by the worker thread */
  IMMDevice *device;
  IAudioClient *client;
  IAudioCaptureClient *capture;
  HANDLE wasapi_event;

  session_t *next;
};

static CRITICAL_SECTION g_registry_cs;
static session_t *g_sessions = NULL;
static int g_registry_ready = 0;

static uint32_t g_next_id = 1;

static void registry_init(void) {
  if (g_registry_ready) return;
  InitializeCriticalSection(&g_registry_cs);
  g_registry_ready = 1;
}

static session_t *registry_find(uint32_t id) {
  session_t *it = g_sessions;
  while (it) {
    if (it->id == id) return it;
    it = it->next;
  }
  return NULL;
}

static void registry_add(session_t *s) {
  EnterCriticalSection(&g_registry_cs);
  s->next = g_sessions;
  g_sessions = s;
  LeaveCriticalSection(&g_registry_cs);
}

static void registry_remove(uint32_t id) {
  EnterCriticalSection(&g_registry_cs);
  session_t **pp = &g_sessions;
  while (*pp) {
    if ((*pp)->id == id) {
      *pp = (*pp)->next;
      break;
    }
    pp = &(*pp)->next;
  }
  LeaveCriticalSection(&g_registry_cs);
}

/* ------------------------------------------------------------------------- *
 * Session setup (runs on the worker thread, COM initialized)
 * ------------------------------------------------------------------------- */

static HRESULT open_device(session_t *s) {
  IMMDeviceEnumerator *en = NULL;
  IMMDevice *dev = NULL;
  HRESULT hr = CoCreateInstance(&G_CLSID_MMDEVICE_ENUMERATOR, NULL, CLSCTX_ALL, &G_IID_IMMDEVICE_ENUMERATOR,
                                (void **)&en);
  if (FAILED(hr)) return hr;

  if (s->device_id[0]) {
    int wlen = MultiByteToWideChar(CP_UTF8, 0, s->device_id, -1, NULL, 0);
    if (wlen <= 0) {
      en->lpVtbl->Release(en);
      return E_INVALIDARG;
    }
    WCHAR *wid = malloc((size_t)wlen * sizeof(WCHAR));
    if (!wid) {
      en->lpVtbl->Release(en);
      return E_OUTOFMEMORY;
    }
    MultiByteToWideChar(CP_UTF8, 0, s->device_id, -1, wid, wlen);
    hr = en->lpVtbl->GetDevice(en, wid, &dev);
    free(wid);
  } else {
    EDataFlow flow = s->loopback ? eRender : eCapture;
    hr = en->lpVtbl->GetDefaultAudioEndpoint(en, flow, eConsole, &dev);
  }
  en->lpVtbl->Release(en);
  if (FAILED(hr)) return hr;

  IAudioClient *client = NULL;
  hr = dev->lpVtbl->Activate(dev, &G_IID_IAUDIO_CLIENT, CLSCTX_ALL, NULL, (void **)&client);
  if (FAILED(hr)) {
    dev->lpVtbl->Release(dev);
    return hr;
  }

  WAVEFORMATEX *mix = NULL;
  hr = client->lpVtbl->GetMixFormat(client, &mix);
  if (FAILED(hr)) {
    client->lpVtbl->Release(client);
    dev->lpVtbl->Release(dev);
    return hr;
  }

  audio_format_t fmt;
  fmt.sample_rate = mix->nSamplesPerSec;
  fmt.channels = mix->nChannels;
  fmt.format = format_from_wave(mix);
  fmt.bytes_per_sample = mix->wBitsPerSample / 8;
  if (fmt.format == FMT_NONE || fmt.bytes_per_sample == 0) {
    CoTaskMemFree(mix);
    client->lpVtbl->Release(client);
    dev->lpVtbl->Release(dev);
    return AUDCLNT_E_UNSUPPORTED_FORMAT;
  }

  REFERENCE_TIME buffer_duration = (REFERENCE_TIME)s->buffer_ms * 10000;
  UINT32 stream_flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  if (s->loopback) stream_flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;

  hr = client->lpVtbl->Initialize(client, AUDCLNT_SHAREMODE_SHARED, stream_flags, buffer_duration, 0, mix, NULL);
  if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
    UINT32 frame_count = 0;
    client->lpVtbl->GetBufferSize(client, &frame_count);
    client->lpVtbl->Release(client);
    client = NULL;
    hr = dev->lpVtbl->Activate(dev, &G_IID_IAUDIO_CLIENT, CLSCTX_ALL, NULL, (void **)&client);
    if (FAILED(hr)) {
      CoTaskMemFree(mix);
      dev->lpVtbl->Release(dev);
      return hr;
    }
    REFERENCE_TIME period = (REFERENCE_TIME)((10000000.0 / (double)fmt.sample_rate) * (double)frame_count);
    hr = client->lpVtbl->Initialize(client, AUDCLNT_SHAREMODE_SHARED, stream_flags, period, period, mix, NULL);
  }
  CoTaskMemFree(mix);
  if (FAILED(hr)) {
    if (client) client->lpVtbl->Release(client);
    dev->lpVtbl->Release(dev);
    return hr;
  }

  IAudioCaptureClient *capture = NULL;
  hr = client->lpVtbl->GetService(client, &G_IID_IAUDIO_CAPTURE_CLIENT, (void **)&capture);
  if (FAILED(hr)) {
    client->lpVtbl->Release(client);
    dev->lpVtbl->Release(dev);
    return hr;
  }

  hr = client->lpVtbl->SetEventHandle(client, s->wasapi_event);
  if (FAILED(hr)) {
    capture->lpVtbl->Release(capture);
    client->lpVtbl->Release(client);
    dev->lpVtbl->Release(dev);
    return hr;
  }

  s->fmt = fmt;
  s->device = dev;
  s->client = client;
  s->capture = capture;

  {
    size_t capacity_frames = ((size_t)s->buffer_ms * (size_t)fmt.sample_rate) / 1000;
    if (capacity_frames < 64) capacity_frames = 64;
    EnterCriticalSection(&s->ring_cs);
    ring_init(&s->ring, capacity_frames, fmt.channels);
    LeaveCriticalSection(&s->ring_cs);
  }
  return S_OK;
}

/* ------------------------------------------------------------------------- *
 * Drain loop (worker thread)
 * ------------------------------------------------------------------------- */

static HRESULT drain(session_t *s) {
  HRESULT hr;
  UINT32 packet = 0;
  hr = s->capture->lpVtbl->GetNextPacketSize(s->capture, &packet);
  if (FAILED(hr)) return hr;

  size_t bytes_per_frame = (size_t)s->fmt.bytes_per_sample * s->fmt.channels;
  while (SUCCEEDED(hr) && packet != 0) {
    BYTE *data = NULL;
    UINT32 frames = 0;
    DWORD flags = 0;
    hr = s->capture->lpVtbl->GetBuffer(s->capture, &data, &frames, &flags, NULL, NULL);
    if (FAILED(hr)) return hr;
    s->total_frames += frames;

    if (frames > 0) {
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        s->silent_frames += frames;
        EnterCriticalSection(&s->ring_cs);
        ring_write_silence(&s->ring, frames);
        LeaveCriticalSection(&s->ring_cs);
      } else {
        size_t count = (size_t)frames * s->fmt.channels;
        float *scratch = malloc(count * sizeof(float));
        if (scratch) {
          const BYTE *p = data;
          for (size_t i = 0; i < count; i++) {
            scratch[i] = sample_to_float(s->fmt.format, p, s->fmt.bytes_per_sample);
            p += s->fmt.bytes_per_sample;
          }
          EnterCriticalSection(&s->ring_cs);
          ring_write(&s->ring, scratch, frames);
          LeaveCriticalSection(&s->ring_cs);
          free(scratch);
        }
      }
    }
    s->capture->lpVtbl->ReleaseBuffer(s->capture, frames);
    hr = s->capture->lpVtbl->GetNextPacketSize(s->capture, &packet);
  }
  return hr;
}

static DWORD WINAPI session_worker(LPVOID param) {
  session_t *s = (session_t *)param;

  CoInitializeEx(NULL, COINIT_MULTITHREADED);

  HRESULT hr = open_device(s);
  s->setup_hr = hr;
  SetEvent(s->setup_event);

  if (SUCCEEDED(hr)) {
    for (;;) {
      int do_start = 0;
      int do_stop = 0;
      int do_release = 0;

      EnterCriticalSection(&s->ctrl_cs);
      if (s->start_requested && !s->started) {
        s->start_requested = 0;
        do_start = 1;
      }
      do_stop = s->stop_requested;
      do_release = s->release_requested;
      LeaveCriticalSection(&s->ctrl_cs);

      if (do_start) {
        HRESULT shr = s->client->lpVtbl->Start(s->client);
        EnterCriticalSection(&s->ctrl_cs);
        if (SUCCEEDED(shr)) {
          s->started = 1;
          s->start_hr = S_OK;
        } else {
          s->start_hr = shr;
        }
        LeaveCriticalSection(&s->ctrl_cs);
        if (FAILED(shr)) {
          s->fatal_hr = shr;
          break;
        }
      }

      if (do_stop || do_release) break;

      DWORD wait = WaitForSingleObject(s->wasapi_event, 100);
      if (wait == WAIT_OBJECT_0) {
        HRESULT dhr = drain(s);
        if (FAILED(dhr)) {
          s->fatal_hr = dhr;
          break;
        }
      }
    }
  }

  /* teardown - the ring buffer is intentionally kept alive so the JS side can
   * drain any remaining captured audio after stop before calling release. */
  if (s->started) {
    s->client->lpVtbl->Stop(s->client);
    EnterCriticalSection(&s->ctrl_cs);
    s->started = 0;
    LeaveCriticalSection(&s->ctrl_cs);
  }
  if (s->capture) {
    s->capture->lpVtbl->Release(s->capture);
    s->capture = NULL;
  }
  if (s->client) {
    s->client->lpVtbl->Release(s->client);
    s->client = NULL;
  }
  if (s->device) {
    s->device->lpVtbl->Release(s->device);
    s->device = NULL;
  }
  if (s->wasapi_event) {
    CloseHandle(s->wasapi_event);
    s->wasapi_event = NULL;
  }
  CoUninitialize();
  SetEvent(s->exit_event);
  return 0;
}

/* ------------------------------------------------------------------------- *
 * N-API plumbing
 * ------------------------------------------------------------------------- */

#define NAPI_OK(env, call)                                                                                             \
  do {                                                                                                                \
    napi_status st__ = (call);                                                                                        \
    if (st__ != napi_ok) {                                                                                            \
      napi_throw_error((env), NULL, "internal N-API failure");                                                        \
      return NULL;                                                                                                    \
    }                                                                                                                 \
  } while (0)

static int get_prop_u32(napi_env env, napi_value obj, const char *name, uint32_t *out) {
  napi_value v;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok) return 0;
  return napi_get_value_uint32(env, v, out) == napi_ok;
}

static int get_prop_i32(napi_env env, napi_value obj, const char *name, int32_t *out) {
  napi_value v;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok) return 0;
  return napi_get_value_int32(env, v, out) == napi_ok;
}

static int get_opt_string(napi_env env, napi_value obj, const char *name, char *buf, size_t cap) {
  napi_value v;
  bool has = false;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok) return 1;
  if (napi_has_named_property(env, obj, name, &has) != napi_ok) return 1;
  if (!has) {
    buf[0] = '\0';
    return 1;
  }
  napi_valuetype t;
  if (napi_typeof(env, v, &t) != napi_ok || t == napi_null || t == napi_undefined) {
    buf[0] = '\0';
    return 1;
  }
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, buf, cap, &len) != napi_ok) return 0;
  return 1;
}

/* ------------------------------------------------------------------------- *
 * enumerateDevices(dataFlow: "input" | "output") -> AudioDeviceInfo[]
 * ------------------------------------------------------------------------- */

static char *device_friendly_name(IMMDevice *dev) {
  IPropertyStore *store = NULL;
  char *name = NULL;
  if (dev->lpVtbl->OpenPropertyStore(dev, STGM_READ, &store) != S_OK) return NULL;
  PROPVARIANT var;
  PropVariantInit(&var);
  if (store->lpVtbl->GetValue(store, &G_PKEY_FRIENDLY_NAME, &var) == S_OK &&
      (var.vt == VT_LPWSTR || var.vt == VT_BSTR) && var.pwszVal) {
    int len = WideCharToMultiByte(CP_UTF8, 0, var.pwszVal, -1, NULL, 0, NULL, NULL);
    if (len > 0) {
      name = (char *)malloc((size_t)len);
      if (name) WideCharToMultiByte(CP_UTF8, 0, var.pwszVal, -1, name, len, NULL, NULL);
    }
  }
  PropVariantClear(&var);
  store->lpVtbl->Release(store);
  return name;
}

static napi_value enumerate_devices(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  char flow[16] = "input";
  if (argc >= 1) {
    size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], flow, sizeof(flow), &len);
  }
  EDataFlow data_flow = (strcmp(flow, "output") == 0) ? eRender : eCapture;

  int init_here = 0;
  HRESULT hr = com_enter(&init_here);
  if (FAILED(hr)) {
    throw_code(env, hr_text(hr) ? hr_text(hr) : "could not initialize COM");
    return NULL;
  }

  /* build results into two parallel arrays (UTF-8 strings + numbers) */
  IMMDeviceEnumerator *en = NULL;
  IMMDeviceCollection *collection = NULL;
  IMMDevice *default_dev = NULL;
  UINT count = 0;

#define MAX_DEVICES 64
  char ids[MAX_DEVICES][256];
  char *names[MAX_DEVICES];
  int32_t states[MAX_DEVICES];
  int32_t chans[MAX_DEVICES];
  int32_t rates[MAX_DEVICES];
  int32_t defaults[MAX_DEVICES];
  size_t ndev = 0;
  memset(ids, 0, sizeof(ids));
  memset(names, 0, sizeof(names));
  memset(states, 0, sizeof(states));
  memset(chans, 0, sizeof(chans));
  memset(rates, 0, sizeof(rates));
  memset(defaults, 0, sizeof(defaults));

  hr = CoCreateInstance(&G_CLSID_MMDEVICE_ENUMERATOR, NULL, CLSCTX_ALL, &G_IID_IMMDEVICE_ENUMERATOR, (void **)&en);
  if (FAILED(hr)) {
    com_exit(init_here);
    throw_code(env, hr_text(hr) ? hr_text(hr) : "could not create MMDevice enumerator");
    return NULL;
  }

  en->lpVtbl->GetDefaultAudioEndpoint(en, data_flow, eConsole, &default_dev);

  /* capture the default device id once so we can compare by id, not pointer */
  char default_id[256] = "";
  if (default_dev) {
    WCHAR *wid = NULL;
    if (default_dev->lpVtbl->GetId(default_dev, &wid) == S_OK && wid) {
      WideCharToMultiByte(CP_UTF8, 0, wid, -1, default_id, (int)sizeof(default_id), NULL, NULL);
      CoTaskMemFree(wid);
    }
  }

  hr = en->lpVtbl->EnumAudioEndpoints(en, data_flow, G_DEVICE_STATE_ALL, &collection);
  if (FAILED(hr)) {
    if (default_dev) default_dev->lpVtbl->Release(default_dev);
    en->lpVtbl->Release(en);
    com_exit(init_here);
    throw_code(env, hr_text(hr) ? hr_text(hr) : "could not enumerate audio endpoints");
    return NULL;
  }

  collection->lpVtbl->GetCount(collection, &count);
  if (count > MAX_DEVICES) count = MAX_DEVICES;

  for (UINT i = 0; i < count; i++) {
    IMMDevice *dev = NULL;
    if (collection->lpVtbl->Item(collection, i, &dev) != S_OK || !dev) continue;

    WCHAR *wid = NULL;
    DWORD state = G_DEVICE_STATE_NOTPRESENT;
    if (dev->lpVtbl->GetId(dev, &wid) == S_OK && wid) {
      WideCharToMultiByte(CP_UTF8, 0, wid, -1, ids[ndev], (int)sizeof(ids[ndev]), NULL, NULL);
      CoTaskMemFree(wid);
    }
    dev->lpVtbl->GetState(dev, &state);
    states[ndev] = (int32_t)state;

    if (default_id[0] != '\0' && strcmp(ids[ndev], default_id) == 0) defaults[ndev] = 1;

    char *nm = device_friendly_name(dev);
    if (nm) {
      names[ndev] = nm;
    } else {
      names[ndev] = strdup(ids[ndev]);
    }

    if (state == G_DEVICE_STATE_ACTIVE) {
      /* read the device's native format for the UI */
      IAudioClient *client = NULL;
      if (dev->lpVtbl->Activate(dev, &G_IID_IAUDIO_CLIENT, CLSCTX_ALL, NULL, (void **)&client) == S_OK) {
        WAVEFORMATEX *mix = NULL;
        if (client->lpVtbl->GetMixFormat(client, &mix) == S_OK) {
          chans[ndev] = (int32_t)mix->nChannels;
          rates[ndev] = (int32_t)mix->nSamplesPerSec;
          CoTaskMemFree(mix);
        }
        client->lpVtbl->Release(client);
      }
    }

    dev->lpVtbl->Release(dev);
    ndev++;
    if (ndev >= MAX_DEVICES) break;
  }

  if (collection) collection->lpVtbl->Release(collection);
  if (default_dev) default_dev->lpVtbl->Release(default_dev);
  en->lpVtbl->Release(en);
  com_exit(init_here);

  napi_value arr;
  NAPI_OK(env, napi_create_array_with_length(env, ndev, &arr));
  for (size_t i = 0; i < ndev; i++) {
    napi_value obj;
    napi_value str;
    NAPI_OK(env, napi_create_object(env, &obj));

    NAPI_OK(env, napi_create_string_utf8(env, ids[i], NAPI_AUTO_LENGTH, &str));
    NAPI_OK(env, napi_set_named_property(env, obj, "id", str));

    const char *name = names[i] ? names[i] : "";
    NAPI_OK(env, napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &str));
    NAPI_OK(env, napi_set_named_property(env, obj, "name", str));

    const char *state_name = "unknown";
    switch (states[i]) {
      case G_DEVICE_STATE_ACTIVE: state_name = "active"; break;
      case G_DEVICE_STATE_DISABLED: state_name = "disabled"; break;
      case G_DEVICE_STATE_NOTPRESENT: state_name = "notpresent"; break;
      case G_DEVICE_STATE_UNPLUGGED: state_name = "unplugged"; break;
      default: break;
    }
    NAPI_OK(env, napi_create_string_utf8(env, state_name, NAPI_AUTO_LENGTH, &str));
    NAPI_OK(env, napi_set_named_property(env, obj, "state", str));

    napi_value b;
    NAPI_OK(env, napi_get_boolean(env, defaults[i] != 0, &b));
    NAPI_OK(env, napi_set_named_property(env, obj, "isDefault", b));

    napi_value num;
    NAPI_OK(env, napi_create_int32(env, chans[i], &num));
    NAPI_OK(env, napi_set_named_property(env, obj, "channels", num));
    NAPI_OK(env, napi_create_int32(env, rates[i], &num));
    NAPI_OK(env, napi_set_named_property(env, obj, "sampleRate", num));

    NAPI_OK(env, napi_set_element(env, arr, i, obj));

    free(names[i]);
  }

  return arr;
}

/* ------------------------------------------------------------------------- *
 * createSession(options) -> { id, sampleRate, channels, format, bufferMs }
 * ------------------------------------------------------------------------- */

static napi_value create_session(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  char kind[32] = "microphone";
  char device_id[512] = "";
  uint32_t buffer_ms = 250;

  if (argc >= 1) {
    napi_valuetype t;
    if (napi_typeof(env, argv[0], &t) == napi_ok && t == napi_object) {
      napi_value v;
      size_t len = 0;
      if (napi_get_named_property(env, argv[0], "kind", &v) == napi_ok) {
        napi_get_value_string_utf8(env, v, kind, sizeof(kind), &len);
      }
      if (!get_opt_string(env, argv[0], "deviceId", device_id, sizeof(device_id))) {
        throw_code(env, "deviceId must be a string");
        return NULL;
      }
      get_prop_u32(env, argv[0], "bufferMs", &buffer_ms);
    }
  }

  if (buffer_ms < 20) buffer_ms = 20;
  if (buffer_ms > 1000) buffer_ms = 1000;

  session_t *s = (session_t *)calloc(1, sizeof(session_t));
  if (!s) {
    throw_code(env, "out of memory");
    return NULL;
  }
  s->loopback = (strcmp(kind, "loopback") == 0);
  s->buffer_ms = buffer_ms;
  strncpy(s->device_id, device_id, sizeof(s->device_id) - 1);
  s->setup_hr = E_PENDING;
  s->start_hr = E_PENDING;
  s->fatal_hr = S_OK;

  InitializeCriticalSection(&s->ctrl_cs);
  InitializeCriticalSection(&s->ring_cs);
  s->setup_event = CreateEventW(NULL, FALSE, FALSE, NULL);
  s->exit_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  s->wasapi_event = CreateEventW(NULL, FALSE, FALSE, NULL);
  if (!s->setup_event || !s->exit_event || !s->wasapi_event) {
    throw_code(env, "could not create worker events");
    DeleteCriticalSection(&s->ctrl_cs);
    DeleteCriticalSection(&s->ring_cs);
    free(s);
    return NULL;
  }

  EnterCriticalSection(&g_registry_cs);
  s->id = g_next_id++;
  LeaveCriticalSection(&g_registry_cs);

  s->thread = CreateThread(NULL, 0, session_worker, s, 0, NULL);
  if (!s->thread) {
    throw_code(env, "could not create capture worker thread");
    CloseHandle(s->setup_event);
    CloseHandle(s->exit_event);
    CloseHandle(s->wasapi_event);
    DeleteCriticalSection(&s->ctrl_cs);
    DeleteCriticalSection(&s->ring_cs);
    free(s);
    return NULL;
  }

  DWORD wait = WaitForSingleObject(s->setup_event, 10000);
  if (wait != WAIT_OBJECT_0) {
    /* worker never came up - release and fail */
    s->release_requested = 1;
    SetEvent(s->wasapi_event);
    WaitForSingleObject(s->exit_event, 3000);
    registry_remove(s->id);
    CloseHandle(s->thread);
    CloseHandle(s->setup_event);
    CloseHandle(s->exit_event);
    if (s->wasapi_event) CloseHandle(s->wasapi_event);
    DeleteCriticalSection(&s->ctrl_cs);
    DeleteCriticalSection(&s->ring_cs);
    free(s);
    throw_code(env, "timed out waiting for WASAPI capture session");
    return NULL;
  }

  if (FAILED(s->setup_hr)) {
    const char *txt = hr_text(s->setup_hr);
    char msg[384];
    if (txt) {
      snprintf(msg, sizeof(msg), "WASAPI %s capture unavailable: %s", s->loopback ? "loopback" : "microphone", txt);
    } else {
      snprintf(msg, sizeof(msg), "WASAPI %s capture unavailable (0x%08lx)", s->loopback ? "loopback" : "microphone",
               (unsigned long)s->setup_hr);
    }
    s->release_requested = 1;
    SetEvent(s->wasapi_event);
    WaitForSingleObject(s->exit_event, 5000);
    CloseHandle(s->thread);
    CloseHandle(s->setup_event);
    CloseHandle(s->exit_event);
    if (s->wasapi_event) CloseHandle(s->wasapi_event);
    DeleteCriticalSection(&s->ctrl_cs);
    DeleteCriticalSection(&s->ring_cs);
    free(s);
    throw_code(env, msg);
    return NULL;
  }

  registry_add(s);

  napi_value out, num, str;
  NAPI_OK(env, napi_create_object(env, &out));
  NAPI_OK(env, napi_create_uint32(env, s->id, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "id", num));
  NAPI_OK(env, napi_create_uint32(env, s->fmt.sample_rate, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "sampleRate", num));
  NAPI_OK(env, napi_create_uint32(env, s->fmt.channels, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "channels", num));
  NAPI_OK(env, napi_create_string_utf8(env, fmt_name(s->fmt.format), NAPI_AUTO_LENGTH, &str));
  NAPI_OK(env, napi_set_named_property(env, out, "format", str));
  NAPI_OK(env, napi_create_uint32(env, s->buffer_ms, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "bufferMs", num));
  return out;
}

/* ------------------------------------------------------------------------- *
 * sessionStart(id)
 * ------------------------------------------------------------------------- */

static napi_value session_start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  uint32_t id = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &id);

  session_t *s = registry_find((uint32_t)id);
  if (!s) {
    throw_code(env, "session not found");
    return NULL;
  }

  EnterCriticalSection(&s->ctrl_cs);
  int can_start = !s->started && !s->start_requested && !s->stop_requested && s->wasapi_event;
  if (can_start) s->start_requested = 1;
  LeaveCriticalSection(&s->ctrl_cs);

  if (can_start && s->wasapi_event) SetEvent(s->wasapi_event);

  napi_value out;
  NAPI_OK(env, napi_get_boolean(env, !can_start, &out));
  return out; /* returns true when the session was already started/stopping */
}

/* ------------------------------------------------------------------------- *
 * sessionStop(id)
 * ------------------------------------------------------------------------- */

static napi_value session_stop(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  uint32_t id = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &id);

  session_t *s = registry_find((uint32_t)id);
  if (!s) {
    throw_code(env, "session not found");
    return NULL;
  }

  EnterCriticalSection(&s->ctrl_cs);
  s->stop_requested = 1;
  LeaveCriticalSection(&s->ctrl_cs);
  if (s->wasapi_event) SetEvent(s->wasapi_event);

  napi_value out;
  NAPI_OK(env, napi_get_boolean(env, true, &out));
  return out;
}

/* ------------------------------------------------------------------------- *
 * sessionPull(id, maxFrames?) -> Float32Array | null
 * ------------------------------------------------------------------------- */

static napi_value session_pull(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  uint32_t id = 0;
  uint32_t max_frames = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &id);
  if (argc >= 2) napi_get_value_uint32(env, argv[1], &max_frames);

  session_t *s = registry_find((uint32_t)id);
  if (!s) {
    throw_code(env, "session not found");
    return NULL;
  }

  EnterCriticalSection(&s->ring_cs);
  size_t have = ring_frames(&s->ring);
  if (have == 0) {
    LeaveCriticalSection(&s->ring_cs);
    return NULL;
  }
  size_t want = (max_frames > 0 && (size_t)max_frames < have) ? (size_t)max_frames : have;
  size_t total_samples = want * s->ring.channels;

  napi_value ab;
  void *data = NULL;
  size_t bytes = total_samples * sizeof(float);
  NAPI_OK(env, napi_create_arraybuffer(env, bytes, &data, &ab));
  ring_read(&s->ring, (float *)data, want);
  LeaveCriticalSection(&s->ring_cs);

  napi_value arr;
  NAPI_OK(env, napi_create_typedarray(env, napi_float32_array, total_samples, ab, 0, &arr));
  return arr;
}

/* ------------------------------------------------------------------------- *
 * sessionRelease(id)
 * ------------------------------------------------------------------------- */

static napi_value session_release(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  uint32_t id = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &id);

  session_t *s = registry_find((uint32_t)id);
  if (!s) {
    napi_value out;
    NAPI_OK(env, napi_get_boolean(env, true, &out));
    return out;
  }

  EnterCriticalSection(&s->ctrl_cs);
  s->release_requested = 1;
  LeaveCriticalSection(&s->ctrl_cs);
  if (s->wasapi_event) SetEvent(s->wasapi_event);

  WaitForSingleObject(s->exit_event, 10000);
  registry_remove(s->id);

  CloseHandle(s->thread);
  CloseHandle(s->setup_event);
  CloseHandle(s->exit_event);

  EnterCriticalSection(&s->ring_cs);
  ring_destroy(&s->ring);
  LeaveCriticalSection(&s->ring_cs);
  DeleteCriticalSection(&s->ctrl_cs);
  DeleteCriticalSection(&s->ring_cs);
  free(s);

  napi_value out;
  NAPI_OK(env, napi_get_boolean(env, true, &out));
  return out;
}

/* ------------------------------------------------------------------------- *
 * sessionInfo(id) -> info object
 * ------------------------------------------------------------------------- */

static napi_value session_info(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  uint32_t id = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &id);

  session_t *s = registry_find((uint32_t)id);
  if (!s) {
    throw_code(env, "session not found");
    return NULL;
  }

  napi_value out, num, str, b;
  NAPI_OK(env, napi_create_object(env, &out));

  EnterCriticalSection(&s->ctrl_cs);
  int started = s->started;
  int request_start = s->start_requested;
  int stopping = s->stop_requested || s->release_requested;
  HRESULT start_hr = s->start_hr;
  HRESULT fatal_hr = s->fatal_hr;
  LeaveCriticalSection(&s->ctrl_cs);

  int running = started && !stopping;

  NAPI_OK(env, napi_create_uint32(env, s->fmt.sample_rate, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "sampleRate", num));
  NAPI_OK(env, napi_create_uint32(env, s->fmt.channels, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "channels", num));
  NAPI_OK(env, napi_create_string_utf8(env, fmt_name(s->fmt.format), NAPI_AUTO_LENGTH, &str));
  NAPI_OK(env, napi_set_named_property(env, out, "format", str));
  NAPI_OK(env, napi_create_uint32(env, s->buffer_ms, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "bufferMs", num));

  NAPI_OK(env, napi_get_boolean(env, running != 0, &b));
  NAPI_OK(env, napi_set_named_property(env, out, "running", b));
  NAPI_OK(env, napi_get_boolean(env, started != 0, &b));
  NAPI_OK(env, napi_set_named_property(env, out, "started", b));
  NAPI_OK(env, napi_get_boolean(env, request_start != 0, &b));
  NAPI_OK(env, napi_set_named_property(env, out, "starting", b));
  NAPI_OK(env, napi_get_boolean(env, stopping != 0, &b));
  NAPI_OK(env, napi_set_named_property(env, out, "stopping", b));

  EnterCriticalSection(&s->ring_cs);
  size_t buffered = ring_frames(&s->ring);
  size_t dropped = s->ring.dropped_frames + (size_t)0;
  int overflowed = s->ring.overflowed;
  LeaveCriticalSection(&s->ring_cs);

  NAPI_OK(env, napi_create_uint32(env, (uint32_t)buffered, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "bufferedFrames", num));
  NAPI_OK(env, napi_create_double(env, (double)s->total_frames, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "totalFrames", num));
  NAPI_OK(env, napi_create_double(env, (double)s->silent_frames, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "silentFrames", num));
  NAPI_OK(env, napi_create_double(env, (double)dropped, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "droppedFrames", num));
  NAPI_OK(env, napi_get_boolean(env, overflowed != 0, &b));
  NAPI_OK(env, napi_set_named_property(env, out, "overflowed", b));

  char err[384] = "";
  HRESULT e = FAILED(start_hr) ? start_hr : (FAILED(fatal_hr) ? fatal_hr : S_OK);
  if (FAILED(e)) {
    const char *txt = hr_text(e);
    if (txt) {
      snprintf(err, sizeof(err), "%s", txt);
    } else {
      snprintf(err, sizeof(err), "WASAPI error 0x%08lx", (unsigned long)e);
    }
  }
  NAPI_OK(env, napi_create_string_utf8(env, err, NAPI_AUTO_LENGTH, &str));
  NAPI_OK(env, napi_set_named_property(env, out, "error", str));

  return out;
}

/* ------------------------------------------------------------------------- *
 * Module registration
 * ------------------------------------------------------------------------- */

static napi_value module_init(napi_env env, napi_value exports) {
  registry_init();

  napi_property_descriptor props[] = {
      {"enumerateDevices", NULL, enumerate_devices, NULL, NULL, NULL, napi_default_jsproperty, NULL},
      {"createSession", NULL, create_session, NULL, NULL, NULL, napi_default_jsproperty, NULL},
      {"sessionStart", NULL, session_start, NULL, NULL, NULL, napi_default_jsproperty, NULL},
      {"sessionStop", NULL, session_stop, NULL, NULL, NULL, napi_default_jsproperty, NULL},
      {"sessionPull", NULL, session_pull, NULL, NULL, NULL, napi_default_jsproperty, NULL},
      {"sessionRelease", NULL, session_release, NULL, NULL, NULL, napi_default_jsproperty, NULL},
      {"sessionInfo", NULL, session_info, NULL, NULL, NULL, napi_default_jsproperty, NULL},
  };
  NAPI_OK(env, napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, module_init)