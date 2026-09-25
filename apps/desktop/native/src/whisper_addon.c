/*
 * CallNotes AI - native whisper.cpp addon.
 *
 * A Node-API only (ABI-stable) addon that wraps a CPU-only build of
 * whisper.cpp (whisper.h C API) for the on-device live transcription engine:
 *
 *   - systemInfo()                          -> build/system info string
 *   - createContext(modelPath, threads)     -> model context handle id
 *   - transcribe(ctx, samples, offsetMs, language) -> synchronous decode of an
 *     already-VAD-gated mono float32 16 kHz window
 *   - freeContext(ctx)                      -> release a model context
 *
 * Contract notes (mirrored in the TypeScript side):
 *   - segment `start`/`end` timestamps are returned RELATIVE to the supplied
 *     sample window (whisper timestamps are in 10 ms units; converted to ms).
 *     The pipeline adds the window's own global offset, so this addon never
 *     applies `offsetMs` itself.
 *   - `confidence` is the mean token probability over tokens in the segment
 *     that carry a probability >= 0; -1 when no such token exists.
 *   - `transcribe` is synchronous/blocking and must be called from a worker
 *     thread (the JS side does this); it never yields to the JS event loop.
 *
 * Privacy: transcribe() only ever reads the in-memory window passed to it and
 * writes transcript text back to the caller - no audio or text is persisted
 * here. Model files are managed entirely by the main process.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <node_api.h>

#include "whisper.h"
#include "ggml.h"

/* ------------------------------------------------------------------------- *
 * Model context registry
 * ------------------------------------------------------------------------- */

#define MAX_CONTEXTS 16

typedef struct wctx_t {
  int active;
  struct whisper_context * ctx;
  struct whisper_context_params params;
  int n_threads;
  char detected_lang[8];
} wctx_t;

static wctx_t g_contexts[MAX_CONTEXTS];
static int g_registry_init = 0;

static void registry_init(void) {
  if (g_registry_init) return;
  memset(g_contexts, 0, sizeof(g_contexts));
  g_registry_init = 1;
}

static wctx_t *registry_find(uint32_t id) {
  if (id == 0 || id > MAX_CONTEXTS) return NULL;
  wctx_t *w = &g_contexts[id - 1];
  return w->active ? w : NULL;
}

static int registry_alloc(struct whisper_context * ctx, int n_threads) {
  for (int i = 0; i < MAX_CONTEXTS; i++) {
    if (g_contexts[i].active) continue;
    g_contexts[i].active = 1;
    g_contexts[i].ctx = ctx;
    g_contexts[i].n_threads = n_threads;
    return i + 1;
  }
  return 0;
}

/* ------------------------------------------------------------------------- *
 * Logging: swallow ggml/whisper log lines so they cannot pollute the
 * renderer console or stdout.
 * ------------------------------------------------------------------------- */

static void quiet_log(enum ggml_log_level level, const char * text, void * user_data) {
  (void) level;
  (void) text;
  (void) user_data;
}

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

#define NAPI_OK(env, call)                                                                                             \
  do {                                                                                                                \
    napi_status st__ = (call);                                                                                        \
    if (st__ != napi_ok) {                                                                                            \
      napi_throw_error((env), NULL, "internal N-API failure");                                                        \
      return NULL;                                                                                                    \
    }                                                                                                                 \
  } while (0)

static int64_t now_ms(void) {
  struct timespec ts;
  if (timespec_get(&ts, TIME_UTC) == 0) return 0;
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void throw_code(napi_env env, const char * message) {
  napi_throw_error(env, NULL, message);
}

/* ------------------------------------------------------------------------- *
 * systemInfo() -> string
 * ------------------------------------------------------------------------- */

static napi_value sys_info(napi_env env, napi_callback_info info) {
  (void) info;
  const char * text = whisper_print_system_info();
  napi_value out;
  NAPI_OK(env, napi_create_string_utf8(env, text ? text : "", NAPI_AUTO_LENGTH, &out));
  return out;
}

/* ------------------------------------------------------------------------- *
 * createContext(modelPath: string, threads: number) -> number
 * ------------------------------------------------------------------------- */

static napi_value create_context(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  char model_path[4096];
  size_t path_len = 0;
  if (argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], model_path, sizeof(model_path), &path_len) != napi_ok ||
      path_len == 0) {
    throw_code(env, "modelPath must be a non-empty string");
    return NULL;
  }

  int32_t n_threads = 4;
  if (argc >= 2) {
    napi_valuetype t;
    if (napi_typeof(env, argv[1], &t) == napi_ok && (t == napi_number || t == napi_bigint)) {
      napi_get_value_int32(env, argv[1], &n_threads);
    }
  }
  if (n_threads < 1) n_threads = 1;
  if (n_threads > 64) n_threads = 64;

  struct whisper_context_params params = whisper_context_default_params();
  params.use_gpu = false;
  params.flash_attn = false;

  struct whisper_context * ctx = whisper_init_from_file_with_params(model_path, params);
  if (!ctx) {
    char msg[448];
    snprintf(msg, sizeof(msg), "failed to init whisper model: %s", model_path);
    throw_code(env, msg);
    return NULL;
  }

  int id = registry_alloc(ctx, n_threads);
  if (id == 0) {
    whisper_free(ctx);
    throw_code(env, "too many whisper contexts");
    return NULL;
  }

  napi_value out;
  NAPI_OK(env, napi_create_uint32(env, (uint32_t)id, &out));
  return out;
}

