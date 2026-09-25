import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  ExportFormat,
  ExportPayload,
  LocalMeetingDetail,
  LocalMeetingListItem,
  MeetingStatus,
  MeetingSyncActionItem,
  MeetingSyncSummary,
  SerializedMeetingDetail,
  SerializedMeetingListItem,
} from "@callnotes/shared";
import { useDataStore } from "../stores/dataStore";
import { useToastStore } from "../stores/toastStore";
import { VirtualizedList } from "../components/ui/VirtualizedList";
import { Button, Spinner } from "../components/ui/Button";
import { EmptyState } from "../components/ui/Card";
import { ErrorNote, Input, Select, TextArea } from "../components/ui/inputs";
import { MeetingStatusBadge, PriorityBadge, SyncStatusBadge, TaskStatusBadge } from "../components/ui/statusBadges";
import { Modal } from "../components/ui/Modal";
import {
  IconAlertTriangle,
  IconAudioLines,
  IconCalendar,
  IconCheck,
  IconDownload,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconTrash,
  IconX,
} from "../components/ui/Icons";
import { formatDate, formatDateTime, formatDuration, truncate } from "../lib/format";

const STATUS_OPTIONS: { value: MeetingStatus | "ALL"; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "RECORDING", label: "Recording" },
  { value: "PROCESSING", label: "Processing" },
  { value: "COMPLETED", label: "Completed" },
  { value: "SYNCED", label: "Synced" },
  { value: "FAILED", label: "Failed" },
];

type SortKey = "newest" | "oldest" | "longest" | "shortest";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "longest", label: "Longest first" },
  { value: "shortest", label: "Shortest first" },
];

const EXPORT_FORMAT_OPTIONS: { format: ExportFormat; label: string }[] = [
  { format: "markdown", label: "Markdown (.md)" },
  { format: "txt", label: "Plain text (.txt)" },
  { format: "json", label: "JSON (.json)" },
  { format: "pdf", label: "PDF (.pdf)" },
];

