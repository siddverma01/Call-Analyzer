import { describe, expect, it } from "vitest";
import { HEALTH_STATUSES, UserRole, healthResponseSchema, paginationParamsSchema } from "@callnotes/shared";

describe("shared contracts", () => {
  it("exposes role union values", () => {
    const role: UserRole = "ADMIN";
    expect(["USER", "ADMIN"]).toContain(role);
  });

  it("validates a health response payload", () => {
    const payload = {
      status: "ok",
      service: "callnotes-api",
      version: "0.1.0",
      uptimeSeconds: 12,
      timestamp: new Date().toISOString(),
      checks: { database: "ok" },
    };
    expect(healthResponseSchema.parse(payload)).toEqual(payload);
  });

  it("rejects unknown health statuses", () => {
    expect(() =>
      healthResponseSchema.parse({
        status: "bogus",
        service: "x",
        version: "1",
        uptimeSeconds: 0,
        timestamp: new Date().toISOString(),
        checks: { database: "ok" },
      }),
    ).toThrow();
  });

  it("parses pagination params with defaults", () => {
    expect(paginationParamsSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(paginationParamsSchema.parse({ page: "3", pageSize: "50" })).toEqual({ page: 3, pageSize: 50 });
  });

  it("rejects oversized page sizes", () => {
    expect(() => paginationParamsSchema.parse({ pageSize: 100000 })).toThrow();
  });

  it("exposes the health status union", () => {
    expect(HEALTH_STATUSES).toEqual(["ok", "degraded", "down"]);
  });
});