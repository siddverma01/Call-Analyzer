import { APP_NAME } from "@callnotes/shared";
import type { BackendEnv } from "@callnotes/config";

/** Builds the pino logger options used by Fastify. */
export function loggerOptions(env: BackendEnv) {
  const base = {
    level: env.LOG_LEVEL,
    base: { service: `${APP_NAME}-api` },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "*.password",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  };

  if (env.NODE_ENV === "development" && env.LOG_LEVEL !== "silent") {
    return {
      ...base,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, singleLine: true },
      },
    };
  }

  return base;
}