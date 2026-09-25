import { z } from "zod";
import { ACTION_ITEM_STATUSES, PRIORITIES } from "./enums.ts";

/**
 * Action item / task DTO. `meetingTitle` is the owning meeting's title so the
 * desktop Tasks view can group items without a separate lookup. Tasks created
 * directly (not linked to a meeting) have `meetingId`/`meetingTitle` of null.
 */
export const actionItemSchema = z.object({
  id: z.string(),
  meetingId: z.string().nullable(),
  meetingTitle: z.string().nullable(),
  description: z.string(),
  assignee: z.string().nullable(),
  dueDate: z.date().nullable(),
  priority: z.enum(PRIORITIES),
  status: z.enum(ACTION_ITEM_STATUSES),
  sourceSegmentId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ActionItemDto = z.infer<typeof actionItemSchema>;

export const createActionItemRequestSchema = z.object({
  meetingId: z.string().min(1).optional(),
  description: z.string().min(1).max(2000),
  assignee: z.string().max(200).nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(ACTION_ITEM_STATUSES).optional(),
}).strict();

export type CreateActionItemRequest = z.infer<typeof createActionItemRequestSchema>;

export const updateActionItemRequestSchema = z.object({
  description: z.string().min(1).max(2000).optional(),
  assignee: z.string().max(200).nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(ACTION_ITEM_STATUSES).optional(),
}).strict();

export type UpdateActionItemRequest = z.infer<typeof updateActionItemRequestSchema>;

/** Filters accepted by the task list endpoint (no filter = everything). */
export const actionItemListQuerySchema = z.object({
  status: z.enum(ACTION_ITEM_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  meetingId: z.string().optional(),
});

export type ActionItemListQuery = z.infer<typeof actionItemListQuerySchema>;