import { z } from "zod";
import { USER_ROLES, USER_STATUSES } from "./enums.ts";

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UserDto = z.infer<typeof userSchema>;

/** Public identity exposed by `/api/me`. */
export const meResponseSchema = userSchema.omit({ updatedAt: true });

export type MeResponse = z.infer<typeof meResponseSchema>;

/** Registration request (public). */
export const registerRequestSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  password: z.string().min(10).max(128),
}).strict();

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
}).strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Request to change the authenticated user's password. */
export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(10).max(128),
});

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/**
 * Response for successful registration/login. Authentication is carried by a
 * secure HttpOnly session cookie; the body only ever exposes the user.
 */
export const authResponseSchema = z.object({
  user: meResponseSchema,
  sessionExpiresAt: z.string(),
});

export type AuthResponse = z.infer<typeof authResponseSchema>;