import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { NativeAudioAddon, NativeSessionInfo } from "./types.js";

const require = createRequire(import.meta.url);
const ADDON_FILE = `callnotes-wasapi-${process.platform}-${process.arch}.node`;

function candidatePaths(): string[] {
  const candidates: string[] = [];
  const override = process.env["CALLNOTES_NATIVE_PATH"];
  if (override) candidates.push(override);

  if (app.isPackaged) {
    // packaged: addon sits next to the compiled main bundle or resources
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

let cachedAddon: NativeAudioAddon | null = null;
let cachedPath: string | null = null;
let cachedError: Error | null = null;

/**
 * Loads the native WASAPI addon once. Never throws on platforms where the
 * addon is absent - use `nativeAvailable()` first to distinguish.
 */
export function loadNativeAddon(): NativeAudioAddon {
  if (cachedAddon) return cachedAddon;
  if (cachedError) throw cachedError;

  if (process.platform !== "win32") {
    cachedError = new Error(`native WASAPI capture is only available on Windows (this host: ${process.platform})`);
    throw cachedError;
  }

  for (const candidate of candidatePaths()) {
    try {
      if (!existsSync(candidate)) continue;
      // require.resolve on the absolute path forces the bundled build to load
      // the real .node at runtime instead of trying to bundle it.
      const resolved = require.resolve(candidate);
      const addon = require(resolved) as NativeAudioAddon;
      if (typeof addon.enumerateDevices !== "function") continue;
      cachedAddon = addon;
      cachedPath = resolved;
      return addon;
    } catch (error) {
      cachedError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!cachedError) {
    cachedError = new Error(
      `no native WASAPI addon found; build it with \`npm run build:wasapi\` (looked for ${ADDON_FILE} in ${JSON.stringify(candidatePaths())})`,
    );
  }
  throw cachedError;
}

/** True when the native addon is loadable on this host. */
export function nativeAvailable(): boolean {
  if (cachedAddon) return true;
  if (cachedError) return false;
  try {
    loadNativeAddon();
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the loaded addon (for diagnostics). */
export function nativeAddonPath(): string | null {
  return cachedPath;
}

/** Probes the native format/preferences plumbing without extra native calls. */
export function nativeSessionInfo(id: number): NativeSessionInfo {
  return loadNativeAddon().sessionInfo(id);
}