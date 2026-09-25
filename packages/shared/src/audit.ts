/**
 * Canonical set of security-relevant audit events recorded by the backend.
 *
 * `ADMIN_LOGIN` is recorded on top of the regular `auth.login` when the actor
 * is an administrator, so admin activity is filterable without a separate
 * table. Metadata associated with any event must never contain passwords,
 * tokens, raw audio, or other secrets - only identifiers and labels.
 */
export const AUDIT_ACTIONS = {
  LOGIN: "auth.login",
  LOGOUT: "auth.logout",
  PASSWORD_CHANGED: "auth.password_change",

  ADMIN_LOGIN: "ADMIN_LOGIN",
  USER_CREATED: "USER_CREATED",
  USER_DISABLED: "USER_DISABLED",
  USER_ENABLED: "USER_ENABLED",
  USER_ROLE_CHANGED: "USER_ROLE_CHANGED",
  MEETING_VIEWED: "MEETING_VIEWED",
  MEETING_DELETED: "MEETING_DELETED",
  TEMPLATE_CHANGED: "TEMPLATE_CHANGED",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Human-readable labels shown in the admin audit log UI. */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  [AUDIT_ACTIONS.LOGIN]: "User signed in",
  [AUDIT_ACTIONS.LOGOUT]: "User signed out",
  [AUDIT_ACTIONS.PASSWORD_CHANGED]: "Password changed",
  [AUDIT_ACTIONS.ADMIN_LOGIN]: "Admin signed in",
  [AUDIT_ACTIONS.USER_CREATED]: "User created",
  [AUDIT_ACTIONS.USER_DISABLED]: "User disabled",
  [AUDIT_ACTIONS.USER_ENABLED]: "User enabled",
  [AUDIT_ACTIONS.USER_ROLE_CHANGED]: "User role changed",
  [AUDIT_ACTIONS.MEETING_VIEWED]: "Meeting viewed",
  [AUDIT_ACTIONS.MEETING_DELETED]: "Meeting deleted",
  [AUDIT_ACTIONS.TEMPLATE_CHANGED]: "Template changed",
};