import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const rootDir =
  typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@callnotes/shared"] })],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(rootDir, "src/main/index.ts"),
          // Emitted as out/main/worker.js so the whisper engine's
          // `new Worker(new URL("./worker.js", import.meta.url))` resolves
          // in the packaged app next to the main bundle.
          worker: resolve(rootDir, "src/main/whisper/worker.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@callnotes/shared"] })],
    build: {
      sourcemap: true,
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          // Main app (src/renderer/index.html) + floating overlay
          // (src/renderer/overlay.html). Both share styles.css but the overlay
          // keeps its own tiny entry so the heavy app bundle never loads in it.
          index: resolve(rootDir, "src/renderer/index.html"),
          overlay: resolve(rootDir, "src/renderer/overlay.html"),
        },
      },
    },
  },
});