/* ------------------------------------------------------------------------- *
 * freeContext(ctx: number) -> boolean
 * ------------------------------------------------------------------------- */

static napi_value free_context(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  uint32_t id = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &id);

  wctx_t *w = registry_find(id);
  if (!w) {
    napi_value out;
    NAPI_OK(env, napi_get_boolean(env, true, &out));
    return out;
  }

  whisper_free(w->ctx);
  memset(w, 0, sizeof(*w));

  napi_value out;
  NAPI_OK(env, napi_get_boolean(env, true, &out));
  return out;
}

/* ------------------------------------------------------------------------- *
 * transcribe(ctx, samples: Float32Array, offsetMs, language) -> result
 * ------------------------------------------------------------------------- */

static napi_value transcribe(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  uint32_t id = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &id);

  wctx_t *w = registry_find(id);
  if (!w) {
    throw_code(env, "transcribe: context not found (was it freed?)");
    return NULL;
  }

  float * samples = NULL;
  size_t n_samples = 0;
  napi_valuetype st = napi_undefined;
  if (argc >= 2 && napi_typeof(env, argv[1], &st) == napi_ok && st == napi_object) {
    napi_get_typedarray_info(env, argv[1], NULL, &n_samples, (void **)&samples, NULL, NULL);
  }
  if (!samples || n_samples == 0) {
    throw_code(env, "transcribe: samples must be a non-empty Float32Array");
    return NULL;
  }

  /* `offsetMs` is intentionally unused for timestamps: the pipeline tracks its
   * own window offsets and re-anchors our relative segment times. */
  (void) 0;

  char language[16] = "";
  const char * lang_ptr = NULL;
  if (argc >= 4) {
    napi_valuetype t = napi_null;
    if (napi_typeof(env, argv[3], &t) == napi_ok && t == napi_string) {
      size_t lang_len = 0;
      napi_get_value_string_utf8(env, argv[3], language, sizeof(language), &lang_len);
      if (lang_len > 0) lang_ptr = language;
    }
  }

  /* Language auto-detection: whisper_full's `detect_language` flag returns
   * without transcribing, so we detect once per context using the plain
   * whisper_lang_auto_detect API and reuse the result across windows. */
  if (!lang_ptr && w->detected_lang[0] == '\0') {
    if (whisper_pcm_to_mel(w->ctx, samples, (int)n_samples, w->n_threads) == 0) {
      float probs[128] = {0};
      const int lid = whisper_lang_auto_detect(w->ctx, 0, w->n_threads, probs);
      if (lid >= 0) {
        const char * lang = whisper_lang_str(lid);
        if (lang) {
          strncpy(w->detected_lang, lang, sizeof(w->detected_lang) - 1);
          w->detected_lang[sizeof(w->detected_lang) - 1] = '\0';
        }
      }
    }
  }
  if (!lang_ptr && w->detected_lang[0] != '\0') lang_ptr = w->detected_lang;

  int64_t t0 = now_ms();

  struct whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  wparams.n_threads = w->n_threads;
  wparams.translate = false;
  wparams.no_context = true; /* windows are independent; the pipeline owns context via overlap */
  wparams.no_timestamps = false;
  wparams.single_segment = false;
  wparams.print_special = false;
  wparams.print_progress = false;
  wparams.print_realtime = false;
  wparams.print_timestamps = false;
  wparams.token_timestamps = false;
  wparams.max_len = 0;
  wparams.max_tokens = 0;
  wparams.audio_ctx = 0;
  wparams.suppress_blank = true;
  wparams.temperature = 0.0f;
  wparams.temperature_inc = 0.2f;
  wparams.language = lang_ptr;
  wparams.detect_language = false;
  wparams.new_segment_callback = NULL;
  wparams.progress_callback = NULL;
  wparams.encoder_begin_callback = NULL;
  wparams.abort_callback = NULL;
  wparams.logits_filter_callback = NULL;

  if ((size_t)n_samples > (size_t)INT32_MAX) {
    throw_code(env, "transcribe: window too long");
    return NULL;
  }

  int rc = whisper_full(w->ctx, wparams, samples, (int)n_samples);
  if (rc != 0) {
    char msg[256];
    snprintf(msg, sizeof(msg), "whisper_full failed (code %d)", rc);
    throw_code(env, msg);
    return NULL;
  }

  const int n_segments = whisper_full_n_segments(w->ctx);
  if (n_segments < 0) {
    throw_code(env, "whisper_full_n_segments failed");
    return NULL;
  }

  /* Build the flat text and per-segment arrays (raw C memory, then JS). */
  char * flat = NULL;
  size_t flat_len = 0;
  size_t flat_cap = 0;
