import { config as loadDotEnv } from "dotenv";
import type { z } from "zod";

export interface LoadConfigOptions {
  /** Path to a `.env` file to load. Defaults to `.env` in the current directory. */
  path?: string;
  /** When true, override an already-populated `process.env`. Defaults to false. */
  override?: boolean;
  /** When false, already-defined env vars win over `.env` values. Defaults to true. */
  silent?: boolean;
}

/**
 * Load `.env`, then parse `process.env` against the given zod schema.
 * Raises a descriptive error on invalid or missing configuration.
 */
export function loadConfig<T extends z.ZodTypeAny>(
  schema: T,
  options: LoadConfigOptions = {},
): z.infer<T> {
  const expanded = { override: options.override ?? false, silent: options.silent ?? true };
  loadDotEnv({ path: options.path, ...expanded });
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}