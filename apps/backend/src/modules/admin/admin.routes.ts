import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { USER_ROLES, USER_STATUSES } from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import { parse } from "../../core/errors.ts";
import { requireRole } from "../auth/guards.ts";
import type { AuditService } from "../audit/audit.service.ts";
import { AdminService } from "./admin.service.ts";

export interface AdminDeps {
  db: Database;
  audit: AuditService;
}

function pagination(query: { page?: unknown; perPage?: unknown }): { page: number; perPage: number } {
  const picked = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  const page = Number.parseInt(picked(query.page, "1"), 10);
  const perPage = Number.parseInt(picked(query.perPage, "20"), 10);
  return {
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    perPage: Number.isFinite(perPage) && perPage >= 1 ? Math.min(100, perPage) : 20,
  };
}

/** Registers ADMIN-only /api/admin endpoints. */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const service = new AdminService(deps.db, deps.audit);
  const adminOnly = requireRole(deps.db, ["ADMIN"]);

  app.get("/api/admin/users", { preHandler: [adminOnly], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) => {
    const { page, perPage } = pagination(request.query as { page?: unknown; perPage?: unknown });
    return service.listUsers(page, perPage);
  });

  app.get("/api/admin/users/:id", { preHandler: [adminOnly], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) => {
    const { id } = request.params as { id: string };
    return service.getUserDetail(id);
  });

  app.get("/api/admin/stats", { preHandler: [adminOnly], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async () => {
    return service.getStats();
  });

  app.patch(
    "/api/admin/users/:id/status",
    { preHandler: [adminOnly], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parse(z.object({ status: z.enum(USER_STATUSES) }), request.body);
      await service.updateStatus(request.authUser!.id, id, body.status);
      return { ok: true };
    },
  );

  app.patch(
    "/api/admin/users/:id/role",
    { preHandler: [adminOnly], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parse(z.object({ role: z.enum(USER_ROLES) }), request.body);
      await service.updateRole(request.authUser!.id, id, body.role);
      return { ok: true };
    },
  );

  app.get("/api/admin/meetings", { preHandler: [adminOnly], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) => {
    const { page, perPage } = pagination(request.query as { page?: unknown; perPage?: unknown });
    return service.listAllMeetings(page, perPage);
  });

  app.get("/api/admin/audit-logs", { preHandler: [adminOnly], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) => {
    const { page, perPage } = pagination(request.query as { page?: unknown; perPage?: unknown });
    return service.listAuditLogs(page, perPage);
  });
}