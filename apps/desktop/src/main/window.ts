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
    show: true,
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

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer console] [${level}] ${message} (${sourceId}:${line})`);
  });

  window.once("ready-to-show", () => {
    console.log("[desktop] window ready-to-show fired!");
    window.show();
    window.focus();
    window.setAlwaysOnTop(true);
    window.setAlwaysOnTop(false);
  });
  window.webContents.on("did-finish-load", () => {
    console.log("[desktop] did-finish-load fired!");
    if (!window.isVisible()) {
      window.show();
      window.focus();
    }
  });
  window.webContents.on("did-fail-load", (_event, code, desc, url) => {
    console.error(`[desktop] did-fail-load: ${code} (${desc}) at ${url}`);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Only allow navigation to app content; open anything else in the OS browser.
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  console.log(`[desktop] isDevelopment=${isDevelopment}, devServerUrl=${devServerUrl}`);
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