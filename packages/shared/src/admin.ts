import type {
  SerializedActionItem,
  SerializedAdminMeetingListItem,
  SerializedUser,
} from "./ipc.ts";

/**
 * Admin console contracts.
 *
 * Admin endpoints/decisions are always backed by role enforcement server-side;
 * these types only shape the payloads crossing the desktop IPC bridge.
 */

/** Admin user list item: the public profile plus per-user usage counters. */
export interface SerializedAdminUserListItem extends SerializedUser {
  meetingCount: number;
  lastActivityAt: string | null;
}

/** Aggregate numbers surfaced on the admin dashboard. */
export interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  totalMeetings: number;
  totalTranscribedMinutes: number;
  totalActionItems: number;
}

/** One user's full admin detail view: profile + stats + meetings + tasks. */
export interface AdminUserDetail {
  user: SerializedAdminUserListItem;
  stats: {
    meetingCount: number;
    actionItemCount: number;
    totalDurationSeconds: number;
    lastActivityAt: string | null;
  };
  meetings: SerializedAdminMeetingListItem[];
  actionItems: SerializedActionItem[];
}