import {
  createHash,
} from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  WhisperModelId,
  WhisperModelInfo,
  WhisperDownloadProgress,
} from "@callnotes/shared";
import { WHISPER_ERROR_CODES } from "@callnotes/shared";
import { MODEL_BY_ID, WHISPER_MODEL_CATALOG, modelUrl } from "./catalog.js";
import { WhisperError } from "./errors.js";

interface ModelState {
  defaultModelId: WhisperModelId | null;
  /** Engine-verified (loaded + decoded once) per model id. */
  verified: Partial<Record<WhisperModelId, boolean>>;
  /** Engine failed to load (corrupt/truncated download) per model id. */
  corrupt: Partial<Record<WhisperModelId, boolean>>;
}

const DEFAULT_STATE: ModelState = {
  defaultModelId: null,
  verified: {},
  corrupt: {},
};

interface ActiveDownload {
  controller: AbortController;
  downloadedBytes: number;
}

/**
 * Downloads, verifies, and manages local whisper.cpp models on the user's
 * machine. Model files live under userData/models (never bundled, never
 * uploaded). Downloads are streamed with an incremental SHA-1 check and an
 * atomic rename; a partial/hash-mismatched file is discarded.
 */
export class WhisperModelManager {
  private state: ModelState;
  private activeDownload: ActiveDownload | null = null;
  private activeDownloadId: WhisperModelId | null = null;

  /** Replaces the injected callback (service sets this after construction). */
  onDownloadProgress: ((event: WhisperDownloadProgress) => void) | null = null;

  constructor(private readonly deps: { modelsDir: string; statePath: string }) {
    mkdirSync(this.deps.modelsDir, { recursive: true });
    const saved = this.readState();
    // Spread fresh nested maps (never share DEFAULT_STATE/readState objects).
    this.state = {
      defaultModelId: saved.defaultModelId ?? DEFAULT_STATE.defaultModelId,
      verified: { ...saved.verified },
      corrupt: { ...saved.corrupt },
    };
  }

  // -------------------------------------------------------------------------
  // Status surface
  // -------------------------------------------------------------------------

  get defaultModelId(): WhisperModelId | null {
    return this.state.defaultModelId;
  }

  /** Full path for an installed (and verified) model, else null. */
  resolveVerifiedModel(id: WhisperModelId): string | null {
    const path = this.resolveModelFile(id);
    if (!path || !this.state.verified[id]) return null;
    return path;
  }

  /** Full path for an installed model file (verified or not), else null. */
  resolveModelFile(id: WhisperModelId): string | null {
    const path = this.resolveModelFileUnchecked(id);
    if (path === null) return null;
    return existsSync(path) ? path : null;
  }

  list(recommendedId?: WhisperModelId | null): WhisperModelInfo[] {
    return WHISPER_MODEL_CATALOG.map((entry, index) => {
      const filePath = this.resolveModelFile(entry.id);
      const installed = filePath !== null;
      const downloading = this.activeDownloadId === entry.id;
      const sizeBytes = downloading
        ? this.activeDownload?.downloadedBytes ?? 0
        : installed
          ? statSync(filePath).size
          : entry.sizeBytes;
      return {
        id: entry.id,
        name: entry.name,
        file: entry.file,
        sizeBytes,
        sizeLabel: entry.sizeLabel,
        recommended: recommendedId ? recommendedId === entry.id : index === 0,
        installed,
        verified: this.state.verified[entry.id] ?? false,
        isDefault: this.state.defaultModelId === entry.id,
        corrupt: this.state.corrupt[entry.id] ?? false,
        downloading,
        downloadedBytes: sizeBytes,
      };
    });
  }

  status(): { defaultModelId: WhisperModelId | null; models: WhisperModelInfo[] } {
    return { defaultModelId: this.defaultModelId, models: this.list() };
  }

