import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { SerializedTemplate } from "@callnotes/shared";
import { useDataStore } from "../stores/dataStore";
import { useToastStore } from "../stores/toastStore";
import { Badge, EmptyState } from "../components/ui/Card";
import { Button, Spinner } from "../components/ui/Button";
import { ErrorNote, Field, Input, Select, TextArea } from "../components/ui/inputs";
import { Modal } from "../components/ui/Modal";
import { IconCheck, IconLayoutTemplate, IconPencil, IconPlus, IconTrash } from "../components/ui/Icons";
import { formatDate } from "../lib/format";

interface TemplateSection {
  key: string;
  label: string;
  type: "list" | "text";
}

function parseSections(schema: unknown): TemplateSection[] {
  const sections = (schema as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections)) return [];
  return sections
    .map((entry): TemplateSection => {
      const section = entry as Partial<TemplateSection>;
      return {
        key: typeof section.key === "string" ? section.key : "",
        label: typeof section.label === "string" ? section.label : "",
        type: section.type === "text" ? "text" : "list",
      };
    })
    .filter((section) => section.key && section.label);
}

export function TemplatesPage(): JSX.Element {
  const templates = useDataStore((s) => s.templates);
  const loading = useDataStore((s) => s.templatesLoading);
  const defaultId = useDataStore((s) => s.templateDefaultId);
  const loadTemplates = useDataStore((s) => s.loadTemplates);

  const [editor, setEditor] = useState<{ mode: "create" | "edit"; template: SerializedTemplate | null } | null>(null);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  if (loading && !templates) {
    return (
      <div className="flex justify-center py-20 text-slate-500">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (!templates || templates.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={<IconLayoutTemplate className="text-3xl" />}
          title="No templates yet"
          message="Create your own meeting template, or use the seeded system ones to structure your summaries."
          action={
            <Button size="sm" onClick={() => setEditor({ mode: "create", template: null })}>
              <IconPlus className="text-sm" />
              New template
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-400">
          Templates control how meeting summaries are structured. System templates are read-only — duplicate one to
          customize it.
        </p>
        <Button size="sm" onClick={() => setEditor({ mode: "create", template: null })}>
          <IconPlus className="text-sm" />
          New template
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {templates.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            isDefault={template.id === defaultId}
            onEdit={
              template.type === "CUSTOM"
                ? () => setEditor({ mode: "edit", template })
                : undefined
            }
            onDuplicate={() => void duplicateWithToast(template.id)}
            onDelete={template.type === "CUSTOM" ? () => void deleteWithToast(template.id) : undefined}
          />
        ))}
      </div>

      {editor && (
        <TemplateEditorModal
          key={editor.template?.id ?? "new"}
          mode={editor.mode}
          template={editor.template}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

async function duplicateWithToast(id: string): Promise<void> {
  const duplicate = useDataStore.getState().duplicateTemplate;
  const pushToast = useToastStore.getState().push;
  const created = await duplicate(id);
  if (created) pushToast("success", `Duplicated as “${created.name}”`);
}

async function deleteWithToast(id: string): Promise<void> {
  const remove = useDataStore.getState().deleteTemplate;
  const pushToast = useToastStore.getState().push;
  if (await remove(id)) pushToast("success", "Template deleted");
}

function TemplateCard({
  template,
  isDefault,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  template: SerializedTemplate;
  isDefault: boolean;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}): JSX.Element {
  const setDefaultTemplate = useDataStore((s) => s.setDefaultTemplate);
  const sections = parseSections(template.schema);

  return (
    <div className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-5 transition-colors hover:border-slate-700">
      <div className="flex items-start justify-between gap-2">
        <h3 className="truncate text-sm font-semibold text-slate-100">{template.name}</h3>
        <div className="flex shrink-0 gap-1.5">
          <Badge tone={template.type === "SYSTEM" ? "indigo" : "sky"}>
            {template.type === "SYSTEM" ? "System" : "Custom"}
          </Badge>
          {isDefault && <Badge tone="emerald">Default</Badge>}
        </div>
      </div>

      {template.description && <p className="mt-1 text-xs text-slate-400">{template.description}</p>}
      <p className="mt-1 text-xs text-slate-500">
        {sections.length > 0 ? `${sections.length} section${sections.length === 1 ? "" : "s"}` : "No sections"} ·{" "}
        {sections.map((s) => s.label).join(", ") || "Plain template"}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
        <Button size="sm" variant="secondary" onClick={() => onDuplicate?.()}>
          Duplicate
        </Button>
        {onEdit && (
          <>
            {isDefault ? (
              <Button size="sm" variant="ghost" onClick={() => void setDefaultTemplate(null).then(() => useToastStore.getState().push("info", "No default template set"))}>
                Clear default
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => void setDefaultTemplate(template.id).then(() => useToastStore.getState().push("success", `“${template.name}” is now your default`))}>
                <IconCheck className="text-sm" />
                Make default
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit template">
              <IconPencil className="text-sm" />
            </Button>
          </>
        )}
        {onDelete && (
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete template">
            <IconTrash className="text-sm text-rose-400" />
          </Button>
        )}
      </div>

      <p className="pt-3 text-[11px] text-slate-600">
        {template.type === "SYSTEM" ? "Built-in" : `Added ${formatDate(template.createdAt)}`}
      </p>
    </div>
  );
}

function TemplateEditorModal({
  mode,
  template,
  onClose,
}: {
  mode: "create" | "edit";
  template: SerializedTemplate | null;
  onClose: () => void;
}): JSX.Element {
  const createTemplate = useDataStore((s) => s.createTemplate);
  const updateTemplate = useDataStore((s) => s.updateTemplate);
  const pushToast = useToastStore.getState().push;

  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [sections, setSections] = useState<TemplateSection[]>(parseSections(template?.schema));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateSection = (index: number, patch: Partial<TemplateSection>): void => {
    setSections((current) => current.map((section, i) => (i === index ? { ...section, ...patch } : section)));
  };

  const addSection = (): void => setSections((current) => [...current, { key: "", label: "", type: "list" }]);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the template a name.");
      return;
    }
    const cleaned = sections
      .map((section) => ({ ...section, key: section.key.trim(), label: section.label.trim() }))
      .filter((section) => section.key && section.label);
    const payload = { name: trimmed, description: description.trim() || undefined, schema: { sections: cleaned } };

    setSaving(true);
    setError(null);
    try {
      let success = false;
      if (mode === "create") {
        success = (await createTemplate(payload)) !== null;
      } else if (template) {
        success = await updateTemplate(template.id, payload);
      }
      if (success) {
        pushToast("success", mode === "create" ? "Template created" : "Template updated");
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open title={mode === "create" ? "New template" : `Edit “${template?.name}”`} onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly review" maxLength={200} autoFocus />
        </Field>
        <Field label="Description" hint="Optional. Shown next to the template when starting a meeting.">
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">Agenda sections</span>
            <Button variant="ghost" size="sm" onClick={addSection}>
              <IconPlus className="text-sm" />
              Add section
            </Button>
          </div>
          {sections.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-700 bg-slate-950/40 px-3 py-4 text-center text-xs text-slate-500">
              No sections — summaries will just have a plain notes area.
            </p>
          ) : (
            <div className="space-y-2">
              {sections.map((section, index) => (
                <div key={index} className="grid grid-cols-12 items-center gap-2 rounded-lg bg-slate-950/60 p-3">
                  <div className="col-span-5">
                    <Input
                      value={section.label}
                      placeholder="Heading (e.g. Decisions)"
                      maxLength={100}
                      onChange={(e) => updateSection(index, { label: e.target.value })}
                    />
                  </div>
                  <div className="col-span-4">
                    <Input
                      value={section.key}
                      placeholder="Key (e.g. decisions)"
                      maxLength={100}
                      onChange={(e) => updateSection(index, { key: e.target.value })}
                    />
                  </div>
                  <div className="col-span-2">
                    <Select value={section.type} onChange={(e) => updateSection(index, { type: e.target.value as "list" | "text" })}>
                      <option value="list">List</option>
                      <option value="text">Text</option>
                    </Select>
                  </div>
                  <div className="col-span-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Remove section"
                      onClick={() => setSections((current) => current.filter((_, i) => i !== index))}
                    >
                      <IconTrash className="text-sm text-rose-400" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <ErrorNote message={error} />}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            {mode === "create" ? "Create template" : "Save changes"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}