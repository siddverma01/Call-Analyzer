export const USER_ROLES = ["USER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const MEETING_STATUSES = [
  "DRAFT",
  "STARTING",
  "RECORDING",
  "PROCESSING",
  "COMPLETED",
  "SYNC_PENDING",
  "SYNCED",
  "FAILED",
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const ACTION_ITEM_STATUSES = ["OPEN", "IN_PROGRESS", "COMPLETED"] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TEMPLATE_TYPES = ["SYSTEM", "CUSTOM"] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export const MEETING_LIFE_CYCLE: readonly [MeetingStatus, ...MeetingStatus[]] = [
  "DRAFT",
  "STARTING",
  "RECORDING",
  "PROCESSING",
  "COMPLETED",
  "SYNC_PENDING",
  "SYNCED",
];