  /**
   * Pick the model to use right now: the persisted default, else the heaviest
   * verified model that is already installed, else null.
   */
  preferredModel(): WhisperModelId | null {
    if (this.defaultModelId && this.resolveModelFile(this.defaultModelId) && !this.state.corrupt[this.defaultModelId]) {
      return this.defaultModelId;
    }
    const installed = [...WHISPER_MODEL_CATALOG]
      .filter((entry) => this.resolveModelFile(entry.id) && !this.state.corrupt[entry.id])
      .sort((a, b) => a.tier - b.tier);
    return installed[installed.length - 1]?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Default model
  // -------------------------------------------------------------------------

  setDefault(id: WhisperModelId): void {
    const entry = MODEL_BY_ID[id];
    if (!this.resolveModelFile(id)) {
      throw new WhisperError(WHISPER_ERROR_CODES.MODEL_MISSING, `Model "${entry.name}" is not downloaded yet.`);
    }
    this.state.defaultModelId = id;
    this.persistState();
  }

  // -------------------------------------------------------------------------
  // Download + verify
  // -------------------------------------------------------------------------

  async download(id: WhisperModelId): Promise<void> {
    if (this.activeDownload) {
      throw new WhisperError(WHISPER_ERROR_CODES.ENGINE_BUSY, "A model download is already in progress.");
    }
    const entry = MODEL_BY_ID[id];
    const filePath = this.resolveModelFile(id);
    if (filePath) {
      // Already fully downloaded; just confirm validity.
      await this.verifyLocalFile(id, filePath);
      return;
    }

    const target = this.resolveModelFileUnchecked(id);
    if (target === null) return; // unreachable: catalog ids always map to a file
    const freeBytes = this.freeSpaceBytes();
    if (freeBytes !== null && freeBytes * 0.9 < entry.sizeBytes) {
      throw new WhisperError(
        WHISPER_ERROR_CODES.INSUFFICIENT_DISK,
        `Not enough free disk space for the ${entry.name} model (~${entry.sizeLabel} free needed).`,
      );
    }

    const controller = new AbortController();
    this.activeDownload = { controller, downloadedBytes: 0 };
    this.activeDownloadId = id;
    this.emitProgress(id, 0, 0, entry.sizeBytes);
    const partPath = `${target}.part`;

    try {
      const response = await fetch(modelUrl(id), {
        signal: controller.signal,
        redirect: "follow",
      });
      if (!response.ok || !response.body) {
        throw new WhisperError(
          WHISPER_ERROR_CODES.MODEL_DOWNLOAD_FAILED,
          `Model download failed (HTTP ${response.status}). Check your connection and retry.`,
        );
      }
      await this.streamToFile(response.body, id, partPath, entry.sizeBytes);
      await this.verifyLocalFile(id, partPath, target);
    } catch (error) {
      this.cleanupPart(partPath);
      throw this.classifyDownloadError(error);
    } finally {
      this.activeDownload = null;
      this.activeDownloadId = null;
    }
  }

  async abortDownload(): Promise<void> {
    this.activeDownload?.controller.abort();
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  deleteModel(id: WhisperModelId): void {
    if (this.state.defaultModelId === id) {
      throw new WhisperError(WHISPER_ERROR_CODES.MODEL_IN_USE, "You cannot delete the default transcription model.");
    }
    const path = this.resolveModelFile(id);
    if (!path) return;
    try {
      unlinkSync(path);
    } catch {
      // best-effort; the file may already be gone
    }
    this.state.verified[id] = false;
    this.state.corrupt[id] = false;
    this.persistState();
  }

  /** Engine outcome for a model load; drives verified/corrupt flags. */
  reportVerification(id: WhisperModelId, ok: boolean): void {
    this.state.verified[id] = ok;
    this.state.corrupt[id] = !ok;
    this.persistState();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private resolveModelFileUnchecked(id: WhisperModelId): string | null {
    const entry = MODEL_BY_ID[id];
    if (!entry) return null;
    return join(this.deps.modelsDir, entry.file);
  }

  private async verifyLocalFile(id: WhisperModelId, candidate: string, finalPath?: string): Promise<void> {
    const path = finalPath ?? candidate;
    const entry = MODEL_BY_ID[id];
    const actualSize = statSync(candidate).size;
    if (actualSize !== entry.sizeBytes) {
      this.cleanupPart(candidate);
      throw new WhisperError(
        WHISPER_ERROR_CODES.MODEL_VERIFY_FAILED,
        `Downloaded file size mismatch for ${entry.name} (got ${actualSize}, expected ${entry.sizeBytes}).`,
      );
    }
    const sha1 = await sha1File(candidate);
    if (sha1 !== entry.sha1) {
      if (finalPath) unlinkSync(candidate);
      this.state.corrupt[id] = true;
      this.persistState();
      throw new WhisperError(
        WHISPER_ERROR_CODES.MODEL_VERIFY_FAILED,
        `SHA-1 verification failed for ${entry.name}. The download is corrupt - delete and retry.`,
      );
    }
    if (!finalPath) return; // already at the final location
    renameSync(candidate, path);
    this.state.verified[id] = true;
    this.state.corrupt[id] = false;
    this.persistState();
  }

  private async streamToFile(
    body: ReadableStream<Uint8Array>,
    id: WhisperModelId,
    partPath: string,
    totalBytes: number,
  ): Promise<void> {
    const reader = body.getReader();
    const hash = createHash("sha1");
    const file = createWriteStream(partPath, { flags: "w" });
    let received = 0;
    let lastEmittedAt = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          hash.update(value);
          file.write(value);
          received += value.byteLength;
          if (this.activeDownload) this.activeDownload.downloadedBytes = received;
          const now = Date.now();
          if (now - lastEmittedAt >= 100) {
            lastEmittedAt = now;
            this.emitProgress(id, Math.min(100, Math.round((received / totalBytes) * 100)), received, totalBytes);
          }
        }
      }
    } finally {
      // note: file.end() awaited implicitly on close; drain synchronously
      file.end();
    }
    await new Promise<void>((resolve, reject) => {
      file.on("error", (error) => reject(error));
      file.on("close", () => resolve());
    });
    this.emitProgress(id, 100, received, totalBytes);
  }

