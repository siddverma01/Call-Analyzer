import { create } from "zustand";
import type { SerializedUser } from "@callnotes/shared";
import { isUnauthorized } from "../lib/api";

export type SessionPhase = "booting" | "anonymous" | "authenticated" | "expired";

interface AuthState {
  phase: SessionPhase;
  user: SerializedUser | null;
  sessionExpiresAt: string | null;
  busy: boolean;
  error: string | null;
  bootstrapped: boolean;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  register: (name: string, email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<boolean>;
  setError: (error: string | null) => void;
  expireSession: () => void;
  clearError: () => void;
}

let bootPromise: Promise<void> | null = null;

/** Wraps all auth IPC calls so a session failure flips the UI to "expired". */
function wrapAuthError(error: unknown, store: ReturnType<typeof useAuthStore.getState>): void {
  if (isUnauthorized(error)) {
    store.expireSession();
  } else if (error instanceof Error) {
    store.setError(error.message);
  } else {
    store.setError("Unexpected error");
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  phase: "booting",
  user: null,
  sessionExpiresAt: null,
  busy: false,
  error: null,
  bootstrapped: false,

  bootstrap: async () => {
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      const state = get();
      if (state.phase !== "booting" && state.bootstrapped) return;
      try {
        const result = await window.callnotes.session();
        if (result.ok) {
          if (result.data.state === "authenticated") {
            set({
              phase: "authenticated",
              user: result.data.user,
              sessionExpiresAt: result.data.sessionExpiresAt,
            });
          } else {
            set({ phase: "anonymous", user: null, sessionExpiresAt: null });
          }
        } else {
          set({ phase: "anonymous", error: result.error.message });
        }
      } catch {
        set({ phase: "anonymous", error: "Could not reach the backend at the configured URL." });
      } finally {
        set({ bootstrapped: true });
      }
    })();
    return bootPromise;
  },

  login: async (email, password) => {
    const store = get();
    await store.bootstrap();
    set({ busy: true, error: null });
    try {
      const result = await window.callnotes.login({ email, password });
      if (!result.ok) {
        set({ busy: false, error: result.error.message });
        return false;
      }
      set({
        busy: false,
        phase: "authenticated",
        user: result.data.user,
        sessionExpiresAt: result.data.sessionExpiresAt,
        error: null,
      });
      return true;
    } catch (error) {
      set({ busy: false });
      wrapAuthError(error, get());
      return false;
    }
  },

  register: async (name, email, password) => {
    const store = get();
    await store.bootstrap();
    set({ busy: true, error: null });
    try {
      const result = await window.callnotes.register({ name, email, password });
      if (!result.ok) {
        set({ busy: false, error: result.error.message });
        return false;
      }
      set({
        busy: false,
        phase: "authenticated",
        user: result.data.user,
        sessionExpiresAt: result.data.sessionExpiresAt,
        error: null,
      });
      return true;
    } catch (error) {
      set({ busy: false });
      wrapAuthError(error, get());
      return false;
    }
  },

  logout: async () => {
    set({ busy: true, error: null });
    try {
      await window.callnotes.logout();
    } catch {
      // Even a failed remote revoke clears the local session.
    }
    set({ busy: false, phase: "anonymous", user: null, sessionExpiresAt: null });
  },

  changePassword: async (currentPassword, newPassword) => {
    set({ busy: true, error: null });
    try {
      const result = await window.callnotes.changePassword({ currentPassword, newPassword });
      if (!result.ok) {
        set({ busy: false, error: result.error.message });
        return false;
      }
      set({ busy: false });
      return true;
    } catch (error) {
      set({ busy: false });
      wrapAuthError(error, get());
      return false;
    }
  },

  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  expireSession: () => set({ phase: "expired", user: null, sessionExpiresAt: null }),
}));