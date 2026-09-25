import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { UserRole, UserStatus } from "@callnotes/shared";
import { useDataStore } from "../../stores/dataStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { Badge, Card, EmptyState } from "../../components/ui/Card";
import { Select } from "../../components/ui/inputs";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { formatDate } from "../../lib/format";
import { IconAlertTriangle, IconEye, IconUsers } from "../../components/ui/Icons";
import { UserDetailModal } from "./UserDetailModal";

const ROLE_TONE = { USER: "slate", ADMIN: "indigo" } as const;
const STATUS_TONE = { ACTIVE: "emerald", DISABLED: "rose" } as const;

type PendingAction = { id: string; kind: "status" | "role"; value: string } | null;

export function UsersPage(): JSX.Element {
  const users = useDataStore((s) => s.adminUsers);
  const loading = useDataStore((s) => s.adminUsersLoading);
  const loadUsers = useDataStore((s) => s.loadAdminUsers);
  const setUserStatus = useDataStore((s) => s.setUserStatus);
  const setUserRole = useDataStore((s) => s.setUserRole);
  const loadAdminUserDetail = useDataStore((s) => s.loadAdminUserDetail);
  const adminBusy = useDataStore((s) => s.adminBusy);
  const me = useAuthStore((s) => s.user);
  const pushToast = useToastStore((s) => s.push);
  const [pending, setPending] = useState<PendingAction>(null);
  const [detailUserId, setDetailUserId] = useState<string | null>(null);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const applyStatus = async (id: string, status: UserStatus): Promise<void> => {
    const okChange = await setUserStatus(id, status);
    if (okChange) pushToast("success", status === "ACTIVE" ? "User enabled" : "User disabled");
  };

  const changeStatus = (id: string, status: UserStatus): void => {
    const target = users?.items.find((u) => u.id === id);
    if (target?.role === "ADMIN" && status === "DISABLED") {
      setPending({ id, kind: "status", value: status });
      return;
    }
    void applyStatus(id, status);
  };

  const changeRole = (id: string, role: UserRole): void => {
    const target = users?.items.find((u) => u.id === id);
    if (target?.role === "ADMIN" && role !== "ADMIN") {
      setPending({ id, kind: "role", value: role });
      return;
    }
    void applyRole(id, role);
  };

  const applyRole = async (id: string, role: UserRole): Promise<void> => {
    const okChange = await setUserRole(id, role);
    if (okChange) pushToast("success", `Role updated to ${role.toLowerCase()}`);
  };

  const confirmPending = (): void => {
    if (!pending) return;
    if (pending.kind === "status") {
      void applyStatus(pending.id, pending.value as UserStatus);
    } else {
      void applyRole(pending.id, pending.value as UserRole);
    }
    setPending(null);
  };

  const openDetail = (id: string): void => {
    setDetailUserId(id);
    void loadAdminUserDetail(id);
  };

  const pendingUser = pending ? users?.items.find((u) => u.id === pending.id) : undefined;
  const pendingLabel = pending
    ? pending.kind === "status"
      ? pending.value === "DISABLED"
        ? "disable"
        : "enable"
      : pending.value === "ADMIN"
        ? "promote to admin"
        : "demote to user"
    : "";

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Change account roles and status. You can’t modify your own account from this screen, and the last active
        administrator is always protected.
      </p>

      {loading && !users ? (
        <p className="py-16 text-center text-slate-500">Loading users…</p>
      ) : !users || users.items.length === 0 ? (
        <EmptyState icon={<IconUsers className="text-3xl" />} title="No users" message="Accounts will appear here." />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3 font-medium">User</th>
                  <th className="px-5 py-3 font-medium">Joined</th>
                  <th className="px-5 py-3 font-medium">Meetings</th>
                  <th className="px-5 py-3 font-medium">Last activity</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Role</th>
                  <th className="px-5 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {users.items.map((user) => {
                  const isSelf = user.id === me?.id;
                  return (
                    <tr key={user.id} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-100">{user.name}</p>
                        <p className="text-xs text-slate-500">{user.email}</p>
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-400">{formatDate(user.createdAt)}</td>
                      <td className="px-5 py-3 text-xs text-slate-300">{user.meetingCount}</td>
                      <td className="px-5 py-3 text-xs text-slate-400">
                        {user.lastActivityAt ? formatDate(user.lastActivityAt) : "—"}
                      </td>
                      <td className="px-5 py-3">
                        {isSelf ? (
                          <Badge tone={STATUS_TONE[user.status]}>{user.status.toLowerCase()}</Badge>
                        ) : (
                          <Select
                            value={user.status}
                            disabled={adminBusy}
                            onChange={(e) => changeStatus(user.id, e.target.value as UserStatus)}
                            className="w-36 py-1.5 text-xs"
                          >
                            <option value="ACTIVE">Active</option>
                            <option value="DISABLED">Disabled</option>
                          </Select>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {isSelf ? (
                          <Badge tone={ROLE_TONE[user.role]}>{user.role.toLowerCase()}</Badge>
                        ) : (
                          <Select
                            value={user.role}
                            disabled={adminBusy}
                            onChange={(e) => changeRole(user.id, e.target.value as UserRole)}
                            className="w-32 py-1.5 text-xs"
                          >
                            <option value="USER">User</option>
                            <option value="ADMIN">Admin</option>
                          </Select>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Button variant="ghost" size="sm" onClick={() => openDetail(user.id)}>
                          <IconEye />
                          Details
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={pending !== null}
        title="Confirm account change"
        onClose={() => setPending(null)}
        width="max-w-md"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <IconAlertTriangle className="mt-0.5 shrink-0 text-amber-400" />
            <p className="text-sm text-slate-300">
              You are about to <span className="font-medium text-white">{pendingLabel}</span> the administrator account
              {pendingUser ? ` “${pendingUser.name}” (${pendingUser.email})` : ""}. Removing the last active admin is
              blocked server-side; this confirmation keeps that action deliberate.
            </p>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmPending}>
              Confirm {pendingLabel}
            </Button>
          </div>
        </div>
      </Modal>

      <UserDetailModal userId={detailUserId} onClose={() => setDetailUserId(null)} />
    </div>
  );
}