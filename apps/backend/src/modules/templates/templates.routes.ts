import type { FastifyInstance } from "fastify";
import {
  createTemplateRequestSchema,
  setDefaultTemplateRequestSchema,
  updateTemplateRequestSchema,
} from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import { parse } from "../../core/errors.ts";
import { requireAuth } from "../auth/guards.ts";
import type { AuditService } from "../audit/audit.service.ts";
import { TemplatesService } from "./templates.service.ts";

export interface TemplatesDeps {
  db: Database;
  audit: AuditService;
}

/** Registers /api/templates (system + own custom, CRUD, duplicate, default). */
export function registerTemplatesRoutes(app: FastifyInstance, deps: TemplatesDeps): void {
  const service = new TemplatesService(deps.db, deps.audit);

  app.get(
    "/api/templates",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      return service.listForUser(request.authUser!.id);
    },
  );

  app.post(
    "/api/templates",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const body = parse(createTemplateRequestSchema, request.body);
      return service.create(request.authUser!.id, body);
    },
  );

  app.post(
    "/api/templates/:id/duplicate",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return service.duplicate(request.authUser!.id, id);
    },
  );

  app.patch(
    "/api/templates/:id",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parse(updateTemplateRequestSchema, request.body);
      return service.updateOwned(request.authUser!.id, id, body);
    },
  );

  app.delete(
    "/api/templates/:id",
    { preHandler: [requireAuth(deps.db)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await service.deleteOwned(request.authUser!.id, id);
      reply.code(204).send();
    },
  );

  app.put(
    "/api/templates/default",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const body = parse(setDefaultTemplateRequestSchema, request.body);
      await service.setDefault(request.authUser!.id, body.templateId);
      return { ok: true };
    },
  );
}