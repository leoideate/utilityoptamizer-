"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, Eye, FileText, Lock, Plus, Send, ShieldAlert, Sparkles, Trash2, Upload, XCircle } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { DOCUMENT_TYPES, type DocumentType } from "@uo/shared";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, IssueList, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { ApiError, api } from "@/lib/api";
import { cn, date, dateTime } from "@/lib/format";
import { useCan, useUser } from "@/lib/session";
import type { Workspace } from "@/lib/types";
import { BillReadingDialog } from "./bill-reading";
import { useRefreshOpportunity } from "./common";
import { RemoveDialog } from "./remove-dialog";

interface Version {
  id: string;
  version: number;
  filename?: string;
  mimeType?: string;
  size?: number;
  scanStatus: "pending" | "clean" | "infected" | "error" | "skipped";
  uploadedAt: string;
  /** Set when the file was removed as a wrong upload (it stays in the history). */
  removedAt?: string | null;
  removeReason?: string | null;
}
interface Item {
  id: string;
  documentType: DocumentType;
  label: string;
  required: boolean;
  sensitive: boolean;
  restricted: boolean;
  requestedAt: string | null;
  received: boolean;
  receivedAt: string | null;
  approval: "pending" | "approved" | "rejected";
  reviewedAt: string | null;
  reviewNotes: string | null;
  expiryDate: string | null;
  versions: Version[];
}

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*";

function Status({ item }: { item: Item }) {
  if (item.approval === "approved") return <Badge tone="success"><CheckCircle2 className="size-3" aria-hidden /> Approved</Badge>;
  if (item.approval === "rejected") return <Badge tone="danger"><XCircle className="size-3" aria-hidden /> Rejected</Badge>;
  if (item.received) return <Badge tone="info"><Clock className="size-3" aria-hidden /> Awaiting review</Badge>;
  if (item.requestedAt) return <Badge tone="warning">Requested {date(item.requestedAt)}</Badge>;
  return <Badge>Not received</Badge>;
}

export function DocumentsTab({ opp }: { opp: Workspace }) {
  const can = useCan();
  const refresh = useRefreshOpportunity(opp.id);
  const { data, isLoading, refetch } = useQuery({ queryKey: ["opportunity", opp.id, "documents"], queryFn: () => api.get<Item[]>(`/opportunities/${opp.id}/documents`) });
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState<{ url: string; mimeType: string; title: string } | null>(null);
  const [reviewing, setReviewing] = useState<Item | null>(null);
  const [removing, setRemoving] = useState<{ item: Item; version: Version } | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const after = () => (refresh(), refetch());
  const standard = useMutation({ mutationFn: () => api.post(`/opportunities/${opp.id}/documents/standard`), onSuccess: after });
  const request = useMutation({ mutationFn: () => api.post(`/opportunities/${opp.id}/documents/request`, { itemIds: selected }), onSuccess: () => (setSelected([]), after()) });
  const toggleRequired = useMutation({ mutationFn: (i: Item) => api.patch(`/documents/${i.id}`, { required: !i.required }), onSuccess: after });
  const open = async (v: Version, title: string) => {
    try {
      const r = await api.get<{ url: string; mimeType: string }>(`/document-versions/${v.id}/url`);
      setPreview({ ...r, title });
    } catch (e) {
      setPreview(null);
      alert((e as ApiError).message);
    }
  };
  const write = opp.permissions.write;
  // Won and lost deals keep their documents as they are.
  const canRemove = write && opp.outcome === "open";
  const deleteItem = useMutation({ mutationFn: (i: Item) => api.del(`/documents/${i.id}`), onSuccess: () => (setDeleting(null), after()) });

  if (isLoading || !data) return <Skeleton className="h-64" />;
  const outstanding = data.filter((d) => d.required && !d.received);

  return (
    <Card>
      <CardHeader
        title="Document checklist"
        description={outstanding.length ? `${outstanding.length} required document${outstanding.length === 1 ? "" : "s"} still outstanding.` : "All required documents are in."}
        actions={
          write && (
            <>
              {selected.length > 0 && can("document.request") && (
                <Button size="sm" variant="secondary" loading={request.isPending} onClick={() => request.mutate()}>
                  <Send /> Request {selected.length} from customer
                </Button>
              )}
              <Button size="sm" variant="secondary" loading={standard.isPending} onClick={() => standard.mutate()}>
                Add standard checklist
              </Button>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus /> Add document
              </Button>
            </>
          )
        }
      />
      {!data.length ? (
        <EmptyState icon={<FileText />} title="No documents on the checklist">
          Add the standard checklist for {opp.serviceType === "merchant_services" ? "Worldpay" : "energy"} deals, or add individual documents.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((item) => (
            <DocumentRow
              key={item.id}
              item={item}
              opp={opp}
              selectable={write && !item.received}
              selected={selected.includes(item.id)}
              onSelect={(on) => setSelected((s) => (on ? [...s, item.id] : s.filter((x) => x !== item.id)))}
              onUploaded={after}
              onOpen={(v) => open(v, `${item.label} v${v.version}`)}
              onReview={() => setReviewing(item)}
              onToggleRequired={() => toggleRequired.mutate(item)}
              canReview={can("document.review")}
              canRemove={canRemove}
              onRemove={(version) => setRemoving({ item, version })}
              onDelete={() => setDeleting(item)}
            />
          ))}
        </ul>
      )}
      {adding && <AddDocumentDialog opp={opp} onClose={() => (setAdding(false), after())} />}
      {reviewing && <ReviewDialog item={reviewing} onClose={() => (setReviewing(null), after())} />}
      {removing && (
        <RemoveDialog
          title={`Remove ${removing.item.label} v${removing.version.version}?`}
          description="The file stops being this document, so it needs uploading again. It stays in the document's history with your reason, and can't be removed if a form, check or submission uses it."
          confirmLabel="Remove file"
          remove={(reason) => api.post(`/document-versions/${removing.version.id}/remove`, { reason })}
          onDone={after}
          onClose={() => setRemoving(null)}
        />
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.label ?? ""} from the checklist?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleteItem.isPending} onClick={() => deleting && deleteItem.mutate(deleting)}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm">Nothing has been uploaded to it, so nothing is lost. The timeline records that it was removed.</p>
      </Dialog>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)} title={preview?.title ?? ""} description="This link expires in a few minutes." wide footer={preview && <Button asChild variant="secondary"><a href={preview.url} target="_blank" rel="noreferrer">Open in new tab</a></Button>}>
        {preview &&
          (preview.mimeType.startsWith("image/") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview.url} alt={preview.title} className="mx-auto max-h-[65vh] rounded-lg" />
          ) : preview.mimeType === "application/pdf" ? (
            <iframe src={preview.url} title={preview.title} className="h-[65vh] w-full rounded-lg border border-border" />
          ) : (
            <p className="text-sm">Preview isn't available for this file type.</p>
          ))}
      </Dialog>
    </Card>
  );
}

