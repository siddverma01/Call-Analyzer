import { useEffect } from "react";
import type { JSX } from "react";
import { useDataStore } from "../../stores/dataStore";
import { Card, EmptyState } from "../../components/ui/Card";
import { MeetingStatusBadge } from "../../components/ui/statusBadges";
import { formatDate, formatDuration } from "../../lib/format";
import { IconServer } from "../../components/ui/Icons";
import type { SerializedAdminMeetingListItem } from "@callnotes/shared";

export function AllMeetingsPage(): JSX.Element {
  const meetings = useDataStore((s) => s.adminMeetings);
  const loading = useDataStore((s) => s.adminMeetingsLoading);
  const loadMeetings = useDataStore((s) => s.loadAdminMeetings);

  useEffect(() => {
    void loadMeetings();
  }, [loadMeetings]);

  const date = (meeting: SerializedAdminMeetingListItem): string => meeting.startedAt ?? meeting.createdAt;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">Every meeting in the system, with its owner.</p>

      {loading && !meetings ? (
        <p className="py-16 text-center text-slate-500">Loading meetings…</p>
      ) : !meetings || meetings.items.length === 0 ? (
        <EmptyState icon={<IconServer className="text-3xl" />} title="No meetings" message="Nothing recorded yet." />
      ) : (
        <Card>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Meeting</th>
                <th className="px-5 py-3 font-medium">Owner</th>
                <th className="px-5 py-3 font-medium">Started</th>
                <th className="px-5 py-3 font-medium">Duration</th>
                <th className="px-5 py-3 font-medium">Action items</th>
                <th className="px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {meetings.items.map((meeting) => (
                <tr key={meeting.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-5 py-3">
                    <p className="max-w-[16rem] truncate font-medium text-slate-100">{meeting.title}</p>
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-400">{meeting.ownerEmail}</td>
                  <td className="px-5 py-3 text-xs text-slate-400">{formatDate(date(meeting))}</td>
                  <td className="px-5 py-3 text-xs text-slate-400">{formatDuration(meeting.durationSeconds)}</td>
                  <td className="px-5 py-3 text-xs text-slate-400">{meeting.actionItemCount}</td>
                  <td className="px-5 py-3">
                    <MeetingStatusBadge status={meeting.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}