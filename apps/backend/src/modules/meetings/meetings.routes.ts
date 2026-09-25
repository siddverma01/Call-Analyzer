import type { FastifyInstance } from "fastify";
import {
  createMeetingRequestSchema,
  meetingListQuerySchema,
  meetingSyncRequestSchema,
  updateMeetingRequestSchema,
} from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import { parse } from "../../core/errors.ts";
import { requireAuth } from "../auth/guards.ts";
import type { AuditService } from "../audit/audit.service.ts";
import { MeetingsService } from "./meetings.service.ts";

export interface MeetingsDeps {
  db: Database;
  audit: AuditService;
}

/** Registers owner-scoped /api/meetings endpoints. */
export function registerMeetingsRoutes(app: FastifyInstance, deps: MeetingsDeps): void {
  const service = new MeetingsService(deps.db);

  app.get(
    "/api/meetings",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      const query = parse(meetingListQuerySchema, request.query ?? {});
      return service.listOwned(request.authUser!.id, query);
    },
  );

  app.post(
    "/api/meetings",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const body = parse(createMeetingRequestSchema, request.body);
      return service.create(request.authUser!.id, body);
    },
  );

  app.get(
    "/api/meetings/:id",
    { preHandler: [requireAuth(deps.db)] },
    async (request) => {
      const { id } = request.params as { id: string };
      const detail = await service.getOwned(request.authUser!.id, id);
      await deps.audit.record({
        userId: request.authUser!.id,
        action: "MEETING_VIEWED",
        resource: "meeting",
        resourceId: id,
        metadata: { title: detail.meeting.title },
      });
      return detail;
    },
  );

  app.patch(
    "/api/meetings/:id",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parse(updateMeetingRequestSchema, request.body);
      return service.updateOwned(request.authUser!.id, id, body);
    },
  );

  app.delete(
    "/api/meetings/:id",
    { preHandler: [requireAuth(deps.db)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await service.deleteOwned(request.authUser!.id, id);
      await deps.audit.record({
        userId: request.authUser!.id,
        action: "MEETING_DELETED",
        resource: "meeting",
        resourceId: id,
        metadata: { title: deleted.title },
      });
      reply.code(204).send();
    },
  );

  app.post(
    "/api/meetings/sync",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request) => {
      const body = parse(meetingSyncRequestSchema, request.body);
      return service.syncOwned(request.authUser!.id, body);
    },
  );
}