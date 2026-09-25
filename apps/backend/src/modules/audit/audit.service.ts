import type { AuditAction } from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";

export type { AuditAction };

export interface AuditInput {
  userId?: string | null;
  action: AuditAction;
  resource: string;
  resourceId?: string | null;
  metadata?: unknown;
}

/** Append-only record of security-relevant events. */
export class AuditService {
  constructor(private readonly db: Database) {}

  async record(input: AuditInput): Promise<void> {
    await this.db.client.auditLog.create({
      data: {
        userId: input.userId ?? null,
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId ?? null,
        metadata: input.metadata ?? {},
      },
    });
  }
}