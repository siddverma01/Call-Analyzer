import type { FastifyInstance } from "fastify";
import type { AppVersion } from "@callnotes/shared";

export function registerVersionRoutes(app: FastifyInstance, version: AppVersion): void {
  app.get("/api/version", async () => ({ version }));
}