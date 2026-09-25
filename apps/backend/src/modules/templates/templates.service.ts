import type {
  CreateTemplateRequest,
  TemplateDto,
  TemplateListResponse,
  UpdateTemplateRequest,
} from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import type { Prisma, Template } from "../../../generated/prisma/client.ts";
import { AppError } from "../../core/errors.ts";
import type { AuditService } from "../audit/audit.service.ts";

function toTemplateDto(t: Template): TemplateDto {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    description: t.description,
    schema: t.schema,
    isDefault: t.isDefault,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** JSON body from zod into a Prisma-serializable JSON value. */
function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export class TemplatesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Templates visible to a user (system + own custom) plus their default id. */
  async listForUser(userId: string): Promise<TemplateListResponse> {
    const [rows, preference] = await Promise.all([
      this.db.client.template.findMany({
        where: { OR: [{ userId: null }, { userId }] },
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      }),
      this.db.client.userTemplatePreference.findUnique({ where: { userId } }),
    ]);

    return {
      items: rows.map((t) => toTemplateDto(t)),
      defaultId: preference?.templateId ?? null,
    };
  }

  /** Creates a user-scoped custom template. */
  async create(userId: string, input: CreateTemplateRequest): Promise<TemplateDto> {
    const template = await this.db.client.template.create({
      data: {
        userId,
        type: "CUSTOM",
        name: input.name,
        description: input.description ?? null,
        schema: jsonValue(input.schema),
        isDefault: false,
      },
    });
    await this.audit.record({
      userId,
      action: "TEMPLATE_CHANGED",
      resource: "template",
      resourceId: template.id,
      metadata: { operation: "create", name: template.name },
    });
    return toTemplateDto(template);
  }

  /** Updates a template owned by the user. System templates are read-only. */
  async updateOwned(userId: string, templateId: string, input: UpdateTemplateRequest): Promise<TemplateDto> {
    const existing = await this.db.client.template.findFirst({
      where: { id: templateId, userId },
    });
    if (!existing) throw new AppError("NOT_FOUND", "Template not found or not editable");

    const data: {
      name?: string;
      description?: string | null;
      schema?: Prisma.InputJsonValue;
    } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.schema !== undefined) data.schema = jsonValue(input.schema);

    const template = await this.db.client.template.update({ where: { id: existing.id }, data });
    await this.audit.record({
      userId,
      action: "TEMPLATE_CHANGED",
      resource: "template",
      resourceId: template.id,
      metadata: { operation: "update", name: template.name },
    });
    return toTemplateDto(template);
  }

  /** Deletes a user-owned custom template; system templates are protected. */
  async deleteOwned(userId: string, templateId: string): Promise<void> {
    const existing = await this.db.client.template.findFirst({
      where: { id: templateId, userId },
    });
    if (!existing) throw new AppError("NOT_FOUND", "Template not found or not editable");

    // Cascade removes this user's default preference for the deleted template.
    await this.db.client.template.delete({ where: { id: existing.id } });
    await this.audit.record({
      userId,
      action: "TEMPLATE_CHANGED",
      resource: "template",
      resourceId: existing.id,
      metadata: { operation: "delete", name: existing.name },
    });
  }

  /** Copies a system or own custom template into a new user-scoped custom one. */
  async duplicate(userId: string, sourceTemplateId: string): Promise<TemplateDto> {
    const source = await this.db.client.template.findUnique({ where: { id: sourceTemplateId } });
    const isSystemTemplate = source?.userId === null;
    const isOwnTemplate = source?.userId === userId;
    if (!source || (!isSystemTemplate && !isOwnTemplate)) {
      throw new AppError("NOT_FOUND", "Template not found");
    }

    const copy = await this.db.client.template.create({
      data: {
        userId,
        type: "CUSTOM",
        name: `${source.name} (copy)`,
        description: source.description,
        schema: jsonValue(source.schema),
        isDefault: false,
      },
    });
    await this.audit.record({
      userId,
      action: "TEMPLATE_CHANGED",
      resource: "template",
      resourceId: copy.id,
      metadata: { operation: "duplicate", name: copy.name, source: source.id },
    });
    return toTemplateDto(copy);
  }

  /** Sets (or clears, when null) the user's default template preference. */
  async setDefault(userId: string, templateId: string | null): Promise<void> {
    if (templateId === null) {
      await this.db.client.userTemplatePreference.deleteMany({ where: { userId } });
      await this.audit.record({
        userId,
        action: "TEMPLATE_CHANGED",
        resource: "template",
        resourceId: null,
        metadata: { operation: "clear_default" },
      });
      return;
    }

    const template = await this.db.client.template.findUnique({ where: { id: templateId } });
    const isSystemTemplate = template?.userId === null;
    const isOwnTemplate = template?.userId === userId;
    if (!template || (!isSystemTemplate && !isOwnTemplate)) {
      throw new AppError("NOT_FOUND", "Template not found");
    }

    await this.db.client.userTemplatePreference.upsert({
      where: { userId },
      update: { templateId },
      create: { userId, templateId },
    });
    await this.audit.record({
      userId,
      action: "TEMPLATE_CHANGED",
      resource: "template",
      resourceId: template.id,
      metadata: { operation: "set_default", name: template.name },
    });
  }
}