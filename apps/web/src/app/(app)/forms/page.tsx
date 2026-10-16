"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DOCUMENT_TYPES, FORM_DOCUMENT_TYPES } from "@uo/shared";
import { useSuppliers } from "@/components/domain";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, EmptyState, Field, Input, IssueList, PageHeader, Select, Skeleton } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { date } from "@/lib/format";
import { useCan } from "@/lib/session";

interface TemplateRow {
  id: string;
  name: string;
  documentType: keyof typeof DOCUMENT_TYPES;
  version: number;
  active: boolean;
  filename: string;
  supplier: { id: string; name: string } | null;
  updatedAt: string;
  _count: { forms: number };
}

export default function FormTemplatesPage() {
  const can = useCan();
  const allowed = can("form.template_manage");
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ["form-templates", "all"], queryFn: () => api.get<TemplateRow[]>("/form-templates/all"), enabled: allowed });
  if (!allowed) return <EmptyState title="Supplier forms are managed by administrators, managers and operations." />;
  return (
    <>
      <PageHeader
        title="Supplier forms"
        description="Upload a supplier's PDF once, place its fields and link them to CRM data. Forms are then filled from an opportunity's Forms tab."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add form
          </Button>
        }
      />
      {list.isLoading ? (
        <Skeleton className="h-40" />
      ) : !list.data?.length ? (
        <EmptyState icon={<FileText />} title="No supplier forms yet">
          Add an application form, rate card or direct debit mandate as a PDF.
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {list.data.map((t) => (
              <li key={t.id}>
                <Link href={`/forms/${t.id}`} className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-5 py-3 hover:bg-surface-2">
                  <span className="min-w-0">
                    <span className={t.active ? "font-medium" : "font-medium text-muted line-through"}>{t.name}</span>
                    <span className="block text-xs text-muted">
                      {t.supplier?.name ?? "Any supplier"} · {DOCUMENT_TYPES[t.documentType]?.label ?? t.documentType} · version {t.version} · updated {date(t.updatedAt)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {!t.active && <Badge>Retired</Badge>}
                    <Badge tone="info">{t._count.forms} filled</Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {adding && <AddTemplateDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function AddTemplateDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const suppliers = useSuppliers("energy");
  const [name, setName] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [documentType, setDocumentType] = useState<string>("application_form");
  const [file, setFile] = useState<File | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const create = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const fd = new FormData();
      fd.append("name", name);
      fd.append("supplierId", supplierId);
      fd.append("documentType", documentType);
      fd.append("file", file!);
      return api.postForm<{ id: string; fieldsFound: number }>("/form-templates", fd);
    },
    onSuccess: (r) => (qc.invalidateQueries({ queryKey: ["form-templates"] }), router.push(`/forms/${r.id}`)),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a supplier form"
      description="Fillable PDFs keep their fields; on flat PDFs you place the fields yourself."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || !file} loading={create.isPending} onClick={() => create.mutate()}>
            Upload
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueList issues={issues} title="Please check:" />
        <Field label="Name" required>
          {(p) => <Input {...p} value={name} placeholder="e.g. Bord Gáis electricity application" onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Supplier">
          {(p) => (
            <Select {...p} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Any supplier</option>
              {suppliers.data
                ?.filter((s) => s.active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Saved on the checklist as">
          {(p) => (
            <Select {...p} value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
              {FORM_DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPES[t].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="PDF" required>
          {(p) => <Input {...p} type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
        </Field>
      </div>
    </Dialog>
  );
}
