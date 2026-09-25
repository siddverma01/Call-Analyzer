import type { WhisperModelId } from "@callnotes/shared";

export interface ModelCatalogEntry {
  id: WhisperModelId;
  name: string;
  file: string;
  sizeBytes: number;
  sizeLabel: string;
  /** Approximate peak RAM/VRAM the model needs while transcribing. */
  memoryBytes: number;
  /** SHA-1 of the official ggml model file (download verification). */
  sha1: string;
  /** Tier used by the recommender (0 = slowest/lightest). */
  tier: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Official whisper.cpp ggml multilingual models. Sizes/SHA-1 match
 * ggml-org/whisper.cpp models/README.md; files live on Hugging Face. The app
 * downloads these on demand - nothing is bundled into the installer.
 */
export const WHISPER_MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "tiny",
    name: "Tiny",
    file: "ggml-tiny.bin",
    sizeBytes: 75 * MB,
    sizeLabel: "75 MB",
    memoryBytes: 273 * MB,
    sha1: "bd577a113a864445d4c299885e0cb97d4ba92b5f",
    tier: 0,
  },
  {
    id: "base",
    name: "Base",
    file: "ggml-base.bin",
    sizeBytes: 142 * MB,
    sizeLabel: "142 MB",
    memoryBytes: 388 * MB,
    sha1: "465707469ff3a37a2b9b8d8f89f2f99de7299dac",
    tier: 1,
  },
  {
    id: "small",
    name: "Small",
    file: "ggml-small.bin",
    sizeBytes: 466 * MB,
    sizeLabel: "466 MB",
    memoryBytes: 852 * MB,
    sha1: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
    tier: 2,
  },
  {
    id: "medium",
    name: "Medium",
    file: "ggml-medium.bin",
    sizeBytes: 1536 * MB,
    sizeLabel: "1.5 GB",
    memoryBytes: 2.1 * GB,
    sha1: "fd9727b6e1217c2f614f9b698455c4ffd82463b4",
    tier: 3,
  },
] as const;

export const MODEL_BY_ID = Object.fromEntries(WHISPER_MODEL_CATALOG.map((m) => [m.id, m])) as Record<
  WhisperModelId,
  ModelCatalogEntry
>;

export function modelUrl(model: WhisperModelId): string {
  const entry = MODEL_BY_ID[model];
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${entry.file}`;
}