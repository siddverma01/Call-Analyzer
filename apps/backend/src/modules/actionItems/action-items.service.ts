import type { ActionItemDto, ActionItemListQuery, CreateActionItemRequest, UpdateActionItemRequest } from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import type { Prisma } from "../../../generated/prisma/client.ts";
import { AppError } from "../../core/errors.ts";

type ActionItemWithMeeting = Prisma.ActionItemGetPayload<{ include: { meeting: { select: { title: true } } } }>;

function toDto(a: ActionItemWithMeeting): ActionItemDto {
  return {
    id: a.id,
    meetingId: a.meetingId,
    meetingTitle: a.meeting?.title ?? null,
    description: a.description,
    assignee: a.assignee,
    dueDate: a.dueDate,
    priority: a.priority,
    status: a.status,
    sourceSegmentId: a.sourceSegmentId,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export class ActionItemsService {
  constructor(private readonly db: Database) {}

  /** Action items owned by a user, newest first, with the meeting title. */
  async listForUser(userId: string, query: ActionItemListQuery = {}): Promise<ActionItemDto[]> {
    const rows = await this.db.client.actionItem.findMany({
      where: {
        userId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.meetingId ? { meetingId: query.meetingId } : {}),
      },
      include: { meeting: { select: { title: true } } },
      orderBy: { createdAt: "desc" },
    });

    return rows.map((a) => toDto(a));
  }

  /**
   * Creates a task. When `meetingId` is provided it must be one of the user's
   * own meetings; otherwise the task stands alone (no meeting link).
   */
  async create(userId: string, input: CreateActionItemRequest): Promise<ActionItemDto> {
    let meetingId: string | null = null;
    if (input.meetingId) {
      const meeting = await this.db.client.meeting.findFirst({
        where: { id: input.meetingId, userId },
        select: { id: true },
      });
      if (!meeting) throw new AppError("VALIDATION_ERROR", "Unknown or unauthorized meeting");
      meetingId = meeting.id;
    }

    const item = await this.db.client.actionItem.create({
      data: {
        userId,
        meetingId,
        description: input.description,
        assignee: input.assignee ?? null,
        dueDate: input.dueDate ?? null,
        priority: input.priority ?? "MEDIUM",
        status: input.status ?? "OPEN",
      },
      include: { meeting: { select: { title: true } } },
    });
    return toDto(item);
  }

  async updateOwned(userId: string, id: string, input: UpdateActionItemRequest): Promise<ActionItemDto> {
    const existing = await this.db.client.actionItem.findFirst({ where: { id, userId } });
    if (!existing) throw new AppError("NOT_FOUND", "Task not found");

    const data: {
      description?: string;
      assignee?: string | null;
      dueDate?: Date | null;
      priority?: "LOW" | "MEDIUM" | "HIGH";
      status?: "OPEN" | "IN_PROGRESS" | "COMPLETED";
    } = {};
    if (input.description !== undefined) data.description = input.description;
    if (input.assignee !== undefined) data.assignee = input.assignee;
    if (input.dueDate !== undefined) data.dueDate = input.dueDate;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.status !== undefined) data.status = input.status;

    const item = await this.db.client.actionItem.update({
      where: { id: existing.id },
      data,
      include: { meeting: { select: { title: true } } },
    });
    return toDto(item);
  }

  async deleteOwned(userId: string, id: string): Promise<void> {
    const existing = await this.db.client.actionItem.findFirst({ where: { id, userId } });
    if (!existing) throw new AppError("NOT_FOUND", "Task not found");
    await this.db.client.actionItem.delete({ where: { id: existing.id } });
  }
}