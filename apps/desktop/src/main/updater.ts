import { app } from "electron";
import electronUpdater from "electron-updater";
import { IpcChannels } from "@callnotes/shared";
import type { UpdateStatusPayload } from "@callnotes/shared";

const { autoUpdater } = electronUpdater;

/**
 * Auto-update is deliberately opt-in and conservative:
 *
 *  - It only does anything in a packaged build (never during `npm run dev`).
 *  - It only activates when `CALLNOTES_UPDATE_URL` is set at launch to an
 *    `https://` endpoint (the "generic" provider serving `latest.yml` plus the
 *    signed installer + blockmap produced by electron-builder).
 *  - With no variable (or a non-https value) the updater is a no-op: the app
 *    never phones an unknown host, satisfying the "no untrusted update
 *    sources" security rule.
 *
 * Updates are downloaded silently in the background and installed on quit
 * (electron-updater default). Progress/errors are pushed to the renderer over
 * the existing IPC bridge so the UI can surface status without opening
 * anything new.
 */
export function configureAutoUpdate(
  sendIpc: (channel: (typeof IpcChannels)[keyof typeof IpcChannels], payload: UpdateStatusPayload) => void,
): void {
  if (!app.isPackaged) return;

  const updateUrl = process.env["CALLNOTES_UPDATE_URL"]?.trim();
  if (!updateUrl) {
    console.log("[updater] disabled: no CALLNOTES_UPDATE_URL configured");
    return;
  }
  try {
    const url = new URL(updateUrl);
    if (url.protocol !== "https:") {
      console.warn("[updater] disabled: CALLNOTES_UPDATE_URL must use https");
      return;
    }
  } catch {
    console.warn("[updater] disabled: CALLNOTES_UPDATE_URL is not a valid URL");
    return;
  }

  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.setFeedURL({ provider: "generic", url: updateUrl });

    autoUpdater.on("checking-for-update", () => sendIpc(IpcChannels.UPDATE_STATUS, { phase: "checking" }));
    autoUpdater.on("update-available", (info) => {
      sendIpc(IpcChannels.UPDATE_STATUS, { phase: "downloading", version: info.version });
    });
    autoUpdater.on("update-not-available", () => sendIpc(IpcChannels.UPDATE_STATUS, { phase: "current" }));
    autoUpdater.on("download-progress", (progress) => {
      sendIpc(IpcChannels.UPDATE_STATUS, { phase: "downloading", percent: progress.percent });
    });
    autoUpdater.on("update-downloaded", () => sendIpc(IpcChannels.UPDATE_STATUS, { phase: "ready" }));
    autoUpdater.on("error", (error) => {
      console.warn("[updater] error:", error.message);
      sendIpc(IpcChannels.UPDATE_STATUS, { phase: "error", message: error.message });
    });

    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.warn("[updater] check failed:", error instanceof Error ? error.message : String(error));
    });
  } catch (error) {
    console.warn("[updater] init failed:", error instanceof Error ? error.message : String(error));
  }
}