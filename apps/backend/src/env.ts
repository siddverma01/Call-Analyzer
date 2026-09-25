import { loadConfig, backendEnvSchema, type BackendEnv } from "@callnotes/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

let cached: BackendEnv | undefined;

/**
 * Path to the repository-root `.env`. Workspaces run with cwd inside a package
 * (e.g. `npm run dev -w apps/backend`), where `.env` does not exist, so we
 * resolve it relative to this source file instead of the process cwd.
 */
function repoRootEnvPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "..", "..", "..", ".env");
  return existsSync(candidate) ? candidate : undefined;
}

/** Loaded once per process; subsequent calls return the cached value. */
export function getEnv(): BackendEnv {
  if (!cached) {
    cached = loadConfig(backendEnvSchema, { path: repoRootEnvPath() });
  }
  return cached;
}

export function setEnvForTests(env: BackendEnv): void {
  cached = env;
}