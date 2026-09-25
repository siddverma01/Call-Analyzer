import { create } from "zustand";
import type {
  AdminMeetingPage,
  AdminStats,
  AdminUserDetail,
  AdminUserPage,
  AuditLogPage,
  CreateActionItemRequest,
  CreateMeetingRequest,
  CreateTemplateRequest,
  ExportFormat,
  ExportPayload,
  MeetingListParams,
  SerializedActionItem,
  SerializedMeetingDetail,
  SerializedMeetingListItem,
  SerializedTemplate,
  UpdateActionItemRequest,
  UpdateMeetingRequest,
  UpdateTemplateRequest,
  UserRole,
  UserStatus,
} from "@callnotes/shared";
import { useAuthStore } from "./authStore";
import { useToastStore } from "./toastStore";
import { isUnauthorized, requireOk } from "../lib/api";

/** Fetch everything needed by the dashboard from genuine backend data. */
export interface DashboardData {
  totalMeetings: number;
  totalTimeSeconds: number;
  openActionItems: number;
  recentMeetings: SerializedMeetingListItem[];
}

interface DataState {
  meetings: SerializedMeetingListItem[] | null;
  meetingsLoading: boolean;
  meetingsTotal: number;
  meetingsError: string | null;
  meetingsPage: number;

  detail: SerializedMeetingDetail | null;
  detailLoading: boolean;

  templates: SerializedTemplate[] | null;
  templatesLoading: boolean;
  templateDefaultId: string | null;

  actionItems: SerializedActionItem[] | null;
  actionItemsLoading: boolean;

  dashboard: DashboardData | null;
  dashboardLoading: boolean;

  adminUsers: AdminUserPage | null;
  adminUsersLoading: boolean;
  adminMeetings: AdminMeetingPage | null;
  adminMeetingsLoading: boolean;
  adminAudit: AuditLogPage | null;
  adminAuditLoading: boolean;
  adminStats: AdminStats | null;
  adminStatsLoading: boolean;
  adminDetail: AdminUserDetail | null;
  adminDetailLoading: boolean;
  adminBusy: boolean;

  loadDashboard: () => Promise<void>;
  loadMeetings: (params?: MeetingListParams) => Promise<void>;
  loadMoreMeetings: (perPage?: number) => Promise<void>;
  loadDetail: (id: string) => Promise<void>;
  createMeeting: (input: CreateMeetingRequest) => Promise<string | null>;
  updateMeeting: (id: string, input: UpdateMeetingRequest) => Promise<boolean>;
  deleteMeeting: (id: string) => Promise<boolean>;
  exportMeeting: (id: string, format: ExportFormat) => Promise<ExportPayload | null>;

  loadTemplates: () => Promise<void>;
  createTemplate: (input: CreateTemplateRequest) => Promise<SerializedTemplate | null>;
  updateTemplate: (id: string, input: UpdateTemplateRequest) => Promise<boolean>;
  deleteTemplate: (id: string) => Promise<boolean>;
  duplicateTemplate: (id: string) => Promise<SerializedTemplate | null>;
  setDefaultTemplate: (templateId: string | null) => Promise<boolean>;

  loadActionItems: () => Promise<void>;
  createActionItem: (input: CreateActionItemRequest) => Promise<SerializedActionItem | null>;
  updateActionItem: (id: string, input: UpdateActionItemRequest) => Promise<boolean>;
  deleteActionItem: (id: string) => Promise<boolean>;

  loadAdminUsers: () => Promise<void>;
  loadAdminMeetings: () => Promise<void>;
  loadAdminAudit: () => Promise<void>;
  loadAdminStats: () => Promise<void>;
  loadAdminUserDetail: (id: string) => Promise<void>;
  setUserStatus: (id: string, status: UserStatus) => Promise<boolean>;
  setUserRole: (id: string, role: UserRole) => Promise<boolean>;

  reset: () => void;
}

function onSessionError(error: unknown): void {
  if (isUnauthorized(error)) {
    useAuthStore.getState().expireSession();
  }
}

const initial = {
  meetings: null,
  meetingsLoading: false,
  meetingsTotal: 0,
  meetingsError: null,
  meetingsPage: 0,
  detail: null,
  detailLoading: false,
  templates: null,
  templatesLoading: false,
  templateDefaultId: null,
  actionItems: null,
  actionItemsLoading: false,
  dashboard: null,
  dashboardLoading: false,
  adminUsers: null,
  adminUsersLoading: false,
  adminMeetings: null,
  adminMeetingsLoading: false,
  adminAudit: null,
  adminAuditLoading: false,
  adminStats: null,
  adminStatsLoading: false,
  adminDetail: null,
  adminDetailLoading: false,
  adminBusy: false,
};

