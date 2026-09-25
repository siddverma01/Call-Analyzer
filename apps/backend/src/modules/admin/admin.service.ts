import type { AdminStats, UserRole, UserStatus } from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import { AppError } from "../../core/errors.ts";
import type { AuditService } from "../audit/audit.service.ts";
import { toPublicUser } from "../users/user.mapper.ts";

export interface AdminUserListItem extends ReturnType<typeof toPublicUser> {
  meetingCount: number;
  lastActivityAt: string | null;
}

export interface AdminUserPage {
  items: AdminUserListItem[];
  total: number;
  page: number;
  perPage: number;
}

export interface AdminMeetingListItem {
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
  ownerEmail: string;
  ownerName: string;
}

export interface AdminMeetingPage {
  items: AdminMeetingListItem[];
  total: number;
  page: number;
  perPage: number;
}

interface ActivityTimestamp {
  userId: string;
  at: Date | null;
}

/** Backend row shape of the admin user detail (dates are JSON-serialized). */
export interface AdminUserDetailRow {
  user: AdminUserListItem;
  stats: {
    meetingCount: number;
    actionItemCount: number;
    totalDurationSeconds: number;
    lastActivityAt: string | null;
  };
  meetings: AdminMeetingListItem[];
  actionItems: Array<{
    id: string;
    meetingId: string | null;
    meetingTitle: string | null;
    description: string;
    assignee: string | null;
    dueDate: Date | null;
    priority: string;
    status: string;
    sourceSegmentId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
}

export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async listUsers(page = 1, perPage = 20): Promise<AdminUserPage> {
    const skip = Math.max(0, (page - 1) * perPage);
    const [rows, total, meetingCounts, lastActivities] = await Promise.all([
      this.db.client.user.findMany({
        orderBy: { createdAt: "asc" },
        skip,
        take: Math.min(100, perPage),
      }),
      this.db.client.user.count(),
      this.db.client.meeting.groupBy({ by: ["userId"], _count: { _all: true } }),
      this.lastActivityMap(),
    ]);

    return {
      items: rows.map((user) => ({
        ...toPublicUser(user),
        meetingCount: meetingCounts.find((m) => m.userId === user.id)?._count._all ?? 0,
        lastActivityAt: lastActivities.get(user.id)?.toISOString() ?? null,
      })),
      total,
      page,
      perPage,
    };
  }

  /** Aggregate numbers for the admin dashboard. */
  async getStats(): Promise<AdminStats> {
    const [totalUsers, activeUsers, meetingAgg, totalActionItems] = await Promise.all([
      this.db.client.user.count(),
      this.db.client.user.count({ where: { status: "ACTIVE" } }),
      this.db.client.meeting.aggregate({
        _count: { _all: true },
        _sum: { durationSeconds: true },
      }),
      this.db.client.actionItem.count(),
    ]);

    return {
      totalUsers,
      activeUsers,
      totalMeetings: meetingAgg._count._all,
      totalTranscribedMinutes: Math.round((meetingAgg._sum.durationSeconds ?? 0) / 60),
      totalActionItems,
    };
  }

