import type {
  CreateMeetingRequest,
  MeetingDetailDto,
  MeetingDto,
  MeetingListQuery,
  MeetingListItem,
  MeetingSort,
  MeetingStatus,
  MeetingSyncRequest,
  UpdateMeetingRequest,
} from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import { Prisma } from "../../../generated/prisma/client.ts";
import { AppError } from "../../core/errors.ts";

export interface MeetingPage {
  items: MeetingListItem[];
  total: number;
  page: number;
  perPage: number;
}

function toMeetingDto(meeting: {
  id: string;
  userId: string;
  title: string;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number;
  status: string;
  templateId: string | null;
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MeetingDto {
  return {
    id: meeting.id,
    userId: meeting.userId,
    title: meeting.title,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    durationSeconds: meeting.durationSeconds,
    status: meeting.status as MeetingStatus,
    templateId: meeting.templateId,
    summary: meeting.summary,
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
  };
}

/** JSONB column value: real JSON in, SQL NULL for missing. */
function jsonValue(value: unknown): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value;
}

interface MeetingFilters {
  status?: MeetingStatus;
  templateId?: string;
  from?: Date;
  to?: Date;
}

function sortOrder(sort?: MeetingSort) {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" as const };
    case "title":
      return { title: "asc" as const };
    case "duration":
      return { durationSeconds: "desc" as const };
    case "updated":
      return { updatedAt: "desc" as const };
    default:
      return { createdAt: "desc" as const };
  }
}

/** Prisma where clause shared by filtered listings (no full-text search). */
function filterWhere(userId: string, filters: MeetingFilters) {
  return {
    userId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.templateId ? { templateId: filters.templateId } : {}),
    ...(filters.from !== undefined ? { startedAt: { gte: filters.from } } : {}),
    ...(filters.to !== undefined ? { startedAt: { lte: filters.to } } : {}),
  };
}

