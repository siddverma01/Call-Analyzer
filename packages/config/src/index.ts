/**
 * Environment loading and validation.
 *
 * All application configuration flows through here so that configuration is
 * typed, validated at startup, and consistent across processes.
 */

export { loadConfig } from "./loader.ts";
export type { LoadConfigOptions } from "./loader.ts";
export { backendEnvSchema, type BackendEnv, devDbEnvSchema, type DevDbEnv } from "./schemas.ts";