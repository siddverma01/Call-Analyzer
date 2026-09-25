import { healthResponseSchema, type HealthResponse } from "@callnotes/shared";
import type {
  AdminMeetingPage,
  AdminStats,
  AdminUserDetail,
  AdminUserPage,
  AuditLogPage,
  ChangePasswordRequest,
  CreateActionItemRequest,
  CreateMeetingRequest,
  CreateTemplateRequest,
  ExportFormat,
  ExportPayload,
  ListParams,
  LoginRequest,
  MeetingListPage,
  MeetingListParams,
  MeetingSyncRequest,
  RegisterRequest,
  SerializedActionItem,
  SerializedAuthResponse,
  SerializedMeetingDetail,
  SerializedMeetingDto,
  SerializedTemplate,
  SerializedTemplateList,
  SerializedUser,
  SessionState,
  UpdateActionItemRequest,
  UpdateMeetingRequest,
  UpdateTemplateRequest,
  UserRole,
  UserStatus,
} from "@callnotes/shared";

/**
 * Error thrown when the backend returns a non-2xx response. Carries the
 * standardized `{ code, message }` body so the renderer can react to auth
 * failures, conflicts, and validation problems without parsing responses.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Minimal abstraction used by tests to control token persistence. */
export interface SessionStorage {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

const AUTH_COOKIE = "callnotes.sid";

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: unknown;
  timeoutMs?: number;
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * The only process that talks to the CallNotes backend over HTTP. Owns the
 * session cookie (loaded from encrypted storage at boot, refreshed on every
 * auth response). The renderer has no network access - it calls this through
 * the preload bridge.
 */
export class ApiClient {
  private sessionToken = "";
  private sessionExpiresAt: string | null = null;
  private booted = false;

  constructor(
    private readonly baseUrl: string,
    private readonly storage?: SessionStorage,
  ) {}

  /** Last known session expiry from the most recent login/register response. */
  getExpiry(): string | null {
    return this.sessionExpiresAt;
  }

