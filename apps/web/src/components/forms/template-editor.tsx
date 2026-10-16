"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, MousePointerClick, Plus, Save, Trash2 } from "lucide-react";
import type { PageViewport } from "pdfjs-dist";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useState } from "react";
import {
  DOCUMENT_TYPES,
  FORM_DOCUMENT_TYPES,
  FORM_FIELD_KINDS,
  FORM_FIELD_KIND_LABELS,
  FORM_SIGNER_ROLES,
  FORM_SIGNER_ROLE_LABELS,
  FORM_SOURCES,
  FORM_SOURCE_KEYS,
  type FormField,
  type FormFieldKind,
} from "@uo/shared";
import { useSuppliers } from "@/components/domain";
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, IssueList, Select, Skeleton } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { cn } from "@/lib/format";
import { PdfPage, toPdf, toScreen, usePdf } from "./pdf-page";

export interface TemplateFull {
  id: string;
  name: string;
  supplierId: string | null;
  supplier: { id: string; name: string } | null;
  documentType: string;
  version: number;
  filename: string;
  active: boolean;
  pages: { width: number; height: number }[];
  fields: FormField[];
}

const DEFAULT_SIZE: Record<FormFieldKind, { w: number; h: number }> = { text: { w: 160, h: 14 }, check: { w: 10, h: 10 }, signature: { w: 150, h: 36 }, signed_date: { w: 80, h: 14 } };
const KIND_COLOURS: Record<FormFieldKind, string> = {
  text: "border-sky-600 bg-sky-500/15",
  check: "border-emerald-600 bg-emerald-500/20",
  signature: "border-fuchsia-600 bg-fuchsia-500/15",
  signed_date: "border-amber-600 bg-amber-500/20",
};

const sourceLabel = (f: FormField) => (f.source ? FORM_SOURCES[f.source].label : f.kind === "signature" || f.kind === "signed_date" ? FORM_SIGNER_ROLE_LABELS[f.signer ?? "customer"] : "Typed when filling");

