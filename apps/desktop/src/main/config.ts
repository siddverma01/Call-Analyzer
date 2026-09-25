import { APP_NAME, APP_VERSION } from "@callnotes/shared";

const DEFAULT_API_URL = "http://127.0.0.1:8787";

export interface DesktopConfig {
  appName: string;
  appVersion: string;
  backendUrl: string;
  isDevelopment: boolean;
}

/** Reads process-level configuration trusted from the packaged/debug environment. */
export function loadDesktopConfig(): DesktopConfig {
  const backendUrl = (process.env["CALLNOTES_API_URL"] ?? DEFAULT_API_URL).replace(/\/+$/, "");
  return {
    appName: APP_NAME,
    appVersion: APP_VERSION,
    backendUrl,
    isDevelopment: process.env["ELECTRON_RENDERER_URL"] !== undefined,
  };
}