import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStorage } from "./api-client.js";

/**
 * Persists the session token so the user stays signed in across app restarts.
 * The token is encrypted with Electron's OS-backed safeStorage when available
 * and stored under the user data directory - never in the renderer, and never
 * in localStorage. If encryption is unavailable the session simply does not
 * survive a restart (fail closed rather than store a token in plain text).
 */
export function createSessionStorage(): SessionStorage {
  const dir = app.getPath("userData");
  const file = join(dir, "session.bin");
  const canEncrypt = safeStorage.isEncryptionAvailable();

  return {
    async load(): Promise<string | null> {
      try {
        if (!existsSync(file)) return null;
        const raw = readFileSync(file, "utf8").trim();
        if (!raw) return null;
        if (canEncrypt && raw.startsWith("enc:")) {
          return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
        }
        return null;
      } catch {
        return null;
      }
    },
    async save(token: string): Promise<void> {
      try {
        if (!canEncrypt) return;
        const payload = `enc:${safeStorage.encryptString(token).toString("base64")}`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, payload, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Persisting is best-effort; the in-memory token still works this session.
      }
    },
    async clear(): Promise<void> {
      try {
        rmSync(file, { force: true });
      } catch {
        // ignore
      }
    },
  };
}