import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserRole, UserStatus } from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import { AppError } from "../../core/errors.ts";
import { hashSessionToken } from "./password.ts";

export const AUTH_COOKIE = "callnotes.sid";

/** Identity resolved from an authenticated session - never client-supplied. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth guard when a valid session cookie is presented. */
    authUser?: AuthUser;
    /** Session row id of the active session (used for revocation). */
    authSessionId?: string;
  }
}

/** Error details shared by every authentication failure path. */
function unauthorized(message = "Authentication required"): AppError {
  return new AppError("UNAUTHORIZED", message);
}

/** Resolves the request identity from the session cookie and DB session row. */
export async function resolveAuthUser(
  request: FastifyRequest,
  db: Database,
  enabled = true,
): Promise<void> {
  const rawToken = request.cookies?.[AUTH_COOKIE];
  if (!rawToken) throw unauthorized();

  const session = await db.client.session.findFirst({
    where: {
      tokenHash: hashSessionToken(rawToken),
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: true },
  });

  if (!session || !session.user) throw unauthorized();

  if (enabled && session.user.status !== "ACTIVE") {
    // Disabled accounts lose their sessions immediately.
    await db.client.session.delete({ where: { id: session.id } }).catch(() => {});
    throw unauthorized("Account is disabled");
  }

  request.authUser = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    status: session.user.status,
  };
  request.authSessionId = session.id;
}

/** PreHandler guard: rejects unauthenticated requests with 401. */
export function requireAuth(db: Database, options?: { statusCheck?: boolean }) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await resolveAuthUser(request, db, options?.statusCheck ?? true);
  };
}

/** PreHandler guard: requires authentication plus one of the given roles. */
export function requireRole(db: Database, roles: readonly UserRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await resolveAuthUser(request, db);
    if (!request.authUser || !roles.includes(request.authUser.role)) {
      throw new AppError("FORBIDDEN", "Insufficient permissions");
    }
  };
}