/** SQL `WHERE` fragment used by the full-text search path. */
function searchWhereSql(userId: string, filters: MeetingFilters, query: string) {
  const clauses = [
    Prisma.sql`m."userId" = ${userId}`,
    Prisma.sql`m."searchVector" @@ plainto_tsquery('english', ${query})`,
  ];
  if (filters.status) clauses.push(Prisma.sql`m."status" = ${filters.status}::"MeetingStatus"`);
  if (filters.templateId) clauses.push(Prisma.sql`m."templateId" = ${filters.templateId}`);
  if (filters.from) clauses.push(Prisma.sql`m."startedAt" >= ${filters.from}`);
  if (filters.to) clauses.push(Prisma.sql`m."startedAt" <= ${filters.to}`);
  return Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}`;
}

export class MeetingsService {
  constructor(private readonly db: Database) {}

  async listOwned(userId: string, query: MeetingListQuery): Promise<MeetingPage> {
    const page = query.page ?? 1;
    const perPage = Math.min(100, query.perPage ?? 20);
    const skip = Math.max(0, (page - 1) * perPage);
    const filters: MeetingFilters = {
      status: query.status,
      templateId: query.templateId,
      from: query.from,
      to: query.to,
    };

    const q = query.q?.trim();

    // Full-text search path: raw SQL against the tsvector search column,
    // always relevance-ranked and hard-scoped to the caller. A query with no
    // searchable terms (e.g. only punctuation) matches nothing.
    if (q !== undefined) {
      if (!q || !/\w/.test(q)) {
        return { items: [], total: 0, page, perPage };
      }
      const [rows, totals] = await Promise.all([
        this.db.client.$queryRaw<
          Array<{
            id: string;
            title: string;
            startedAt: Date | null;
            endedAt: Date | null;
            durationSeconds: number;
            status: string;
            templateId: string | null;
            templateName: string | null;
            summaryPreview: string | null;
            actionItemCount: number;
            createdAt: Date;
          }>
        >`
          SELECT
            m."id", m."title", m."startedAt", m."endedAt", m."durationSeconds",
            m."status", m."templateId", t."name" AS "templateName",
            m."summary" AS "summaryPreview",
            (SELECT COUNT(*)::int FROM "ActionItem" ai WHERE ai."meetingId" = m."id") AS "actionItemCount",
            m."createdAt"
          FROM "Meeting" m
          LEFT JOIN "Template" t ON t."id" = m."templateId"
          ${searchWhereSql(userId, filters, q)}
          ORDER BY ts_rank(m."searchVector", plainto_tsquery('english', ${q})) DESC, m."createdAt" DESC
          LIMIT ${perPage} OFFSET ${skip}
        `,
        this.db.client.$queryRaw<Array<{ total: number }>>`
          SELECT COUNT(*)::int AS "total"
          FROM "Meeting" m
          ${searchWhereSql(userId, filters, q)}
        `,
      ]);

      return {
        items: rows.map((m) => ({ ...m, status: m.status as MeetingStatus })),
        total: totals[0]?.total ?? 0,
        page,
        perPage,
      };
    }

    // Standard path: Prisma query with optional filters + sort.
    const [rows, total] = await Promise.all([
      this.db.client.meeting.findMany({
        where: filterWhere(userId, filters),
        orderBy: sortOrder(query.sort),
        skip,
        take: perPage,
        include: {
          template: { select: { name: true } },
          _count: { select: { actionItems: true } },
        },
      }),
      this.db.client.meeting.count({ where: filterWhere(userId, filters) }),
    ]);

    return {
      items: rows.map((m) => ({
        id: m.id,
        title: m.title,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        durationSeconds: m.durationSeconds,
        status: m.status,
        templateId: m.templateId,
        templateName: m.template?.name ?? null,
        summaryPreview: m.summary,
        actionItemCount: m._count.actionItems,
        createdAt: m.createdAt,
      })),
      total,
      page,
      perPage,
    };
  }

  async create(userId: string, input: CreateMeetingRequest): Promise<MeetingDto> {
    let templateId: string | null = null;
    if (input.templateId) {
      const template = await this.db.client.template.findUnique({
        where: { id: input.templateId },
      });
      const isSystemTemplate = template?.userId === null;
      const isOwnTemplate = template?.userId === userId;
      if (!template || (!isSystemTemplate && !isOwnTemplate)) {
        throw new AppError("VALIDATION_ERROR", "Unknown or unauthorized template");
      }
      templateId = template.id;
    }

    // userId is always derived from the authenticated session, never the body.
    const meeting = await this.db.client.meeting.create({
      data: {
        userId,
        title: input.title ?? "Untitled meeting",
        templateId,
        startedAt: input.startedAt ?? null,
        status: "DRAFT",
        durationSeconds: 0,
      },
    });

    return toMeetingDto(meeting);
  }

  async getOwned(userId: string, meetingId: string): Promise<MeetingDetailDto> {
    const meeting = await this.db.client.meeting.findFirst({
      where: { id: meetingId, userId },
    });
    if (!meeting) throw new AppError("NOT_FOUND", "Meetings not found");

    const [segments, summaries] = await Promise.all([
      this.db.client.transcriptSegment.findMany({
        where: { meetingId },
        orderBy: { startTime: "asc" },
      }),
      this.db.client.meetingSummary.findMany({ where: { meetingId } }),
    ]);

    const summary = summaries[0];
    return {
      meeting: toMeetingDto(meeting),
      segments: segments.map((s) => ({
        id: s.id,
        speaker: s.speaker,
        startTime: s.startTime,
        endTime: s.endTime,
        text: s.text,
        confidence: s.confidence,
        isEdited: s.isEdited,
      })),
      summary: summary
        ? {
            id: summary.id,
            summary: summary.summary,
            discussionPoints: summary.discussionPoints,
            decisions: summary.decisions,
            risks: summary.risks,
            openQuestions: summary.openQuestions,
            blockers: summary.blockers,
            followUps: summary.followUps,
            importantDates: summary.importantDates,
            participants: summary.participants,
            aiModel: summary.aiModel,
            aiProvider: summary.aiProvider,
          }
        : null,
    };
  }

  async updateOwned(userId: string, meetingId: string, input: UpdateMeetingRequest): Promise<MeetingDto> {
    const existing = await this.db.client.meeting.findFirst({
      where: { id: meetingId, userId },
    });
    if (!existing) throw new AppError("NOT_FOUND", "Meetings not found");

    const data: {
      title?: string;
      status?: MeetingStatus;
      endedAt?: Date | null;
      durationSeconds?: number;
    } = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.status !== undefined) data.status = input.status;
    if (input.endedAt !== undefined) {
      data.endedAt = input.endedAt;
      if (existing.startedAt) {
        data.durationSeconds = Math.max(0, Math.round((input.endedAt.getTime() - existing.startedAt.getTime()) / 1000));
      }
    }

    const meeting = await this.db.client.meeting.update({ where: { id: existing.id }, data });
    return toMeetingDto(meeting);
  }

  async deleteOwned(userId: string, meetingId: string): Promise<{ id: string; title: string }> {
    const existing = await this.db.client.meeting.findFirst({
      where: { id: meetingId, userId },
    });
    if (!existing) throw new AppError("NOT_FOUND", "Meetings not found");
    await this.db.client.meeting.delete({ where: { id: existing.id } });
    return { id: existing.id, title: existing.title };
  }

  /**
   * Idempotent offline-first upsert driven by the desktop app. The payload is
   * a full snapshot of one meeting keyed by `clientMeetingId`; segments and
   * action items carry their own client ids, so re-delivering the same payload
   * (e.g. after a dropped response) has no side effects. Everything runs in a
   * single transaction and is scoped to the authenticated user.
   */
  async syncOwned(userId: string, input: MeetingSyncRequest): Promise<MeetingDto> {
    let templateId: string | null = null;
    if (input.templateId) {
      const template = await this.db.client.template.findUnique({ where: { id: input.templateId } });
      const isSystemTemplate = template?.userId === null;
      const isOwnTemplate = template?.userId === userId;
      if (!template || (!isSystemTemplate && !isOwnTemplate)) {
        throw new AppError("VALIDATION_ERROR", "Unknown or unauthorized template");
      }
      templateId = template.id;
    }

    // The meeting row itself is upserted atomically. Segment snapshots can
    // number in the thousands for 1-4 hour meetings, and every row insert fires
    // a database trigger that recomputes the meeting's full-text search
    // document; keeping all of that inside one interactive transaction is both
    // slow and fragile. Every segment write is individually idempotent
    // (keyed by meetingId + clientSegmentId), so bulk segment/action-item writes
    // run as auto-commit queries instead - a partial failure on a giant sync is
    // simply re-merged on the next delivery.
    const meeting = await this.db.client.$transaction(async (tx) => {
      const existing = await tx.meeting.findFirst({
        where: { userId, clientMeetingId: input.clientMeetingId },
      });

      return existing != null
        ? await tx.meeting.update({
            where: { id: existing.id },
            data: {
              title: input.title ?? existing.title,
              templateId,
              startedAt: input.startedAt ?? existing.startedAt,
              endedAt: input.endedAt !== undefined ? input.endedAt : (existing.endedAt ?? null),
              durationSeconds: input.durationSeconds ?? existing.durationSeconds,
              status: input.status ?? existing.status,
              summary: input.summary !== undefined ? input.summary : (existing.summary ?? null),
            },
          })
        : await tx.meeting.create({
            data: {
              userId,
              clientMeetingId: input.clientMeetingId,
              title: input.title ?? "Untitled meeting",
              templateId,
              startedAt: input.startedAt ?? null,
              endedAt: input.endedAt ?? null,
              durationSeconds: input.durationSeconds ?? 0,
              status: input.status ?? "DRAFT",
              summary: input.summary ?? null,
            },
          });
    });

    // Client segment ids are the idempotency key; map them to server ones so
    // action items can link their "source transcript segment" correctly.
    // Batching matters at long-meeting scale: one bulk `findMany` for the rows
    // being compared, one `createMany` (duplicate-safe) for brand-new segments,
    // and per-row updates only for segments whose content actually changed.
    const segmentIdByClient = new Map<string, string>();
    const clientSegments = input.segments ?? [];
    if (clientSegments.length > 0) {
      const existing = await this.db.client.transcriptSegment.findMany({
        where: {
          meetingId: meeting.id,
          clientSegmentId: { in: clientSegments.map((s) => s.clientSegmentId) },
        },
        select: {
          id: true,
          clientSegmentId: true,
          speaker: true,
          startTime: true,
          endTime: true,
          text: true,
          confidence: true,
          isEdited: true,
        },
      });
      const existingByClient = new Map(existing.map((row) => [row.clientSegmentId, row]));
      for (const row of existing) segmentIdByClient.set(row.clientSegmentId, row.id);

      const toCreate: Array<Prisma.TranscriptSegmentCreateManyInput> = [];
      const toUpdate: Array<{
        clientSegmentId: string;
        data: Prisma.TranscriptSegmentUpdateInput | Prisma.TranscriptSegmentUncheckedUpdateInput;
      }> = [];

      for (const segment of clientSegments) {
        const prev = existingByClient.get(segment.clientSegmentId);
        const latest = {
          speaker: segment.speaker ?? "Speaker 1",
          startTime: segment.startTime ?? new Date(),
          endTime: segment.endTime ?? new Date(),
          text: segment.text,
          confidence: segment.confidence ?? null,
          isEdited: segment.isEdited ?? false,
        };
        if (prev == null) {
          toCreate.push({ ...latest, meetingId: meeting.id, clientSegmentId: segment.clientSegmentId });
        } else if (
          prev.speaker !== latest.speaker ||
          prev.text !== latest.text ||
          prev.isEdited !== latest.isEdited ||
          prev.confidence !== latest.confidence ||
          new Date(prev.startTime ?? 0).getTime() !== new Date(latest.startTime).getTime() ||
          new Date(prev.endTime ?? 0).getTime() !== new Date(latest.endTime).getTime()
        ) {
          toUpdate.push({ clientSegmentId: segment.clientSegmentId, data: latest });
        }
      }

      if (toCreate.length > 0) {
        await this.db.client.transcriptSegment.createMany({ data: toCreate, skipDuplicates: true });
        const created = await this.db.client.transcriptSegment.findMany({
          where: {
            meetingId: meeting.id,
            clientSegmentId: { in: toCreate.map((s) => s.clientSegmentId) },
          },
          select: { id: true, clientSegmentId: true },
        });
        for (const row of created) segmentIdByClient.set(row.clientSegmentId, row.id);
      }
      for (const change of toUpdate) {
        const saved = await this.db.client.transcriptSegment.update({
          where: {
            meetingId_clientSegmentId: {
              meetingId: meeting.id,
              clientSegmentId: change.clientSegmentId,
            },
          },
          data: change.data,
        });
        segmentIdByClient.set(change.clientSegmentId, saved.id);
      }
    }

    if (input.summaryDetails) {
      const summaryBody = {
        summary: input.summaryDetails.summary,
        discussionPoints: jsonValue(input.summaryDetails.discussionPoints),
        decisions: jsonValue(input.summaryDetails.decisions),
        risks: jsonValue(input.summaryDetails.risks),
        openQuestions: jsonValue(input.summaryDetails.openQuestions),
        blockers: jsonValue(input.summaryDetails.blockers),
        followUps: jsonValue(input.summaryDetails.followUps),
        importantDates: jsonValue(input.summaryDetails.importantDates),
        participants: jsonValue(input.summaryDetails.participants),
        aiModel: input.summaryDetails.aiModel ?? null,
        aiProvider: input.summaryDetails.aiProvider ?? null,
      };
      await this.db.client.meetingSummary.upsert({
        where: { meetingId: meeting.id },
        update: { ...summaryBody },
        create: { meetingId: meeting.id, ...summaryBody },
      });
    }

    for (const item of input.actionItems ?? []) {
      const sourceSegmentId = item.sourceSegmentId
        ? (segmentIdByClient.get(item.sourceSegmentId) ?? null)
        : null;
      const itemData = {
        description: item.description,
        assignee: item.assignee ?? null,
        dueDate: item.dueDate ?? null,
        priority: item.priority ?? "MEDIUM",
        status: item.status ?? "OPEN",
        sourceSegmentId,
      };
      if (item.clientItemId) {
        await this.db.client.actionItem.upsert({
          where: {
            meetingId_clientItemId: {
              meetingId: meeting.id,
              clientItemId: item.clientItemId,
            },
          },
          update: itemData,
          create: { ...itemData, meetingId: meeting.id, userId, clientItemId: item.clientItemId },
        });
      } else {
        await this.db.client.actionItem.create({ data: { ...itemData, meetingId: meeting.id, userId } });
      }
    }

    return toMeetingDto(meeting);
  }
}