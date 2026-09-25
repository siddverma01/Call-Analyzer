import { useEffect, useState } from "react";
import type { JSX } from "react";
import { AUDIT_ACTION_LABELS } from "@callnotes/shared";
import { useDataStore } from "../../stores/dataStore";
import { EmptyState } from "../../components/ui/Card";
import { IconScrollText } from "../../components/ui/Icons";
import { formatDateTime } from "../../lib/format";

export function AuditLogsPage(): JSX.Element {
  const audit = useDataStore((s) => s.adminAudit);
  const loading = useDataStore((s) => s.adminAuditLoading);
  const loadAudit = useDataStore((s) => s.loadAdminAudit);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">A chronological record of security and account events.</p>

      {loading && !audit ? (
        <p className="py-16 text-center text-slate-500">Loading audit logs…</p>
      ) : !audit || audit.items.length === 0 ? (
        <EmptyState
          icon={<IconScrollText className="text-3xl" />}
          title="No events yet"
          message="Sign-ins and admin actions will be recorded here."
        />
      ) : (
        <div className="space-y-2">
          {audit.items.map((entry) => {
            const open = openId === entry.id;
            const label = AUDIT_ACTION_LABELS[entry.action as keyof typeof AUDIT_ACTION_LABELS] ?? entry.action;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setOpenId(open ? null : entry.id)}
                className="w-full rounded-xl border border-slate-800 bg-slate-900/60 px-5 py-3 text-left transition-colors hover:bg-slate-800/60"
              >
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium text-slate-100">{label}</span>
                  <span className="font-mono text-xs text-slate-500">{entry.resource}</span>
                  {entry.resourceId && <span className="font-mono text-xs text-slate-600">{entry.resourceId}</span>}
                  <span className="ml-auto text-xs text-slate-500">{entry.actor?.email ?? "system"}</span>
                  <span className="text-xs text-slate-500">{formatDateTime(entry.createdAt)}</span>
                </div>
                {open && entry.metadata !== null && entry.metadata !== undefined && (
                  <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-950/70 p-3 text-xs text-slate-400">
                    {JSON.stringify(entry.metadata, null, 2)}
                  </pre>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}