  /** Loads a persisted session once. Fail-closed on any storage problem. */
  private async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    if (!this.storage) return;
    try {
      this.sessionToken = (await this.storage.load()) ?? "";
    } catch {
      this.sessionToken = "";
    }
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    await this.boot();

    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (this.sessionToken) headers["cookie"] = `${AUTH_COOKIE}=${this.sessionToken}`;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: timeoutSignal(options.timeoutMs ?? 15_000),
      redirect: "manual",
    });

    const setCookie = response.headers.get("set-cookie");
    const match = setCookie?.match(new RegExp(`${AUTH_COOKIE}=([^;]+)`));
    if (match?.[1]) {
      this.sessionToken = match[1];
      await (this.storage?.save(this.sessionToken).catch(() => undefined));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const payload = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;

    if (!response.ok) {
      const error = payload?.error;
      throw new ApiError(
        error?.code ?? "INTERNAL_ERROR",
        error?.message ?? `Request failed (${response.status})`,
        response.status,
      );
    }

    return payload as T;
  }

  /** Unauthenticated backend liveness probe. */
  async health(): Promise<HealthResponse> {
    const response = await fetch(`${this.baseUrl}/health`, {
      signal: timeoutSignal(3000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new ApiError("SERVICE_UNAVAILABLE", `Backend health returned ${response.status}`, response.status);
    }
    return healthResponseSchema.parse(await response.json());
  }

  async register(input: RegisterRequest): Promise<SerializedAuthResponse> {
    const result = await this.request<SerializedAuthResponse>("/api/auth/register", {
      method: "POST",
      body: input,
    });
    this.sessionExpiresAt = result.sessionExpiresAt;
    return result;
  }

  async login(input: LoginRequest): Promise<SerializedAuthResponse> {
    const result = await this.request<SerializedAuthResponse>("/api/auth/login", { method: "POST", body: input });
    this.sessionExpiresAt = result.sessionExpiresAt;
    return result;
  }

  /** Boot-time session check. An expired/invalid session resolves to anonymous. */
  async sessionInfo(): Promise<SessionState> {
    let user: SerializedUser;
    try {
      user = await this.me();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.code === "UNAUTHORIZED")) {
        this.sessionToken = "";
        this.sessionExpiresAt = null;
        await (this.storage?.clear().catch(() => undefined));
        return { state: "anonymous" };
      }
      throw error;
    }
    return { state: "authenticated", user, sessionExpiresAt: this.getExpiry() };
  }

  async me(): Promise<SerializedUser> {
    const res = await this.request<{ user: SerializedUser }>("/api/me");
    return res.user;
  }

  async logout(): Promise<{ ok: boolean }> {
    try {
      await this.request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    } finally {
      this.sessionToken = "";
      this.sessionExpiresAt = null;
      await (this.storage?.clear().catch(() => undefined));
    }
    return { ok: true };
  }

  async changePassword(input: ChangePasswordRequest): Promise<{ ok: boolean }> {
    await this.request<void>("/api/auth/password", { method: "PATCH", body: input });
    return { ok: true };
  }

  async listMeetings(params?: MeetingListParams): Promise<MeetingListPage> {
    const query = encodeListParams(params);
    return this.request<MeetingListPage>(`/api/meetings${query}`);
  }

  async createMeeting(input: CreateMeetingRequest): Promise<SerializedMeetingDto> {
    return this.request<SerializedMeetingDto>("/api/meetings", { method: "POST", body: input });
  }

  /**
   * Idempotent offline-first upsert of one meeting (metadata, transcript,
   * summary details, action items). Re-delivering the same payload is safe.
   */
  async syncMeeting(payload: MeetingSyncRequest): Promise<SerializedMeetingDto> {
    return this.request<SerializedMeetingDto>("/api/meetings/sync", { method: "POST", body: payload });
  }

  async getMeeting(id: string): Promise<SerializedMeetingDetail> {
    return this.request<SerializedMeetingDetail>(`/api/meetings/${encodeURIComponent(id)}`);
  }

  async updateMeeting(id: string, input: UpdateMeetingRequest): Promise<SerializedMeetingDto> {
    return this.request<SerializedMeetingDto>(`/api/meetings/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: input,
    });
  }

  async deleteMeeting(id: string): Promise<{ ok: boolean }> {
    await this.request<void>(`/api/meetings/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  }

  /** Renders a meeting export; PDF content arrives base64-encoded. */
  async exportMeeting(id: string, format: ExportFormat): Promise<ExportPayload> {
    return this.request<ExportPayload>(`/api/meetings/${encodeURIComponent(id)}/export?format=${format}`);
  }

  async listTemplates(): Promise<SerializedTemplateList> {
    return this.request<SerializedTemplateList>("/api/templates");
  }

  async createTemplate(input: CreateTemplateRequest): Promise<SerializedTemplate> {
    return this.request<SerializedTemplate>("/api/templates", { method: "POST", body: input });
  }

  async updateTemplate(id: string, input: UpdateTemplateRequest): Promise<SerializedTemplate> {
    return this.request<SerializedTemplate>(`/api/templates/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: input,
    });
  }

  async deleteTemplate(id: string): Promise<{ ok: boolean }> {
    await this.request<void>(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  }

  async duplicateTemplate(id: string): Promise<SerializedTemplate> {
    return this.request<SerializedTemplate>(`/api/templates/${encodeURIComponent(id)}/duplicate`, {
      method: "POST",
    });
  }

  async setDefaultTemplate(templateId: string | null): Promise<{ ok: boolean }> {
    await this.request<void>("/api/templates/default", { method: "PUT", body: { templateId } });
    return { ok: true };
  }

  async listActionItems(): Promise<SerializedActionItem[]> {
    return this.request<SerializedActionItem[]>("/api/action-items");
  }

  async createActionItem(input: CreateActionItemRequest): Promise<SerializedActionItem> {
    return this.request<SerializedActionItem>("/api/action-items", { method: "POST", body: input });
  }

  async updateActionItem(id: string, input: UpdateActionItemRequest): Promise<SerializedActionItem> {
    return this.request<SerializedActionItem>(`/api/action-items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: input,
    });
  }

  async deleteActionItem(id: string): Promise<{ ok: boolean }> {
    await this.request<void>(`/api/action-items/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  }

  async adminListUsers(params?: ListParams): Promise<AdminUserPage> {
    const query = encodeListParams(params);
    return this.request<AdminUserPage>(`/api/admin/users${query}`);
  }

  async adminUpdateUserStatus(id: string, status: UserStatus): Promise<{ ok: boolean }> {
    await this.request<void>(`/api/admin/users/${encodeURIComponent(id)}/status`, {
      method: "PATCH",
      body: { status },
    });
    return { ok: true };
  }

  async adminUpdateUserRole(id: string, role: UserRole): Promise<{ ok: boolean }> {
    await this.request<void>(`/api/admin/users/${encodeURIComponent(id)}/role`, {
      method: "PATCH",
      body: { role },
    });
    return { ok: true };
  }

  async adminListMeetings(params?: ListParams): Promise<AdminMeetingPage> {
    const query = encodeListParams(params);
    return this.request<AdminMeetingPage>(`/api/admin/meetings${query}`);
  }

  async adminListAuditLogs(params?: ListParams): Promise<AuditLogPage> {
    const query = encodeListParams(params);
    return this.request<AuditLogPage>(`/api/admin/audit-logs${query}`);
  }

  async adminStats(): Promise<AdminStats> {
    return this.request<AdminStats>(`/api/admin/stats`);
  }

  async adminGetUserDetail(id: string): Promise<AdminUserDetail> {
    return this.request<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`);
  }
}

function encodeListParams(params?: MeetingListParams): string {
  if (!params) return "";
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.perPage !== undefined) search.set("perPage", String(params.perPage));
  if (params.q !== undefined && params.q !== "") search.set("q", params.q);
  if (params.status !== undefined) search.set("status", params.status);
  if (params.templateId !== undefined) search.set("templateId", params.templateId);
  if (params.from !== undefined) search.set("from", params.from);
  if (params.to !== undefined) search.set("to", params.to);
  if (params.sort !== undefined) search.set("sort", params.sort);
  const value = search.toString();
  return value ? `?${value}` : "";
}