function DocumentRow({
  item,
  opp,
  selectable,
  selected,
  onSelect,
  onUploaded,
  onOpen,
  onReview,
  onToggleRequired,
  canReview,
  canRemove,
  onRemove,
  onDelete,
}: {
  item: Item;
  opp: Workspace;
  selectable: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onUploaded: () => void;
  onOpen: (v: Version) => void;
  onReview: () => void;
  onToggleRequired: () => void;
  canReview: boolean;
  canRemove: boolean;
  onRemove: (v: Version) => void;
  onDelete: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const aiReading = useUser().features.aiReading;
  const [readingBill, setReadingBill] = useState(false);
  const [over, setOver] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [error, setError] = useState<string[]>([]);
  const upload = useMutation({
    meta: { silent: true },
    mutationFn: (file: File) => api.upload(`/documents/${item.id}/versions`, file),
    onSuccess: () => (setError([]), onUploaded()),
    onError: (e) => setError(e instanceof ApiError ? (e.issues.length ? e.issues : [e.message]) : ["Upload failed."]),
  });
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f && opp.permissions.write) upload.mutate(f);
  };
  // The document's file is its newest version that hasn't been removed.
  const latest = item.versions.find((v) => !v.removedAt);

  return (
    <li
      className={cn("px-5 py-3 transition-colors", over && "bg-primary-soft")}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-3">
        {selectable ? <input type="checkbox" className="size-6 shrink-0 accent-[var(--primary)] lg:size-4" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${item.label}`} /> : <span className="size-6 shrink-0 lg:size-4" />}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {item.label}
            {item.sensitive && <Lock className="size-3.5 text-muted" aria-label="Restricted document" />}
            {!item.required && <span className="text-xs font-normal text-muted">optional</span>}
            <Status item={item} />
          </p>
          <p className="text-xs text-muted">
            {latest ? `v${latest.version} uploaded ${dateTime(latest.uploadedAt)}` : "Drop a file here or use Upload."}
            {item.expiryDate && ` · Expires ${date(item.expiryDate)}`}
            {latest?.scanStatus === "pending" && " · Virus scan pending"}
            {latest?.scanStatus === "skipped" && " · Not virus-scanned (no scanner configured)"}
          </p>
          {latest?.scanStatus === "infected" && (
            <p className="mt-1 flex items-center gap-1 text-xs text-danger">
              <ShieldAlert className="size-3.5" aria-hidden /> The last file failed the virus scan and was removed.
            </p>
          )}
          {item.approval === "rejected" && item.reviewNotes && <p className="mt-1 text-xs text-danger">Rejected: {item.reviewNotes}</p>}
          {error.length > 0 && <IssueList issues={error} title="Upload failed:" />}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {latest && !item.restricted && (
            <Button size="sm" variant="ghost" onClick={() => onOpen(latest)}>
              <Eye /> View
            </Button>
          )}
          {(item.versions.length > 1 || (item.versions.length === 1 && !latest)) && (
            <Button size="sm" variant="ghost" onClick={() => setShowVersions((s) => !s)} aria-expanded={showVersions}>
              {item.versions.length} versions
            </Button>
          )}
          {aiReading && item.documentType === "energy_bill" && latest && latest.scanStatus !== "infected" && opp.permissions.write && opp.outcome !== "won" && (
            <Button size="sm" variant="secondary" onClick={() => setReadingBill(true)}>
              <Sparkles /> Read bill
            </Button>
          )}
          {canReview && item.received && item.approval === "pending" && (
            <Button size="sm" variant="secondary" onClick={onReview}>
              Review
            </Button>
          )}
          {opp.permissions.write && (
            <>
              <input ref={input} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} aria-label={`Upload ${item.label}`} />
              <Button size="sm" variant="secondary" loading={upload.isPending} onClick={() => input.current?.click()}>
                <Upload /> Upload
              </Button>
              <Button size="sm" variant="ghost" onClick={onToggleRequired} title={item.required ? "Mark as optional" : "Mark as required"}>
                {item.required ? "Make optional" : "Make required"}
              </Button>
            </>
          )}
          {canRemove && latest && !item.restricted && (
            <Button size="sm" variant="ghost" onClick={() => onRemove(latest)} title="Remove a wrong upload">
              <Trash2 /> Remove file
            </Button>
          )}
          {canRemove && !item.versions.length && (
            <Button size="sm" variant="ghost" onClick={onDelete} title="Delete this row from the checklist">
              <Trash2 /> Delete
            </Button>
          )}
        </div>
      </div>
      {readingBill && latest && <BillReadingDialog opp={opp} versionId={latest.id} onClose={() => setReadingBill(false)} />}
      {showVersions && (
        <ul className="ml-7 mt-2 space-y-1 border-l border-border pl-3 text-xs">
          {item.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2">
              <span className={cn(v.removedAt && "text-muted line-through")}>
                v{v.version} · {dateTime(v.uploadedAt)} {v.filename && `· ${v.filename}`}
              </span>
              {v.removedAt && (
                <span className="text-muted">
                  Removed {date(v.removedAt)}
                  {v.removeReason && `: ${v.removeReason}`}
                </span>
              )}
              {!item.restricted && v.scanStatus !== "infected" && (
                <button className="min-h-6 text-primary hover:underline" onClick={() => onOpen(v)}>
                  View
                </button>
              )}
              {canRemove && !v.removedAt && !item.restricted && v.id !== latest?.id && (
                <button className="min-h-6 text-danger hover:underline" onClick={() => onRemove(v)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function AddDocumentDialog({ opp, onClose }: { opp: Workspace; onClose: () => void }) {
  const [type, setType] = useState<DocumentType>("other");
  const [required, setRequired] = useState(true);
  const [expiry, setExpiry] = useState("");
  const m = useMutation({ mutationFn: () => api.post(`/opportunities/${opp.id}/documents`, { documentType: type, required, expiryDate: expiry || null }), onSuccess: onClose });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add document to checklist"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} onClick={() => m.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Document type">
          {(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value as DocumentType)}>
              {Object.entries(DOCUMENT_TYPES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                  {v.sensitive ? " (restricted)" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Checkbox label="Required before submission" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        <Field label="Expiry date" hint="e.g. for photo ID">
          {(p) => <Input {...p} type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function ReviewDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const [notes, setNotes] = useState("");
  const [expiry, setExpiry] = useState(item.expiryDate?.slice(0, 10) ?? "");
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: (approval: "approved" | "rejected") => api.post(`/documents/${item.id}/review`, { approval, reviewNotes: notes || null, expiryDate: expiry || null }),
    onSuccess: onClose,
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Review: ${item.label}`}
      footer={
        <>
          <Button variant="danger" loading={m.isPending && m.variables === "rejected"} onClick={() => m.mutate("rejected")}>
            Reject
          </Button>
          <Button loading={m.isPending && m.variables === "approved"} onClick={() => m.mutate("approved")}>
            Approve
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Notes" hint="Required when rejecting: tell the salesperson what's wrong.">
          {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        <Field label="Expiry date">{(p) => <Input {...p} type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />}</Field>
        <IssueList issues={issues} />
      </div>
    </Dialog>
  );
}
