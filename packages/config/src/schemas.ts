import { z } from "zod";

/**
 * Backend environment variables.
 * Keep this in sync with the repo root `.env.example`.
 */
export const backendEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_API_URL: z.string().url().default("http://127.0.0.1:8080"),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  DATABASE_URL: z.string().min(1).default("postgresql://postgres:postgres@localhost:5432/callnotes?schema=public"),

  // --- Authentication (session cookie) -------------------------------------
  // Minimum 32 chars. Operates as the signing key for the session cookie.
  COOKIE_SECRET: z.string().min(32),
  // Session lifetime in days. A fresh session is created on every login.
  SESSION_TTL_DAYS: z.coerce.number().positive().default(14),
  // Send the cookie over HTTPS only. Keep false for local development.
  COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  COOKIE_SAME_SITE: z.enum(["strict", "lax", "none"]).default("strict"),
});

export type BackendEnv = z.infer<typeof backendEnvSchema>;

/**
 * Environment variables used by the local (embedded, dockerless) PostgreSQL
 * harness in `scripts/dev-db.mjs`.
 */
export const devDbEnvSchema = z.object({
  DEV_PG_PORT: z.coerce.number().int().min(1).max(65535).default(55432),
  DEV_PG_USER: z.string().default("callnotes"),
  DEV_PG_PASSWORD: z.string().default("callnotes"),
  DEV_PG_DATABASE: z.string().default("callnotes"),
  DEV_PG_DATA_DIR: z.string().default("./data/pg"),
});

export type DevDbEnv = z.infer<typeof devDbEnvSchema>;