/** Lets a template manager place fields on a supplier PDF and map each to CRM data. */
export function TemplateEditor({ id }: { id: string }) {
  const qc = useQueryClient();
  const tpl = useQuery({ queryKey: ["form-template", id], queryFn: () => api.get<TemplateFull>(`/form-templates/${id}`) });
  const pdf = usePdf(`/form-templates/${id}/file`);
  const suppliers = useSuppliers("energy");
  const [fields, setFields] = useState<FormField[]>([]);
  const [meta, setMeta] = useState({ name: "", supplierId: "", documentType: "application_form", active: true });
  const [dirty, setDirty] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<FormFieldKind | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  useEffect(() => {
    if (!tpl.data) return;
    setFields(tpl.data.fields);
    setMeta({ name: tpl.data.name, supplierId: tpl.data.supplierId ?? "", documentType: tpl.data.documentType, active: tpl.data.active });
    setDirty(false);
  }, [tpl.data]);

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => api.patch(`/form-templates/${id}`, { ...meta, supplierId: meta.supplierId || null, fields }),
    onSuccess: () => (setIssues([]), setDirty(false), qc.invalidateQueries({ queryKey: ["form-template", id] }), qc.invalidateQueries({ queryKey: ["form-templates"] })),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });

  const update = (fid: string, patch: Partial<FormField>) => (setFields((fs) => fs.map((f) => (f.id === fid ? { ...f, ...patch } : f))), setDirty(true));
  const remove = (fid: string) => (setFields((fs) => fs.filter((f) => f.id !== fid)), setSelected(null), setDirty(true));
  const current = fields.find((f) => f.id === selected) ?? null;
  const pageCount = tpl.data?.pages.length ?? 1;
  const unmapped = fields.filter((f) => (f.kind === "text" || f.kind === "check") && !f.source).length;

  if (tpl.isLoading) return <Skeleton className="h-96" />;
  if (!tpl.data) return <p className="text-sm text-muted">Template not found.</p>;

  const place = (vp: PageViewport, e: ReactPointerEvent<HTMLDivElement>) => {
    if (!adding) return;
    const r = e.currentTarget.getBoundingClientRect();
    const size = DEFAULT_SIZE[adding];
    const p = toPdf(vp, e.clientX - r.left, e.clientY - r.top);
    const fid = `f${Date.now().toString(36)}`;
    const f: FormField = {
      id: fid,
      label: `${FORM_FIELD_KIND_LABELS[adding]} ${fields.length + 1}`,
      kind: adding,
      page,
      x: Math.max(0, Math.round(p.x)),
      y: Math.max(0, Math.round(p.y - size.h)),
      w: size.w,
      h: size.h,
      source: null,
      signer: adding === "signature" || adding === "signed_date" ? "customer" : null,
    };
    setFields((fs) => [...fs, f]);
    setSelected(fid);
    setAdding(null);
    setDirty(true);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">Add:</span>
          {FORM_FIELD_KINDS.map((k) => (
            <Button key={k} size="sm" variant={adding === k ? "primary" : "secondary"} onClick={() => setAdding(adding === k ? null : k)}>
              <Plus /> {FORM_FIELD_KIND_LABELS[k]}
            </Button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <span className="text-sm tabular-nums">
              Page {page + 1} of {pageCount}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        </div>
        {adding && (
          <p className="flex items-center gap-2 rounded-lg bg-info-soft p-2 text-sm text-info">
            <MousePointerClick className="size-4" aria-hidden /> Click on the page where the {FORM_FIELD_KIND_LABELS[adding].toLowerCase()} should start.
          </p>
        )}
        {pdf.data ? (
          <PdfPage
            doc={pdf.data}
            page={page}
            label={`${tpl.data.name}, page ${page + 1}`}
            overlay={(vp) => (
              <div className={cn("absolute inset-0", adding && "cursor-crosshair")} onPointerDown={(e) => e.target === e.currentTarget && (adding ? place(vp, e) : setSelected(null))}>
                {fields
                  .filter((f) => f.page === page)
                  .map((f) => (
                    <FieldBox key={f.id} field={f} viewport={vp} selected={f.id === selected} onSelect={() => setSelected(f.id)} onChange={(p) => update(f.id, p)} />
                  ))}
              </div>
            )}
          />
        ) : pdf.isError ? (
          <p className="text-sm text-danger">The PDF couldn&apos;t be shown.</p>
        ) : (
          <Skeleton className="aspect-[1/1.41] w-full" />
        )}
      </div>

      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader
            title="Template"
            description={`Version ${tpl.data.version} · ${tpl.data.filename}`}
            actions={
              <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                <Save /> Save
              </Button>
            }
          />
          <div className="space-y-3 p-5">
            <IssueList issues={issues} title="Please check:" />
            <Field label="Name">{(p) => <Input {...p} value={meta.name} onChange={(e) => (setMeta({ ...meta, name: e.target.value }), setDirty(true))} />}</Field>
            <Field label="Supplier">
              {(p) => (
                <Select {...p} value={meta.supplierId} onChange={(e) => (setMeta({ ...meta, supplierId: e.target.value }), setDirty(true))}>
                  <option value="">Any supplier</option>
                  {suppliers.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Saved on the checklist as">
              {(p) => (
                <Select {...p} value={meta.documentType} onChange={(e) => (setMeta({ ...meta, documentType: e.target.value }), setDirty(true))}>
                  {FORM_DOCUMENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {DOCUMENT_TYPES[t].label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Checkbox label="In use (shown when filling forms)" checked={meta.active} onChange={(e) => (setMeta({ ...meta, active: e.target.checked }), setDirty(true))} />
            {unmapped > 0 && <p className="text-xs text-muted">{unmapped} field{unmapped === 1 ? " is" : "s are"} not linked to CRM data; they&apos;re typed when the form is filled.</p>}
          </div>
        </Card>

        {current ? (
          <FieldPanel key={current.id} field={current} onChange={(p) => update(current.id, p)} onRemove={() => remove(current.id)} pageCount={pageCount} />
        ) : (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">Select a box on the page to link it to CRM data, or add a new field.</p>
        )}

        <Card>
          <CardHeader title={`Fields (${fields.length})`} />
          <ul className="max-h-80 divide-y divide-border overflow-y-auto">
            {fields.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className={cn("flex min-h-9 w-full items-center justify-between gap-2 px-5 py-1.5 text-left text-sm hover:bg-surface-2", f.id === selected && "bg-surface-2")}
                  onClick={() => (setPage(f.page), setSelected(f.id))}
                >
                  <span className="min-w-0 truncate">{f.label}</span>
                  <span className="shrink-0 text-xs text-muted">
                    p{f.page + 1} · {sourceLabel(f)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

/** A draggable, resizable field box. Coordinates stay in PDF points. */
function FieldBox({ field, viewport, selected, onSelect, onChange }: { field: FormField; viewport: PageViewport; selected: boolean; onSelect: () => void; onChange: (p: Partial<FormField>) => void }) {
  const box = toScreen(viewport, field);
  const scale = viewport.scale;
  const drag = (e: ReactPointerEvent, mode: "move" | "resize") => {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const start = { cx: e.clientX, cy: e.clientY, ...field };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.cx) / scale;
      const dy = (ev.clientY - start.cy) / scale;
      if (mode === "move") onChange({ x: Math.max(0, Math.round(start.x + dx)), y: Math.max(0, Math.round(start.y - dy)) });
      else {
        const h = Math.max(6, Math.round(start.h + dy));
        onChange({ w: Math.max(6, Math.round(start.w + dx)), h, y: Math.round(start.y + start.h - h) });
      }
    };
    const onUp = () => (el.removeEventListener("pointermove", onMove), el.removeEventListener("pointerup", onUp));
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${field.label} (${FORM_FIELD_KIND_LABELS[field.kind]})`}
      aria-pressed={selected}
      title={`${field.label}: ${sourceLabel(field)}`}
      onPointerDown={(e) => drag(e, "move")}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 10 : 1;
        const moves: Record<string, Partial<FormField>> = { ArrowLeft: { x: field.x - step }, ArrowRight: { x: field.x + step }, ArrowUp: { y: field.y + step }, ArrowDown: { y: field.y - step } };
        if (moves[e.key]) {
          e.preventDefault();
          onChange(moves[e.key]);
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn("absolute cursor-move touch-none border", KIND_COLOURS[field.kind], selected ? "z-10 ring-2 ring-[var(--primary)]" : "", !field.source && (field.kind === "text" || field.kind === "check") && "border-dashed")}
      style={box}
    >
      {selected && <span onPointerDown={(e) => drag(e, "resize")} className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm bg-[var(--primary)]" aria-hidden />}
    </div>
  );
}

function FieldPanel({ field, onChange, onRemove, pageCount }: { field: FormField; onChange: (p: Partial<FormField>) => void; onRemove: () => void; pageCount: number }) {
  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof FORM_SOURCE_KEYS>();
    for (const k of FORM_SOURCE_KEYS) {
      const s = FORM_SOURCES[k] as { group: string; check?: boolean };
      if (field.kind === "check" ? !s.check : s.check) continue;
      byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), k]);
    }
    return [...byGroup];
  }, [field.kind]);
  const signerKind = field.kind === "signature" || field.kind === "signed_date";
  return (
    <Card>
      <CardHeader
        title="Field"
        description={<Badge>{FORM_FIELD_KIND_LABELS[field.kind]}</Badge>}
        actions={
          <Button size="sm" variant="ghost" onClick={onRemove}>
            <Trash2 /> Remove
          </Button>
        }
      />
      <div className="space-y-3 p-5">
        <Field label="Label">{(p) => <Input {...p} value={field.label} onChange={(e) => onChange({ label: e.target.value })} />}</Field>
        <Field label="Type">
          {(p) => (
            <Select {...p} value={field.kind} onChange={(e) => onChange({ kind: e.target.value as FormFieldKind, source: null, signer: ["signature", "signed_date"].includes(e.target.value) ? (field.signer ?? "customer") : null })}>
              {FORM_FIELD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FORM_FIELD_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {signerKind ? (
          <Field label="Whose signature">
            {(p) => (
              <Select {...p} value={field.signer ?? "customer"} onChange={(e) => onChange({ signer: e.target.value as FormField["signer"] })}>
                {FORM_SIGNER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {FORM_SIGNER_ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <Field label="Fill from" hint="Leave as typed for values the CRM doesn't hold.">
            {(p) => (
              <Select {...p} value={field.source ?? ""} onChange={(e) => onChange({ source: (e.target.value || null) as FormField["source"] })}>
                <option value="">Typed when filling</option>
                {groups.map(([g, keys]) => (
                  <optgroup key={g} label={g}>
                    {keys.map((k) => (
                      <option key={k} value={k}>
                        {FORM_SOURCES[k].label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
        )}
        {field.kind === "text" && (
          <div className="grid grid-cols-2 gap-3 [&>*:first-child]:col-span-2">
            <Field label="Character boxes" hint="For rows of single-character boxes (e.g. MPRN). Blank = one box.">
              {(p) => <Input {...p} type="number" min={2} max={60} value={field.comb ?? ""} onChange={(e) => onChange({ comb: e.target.value ? Number(e.target.value) : undefined })} />}
            </Field>
            <Field label="Font size" hint="Blank = fit the box">
              {(p) => <Input {...p} type="number" min={5} max={24} value={field.fontSize ?? ""} onChange={(e) => onChange({ fontSize: e.target.value ? Number(e.target.value) : undefined })} />}
            </Field>
            <div className="flex items-end pb-2">
              <Checkbox label="Required" checked={!!field.required} onChange={(e) => onChange({ required: e.target.checked })} />
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 text-xs text-muted">
          <span>
            Page {field.page + 1} of {pageCount}
          </span>
          <span className="text-right tabular-nums">
            {Math.round(field.w)} × {Math.round(field.h)} pt
          </span>
        </div>
        <p className="text-xs text-muted">Drag to move, drag the corner to resize, or use the arrow keys (Shift for bigger steps).</p>
      </div>
    </Card>
  );
}