function triggerDownload(payload: ExportPayload): void {
  const bytes =
    payload.format === "pdf"
      ? Uint8Array.from(atob(payload.content), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(payload.content);
  const blob = new Blob([bytes], { type: payload.contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = payload.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function meetingDate(meeting: SerializedMeetingListItem): string {
  return meeting.startedAt ?? meeting.createdAt;
}

export function MeetingsPage(): JSX.Element {
  const meetings = useDataStore((s) => s.meetings);
  const loading = useDataStore((s) => s.meetingsLoading);
  const error = useDataStore((s) => s.meetingsError);
  const loadMeetings = useDataStore((s) => s.loadMeetings);
  const loadMoreMeetings = useDataStore((s) => s.loadMoreMeetings);
  const meetingsTotal = useDataStore((s) => s.meetingsTotal);
  const loadDetail = useDataStore((s) => s.loadDetail);
  const detail = useDataStore((s) => s.detail);
  const detailLoading = useDataStore((s) => s.detailLoading);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<MeetingStatus | "ALL">("ALL");
  const [sort, setSort] = useState<SortKey>("newest");
  const [detailId, setDetailId] = useState<string | null>(null);

  const [localMeetings, setLocalMeetings] = useState<LocalMeetingListItem[]>([]);
  const [localDetail, setLocalDetail] = useState<LocalMeetingDetail | null>(null);
  const [localDetailLoading, setLocalDetailLoading] = useState(false);

  const refreshLocal = useCallback(async (): Promise<void> => {
    try {
      setLocalMeetings(await window.callnotes.meetingListLocal());
    } catch {
      setLocalMeetings([]);
    }
  }, []);

  // Server-side search: debounce so keystrokes trigger one full-text query that
  // scans transcripts, summaries, and decisions. An empty query loads the list.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadMeetings({ page: 1, perPage: 100, q: search.trim() || undefined });
    }, search.trim() ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [search, loadMeetings]);

  // Offline meetings live in the local SQLite store; refresh when a recording
  // is created/finalized or when a queued meeting moves through the sync queue.
  useEffect(() => {
    void refreshLocal();
    const unsubMeeting = window.callnotes.onMeetingEvent(() => void refreshLocal());
    const unsubSync = window.callnotes.onSyncEvent(() => void refreshLocal());
    return () => {
      unsubMeeting();
      unsubSync();
    };
  }, [refreshLocal]);

  const openLocal = async (meetingId: string): Promise<void> => {
    setLocalDetailLoading(true);
    setLocalDetail(null);
    try {
      setLocalDetail(await window.callnotes.meetingGetLocal(meetingId));
    } catch {
      setLocalDetail(null);
    } finally {
      setLocalDetailLoading(false);
    }
  };

  useEffect(() => {
    if (detailId) void loadDetail(detailId);
  }, [detailId, loadDetail]);

  const filtered = useMemo(() => {
    const result = (meetings ?? []).filter((m) => {
      if (status !== "ALL" && m.status !== status) return false;
      return true;
    });
    const sorted = [...result].sort((a, b) => {
      switch (sort) {
        case "oldest":
          return meetingDate(a).localeCompare(meetingDate(b));
        case "longest":
          return b.durationSeconds - a.durationSeconds;
        case "shortest":
          return a.durationSeconds - b.durationSeconds;
        case "newest":
        default:
          return meetingDate(b).localeCompare(meetingDate(a));
      }
    });
    return sorted;
  }, [meetings, status, sort]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search transcripts, summaries, decisions…"
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value as MeetingStatus | "ALL")} className="w-44">
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="w-40">
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {error && <div className="text-sm text-rose-300">{error}</div>}

      {loading && !meetings ? (
        <div className="flex justify-center py-20 text-slate-500">
          <Spinner className="h-6 w-6" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<IconAudioLines className="text-3xl" />}
          title={search || status !== "ALL" ? "No meetings match" : "No meetings yet"}
          message={
            search || status !== "ALL"
              ? "Try a different search or filter."
              : "Transcribed meetings will appear here with transcripts, summaries, and action items."
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((meeting) => (
            <button
              key={meeting.id}
              type="button"
              onClick={() => setDetailId(meeting.id)}
              className="w-full rounded-xl border border-slate-800 bg-slate-900/60 px-5 py-4 text-left transition-colors hover:border-slate-700 hover:bg-slate-800/60"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">{meeting.title}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                    <IconCalendar className="text-xs" />
                    {formatDate(meetingDate(meeting))}
                    <span className="text-slate-700">·</span>
                    {formatDuration(meeting.durationSeconds)}
                    {meeting.templateName && (
                      <>
                        <span className="text-slate-700">·</span>
                        {meeting.templateName}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {meeting.actionItemCount > 0 && (
                    <span className="text-xs text-slate-400">{meeting.actionItemCount} action items</span>
                  )}
                  {meeting.summaryPreview && (
                    <span className="hidden max-w-[18rem] truncate text-xs text-slate-500 xl:inline">
                      {truncate(meeting.summaryPreview, 80)}
                    </span>
                  )}
                  <MeetingStatusBadge status={meeting.status} />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {!search.trim() && (meetings?.length ?? 0) < meetingsTotal && (
        <div className="flex justify-center pt-1">
          <Button variant="ghost" onClick={() => void loadMoreMeetings(100)} loading={loading}>
            Load more meetings ({meetingsTotal - (meetings?.length ?? 0)} remaining)
          </Button>
        </div>
      )}

      {localMeetings.length > 0 && (
        <section className="pt-2">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Recorded on this device
            </h2>
            <span className="text-xs text-slate-500">Saved locally, synced when online</span>
          </div>
          <div className="space-y-2">
            {localMeetings.map((meeting) => (
              <button
                key={meeting.id}
                type="button"
                onClick={() => void openLocal(meeting.id)}
                className="w-full rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-5 py-4 text-left transition-colors hover:border-slate-600 hover:bg-slate-800/50"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-200">{meeting.title}</p>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                      <IconCalendar className="text-xs" />
                      {formatDate(meeting.startedAt ?? meeting.createdAt)}
                      <span className="text-slate-700">·</span>
                      {formatDuration(meeting.durationSeconds)}
                      <span className="text-slate-700">·</span>
                      {meeting.segmentCount} segments
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {meeting.hasLocalRecording && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                        <IconAudioLines className="text-xs" />
                        Audio on disk
                      </span>
                    )}
                    {meeting.summaryPreview && (
                      <span className="hidden max-w-[18rem] truncate text-xs text-slate-500 xl:inline">
                        {truncate(meeting.summaryPreview, 80)}
                      </span>
                    )}
                    <MeetingStatusBadge status={meeting.status} />
                    <SyncStatusBadge status={meeting.syncStatus} error={meeting.syncError} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {detailId && detail && (
        <MeetingDetailModal
          meetingId={detailId}
          detail={detail}
          loading={detailLoading}
          onClose={() => setDetailId(null)}
        />
      )}

      {localDetail && (
        <LocalMeetingModal detail={localDetail} loading={localDetailLoading} onClose={() => setLocalDetail(null)} />
      )}
    </div>
  );
}

function MeetingDetailModal({
  meetingId,
  detail,
  loading,
  onClose,
}: {
  meetingId: string;
  detail: SerializedMeetingDetail;
  loading: boolean;
  onClose: () => void;
}): JSX.Element {
  const updateMeeting = useDataStore((s) => s.updateMeeting);
  const deleteMeeting = useDataStore((s) => s.deleteMeeting);
  const exportMeeting = useDataStore((s) => s.exportMeeting);
  const pushToast = useToastStore((s) => s.push);

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(detail.meeting.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const exportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setTitle(detail.meeting.title);
    setEditing(false);
    setConfirmDelete(false);
    setShowExport(false);
  }, [detail.meeting.id, detail.meeting.title]);

  useEffect(() => {
    if (!showExport) return;
    const onPointer = (event: MouseEvent): void => {
      if (exportRef.current && !exportRef.current.contains(event.target as Node)) setShowExport(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [showExport]);

  const download = async (format: ExportFormat): Promise<void> => {
    setExporting(format);
    try {
      const payload = await exportMeeting(meetingId, format);
      if (payload) {
        triggerDownload(payload);
        pushToast("success", `Exported as ${format.toUpperCase()}`);
      }
    } finally {
      setExporting(null);
      setShowExport(false);
    }
  };

  const saveTitle = async (): Promise<void> => {
    const next = title.trim();
    if (!next || next === detail.meeting.title) {
      setEditing(false);
      setTitle(detail.meeting.title);
      return;
    }
    const okUpdate = await updateMeeting(meetingId, { title: next });
    if (okUpdate) {
      pushToast("success", "Meeting renamed");
      setEditing(false);
    } else {
      pushToast("error", "Could not rename the meeting");
    }
  };

  const remove = async (): Promise<void> => {
    const okDelete = await deleteMeeting(meetingId);
    if (okDelete) {
      pushToast("success", "Meeting deleted");
      onClose();
    } else {
      pushToast("error", "Could not delete the meeting");
    }
  };

  const { meeting, segments, summary } = detail;

  return (
    <Modal open onClose={onClose} title={editing ? "Rename meeting" : "Meeting details"} width="max-w-2xl">
      {loading ? (
        <div className="flex justify-center py-14 text-slate-500">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <div className="space-y-6">
          {editing ? (
            <div className="flex items-center gap-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={200} />
              <Button size="sm" onClick={() => void saveTitle()}>
                <IconCheck className="text-sm" />
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                <IconX />
              </Button>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-white">{meeting.title}</h3>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>{formatDateTime(meeting.startedAt ?? meeting.createdAt)}</span>
                  <span className="text-slate-700">·</span>
                  <span>{formatDuration(meeting.durationSeconds)}</span>
                  {meeting.templateName && (
                    <>
                      <span className="text-slate-700">·</span>
                      <span>{meeting.templateName}</span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <MeetingStatusBadge status={meeting.status} />
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  aria-label="Rename"
                  title="Rename"
                  className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  <IconPencil />
                </button>
                <div ref={exportRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setShowExport((value) => !value)}
                    aria-label="Export"
                    title="Export meeting"
                    className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
                  >
                    <IconDownload />
                  </button>
                  {showExport && (
                    <div className="absolute right-0 top-full z-[80] mt-1 w-44 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
                      <p className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                        Export as…
                      </p>
                      {EXPORT_FORMAT_OPTIONS.map((option) => (
                        <button
                          key={option.format}
                          type="button"
                          disabled={exporting !== null}
                          onClick={() => void download(option.format)}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                        >
                          {option.label}
                          {exporting === option.format && <Spinner className="h-3.5 w-3.5" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete"
                  title="Delete meeting"
                  className="rounded-lg p-2 text-slate-400 hover:bg-rose-900/40 hover:text-rose-300"
                >
                  <IconTrash />
                </button>
              </div>
            </div>
          )}

          {summary && (
            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Summary</h4>
              <p className="text-sm leading-relaxed text-slate-200">{summary.summary}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <NotesBlock title="Discussion points" value={summary.discussionPoints} />
                <NotesBlock title="Decisions" value={summary.decisions} />
                <NotesBlock title="Risks and blockers" value={summary.risks} />
                <NotesBlock title="Blockers" value={summary.blockers} />
                <NotesBlock title="Open questions" value={summary.openQuestions} />
                <NotesBlock title="Follow-ups" value={summary.followUps} />
                <NotesBlock title="Important dates" value={summary.importantDates} />
              </div>
            </section>
          )}

          {segments.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Transcript · {segments.length} segments
              </h4>
              <div className="space-y-2">
                {segments.map((segment) => (
                  <div key={segment.id} className="flex gap-3 rounded-lg bg-slate-950/60 p-3">
                    <span className="mt-0.5 shrink-0 text-xs font-medium text-indigo-300">{segment.speaker}</span>
                    <div className="min-w-0">
                      <p className="text-sm text-slate-200">{segment.text}</p>
                      <p className="mt-0.5 text-[10px] text-slate-600">
                        {formatDateTime(segment.startTime)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!summary && segments.length === 0 && (
            <p className="text-sm text-slate-500">
              No transcript or summary yet. Recording and transcription are not configured.
            </p>
          )}
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6" role="alertdialog">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <h4 className="text-base font-semibold text-white">Delete meeting?</h4>
            <p className="mt-1 text-sm text-slate-400">
              This removes “{meeting.title}” and its transcript permanently. This cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void remove()}>
                <IconTrash className="text-sm" />
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

const SUMMARY_SECTIONS: { key: keyof MeetingSyncSummary; label: string }[] = [
  { key: "discussionPoints", label: "Discussion points" },
  { key: "decisions", label: "Decisions" },
  { key: "risks", label: "Risks" },
  { key: "openQuestions", label: "Open questions" },
  { key: "blockers", label: "Blockers" },
  { key: "followUps", label: "Follow-ups" },
  { key: "importantDates", label: "Important dates" },
  { key: "participants", label: "Participants" },
];

interface EditableSummary {
  summary: string;
  sections: Record<string, string[]>;
  aiModel: string | null;
  aiProvider: string | null;
}

function toEditableSummary(value: MeetingSyncSummary | null): EditableSummary {
  const sections: Record<string, string[]> = {};
  for (const { key } of SUMMARY_SECTIONS) {
    sections[key] = toStringList(value?.[key]);
  }
  return {
    summary: value?.summary ?? "",
    sections,
    aiModel: value?.aiModel ?? null,
    aiProvider: value?.aiProvider ?? null,
  };
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") return entry.text;
      return typeof entry === "object" ? JSON.stringify(entry) : String(entry);
    })
    .filter((entry): entry is string => entry.length > 0);
}

function toDateInput(value: string | Date | null | undefined): string {
  if (value == null) return "";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function LocalMeetingModal({
  detail,
  loading,
  onClose,
}: {
  detail: LocalMeetingDetail;
  loading: boolean;
  onClose: () => void;
}): JSX.Element {
  const [detailState, setDetailState] = useState(detail);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditableSummary | null>(null);
  const [draftItems, setDraftItems] = useState<MeetingSyncActionItem[]>([]);

  useEffect(() => {
    setDetailState(detail);
    setEditing(false);
    setAnalysisError(null);
    setConfirmDiscard(false);
  }, [detail]);

  const summary = detailState.summary;
  const hasTranscript = detailState.segments.length > 0;
  const canAnalyze = hasTranscript && !analyzing;

  const analyze = async (): Promise<void> => {
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const outcome = await window.callnotes.llmAnalyzeMeeting(detailState.id);
      if (outcome.ok && outcome.meeting) {
        setDetailState(outcome.meeting);
      } else {
        setAnalysisError(outcome.error?.message ?? "Summary generation unavailable.");
      }
    } catch {
      setAnalysisError("Summary generation unavailable.");
    } finally {
      setAnalyzing(false);
    }
  };

  const beginEdit = (): void => {
    setDraft(toEditableSummary(summary));
    setDraftItems(detailState.actionItems.map((item) => ({ ...item })));
    setEditing(true);
  };

  // Re-run transcription + analysis from the preserved local audio.
  const retry = async (): Promise<void> => {
    if (busy || !detailState.hasLocalRecording) return;
    setBusy(true);
    setAnalysisError(null);
    try {
      const result = await window.callnotes.meetingRetry(detailState.id);
      if (!result.ok) {
        setAnalysisError(result.error?.message ?? "Could not retry transcription.");
      } else {
        const next = await window.callnotes.meetingGetLocal(detailState.id);
        if (next) setDetailState(next);
        setConfirmDiscard(false);
      }
    } catch {
      setAnalysisError("Could not retry transcription.");
    } finally {
      setBusy(false);
    }
  };

  // Explicitly delete the preserved local audio (the meeting record stays).
  const discard = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setAnalysisError(null);
    try {
      const result = await window.callnotes.meetingDiscardRecording(detailState.id);
      if (!result.ok) {
        setAnalysisError(result.error?.message ?? "Could not delete the recording audio.");
      } else {
        const next = await window.callnotes.meetingGetLocal(detailState.id);
        if (next) setDetailState(next);
        setConfirmDiscard(false);
      }
    } catch {
      setAnalysisError("Could not delete the recording audio.");
    } finally {
      setBusy(false);
    }
  };

  const updateSection = (key: string, text: string): void => {
    if (!draft) return;
    const values = text
      .split("\n")
      .map((line) => line.trim().replace(/^[-•]\s+/, ""))
      .filter((line) => line.length > 0);
    setDraft({ ...draft, sections: { ...draft.sections, [key]: values } });
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    const summary: MeetingSyncSummary = {
      summary: draft.summary.trim(),
      discussionPoints: draft.sections.discussionPoints,
      decisions: draft.sections.decisions,
      risks: draft.sections.risks,
      openQuestions: draft.sections.openQuestions,
      blockers: draft.sections.blockers,
      followUps: draft.sections.followUps,
      importantDates: draft.sections.importantDates,
      participants: draft.sections.participants,
      aiModel: draft.aiModel,
      aiProvider: draft.aiProvider,
    };
    try {
      const result = await window.callnotes.meetingSaveNotes(detailState.id, {
        summary,
        actionItems: draftItems.filter((item) => item.description.trim().length > 0),
      });
      if (!result.ok) {
        setAnalysisError(result.error?.message ?? "Could not save notes.");
      } else {
        const next = await window.callnotes.meetingGetLocal(detailState.id);
        if (next) setDetailState(next);
        setEditing(false);
      }
    } catch {
      setAnalysisError("Could not save notes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Offline recording" width="max-w-3xl">
      {loading ? (
        <div className="flex justify-center py-14 text-slate-500">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-white">{detailState.title}</h3>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span>{formatDateTime(detailState.startedAt ?? detailState.createdAt)}</span>
                <span className="text-slate-700">·</span>
                <span>{formatDuration(detailState.durationSeconds)}</span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <MeetingStatusBadge status={detailState.status} />
              <SyncStatusBadge status={detailState.syncStatus} error={detailState.syncError} />
            </div>
          </div>

          {/* Failed capture: preserved local audio can be retried or discarded */}
          {detailState.status === "FAILED" && (
            <section className="rounded-xl border border-amber-800/40 bg-amber-950/20 p-4">
              {detailState.hasLocalRecording ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-300">
                      <IconAlertTriangle className="text-sm" />
                      Recording preserved on this device
                    </h4>
                    <p className="mt-1 text-xs text-slate-400">
                      Processing failed, but the raw audio is still here so it can be retried. It never leaves your
                      machine.
                    </p>
                    {detailState.processingError && (
                      <p className="mt-1 text-xs text-amber-300/90">{detailState.processingError}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="sm" onClick={() => void retry()} loading={busy} disabled={busy}>
                      <IconRefresh className="text-sm" />
                      Retry
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(true)} disabled={busy}>
                      <IconTrash className="text-sm text-rose-400" />
                      Delete audio
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <IconAlertTriangle className="text-sm text-amber-300" />
                  This meeting could not be processed and its temporary audio has been removed.
                  {detailState.processingError && (
                    <span className="text-amber-300/90">{detailState.processingError}</span>
                  )}
                </p>
              )}
            </section>
          )}

          {/* Local AI analysis */}
          {hasTranscript && (
            <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <IconSparkles className="text-indigo-300" />
                  Local AI analysis
                </h4>
                {summary ? (
                  !editing && (
                    <Button variant="ghost" size="sm" onClick={beginEdit}>
                      <IconPencil className="text-sm" />
                      Edit
                    </Button>
                  )
                ) : (
                  <Button size="sm" loading={analyzing} onClick={() => void analyze()} disabled={!canAnalyze}>
                    <IconSparkles className="text-sm" />
                    {analyzing ? "Analyzing…" : "Generate summary"}
                  </Button>
                )}
              </div>

              {analyzing && (
                <p className="flex items-center gap-2 text-sm text-slate-400">
                  <Spinner className="h-4 w-4" />
                  Analyzing the transcript with your local model…
                </p>
              )}

              {analysisError && (
                <div className="space-y-2">
                  <ErrorNote message={`${analysisError}`} />
                  <div className="flex items-center gap-2">
                    <Button size="sm" loading={analyzing} onClick={() => void analyze()}>
                      Retry
                    </Button>
                    {analysisError === "Summary generation unavailable." ? (
                      <p className="text-xs text-amber-400">
                        Your transcript is safe — it stays stored locally on this device.
                      </p>
                    ) : null}
                  </div>
                </div>
              )}

              {!summary && !analyzing && !analysisError && (
                <p className="text-sm text-slate-500">
                  Generate an AI summary, decisions, risks, and action items from the transcript with your local model.
                </p>
              )}

              {summary && !editing && (
                <SummaryReadView summary={summary} />
              )}

              {!editing && detailState.actionItems.length > 0 && (
                <ActionItemsReadView items={detailState.actionItems} segments={detailState.segments} />
              )}

              {summary && editing && draft && (
                <div className="space-y-4">
                  <SectionLabel>Summary</SectionLabel>
                  <TextArea
                    value={draft.summary}
                    onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                    rows={4}
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    {SUMMARY_SECTIONS.map(({ key, label }) => (
                      <div key={key}>
                        <SectionLabel>{label}</SectionLabel>
                        <TextArea
                          value={(draft.sections[key] ?? []).join("\n")}
                          onChange={(e) => updateSection(key, e.target.value)}
                          rows={3}
                          placeholder="One item per line"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    <SectionLabel>{`Action items · ${draftItems.length}`}</SectionLabel>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setDraftItems((items) => [
                          ...items,
                          { description: "", assignee: null, dueDate: null, priority: "MEDIUM", status: "OPEN" },
                        ])
                      }
                    >
                      <IconPlus className="text-sm" />
                      Add item
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {draftItems.map((item, index) => (
                      <div key={`${item.clientItemId ?? "new"}-${index}`} className="rounded-lg bg-slate-950/60 p-3">
                        <div className="grid gap-2 sm:grid-cols-12">
                          <div className="sm:col-span-4">
                            <Input
                              value={item.description}
                              placeholder="Action item description"
                              onChange={(e) =>
                                setDraftItems((items) =>
                                  items.map((it, i) => (i === index ? { ...it, description: e.target.value } : it)),
                                )
                              }
                            />
                          </div>
                          <div className="sm:col-span-3">
                            <Input
                              value={item.assignee ?? ""}
                              placeholder="Assignee"
                              onChange={(e) =>
                                setDraftItems((items) =>
                                  items.map((it, i) => (i === index ? { ...it, assignee: e.target.value || null } : it)),
                                )
                              }
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <Input
                              type="date"
                              value={toDateInput(item.dueDate)}
                              onChange={(e) =>
                                setDraftItems((items) =>
                                  items.map((it, i) =>
                                    i === index
                                      ? { ...it, dueDate: e.target.value ? new Date(e.target.value) : null }
                                      : it,
                                  ),
                                )
                              }
                            />
                          </div>
                          <div className="sm:col-span-1">
                            <Select
                              value={item.priority ?? "MEDIUM"}
                              aria-label="Priority"
                              onChange={(e) =>
                                setDraftItems((items) =>
                                  items.map((it, i) =>
                                    i === index ? { ...it, priority: e.target.value as MeetingSyncActionItem["priority"] } : it,
                                  ),
                                )
                              }
                            >
                              <option value="LOW">Low</option>
                              <option value="MEDIUM">Med</option>
                              <option value="HIGH">High</option>
                            </Select>
                          </div>
                          <div className="sm:col-span-1">
                            <Select
                              value={item.status ?? "OPEN"}
                              aria-label="Status"
                              onChange={(e) =>
                                setDraftItems((items) =>
                                  items.map((it, i) =>
                                    i === index ? { ...it, status: e.target.value as MeetingSyncActionItem["status"] } : it,
                                  ),
                                )
                              }
                            >
                              <option value="OPEN">Open</option>
                              <option value="IN_PROGRESS">In progress</option>
                              <option value="COMPLETED">Done</option>
                            </Select>
                          </div>
                          <div className="sm:col-span-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDraftItems((items) => items.filter((_, i) => i !== index))}
                              aria-label="Remove action item"
                            >
                              <IconTrash className="text-sm text-rose-400" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                      Cancel
                    </Button>
                    <Button onClick={() => void save()} loading={saving}>
                      <IconCheck className="text-sm" />
                      Save analysis
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}

          {detailState.segments.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Full transcript · {detailState.segments.length} segments
              </h4>
              <VirtualizedList
                count={detailState.segments.length}
                itemHeight={72}
                height={384}
                className="w-full rounded-lg border border-slate-800/60 bg-slate-950/30"
                rowKey={(index) => detailState.segments[index]?.clientSegmentId ?? `${index}-row`}
                renderRow={(index) => {
                  const segment = detailState.segments[index];
                  if (segment == null) return <div className="h-full" />;
                  return (
                    <div className="flex h-full gap-3 overflow-hidden px-3 py-2">
                      <span className="mt-0.5 w-16 shrink-0 text-xs font-medium text-indigo-300">
                        {index + 1}. {segment.speaker}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm text-slate-200">{segment.text}</p>
                        <p className="mt-0.5 text-[10px] text-slate-600">{formatTime(segment.startMs)}</p>
                      </div>
                    </div>
                  );
                }}
              />
            </section>
          )}

          {detailState.segments.length === 0 && detailState.actionItems.length === 0 && !detailState.summary && (
            <p className="text-sm text-slate-500">Nothing was captured for this meeting.</p>
          )}
        </div>
      )}

      {confirmDiscard && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6" role="alertdialog">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <h4 className="text-base font-semibold text-white">Delete recording audio?</h4>
            <p className="mt-1 text-sm text-slate-400">
              This removes the preserved raw audio for “{detailState.title}” from this device. The meeting and any
              transcript text saved so far stay here, but transcription can no longer be retried.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmDiscard(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void discard()} loading={busy}>
                <IconTrash className="text-sm" />
                Delete audio
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SummaryReadView({ summary }: { summary: MeetingSyncSummary }): JSX.Element {
  return (
    <div className="space-y-3">
      <div>
        <SectionLabel>Summary</SectionLabel>
        <p className="text-sm leading-relaxed text-slate-200">{summary.summary}</p>
        {(summary.aiModel ?? summary.aiProvider) && (
          <p className="mt-1 text-[10px] text-slate-600">
            Generated by {summary.aiModel ?? "local model"} via {summary.aiProvider ?? "local runtime"}
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {SUMMARY_SECTIONS.map(({ key, label }) => (
          <NotesBlock key={key} title={label} value={summary[key]} />
        ))}
      </div>
    </div>
  );
}

function ActionItemsReadView({
  items,
  segments,
}: {
  items: MeetingSyncActionItem[];
  segments: LocalMeetingDetail["segments"];
}): JSX.Element {
  const segmentByIndex = new Map(segments.map((segment, index) => [segment.clientSegmentId, index]));
  return (
    <div className="space-y-2">
      <SectionLabel>{`Action items · ${items.length}`}</SectionLabel>
      <div className="space-y-2">
        {items.map((item) => {
          const sourceIndex = item.sourceSegmentId ? segmentByIndex.get(item.sourceSegmentId) : undefined;
          const source = sourceIndex !== undefined ? segments[sourceIndex] : null;
          return (
            <div key={item.clientItemId ?? item.description} className="rounded-lg bg-slate-950/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-slate-200">{item.description}</p>
                <span className="flex items-center gap-1.5">
                  <TaskStatusBadge status={item.status ?? "OPEN"} />
                  <PriorityBadge priority={item.priority ?? "MEDIUM"} />
                </span>
              </div>
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                <span>Assignee: {item.assignee ?? "Unknown"}</span>
                {item.dueDate && <span>Due: {formatDate(item.dueDate)}</span>}
                {source && <span>Source: segment {sourceIndex !== undefined ? sourceIndex + 1 : ""}</span>}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return <p className="mb-1.5 block text-xs font-medium text-slate-300">{children}</p>;
}

function NotesBlock({ title, value }: { title: string; value: unknown }): JSX.Element | null {
  const rendered = renderNotes(value);
  if (!rendered) return null;
  return (
    <div className="rounded-lg bg-slate-950/60 p-3">
      <p className="text-xs font-semibold text-slate-400">{title}</p>
      <div className="mt-1 text-sm text-slate-300">{rendered}</div>
    </div>
  );
}

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderNotes(value: unknown): JSX.Element | null {
  if (value == null) return null;
  if (typeof value === "string") return <p>{value}</p>;
  if (Array.isArray(value)) {
    const items = value.map((item, index) => (
      <li key={index} className="list-inside list-disc">
        {typeof item === "string" ? item : JSON.stringify(item)}
      </li>
    ));
    return <ul className="space-y-0.5">{items}</ul>;
  }
  if (typeof value === "object") return <p className="whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</p>;
  if (typeof value === "number" || typeof value === "boolean") return <p>{String(value)}</p>;
  if (typeof value === "bigint") return <p>{value.toString()}</p>;
  return null;
}