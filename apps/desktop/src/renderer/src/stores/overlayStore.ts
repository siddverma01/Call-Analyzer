import { create } from "zustand";

interface OverlayUiStore {
  /**
   * A meeting that the floating overlay just started in main. NewMeetingPage
   * adopts it on mount so the "recording" screen appears without re-starting.
   */
  pendingMeetingId: string | null;
  setPendingMeeting: (id: string) => void;
  consumePendingMeeting: () => void;
}

export const useOverlayStore = create<OverlayUiStore>((set) => ({
  pendingMeetingId: null,
  setPendingMeeting: (id) => set({ pendingMeetingId: id }),
  consumePendingMeeting: () => set({ pendingMeetingId: null }),
}));