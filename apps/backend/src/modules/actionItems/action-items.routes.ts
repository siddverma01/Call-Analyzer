import type { FastifyInstance } from "fastify";
import {
  actionItemListQuerySchema,
  createActionItemRequestSchema,
  updateActionItemRequestSchema,
} from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import { parse } from "../../core/errors.ts";
import { requireAuth } from "../auth/guards.ts";
import { ActionItemsService } from "./action-items.service.ts";

export interface ActionItemsDeps {
  db: Database;
}

/** Registers the user-scoped /api/action-items endpoints. */
export function registerActionItemsRoutes(app: FastifyInstance, deps: ActionItemsDeps): void {
  const service = new ActionItemsService(deps.db);

  app.get(
    "/api/action-items",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      const query = parse(actionItemListQuerySchema, request.query ?? {});
      return service.listForUser(request.authUser!.id, query);
    },
  );

  app.post(
    "/api/action-items",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      const body = parse(createActionItemRequestSchema, request.body);
      return service.create(request.authUser!.id, body);
    },
  );

  app.patch(
    "/api/action-items/:id",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parse(updateActionItemRequestSchema, request.body);
      return service.updateOwned(request.authUser!.id, id, body);
    },
  );

  app.delete(
    "/api/action-items/:id",
    { preHandler: [requireAuth(deps.db)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await service.deleteOwned(request.authUser!.id, id);
      reply.code(204).send();
    },
  );
}