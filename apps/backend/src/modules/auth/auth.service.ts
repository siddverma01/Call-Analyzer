import type {
  AuthResponse,
  ChangePasswordRequest,
  LoginRequest,
  MeResponse,
  RegisterRequest,
} from "@callnotes/shared";
import type { Database } from "../../db/prisma.ts";
import { Prisma } from "../../../generated/prisma/client.ts";
import { AppError } from "../../core/errors.ts";
import type { AuditService } from "../audit/audit.service.ts";
import type { SessionStore } from "./session-store.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { toPublicUser } from "../users/user.mapper.ts";

export interface AuthResult extends AuthResponse {
  sessionId: string;
  token: string;
}

interface TransientContext {
  userAgent?: string;
  ip?: string;
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessions: SessionStore,
    private readonly audit: AuditService,
  ) {}

  async register(input: RegisterRequest, transient: TransientContext): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.db.client.user.findUnique({ where: { email } });
    if (existing) {
      throw new AppError("CONFLICT", "An account with this email already exists");
    }

    let user;
    try {
      user = await this.db.client.user.create({
        data: {
          email,
          name: input.name.trim(),
          passwordHash: await hashPassword(input.password),
          role: "USER",
          status: "ACTIVE",
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError("CONFLICT", "An account with this email already exists");
      }
      throw error;
    }

    await this.audit.record({ userId: user.id, action: "USER_CREATED", resource: "user", resourceId: user.id });

    const session = await this.sessions.createSession(user.id, transient);
    return {
      user: toPublicUser(user),
      sessionExpiresAt: session.expiresAt.toISOString(),
      sessionId: session.sessionId,
      token: session.token,
    };
  }

  async login(input: LoginRequest, transient: TransientContext): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    const user = await this.db.client.user.findUnique({ where: { email } });

    // Run a dummy verification for unknown emails to keep timing uniform.
    const hash = user ? user.passwordHash : "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const isValid = await verifyPassword(hash, input.password);
    if (!user || !isValid) {
      throw new AppError("UNAUTHORIZED", "Invalid email or password");
    }
    if (user.status !== "ACTIVE") {
      throw new AppError("FORBIDDEN", "This account is disabled");
    }

    await this.audit.record({ userId: user.id, action: "auth.login", resource: "user", resourceId: user.id });
    if (user.role === "ADMIN") {
      await this.audit.record({ userId: user.id, action: "ADMIN_LOGIN", resource: "admin", resourceId: user.id });
    }

    const session = await this.sessions.createSession(user.id, transient);
    return {
      user: toPublicUser(user),
      sessionExpiresAt: session.expiresAt.toISOString(),
      sessionId: session.sessionId,
      token: session.token,
    };
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId) {
      await this.sessions.revokeSession(sessionId);
    }
  }

  async currentUser(userId: string): Promise<MeResponse> {
    const user = await this.db.client.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("UNAUTHORIZED", "Account no longer exists");
    return toPublicUser(user);
  }

  async changePassword(
    userId: string,
    sessionId: string,
    input: ChangePasswordRequest,
  ): Promise<void> {
    const user = await this.db.client.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("UNAUTHORIZED", "Account no longer exists");

    const currentOk = await verifyPassword(user.passwordHash, input.currentPassword);
    if (!currentOk) throw new AppError("VALIDATION_ERROR", "Current password is incorrect");

    if (input.currentPassword === input.newPassword) {
      throw new AppError("VALIDATION_ERROR", "New password must differ from the current one");
    }

    const passwordHash = await hashPassword(input.newPassword);
    await this.db.client.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    // Force a re-login everywhere except the session that performed the change.
    await this.sessions.revokeAllExcept(user.id, sessionId);
    await this.audit.record({ userId: user.id, action: "auth.password_change", resource: "user", resourceId: user.id });
  }
}