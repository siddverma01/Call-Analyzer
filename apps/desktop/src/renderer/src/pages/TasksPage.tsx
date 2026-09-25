import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { SerializedActionItem } from "@callnotes/shared";
import { useDataStore } from "../stores/dataStore";
import { useToastStore } from "../stores/toastStore";
import { EmptyState } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { ErrorNote, Field, Input, Select, TextArea } from "../components/ui/inputs";
import { Modal } from "../components/ui/Modal";
import { PriorityBadge, TaskStatusBadge } from "../components/ui/statusBadges";
import { IconCheck, IconCheckSquare, IconPencil, IconPlus, IconSearch, IconTrash } from "../components/ui/Icons";
import { formatDate } from "../lib/format";

type StatusFilter = "ALL" | "OPEN" | "IN_PROGRESS" | "COMPLETED";

export function TasksPage(): JSX.Element {
  const actionItems = useDataStore((s) => s.actionItems);
  const loading = useDataStore((s) => s.actionItemsLoading);
  const loadActionItems = useDataStore((s) => s.loadActionItems);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [editor, setEditor] = useState<SerializedActionItem | "new" | null>(null);

  useEffect(() => {
    void loadActionItems();
  }, [loadActionItems]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (actionItems ?? []).filter((item) => {
      if (status !== "ALL" && item.status !== status) return false;
      if (q && !item.description.toLowerCase().includes(q) && !(item.meetingTitle ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [actionItems, query, status]);

  const counts = useMemo(() => {
    return {
      open: (actionItems ?? []).filter((a) => a.status === "OPEN").length,
      inProgress: (actionItems ?? []).filter((a) => a.status === "IN_PROGRESS").length,
      completed: (actionItems ?? []).filter((a) => a.status === "COMPLETED").length,
    };
  }, [actionItems]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FilterPill active={status === "ALL"} onClick={() => setStatus("ALL")} label={`All (${(actionItems ?? []).length})`} />
        <FilterPill active={status === "OPEN"} onClick={() => setStatus("OPEN")} label={`Open (${counts.open})`} />
        <FilterPill
          active={status === "IN_PROGRESS"}
          onClick={() => setStatus("IN_PROGRESS")}
          label={`In progress (${counts.inProgress})`}
        />
        <FilterPill
          active={status === "COMPLETED"}
          onClick={() => setStatus("COMPLETED")}
          label={`Completed (${counts.completed})`}
        />
        <div className="ml-auto flex items-center gap-2">
          <div className="relative w-full sm:w-64">
            <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks…" className="pl-9" />
          </div>
          <Button size="sm" onClick={() => setEditor("new")}>
            <IconPlus className="text-sm" />
            Add task
          </Button>
        </div>
      </div>

      {loading && !actionItems ? (
        <p className="py-16 text-center text-slate-500">Loading tasks…</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<IconCheckSquare className="text-3xl" />}
          title={actionItems?.length ? "No tasks match" : "No action items yet"}
          message={
            actionItems?.length
              ? "Try a different search or filter."
              : "Action items from your meeting summaries will show up here, or add one yourself."
          }
          action={
            actionItems?.length === 0 ? (
              <Button size="sm" onClick={() => setEditor("new")}>
                <IconPlus className="text-sm" />
                Add task
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => (
            <TaskRow key={item.id} item={item} onEdit={() => setEditor(item)} onDelete={() => void deleteWithToast(item.id)} />
          ))}
        </div>
      )}

      {editor && (
        <TaskEditorModal
          key={editor === "new" ? "new" : editor.id}
          editor={editor}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

async function deleteWithToast(id: string): Promise<void> {
  const remove = useDataStore.getState().deleteActionItem;
  const pushToast = useToastStore.getState().push;
  if (await remove(id)) pushToast("success", "Task deleted");
}

function TaskRow({ item, onEdit, onDelete }: { item: SerializedActionItem; onEdit: () => void; onDelete: () => void }): JSX.Element {
  const updateActionItem = useDataStore((s) => s.updateActionItem);
  const completed = item.status === "COMPLETED";

  return (
    <div className={`flex items-start gap-4 rounded-xl border border-slate-800 bg-slate-900/60 px-5 py-4 ${completed ? "opacity-70" : ""}`}>
      <button
        type="button"
        title={completed ? "Mark as open" : "Mark as complete"}
        aria-label={completed ? "Mark as open" : "Mark as complete"}
        onClick={() => void updateActionItem(item.id, { status: completed ? "OPEN" : "COMPLETED" })}
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
          completed ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30" : "bg-slate-800 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
        }`}
      >
        <IconCheck className="text-sm" />
      </button>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium text-slate-100 ${completed ? "line-through" : ""}`}>{item.description}</p>
        <p className="mt-0.5 text-xs text-slate-500">{item.meetingTitle ? `From “${item.meetingTitle}”` : "Standalone task"}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          <PriorityBadge priority={item.priority} />
          <TaskStatusBadge status={item.status} />
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          {item.assignee && <span>{item.assignee}</span>}
          {item.dueDate && <span>due {formatDate(item.dueDate)}</span>}
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit task">
            <IconPencil className="text-sm" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete task">
            <IconTrash className="text-sm text-rose-400" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function TaskEditorModal({
  editor,
  onClose,
}: {
  editor: SerializedActionItem | "new";
  onClose: () => void;
}): JSX.Element {
  const createActionItem = useDataStore((s) => s.createActionItem);
  const updateActionItem = useDataStore((s) => s.updateActionItem);
  const pushToast = useToastStore.getState().push;

  const existing = editor === "new" ? null : editor;
  const [description, setDescription] = useState(existing?.description ?? "");
  const [assignee, setAssignee] = useState(existing?.assignee ?? "");
  const [dueDate, setDueDate] = useState(existing?.dueDate?.slice(0, 10) ?? "");
  const [priority, setPriority] = useState<"LOW" | "MEDIUM" | "HIGH">(existing?.priority ?? "MEDIUM");
  const [status, setStatus] = useState<"OPEN" | "IN_PROGRESS" | "COMPLETED">(existing?.status ?? "OPEN");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = description.trim();
    if (!trimmed) {
      setError("Describe the task first.");
      return;
    }
    setSaving(true);
    setError(null);
    const due = dueDate ? new Date(dueDate) : null;
    try {
      if (existing) {
        const updated = await updateActionItem(existing.id, {
          description: trimmed,
          assignee: assignee.trim() || null,
          dueDate: due,
          priority,
          status,
        });
        if (updated) {
          pushToast("success", "Task updated");
          onClose();
        }
      } else {
        const created = await createActionItem({
          description: trimmed,
          assignee: assignee.trim() || null,
          dueDate: due,
          priority,
          status,
        });
        if (created) {
          pushToast("success", "Task added");
          onClose();
        }
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open title={existing ? "Edit task" : "New task"} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Description">
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assignee">
            <Input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Who owns this?" maxLength={200} />
          </Field>
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as "LOW" | "MEDIUM" | "HIGH")}>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as "OPEN" | "IN_PROGRESS" | "COMPLETED")}>
              <option value="OPEN">Open</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="COMPLETED">Completed</option>
            </Select>
          </Field>
        </div>

        {error && <ErrorNote message={error} />}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            {existing ? "Save changes" : "Add task"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-indigo-500/20 text-indigo-200" : "bg-slate-800/70 text-slate-400 hover:text-slate-200"
      }`}
    >
      {label}
    </button>
  );
}