import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallNotesBridge, SerializedUser } from "@callnotes/shared";

const USER: SerializedUser = {
  id: "u1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  role: "USER",
  status: "ACTIVE",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SESSION_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

interface FreshModules {
  useAuthStore: typeof import("../src/renderer/src/stores/authStore").useAuthStore;
  BridgeError: typeof import("../src/renderer/src/lib/api").BridgeError;
  callnotes: CallNotesBridge;
}

/** Fresh module instances per test so the module-level `bootPromise` resets. */
async function freshModules(): Promise<FreshModules> {
  vi.resetModules();
  const callnotes = {
    session: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
  } as unknown as CallNotesBridge;
  vi.stubGlobal("window", { callnotes });
  const authStoreModule = await import("../src/renderer/src/stores/authStore");
  const apiModule = await import("../src/renderer/src/lib/api");
  return { useAuthStore: authStoreModule.useAuthStore, BridgeError: apiModule.BridgeError, callnotes };
}

function authenticatedResult(): {
  ok: true;
  data: { state: "authenticated"; user: SerializedUser; sessionExpiresAt: string };
} {
  return { ok: true, data: { state: "authenticated", user: USER, sessionExpiresAt: SESSION_EXPIRES_AT } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bootstrap", () => {
  it("resolves a stored session to authenticated", async () => {
    const { useAuthStore, callnotes } = await freshModules();
    (callnotes.session as ReturnType<typeof vi.fn>).mockResolvedValue(authenticatedResult());

    expect(useAuthStore.getState().phase).toBe("booting");
    await useAuthStore.getState().bootstrap();

    const state = useAuthStore.getState();
    expect(state.phase).toBe("authenticated");
    expect(state.user?.email).toBe("ada@example.com");
    expect(state.sessionExpiresAt).toBe(SESSION_EXPIRES_AT);
    expect(state.bootstrapped).toBe(true);
  });

  it("resolves an anonymous session when the backend returns anonymous", async () => {
    const { useAuthStore, callnotes } = await freshModules();
    (callnotes.session as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { state: "anonymous" } });

    await useAuthStore.getState().bootstrap();

    expect(useAuthStore.getState().phase).toBe("anonymous");
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("falls back to anonymous when the backend is unreachable", async () => {
    const { useAuthStore, callnotes } = await freshModules();
    (callnotes.session as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));

    await useAuthStore.getState().bootstrap();

    const state = useAuthStore.getState();
    expect(state.phase).toBe("anonymous");
    expect(state.error).toContain("Could not reach the backend");
  });
});

describe("login", () => {
  it("authenticates on a successful login", async () => {
    const { useAuthStore, callnotes } = await freshModules();
    (callnotes.session as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { state: "anonymous" } });
    (callnotes.login as ReturnType<typeof vi.fn>).mockResolvedValue(authenticatedResult());

    const ok = await useAuthStore.getState().login("ada@example.com", "s3cret");

    expect(ok).toBe(true);
    const state = useAuthStore.getState();
    expect(state.phase).toBe("authenticated");
    expect(state.user?.id).toBe("u1");
  });

  it("surfaces a non-ok response as an error", async () => {
    const { useAuthStore, callnotes } = await freshModules();
    (callnotes.session as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { state: "anonymous" } });
    (callnotes.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: { code: "INVALID_CREDENTIALS", message: "Bad email or password", status: 401 },
    });

    const ok = await useAuthStore.getState().login("ada@example.com", "wrong");

    expect(ok).toBe(false);
    expect(useAuthStore.getState().phase).toBe("anonymous");
    expect(useAuthStore.getState().error).toBe("Bad email or password");
  });

  it("flips to expired when the backend rejects the session", async () => {
    const { useAuthStore, BridgeError, callnotes } = await freshModules();
    (callnotes.session as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { state: "anonymous" } });
    (callnotes.login as ReturnType<typeof vi.fn>).mockRejectedValue(
      new BridgeError("UNAUTHORIZED", "Session expired", 401),
    );

    const ok = await useAuthStore.getState().login("ada@example.com", "s3cret");

    expect(ok).toBe(false);
    expect(useAuthStore.getState().phase).toBe("expired");
  });
});

describe("logout", () => {
  it("clears local session even if the remote call throws", async () => {
    const { useAuthStore, callnotes } = await freshModules();
    (callnotes.logout as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));

    useAuthStore.setState({ phase: "authenticated", user: USER, sessionExpiresAt: SESSION_EXPIRES_AT });
    await useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.phase).toBe("anonymous");
    expect(state.user).toBeNull();
    expect(state.sessionExpiresAt).toBeNull();
  });
});

describe("changePassword", () => {
  it("reports success and failure", async () => {
    const { useAuthStore, callnotes } = await freshModules();
    const fn = callnotes.changePassword as ReturnType<typeof vi.fn>;
    fn.mockResolvedValueOnce({ ok: true, data: { ok: true } });
    fn.mockResolvedValueOnce({
      ok: false,
      error: { code: "BAD_CURRENT_PASSWORD", message: "Wrong current password", status: 400 },
    });

    expect(await useAuthStore.getState().changePassword("old", "new")).toBe(true);
    expect(await useAuthStore.getState().changePassword("wrong", "new")).toBe(false);
    expect(useAuthStore.getState().error).toBe("Wrong current password");
  });
});