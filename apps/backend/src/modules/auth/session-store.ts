import type { BackendEnv } from "@callnotes/config";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { Database } from "../../db/prisma.ts";
import { generateSessionToken, hashSessionToken } from "./password.ts";

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

/** Server-side session persistence: tokens are stored SHA-256 hashed only. */
export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly env: BackendEnv,
  ) {}

  get ttlSeconds(): number {
    return Math.round(this.env.SESSION_TTL_DAYS * 24 * 60 * 60);
  }

  /** Cookie serialization options for the session cookie. */
  cookieOptions(overrides: Partial<CookieSerializeOptions> = {}): CookieSerializeOptions {
    return {
      httpOnly: true,
      sameSite: this.env.COOKIE_SAME_SITE,
      secure: this.env.COOKIE_SECURE,
      path: "/",
      maxAge: this.ttlSeconds,
      ...overrides,
    };
  }

  /** Creates a session row and returns the raw token (shown once to client). */
  async createSession(
    userId: string,
    transient: { userAgent?: string; ip?: string },
  ): Promise<CreatedSession> {
    await this.deleteExpiredFor(userId);

    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const session = await this.db.client.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt,
        userAgent: transient.userAgent?.slice(0, 300),
        ip: transient.ip,
      },
    });

    return { token, sessionId: session.id, expiresAt };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.client.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revokes every session belonging to a user except the given one. */
  async revokeAllExcept(userId: string, keepSessionId: string): Promise<void> {
    await this.db.client.session.updateMany({
      where: { userId, revokedAt: null, NOT: { id: keepSessionId } },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async deleteExpiredFor(userId: string): Promise<void> {
    await this.db.client.session.deleteMany({
      where: { userId, expiresAt: { lte: new Date() } },
    });
  }
}