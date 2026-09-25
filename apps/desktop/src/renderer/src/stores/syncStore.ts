import { create } from "zustand";
import type { SyncState } from "@callnotes/shared";

interface SyncStore {
  state: SyncState | null;
  /** Fetch the current state once and stream every update pushed by main. */
  subscribe: () => Promise<void>;
  /** Manually trigger an immediate sync attempt (ignores backoff timers). */
  syncNow: () => Promise<void>;
}

let subscriptionActive = false;

export const useSyncStore = create<SyncStore>((set) => ({
  state: null,

  subscribe: async () => {
    try {
      set({ state: await window.callnotes.syncStatus() });
    } catch {
      set({ state: null });
    }
    if (!subscriptionActive) {
      subscriptionActive = true;
      window.callnotes.onSyncEvent((state) => set({ state }));
    }
  },

  syncNow: async () => {
    try {
      set({ state: await window.callnotes.syncNow() });
    } catch {
      // keep whatever state we already show; main keeps retrying on its own
    }
  },
}));