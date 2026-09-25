import type { FastifyInstance } from "fastify";
import type { HealthService } from "./health.service.ts";

export interface HealthDeps {
  health: HealthService;
  startTime: Date;
  version: string;
}

/** Registers liveness + readiness health routes. */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  const { health, startTime, version } = deps;

  app.get("/health", async () => {
    const components = await health.checkAll();
    return {
      status: health.aggregate(components),
      service: "callnotes-api",
      version,
      uptimeSeconds: Math.floor((Date.now() - startTime.getTime()) / 1000),
      timestamp: new Date().toISOString(),
      checks: {
        database: components.find((c) => c.name === "database")?.status ?? "down",
      },
    };
  });

  app.get("/health/database", async () => {
    const db = await health.checkDatabase();
    return {
      status: "ok",
      service: "callnotes-api-database",
      version,
      uptimeSeconds: Math.floor((Date.now() - startTime.getTime()) / 1000),
      timestamp: new Date().toISOString(),
      components: [db],
    };
  });

  app.get("/health/ready", async () => {
    const components = await health.checkAll();
    const status = health.aggregate(components);
    return {
      status,
      service: "callnotes-api",
      version,
      uptimeSeconds: Math.floor((Date.now() - startTime.getTime()) / 1000),
      timestamp: new Date().toISOString(),
      components,
    };
  });
}