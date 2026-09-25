import { BrowserWindow, shell } from "electron";
import { join } from "node:path";

/**
 * Creates the main application window with hardened webPreferences.
 *
 * - contextIsolation: true   - renderer never touches Node primitives
 * - nodeIntegration: false    - no require/fs/child_process in the renderer
 * - sandbox: true             - Chromium-level sandboxing for the renderer
 */
export function createMainWindow(isDevelopment: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: "CallNotes AI",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Only allow navigation to app content; open anything else in the OS browser.
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (isDevelopment && devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

function isAllowedNavigation(url: string): boolean {
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  return url.startsWith("file://");
}