export const useDataStore = create<DataState>((set, get) => ({
  ...initial,

  loadDashboard: async () => {
    set({ dashboardLoading: true });
    try {
      const [meetingsRes, itemsRes] = await Promise.all([
        window.callnotes.listMeetings({ page: 1, perPage: 100 }),
        window.callnotes.listActionItems(),
      ]);
      const meetings = requireOk(meetingsRes);
      const actionItems = requireOk(itemsRes);
      const recentMeetings = meetings.items.slice(0, 6);
      set({
        dashboard: {
          totalMeetings: meetings.total,
          totalTimeSeconds: meetings.items.reduce((sum, m) => sum + (m.durationSeconds ?? 0), 0),
          openActionItems: actionItems.filter((a) => a.status !== "COMPLETED").length,
          recentMeetings,
        },
        meetingsTotal: meetings.total,
        meetings: meetings.items,
        actionItems,
        dashboardLoading: false,
      });
    } catch (error) {
      onSessionError(error);
      set({ dashboardLoading: false });
    }
  },

  loadMeetings: async (params) => {
    set({ meetingsLoading: true, meetingsError: null });
    try {
      const res = await window.callnotes.listMeetings(params);
      const page = requireOk(res);
      set({
        meetings: page.items,
        meetingsTotal: page.total,
        meetingsPage: page.page,
        meetingsLoading: false,
      });
    } catch (error) {
      onSessionError(error);
      set({ meetingsLoading: false, meetingsError: error instanceof Error ? error.message : "Failed to load meetings" });
    }
  },

  loadMoreMeetings: async (perPage = 100) => {
    const { meetings, meetingsPage, meetingsTotal } = get();
    if (!meetings || meetings.length >= meetingsTotal || get().meetingsLoading) return;
    set({ meetingsLoading: true, meetingsError: null });
    try {
      const res = await window.callnotes.listMeetings({ page: meetingsPage + 1, perPage });
      const page = requireOk(res);
      const seen = new Set(get().meetings?.map((m) => m.id));
      const fresh = page.items.filter((m) => !seen.has(m.id));
      set({
        meetings: [...(get().meetings ?? []), ...fresh],
        meetingsTotal: page.total,
        meetingsPage: page.page,
        meetingsLoading: false,
      });
    } catch (error) {
      onSessionError(error);
      set({ meetingsLoading: false, meetingsError: error instanceof Error ? error.message : "Failed to load meetings" });
    }
  },

  loadDetail: async (id) => {
    set({ detailLoading: true });
    try {
      const res = await window.callnotes.getMeeting(id);
      set({ detail: requireOk(res), detailLoading: false });
    } catch (error) {
      onSessionError(error);
      set({ detailLoading: false });
    }
  },

  createMeeting: async (input) => {
    try {
      const res = await window.callnotes.createMeeting(input);
      const meeting = requireOk(res);
      await get().loadMeetings({ page: 1, perPage: 20 });
      return meeting.id;
    } catch (error) {
      onSessionError(error);
      return null;
    }
  },

  updateMeeting: async (id, input) => {
    try {
      const res = await window.callnotes.updateMeeting(id, input);
      requireOk(res);
      await get().loadMeetings({ page: 1, perPage: 20 });
      return true;
    } catch (error) {
      onSessionError(error);
      return false;
    }
  },

  deleteMeeting: async (id) => {
    try {
      const res = await window.callnotes.deleteMeeting(id);
      requireOk(res);
      await get().loadMeetings({ page: 1, perPage: 20 });
      return true;
    } catch (error) {
      onSessionError(error);
      return false;
    }
  },

  exportMeeting: async (id, format) => {
    try {
      const res = await window.callnotes.exportMeeting(id, format);
      return requireOk(res);
    } catch (error) {
      onSessionError(error);
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Export failed");
      return null;
    }
  },

  loadTemplates: async () => {
    set({ templatesLoading: true });
    try {
      const res = await window.callnotes.listTemplates();
      const list = requireOk(res);
      set({ templates: list.items, templateDefaultId: list.defaultId, templatesLoading: false });
    } catch (error) {
      onSessionError(error);
      set({ templatesLoading: false });
    }
  },

  createTemplate: async (input) => {
    try {
      const res = await window.callnotes.createTemplate(input);
      const template = requireOk(res);
      await get().loadTemplates();
      return template;
    } catch (error) {
      onSessionError(error);
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not create template");
      return null;
    }
  },

  updateTemplate: async (id, input) => {
    try {
      const res = await window.callnotes.updateTemplate(id, input);
      requireOk(res);
      await get().loadTemplates();
      return true;
    } catch (error) {
      onSessionError(error);
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not update template");
      return false;
    }
  },

  deleteTemplate: async (id) => {
    try {
      const res = await window.callnotes.deleteTemplate(id);
      requireOk(res);
      await get().loadTemplates();
      return true;
    } catch (error) {
      onSessionError(error);
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not delete template");
      return false;
    }
  },

  duplicateTemplate: async (id) => {
    try {
      const res = await window.callnotes.duplicateTemplate(id);
      const template = requireOk(res);
      await get().loadTemplates();
      return template;
    } catch (error) {
      onSessionError(error);
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not duplicate template");
      return null;
    }
  },

  setDefaultTemplate: async (templateId) => {
    try {
      const res = await window.callnotes.setDefaultTemplate(templateId);
      requireOk(res);
      set({ templateDefaultId: templateId });
      return true;
    } catch (error) {
      onSessionError(error);
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not update default template");
      return false;
    }
  },

  loadActionItems: async () => {
    set({ actionItemsLoading: true });
    try {
      const res = await window.callnotes.listActionItems();
      set({ actionItems: requireOk(res), actionItemsLoading: false });
    } catch (error) {
      onSessionError(error);
      set({ actionItemsLoading: false });
    }
  },

  createActionItem: async (input) => {
    try {
      const res = await window.callnotes.createActionItem(input);
      const item = requireOk(res);
      await get().loadActionItems();
      return item;
    } catch (error) {
      onSessionError(error);
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not create task");
      return null;
    }
  },

  updateActionItem: async (id, input) => {
    try {
      const res = await window.callnotes.updateActionItem(id, input);
      requireOk(res);
      await get().loadActionItems();
      return true;
    } catch (error) {
      onSessionError(error);
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not update task");
      return false;
    }
  },

  deleteActionItem: async (id) => {
    try {
      const res = await window.callnotes.deleteActionItem(id);
      requireOk(res);
      await get().loadActionItems();
      return true;
    } catch (error) {
      onSessionError(error);
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not delete task");
      return false;
    }
  },

  loadAdminUsers: async () => {
    set({ adminUsersLoading: true });
    try {
      const res = await window.callnotes.adminListUsers({ page: 1, perPage: 100 });
      set({ adminUsers: requireOk(res), adminUsersLoading: false });
    } catch (error) {
      onSessionError(error);
      set({ adminUsersLoading: false });
    }
  },

  loadAdminMeetings: async () => {
    set({ adminMeetingsLoading: true });
    try {
      const res = await window.callnotes.adminListMeetings({ page: 1, perPage: 100 });
      set({ adminMeetings: requireOk(res), adminMeetingsLoading: false });
    } catch (error) {
      onSessionError(error);
      set({ adminMeetingsLoading: false });
    }
  },

  loadAdminAudit: async () => {
    set({ adminAuditLoading: true });
    try {
      const res = await window.callnotes.adminListAuditLogs({ page: 1, perPage: 100 });
      set({ adminAudit: requireOk(res), adminAuditLoading: false });
    } catch (error) {
      onSessionError(error);
      set({ adminAuditLoading: false });
    }
  },

  loadAdminStats: async () => {
    set({ adminStatsLoading: true });
    try {
      const res = await window.callnotes.adminStats();
      set({ adminStats: requireOk(res), adminStatsLoading: false });
    } catch (error) {
      onSessionError(error);
      set({ adminStatsLoading: false });
    }
  },

  loadAdminUserDetail: async (id) => {
    set({ adminDetailLoading: true });
    try {
      const res = await window.callnotes.adminGetUserDetail(id);
      set({ adminDetail: requireOk(res), adminDetailLoading: false });
    } catch (error) {
      onSessionError(error);
      set({ adminDetailLoading: false });
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not load user details");
    }
  },

  setUserStatus: async (id, status) => {
    set({ adminBusy: true });
    try {
      const res = await window.callnotes.adminUpdateUserStatus(id, status);
      requireOk(res);
      await get().loadAdminUsers();
      set({ adminBusy: false });
      return true;
    } catch (error) {
      onSessionError(error);
      set({ adminBusy: false });
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not update status");
      return false;
    }
  },

  setUserRole: async (id, role) => {
    set({ adminBusy: true });
    try {
      const res = await window.callnotes.adminUpdateUserRole(id, role);
      requireOk(res);
      await get().loadAdminUsers();
      set({ adminBusy: false });
      return true;
    } catch (error) {
      onSessionError(error);
      set({ adminBusy: false });
      useToastStore.getState().push("error", error instanceof Error ? error.message : "Could not update role");
      return false;
    }
  },

  reset: () => set({ ...initial }),
}));