import { z } from "zod";

/**
 * Health / readiness contract shared by backend, desktop, and admin.
 */

export const HEALTH_STATUSES = ["ok", "degraded", "down"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const healthResponseSchema = z.object({
  status: z.enum(HEALTH_STATUSES),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string().datetime(),
  checks: z.object({
    database: z.enum(HEALTH_STATUSES),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  latencyMs: number;
  detail?: string;
}

export const healthDetailedResponseSchema = z.object({
  status: z.enum(HEALTH_STATUSES),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string().datetime(),
  components: z.array(z.object({ name: z.string(), status: z.enum(HEALTH_STATUSES), latencyMs: z.number(), detail: z.string().optional() })),
});

export type HealthDetailedResponse = z.infer<typeof healthDetailedResponseSchema>;