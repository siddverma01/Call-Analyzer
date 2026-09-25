import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  meResponseSchema,
  registerRequestSchema,
} from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import type { BackendEnv } from "@callnotes/config";
import type { AuthResult } from "./auth.service.ts";
import { parse } from "../../core/errors.ts";
import { AUTH_COOKIE, requireAuth, resolveAuthUser } from "./guards.ts";
import { AuthService } from "./auth.service.ts";
import type { AuditService } from "../audit/audit.service.ts";
import type { SessionStore } from "./session-store.ts";

export interface AuthDeps {
  db: Database;
  env: BackendEnv;
  sessions: SessionStore;
  audit: AuditService;
}

function clientInfo(request: FastifyRequest): { userAgent?: string; ip?: string } {
  return { userAgent: request.headers["user-agent"], ip: request.ip };
}

/** Registers the /api/auth/* endpoints. */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, sessions, audit } = deps;
  const service = new AuthService(db, sessions, audit);

  const replyAuth = (
    reply: FastifyReply,
    result: Pick<AuthResult, "token" | "sessionExpiresAt" | "user">,
  ) => {
    reply.setCookie(AUTH_COOKIE, result.token, sessions.cookieOptions());
    return { user: result.user, sessionExpiresAt: result.sessionExpiresAt };
  };

  app.post(
    "/api/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = parse(registerRequestSchema, request.body);
      const result = await service.register(body, clientInfo(request));
      reply.status(201);
      return replyAuth(reply, result);
    },
  );

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = parse(loginRequestSchema, request.body);
      return replyAuth(reply, await service.login(body, clientInfo(request)));
    },
  );

  app.post(
    "/api/auth/logout",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // Best-effort session revocation: an invalid/expired cookie still gets
      // a clean 204 and a cleared cookie.
      try {
        await resolveAuthUser(request, db);
      } catch {
        // ignore authentication failures on logout
      }
      const sessionId = request.authSessionId;
      await service.logout(sessionId);
      if (sessionId) {
        await audit.record({ userId: request.authUser?.id, action: "auth.logout", resource: "session" });
      }
      reply.clearCookie(AUTH_COOKIE, sessions.cookieOptions({ maxAge: undefined }));
      return { ok: true };
    },
  );

  app.get(
    "/api/me",
    {
      preHandler: [requireAuth(db)],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      const user = await service.currentUser(request.authUser!.id);
      return { user: meResponseSchema.parse(user) };
    },
  );

  app.patch(
    "/api/auth/password",
    {
      preHandler: [requireAuth(db)],
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = parse(changePasswordRequestSchema, request.body);
      await service.changePassword(request.authUser!.id, request.authSessionId!, body);
      reply.code(204).send();
    },
  );
}