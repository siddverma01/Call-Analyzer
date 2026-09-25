import { create } from "zustand";

export type PageId =
  | "dashboard"
  | "new-meeting"
  | "meetings"
  | "tasks"
  | "templates"
  | "settings"
  | "admin"
  | "admin-users"
  | "admin-meetings"
  | "admin-audit";

export type BackendStatus = "checking" | "online" | "offline";

/** Pages only reachable by administrators. */
export const ADMIN_PAGES = new Set<PageId>(["admin", "admin-users", "admin-meetings", "admin-audit"]);

interface AppState {
  page: PageId;
  backendStatus: BackendStatus;
  apiUrl: string;
  setPage: (page: PageId) => void;
  setBackendStatus: (status: BackendStatus) => void;
  setApiUrl: (url: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  page: "dashboard",
  backendStatus: "checking",
  apiUrl: "",
  setPage: (page) => set({ page }),
  setBackendStatus: (backendStatus) => set({ backendStatus }),
  setApiUrl: (apiUrl) => set({ apiUrl }),
}));