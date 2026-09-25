import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { WhisperNativeAddon } from "./types.js";

const require = createRequire(import.meta.url);
const ADDON_FILE = `callnotes-whisper-${process.platform}-${process.arch}.node`;

function candidatePaths(): string[] {
  const candidates: string[] = [];
  const override = process.env["CALLNOTES_NATIVE_PATH"];
  if (override) candidates.push(join(override, ADDON_FILE));
  if (app.isPackaged) {
    const resources = process.resourcesPath;
    candidates.push(join(resources, ADDON_FILE));
    candidates.push(join(resources, "app.asar.unpacked", "native", "prebuilds", ADDON_FILE));
  } else {
    const appRoot = app.getAppPath();
    candidates.push(join(appRoot, "native", "prebuilds", ADDON_FILE));
    candidates.push(join(appRoot, "apps", "desktop", "native", "prebuilds", ADDON_FILE));
    candidates.push(join(appRoot, "..", "apps", "desktop", "native", "prebuilds", ADDON_FILE));
  }
  return candidates;
}

/** Absolute path of the whisper addon if a prebuilt binary is present. */
export function resolveWhisperAddonPath(): string | null {
  for (const candidate of candidatePaths()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let cachedAddon: WhisperNativeAddon | null = null;
let cachedPath: string | null = null;
let cachedError: Error | null = null;

/**
 * Loads the native whisper.cpp addon. Never throws when the addon is absent -
 * use `whisperNativeAvailable()` first to distinguish.
 */
export function loadWhisperAddon(): WhisperNativeAddon {
  if (cachedAddon) return cachedAddon;
  if (cachedError) throw cachedError;

  const path = resolveWhisperAddonPath();
  if (!path) {
    cachedError = new Error(`no native whisper addon found (looked for ${ADDON_FILE})`);
    throw cachedError;
  }
  try {
    const resolved = require.resolve(path);
    const addon = require(resolved) as WhisperNativeAddon;
    if (typeof addon.createContext !== "function" || typeof addon.transcribe !== "function") {
      throw new Error("whisper addon is missing createContext/transcribe exports");
    }
    cachedAddon = addon;
    cachedPath = resolved;
    return addon;
  } catch (error) {
    cachedError = error instanceof Error ? error : new Error(String(error));
    throw cachedError;
  }
}

/** True when the native whisper addon is loadable on this host. */
export function whisperNativeAvailable(): boolean {
  if (cachedAddon) return true;
  if (cachedError) return false;
  try {
    loadWhisperAddon();
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the loaded whisper addon (for diagnostics). */
export function whisperAddonPath(): string | null {
  return cachedPath;
}