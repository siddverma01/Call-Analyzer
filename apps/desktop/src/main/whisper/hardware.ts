import { arch, cpus, platform, totalmem } from "node:os";
import { execFile } from "node:child_process";
import type { HardwareInfo, WhisperModelId } from "@callnotes/shared";

const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface HardwareSnapshot {
  cpuModel: string;
  cores: number;
  threads: number;
  ramBytes: number;
  gpu: { name: string; vramBytes: number } | null;
  platform: string;
  arch: string;
}

/**
 * Deterministic model recommendation from hardware facts (pure, unit-tested).
 * Rules favour a model that stays comfortably under available RAM while being
 * able to finish faster than realtime: bigger machine => bigger tier, weak
 * cores => one tier down.
 */
export function recommendModel(snapshot: Pick<HardwareSnapshot, "ramBytes" | "cores">): WhisperModelId {
  const ramGb = snapshot.ramBytes / GB;
  const strongCpu = snapshot.cores >= 8;
  const midCpu = snapshot.cores >= 4;

  if (ramGb >= 14 && strongCpu) return "medium";
  if (ramGb >= 7 && strongCpu) return "small";
  if (ramGb >= 7) return midCpu ? "small" : "base";
  if (ramGb >= 4 && midCpu) return "base";
  return "tiny";
}

export async function detectHardware(): Promise<HardwareInfo> {
  const list = cpus();
  const snapshot: HardwareSnapshot = {
    cpuModel: list[0]?.model.trim() || "Unknown CPU",
    cores: list.length,
    threads: list.length,
    ramBytes: totalmem(),
    gpu: await detectGpu(),
    platform: platform(),
    arch: arch(),
  };
  return {
    cpuModel: snapshot.cpuModel,
    cores: snapshot.cores,
    threads: snapshot.threads,
    ramBytes: snapshot.ramBytes,
    gpu: snapshot.gpu,
    platform: snapshot.platform,
    arch: snapshot.arch,
    recommendedModelId: recommendModel(snapshot),
  };
}

/** Best-effort NVIDIA VRAM via nvidia-smi; null when no NVIDIA driver. */
async function detectGpu(): Promise<{ name: string; vramBytes: number } | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 2000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }
        const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
        if (!firstLine) {
          resolve(null);
          return;
        }
        const [name, vramMib] = firstLine.split(",").map((part) => part.trim());
        const mib = Number(vramMib);
        if (!name || !Number.isFinite(mib) || mib <= 0) {
          resolve(null);
          return;
        }
        resolve({ name, vramBytes: Math.round(mib * MB) });
      },
    );
  });
}

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.round(bytes / (1024))} KB`;
}