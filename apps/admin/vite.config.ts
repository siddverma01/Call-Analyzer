import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'";

/** Injects a strict CSP into the production build (Vite dev needs eval/HMR). */
const injectCsp: Plugin = {
  name: "inject-csp",
  apply: "build",
  transformIndexHtml(html) {
    return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), injectCsp],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});