  private emitProgress(modelId: WhisperModelId, percent: number, downloadedBytes: number, totalBytes: number): void {
    this.onDownloadProgress?.({ modelId, percent, downloadedBytes, totalBytes });
  }

  private freeSpaceBytes(): number | null {
    try {
      const info = statfsSync(this.deps.modelsDir);
      return info.bavail * info.bsize;
    } catch {
      return null;
    }
  }

  private cleanupPart(partPath: string): void {
    try {
      if (existsSync(partPath)) unlinkSync(partPath);
    } catch {
      // best-effort cleanup
    }
  }

  private classifyDownloadError(error: unknown): WhisperError {
    if (WhisperError.is(error)) return error;
    if (error instanceof Error && error.name === "AbortError") {
      return new WhisperError(WHISPER_ERROR_CODES.CANCELLED, "Model download cancelled.");
    }
    return new WhisperError(
      WHISPER_ERROR_CODES.MODEL_DOWNLOAD_FAILED,
      `Model download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private readState(): Partial<ModelState> {
    try {
      if (!existsSync(this.deps.statePath)) return {};
      const raw = JSON.parse(readFileSync(this.deps.statePath, "utf8")) as Partial<ModelState>;
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  private persistState(): void {
    try {
      mkdirSync(dirname(this.deps.statePath), { recursive: true });
      writeFileSync(this.deps.statePath, JSON.stringify(this.state, null, 2), "utf8");
    } catch {
      // best-effort persistence
    }
  }
}

export async function sha1File(path: string): Promise<string> {
  const hash = createHash("sha1");
  for await (const chunk of createReadStream(path)) {
    if (chunk instanceof Buffer) hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Model files present on disk (used by tests / diagnostics). */
export function installedModelFiles(modelsDir: string): string[] {
  if (!existsSync(modelsDir)) return [];
  return readdirSync(modelsDir)
    .filter((name) => name.startsWith("ggml-") && name.endsWith(".bin"))
    .map((name) => basename(name));
}