#define FLAT_APPEND(s, n)                                                                                              \
  do {                                                                                                                 \
    size_t n__ = (n);                                                                                                  \
    if (flat_len + n__ + 1 > flat_cap) {                                                                               \
      size_t new_cap = flat_cap ? flat_cap * 2 : 4096;                                                                 \
      while (new_cap < flat_len + n__ + 1) new_cap *= 2;                                                               \
      char * tmp = (char *)realloc(flat, new_cap);                                                                     \
      if (!tmp) goto oom;                                                                                              \
      flat = tmp;                                                                                                      \
      flat_cap = new_cap;                                                                                              \
    }                                                                                                                  \
    memcpy(flat + flat_len, (s), n__);                                                                                 \
    flat_len += n__;                                                                                                   \
    flat[flat_len] = '\0';                                                                                             \
  } while (0)

  typedef struct seg_entry_t {
    int64_t start;
    int64_t end;
    float confidence;
    const char * text;
    size_t text_len;
  } seg_entry_t;
  seg_entry_t * segs = (seg_entry_t *)calloc((size_t)n_segments, sizeof(seg_entry_t));
  if (!segs) goto oom;

  int used = 0;
  for (int i = 0; i < n_segments; i++) {
    const char * text = whisper_full_get_segment_text(w->ctx, i);
    size_t text_len = text ? strlen(text) : 0;
    if (text_len == 0) continue;

    const int64_t t0seg = whisper_full_get_segment_t0(w->ctx, i);
    const int64_t t1seg = whisper_full_get_segment_t1(w->ctx, i);

    const int n_tokens = whisper_full_n_tokens(w->ctx, i);
    float acc = 0.0f;
    int count = 0;
    for (int k = 0; k < n_tokens; k++) {
      whisper_token_data td = whisper_full_get_token_data(w->ctx, i, k);
      if (td.p >= 0.0f && td.p <= 1.0f) {
        acc += td.p;
        count++;
      }
    }

    segs[used].start = t0seg * 10; /* 10 ms units -> ms */
    segs[used].end = t1seg * 10;
    segs[used].confidence = count > 0 ? acc / (float)count : -1.0f;
    segs[used].text = text;
    segs[used].text_len = text_len;
    used++;

    FLAT_APPEND(text, text_len);
  }

  int64_t elapsed = now_ms() - t0;

  napi_value out, js_text, js_segs, js_elapsed, str, num;
  NAPI_OK(env, napi_create_object(env, &out));
  NAPI_OK(env, napi_create_string_utf8(env, flat ? flat : "", NAPI_AUTO_LENGTH, &js_text));
  NAPI_OK(env, napi_set_named_property(env, out, "text", js_text));
  NAPI_OK(env, napi_create_array_with_length(env, (size_t)used, &js_segs));
  for (int i = 0; i < used; i++) {
    napi_value seg, js_start, js_end, js_conf;
    NAPI_OK(env, napi_create_object(env, &seg));
    NAPI_OK(env, napi_create_double(env, (double)segs[i].start, &js_start));
    NAPI_OK(env, napi_set_named_property(env, seg, "start", js_start));
    NAPI_OK(env, napi_create_double(env, (double)segs[i].end, &js_end));
    NAPI_OK(env, napi_set_named_property(env, seg, "end", js_end));
    NAPI_OK(env, napi_create_double(env, (double)segs[i].confidence, &js_conf));
    NAPI_OK(env, napi_set_named_property(env, seg, "confidence", js_conf));
    NAPI_OK(env, napi_create_string_utf8(env, segs[i].text, segs[i].text_len, &str));
    NAPI_OK(env, napi_set_named_property(env, seg, "text", str));
    NAPI_OK(env, napi_set_element(env, js_segs, (uint32_t)i, seg));
  }
  NAPI_OK(env, napi_set_named_property(env, out, "segments", js_segs));
  NAPI_OK(env, napi_create_int64(env, elapsed, &num));
  NAPI_OK(env, napi_set_named_property(env, out, "elapsedMs", num));

  free(segs);
  free(flat);
  return out;

oom:
  free(segs);
  free(flat);
  throw_code(env, "out of memory building transcription result");
  return NULL;
#undef FLAT_APPEND
}

/* ------------------------------------------------------------------------- *
 * Module registration
 * ------------------------------------------------------------------------- */

static napi_value module_init(napi_env env, napi_value exports) {
  registry_init();
  whisper_log_set(quiet_log, NULL);

  napi_property_descriptor props[] = {
      {"systemInfo", NULL, sys_info, NULL, NULL, NULL, napi_default_jsproperty, NULL},
      {"createContext", NULL, create_context, NULL, NULL, NULL, napi_default_jsproperty, NULL},
      {"transcribe", NULL, transcribe, NULL, NULL, NULL, napi_default_jsproperty, NULL},
      {"freeContext", NULL, free_context, NULL, NULL, NULL, napi_default_jsproperty, NULL},
  };
  NAPI_OK(env, napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, module_init)