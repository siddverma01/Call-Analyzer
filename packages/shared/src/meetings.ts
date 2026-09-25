import { z } from "zod";
import { MEETING_STATUSES } from "./enums.ts";

/** Meeting create/update payloads and DTOs. */

export const createMeetingRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  templateId: z.string().min(1).optional(),
  startedAt: z.coerce.date().optional(),
}).strict();

export type CreateMeetingRequest = z.infer<typeof createMeetingRequestSchema>;

export const updateMeetingRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.enum(MEETING_STATUSES).optional(),
  endedAt: z.coerce.date().optional(),
}).strict();

export type UpdateMeetingRequest = z.infer<typeof updateMeetingRequestSchema>;

export const meetingSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  startedAt: z.date().nullable(),
  endedAt: z.date().nullable(),
  durationSeconds: z.number().int().nonnegative(),
  status: z.enum(MEETING_STATUSES),
  templateId: z.string().nullable(),
  summary: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type MeetingDto = z.infer<typeof meetingSchema>;

export const meetingListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  startedAt: z.date().nullable(),
  endedAt: z.date().nullable(),
  durationSeconds: z.number().int().nonnegative(),
  status: z.enum(MEETING_STATUSES),
  templateId: z.string().nullable(),
  templateName: z.string().nullable(),
  summaryPreview: z.string().nullable(),
  actionItemCount: z.number().int().nonnegative(),
  createdAt: z.date(),
});

export type MeetingListItem = z.infer<typeof meetingListItemSchema>;

/** Single transcript segment returned inside a meeting detail. */
export const transcriptSegmentSchema = z.object({
  id: z.string(),
  speaker: z.string(),
  startTime: z.date(),
  endTime: z.date(),
  text: z.string(),
  confidence: z.number().nullable(),
  isEdited: z.boolean(),
});

export type TranscriptSegmentDto = z.infer<typeof transcriptSegmentSchema>;

/** Structured notes attached to a meeting. */
export const meetingSummarySchema = z.object({
  id: z.string(),
  summary: z.string(),
  discussionPoints: z.unknown().nullable(),
  decisions: z.unknown().nullable(),
  risks: z.unknown().nullable(),
  openQuestions: z.unknown().nullable(),
  blockers: z.unknown().nullable(),
  followUps: z.unknown().nullable(),
  importantDates: z.unknown().nullable(),
  participants: z.unknown().nullable(),
  aiModel: z.string().nullable(),
  aiProvider: z.string().nullable(),
});

export type MeetingSummaryDto = z.infer<typeof meetingSummarySchema>;

/** Full meeting resource: metadata plus transcript segments and notes. */
export const meetingDetailSchema = z.object({
  meeting: meetingSchema,
  segments: z.array(transcriptSegmentSchema),
  summary: meetingSummarySchema.nullable(),
});

export type MeetingDetailDto = z.infer<typeof meetingDetailSchema>;

/** Sort orders supported by the meeting list endpoint. */
export const MEETING_SORTS = ["newest", "oldest", "title", "duration", "updated"] as const;
export type MeetingSort = (typeof MEETING_SORTS)[number];

/**
 * Query params for `GET /api/meetings`. When `q` is present the server runs a
 * Postgres full-text search over the meeting's search vector (title,
 * transcript, summary, decisions, action items) scoped to the caller.
 */
export const meetingListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  status: z.enum(MEETING_STATUSES).optional(),
  templateId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(MEETING_SORTS).optional(),
});

export type MeetingListQuery = z.infer<typeof meetingListQuerySchema>;