  /** Full admin detail view for one user: profile, stats, meetings, and tasks. */
  async getUserDetail(userId: string): Promise<AdminUserDetailRow> {
    const [user, [meetings, actionItems], meetingCount, durationSeconds, lastActivities] = await Promise.all([
      this.db.client.user.findUnique({ where: { id: userId } }),
      Promise.all([
        this.db.client.meeting.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          include: {
            template: { select: { name: true } },
            _count: { select: { actionItems: true } },
          },
        }),
        this.db.client.actionItem.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          include: { meeting: { select: { title: true } } },
        }),
      ]),
      this.db.client.meeting.count({ where: { userId } }),
      this.db.client.meeting.aggregate({ where: { userId }, _sum: { durationSeconds: true } }),
      this.lastActivityMap(),
    ]);
    if (!user) throw new AppError("NOT_FOUND", "User not found");

    const lastActivityAt = lastActivities.get(user.id)?.toISOString() ?? null;

    return {
      user: {
        ...toPublicUser(user),
        meetingCount,
        lastActivityAt,
      },
      stats: {
        meetingCount,
        actionItemCount: actionItems.length,
        totalDurationSeconds: durationSeconds._sum.durationSeconds ?? 0,
        lastActivityAt,
      },
      meetings: meetings.map((m) => ({
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
        ownerEmail: user.email,
        ownerName: user.name,
      })),
      actionItems: actionItems.map((item) => ({
        id: item.id,
        meetingId: item.meetingId,
        meetingTitle: item.meeting?.title ?? null,
        description: item.description,
        assignee: item.assignee,
        dueDate: item.dueDate,
        priority: item.priority,
        status: item.status,
        sourceSegmentId: item.sourceSegmentId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    };
  }

  async updateStatus(actorId: string, targetId: string, status: UserStatus): Promise<void> {
    const target = await this.db.client.user.findUnique({ where: { id: targetId } });
    if (!target) throw new AppError("NOT_FOUND", "User not found");
    if (target.id === actorId) {
      throw new AppError("FORBIDDEN", "You cannot change your own account status");
    }
    if (status === "DISABLED" && target.role === "ADMIN") {
      await this.ensureNotLastAdmin(targetId);
    }
    if (target.status === status) {
      return;
    }

    await this.db.client.user.update({ where: { id: targetId }, data: { status } });
    await this.audit.record({
      userId: actorId,
      action: status === "DISABLED" ? "USER_DISABLED" : "USER_ENABLED",
      resource: "user",
      resourceId: targetId,
      metadata: { from: target.status, to: status },
    });
  }

  async updateRole(actorId: string, targetId: string, role: UserRole): Promise<void> {
    const target = await this.db.client.user.findUnique({ where: { id: targetId } });
    if (!target) throw new AppError("NOT_FOUND", "User not found");
    if (target.id === actorId) {
      throw new AppError("FORBIDDEN", "You cannot change your own role");
    }
    if (target.role === "ADMIN" && role !== "ADMIN") {
      await this.ensureNotLastAdmin(targetId);
    }
    if (target.role === role) {
      return;
    }

    await this.db.client.user.update({ where: { id: targetId }, data: { role } });
    await this.audit.record({
      userId: actorId,
      action: "USER_ROLE_CHANGED",
      resource: "user",
      resourceId: targetId,
      metadata: { from: target.role, to: role },
    });
  }

  async listAuditLogs(page = 1, perPage = 20): Promise<{
    items: {
      id: string;
      action: string;
      resource: string;
      resourceId: string | null;
      metadata: unknown;
      createdAt: Date;
      actor: { id: string; email: string } | null;
    }[];
    total: number;
    page: number;
    perPage: number;
  }> {
    const skip = Math.max(0, (page - 1) * perPage);
    const [rows, total] = await Promise.all([
      this.db.client.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: Math.min(100, perPage),
        include: { user: { select: { id: true, email: true } } },
      }),
      this.db.client.auditLog.count(),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        resource: row.resource,
        resourceId: row.resourceId,
        metadata: row.metadata,
        createdAt: row.createdAt,
        actor: row.user,
      })),
      total,
      page,
      perPage,
    };
  }

  /** Every meeting in the system, with its owner. Admin-only. */
  async listAllMeetings(page = 1, perPage = 20): Promise<AdminMeetingPage> {
    const skip = Math.max(0, (page - 1) * perPage);
    const [rows, total] = await Promise.all([
      this.db.client.meeting.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: Math.min(100, perPage),
        include: {
          template: { select: { name: true } },
          user: { select: { email: true, name: true } },
          _count: { select: { actionItems: true } },
        },
      }),
      this.db.client.meeting.count(),
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
        ownerEmail: m.user?.email ?? "",
        ownerName: m.user?.name ?? "",
      })),
      total,
      page,
      perPage,
    };
  }

  /**
   * Latest activity timestamp per user, derived from the newest of their
   * sessions, meetings, and action items. Aggregations avoid loading full rows.
   */
  private async lastActivityMap(): Promise<Map<string, Date>> {
    const [sessions, meetings, actionItems] = await Promise.all([
      this.db.client.session.groupBy({ by: ["userId"], _max: { createdAt: true } }),
      this.db.client.meeting.groupBy({ by: ["userId"], _max: { updatedAt: true } }),
      this.db.client.actionItem.groupBy({ by: ["userId"], _max: { updatedAt: true } }),
    ]);

    const timestamps: ActivityTimestamp[] = [];
    for (const row of sessions) timestamps.push({ userId: row.userId, at: row._max.createdAt });
    for (const row of meetings) timestamps.push({ userId: row.userId, at: row._max.updatedAt });
    for (const row of actionItems) timestamps.push({ userId: row.userId, at: row._max.updatedAt });

    const latest = new Map<string, Date>();
    for (const entry of timestamps) {
      if (!entry.at) continue;
      const current = latest.get(entry.userId);
      if (!current || entry.at > current) latest.set(entry.userId, entry.at);
    }
    return latest;
  }

  /** Guards the "at least one active ADMIN" invariant. */
  private async ensureNotLastAdmin(adminId: string): Promise<void> {
    const count = await this.db.client.user.count({
      where: { role: "ADMIN", status: "ACTIVE", NOT: { id: adminId } },
    });
    if (count === 0) {
      throw new AppError("FORBIDDEN", "Cannot disable or demote the last active admin");
    }
  }
}