import type { ComponentHealth, HealthStatus } from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";

export class HealthService {
  constructor(private readonly db: Database) {}

  async checkDatabase(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      await this.db.ping();
      return { name: "database", status: "ok", latencyMs: Date.now() - started };
    } catch (error) {
      return {
        name: "database",
        status: "down",
        latencyMs: Date.now() - started,
        detail: error instanceof Error ? error.message : "unknown error",
      };
    }
  }

  async checkAll(): Promise<ComponentHealth[]> {
    return [await this.checkDatabase()];
  }

  aggregate(components: ComponentHealth[]): HealthStatus {
    if (components.every((c) => c.status === "ok")) return "ok";
    if (components.some((c) => c.status === "down")) return "down";
    return "degraded";
  }
}