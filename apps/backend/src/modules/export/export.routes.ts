import type { FastifyInstance } from "fastify";
import { exportRequestSchema } from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import { parse } from "../../core/errors.ts";
import { requireAuth } from "../auth/guards.ts";
import { ExportService } from "./export.service.ts";

export interface ExportDeps {
  db: Database;
}

/** Registers GET /api/meetings/:id/export (owner-scoped, text + PDF exports). */
export function registerExportRoutes(app: FastifyInstance, deps: ExportDeps): void {
  const service = new ExportService(deps.db);

  app.get(
    "/api/meetings/:id/export",
    {
      preHandler: [requireAuth(deps.db)],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = parse(exportRequestSchema, request.query ?? {});
      return service.exportMeeting(request.authUser!.id, id, query.format);
    },
  );
}