import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { APP_NAME, APP_VERSION } from "@callnotes/shared";
import type { BackendEnv } from "@callnotes/config";
import { loggerOptions } from "./core/logger.ts";
import { onError } from "./core/errors.ts";
import { createDatabase, type Database } from "./db/prisma.ts";
import { HealthService } from "./modules/health/health.service.ts";
import { registerHealthRoutes } from "./modules/health/health.routes.ts";
import { registerVersionRoutes } from "./modules/version/version.routes.ts";
import { AuditService } from "./modules/audit/audit.service.ts";
import { SessionStore } from "./modules/auth/session-store.ts";
import { registerAuthRoutes } from "./modules/auth/auth.routes.ts";
import { registerMeetingsRoutes } from "./modules/meetings/meetings.routes.ts";
import { registerTemplatesRoutes } from "./modules/templates/templates.routes.ts";
import { registerActionItemsRoutes } from "./modules/actionItems/action-items.routes.ts";
import { registerAdminRoutes } from "./modules/admin/admin.routes.ts";
import { registerExportRoutes } from "./modules/export/export.routes.ts";

export interface BuildAppOptions {
  env: BackendEnv;
  /** Provide a pre-configured database for tests; defaults to a real connection. */
  database?: Database;
  /** Override the connection URL (used by the embedded-dev harness). */
  databaseUrl?: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  database: Database;
}

/** Assembles a fully-configured Fastify instance (plugins + routes). Does not listen. */
export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { env } = options;
  const startTime = new Date();
  const database = options.database ?? createDatabase(options.databaseUrl ?? env.DATABASE_URL);

  const app = Fastify({
    logger: loggerOptions(env),
    bodyLimit: 1_048_576, // 1 MiB - text-only API
    trustProxy: true,
  });

  // Standardized error responses - never leak internals.
  app.setErrorHandler(onError);

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], objectSrc: ["'none'"] } },
  });

  if (env.CORS_ORIGINS.length > 0) {
    await app.register(cors, { origin: env.CORS_ORIGINS, credentials: true });
  }

  await app.register(cookie, { secret: env.COOKIE_SECRET });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    ban: 5,
    errorResponseBuilder: () => ({
      error: { code: "RATE_LIMITED", message: "Too many requests. Please retry later." },
    }),
  });

  await app.register(swagger, {
    openapi: {
      info: { title: `${APP_NAME} API`, version: APP_VERSION },
      servers: [{ url: env.PUBLIC_API_URL }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: false },
  });

  const health = new HealthService(database);
  registerHealthRoutes(app, { health, startTime, version: APP_VERSION });
  registerVersionRoutes(app, { name: APP_NAME, version: APP_VERSION, node: process.version, platform: process.platform, arch: process.arch });

  const audit = new AuditService(database);
  const sessions = new SessionStore(database, env);

  registerAuthRoutes(app, { db: database, env, sessions, audit });
  registerMeetingsRoutes(app, { db: database, audit });
  registerTemplatesRoutes(app, { db: database, audit });
  registerActionItemsRoutes(app, { db: database });
  registerAdminRoutes(app, { db: database, audit });
  registerExportRoutes(app, { db: database });

  return { app, database };
}