"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { BellRing, PenLine, Plus, Trash2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, IssueList, Select, Skeleton } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { date, dateTime } from "@/lib/format";
import type { Workspace } from "@/lib/types";
import { useRefreshOpportunity } from "./common";

interface Signer {
  id: string;
  role: "customer" | "broker";
  name: string;
  email: string;
  status: "pending" | "signed" | "declined";
  signedAt: string | null;
}
interface Request {
  id: string;
  title: string;
  provider: string;
  status: "draft" | "sent" | "partially_signed" | "completed" | "declined" | "expired" | "cancelled";
  requestedAt: string | null;
  lastReminderAt: string | null;
  completedAt: string | null;
  signers: Signer[];
  template: { name: string } | null;
}

const STATUS_TONE = { draft: "neutral", sent: "info", partially_signed: "warning", completed: "success", declined: "danger", expired: "danger", cancelled: "neutral" } as const;
const STATUS_LABEL = { draft: "Draft", sent: "Awaiting signature", partially_signed: "Partly signed", completed: "Signed", declined: "Declined", expired: "Expired", cancelled: "Cancelled" } as const;

export function SignaturesTab({ opp }: { opp: Workspace }) {
  const refresh = useRefreshOpportunity(opp.id);
  const { data, isLoading, refetch } = useQuery({ queryKey: ["opportunity", opp.id, "signatures"], queryFn: () => api.get<Request[]>(`/opportunities/${opp.id}/signatures`) });
  const [creating, setCreating] = useState(false);
  const after = () => (refresh(), refetch());
  const remind = useMutation({ mutationFn: (id: string) => api.post(`/signatures/${id}/remind`), onSuccess: after });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/signatures/${id}/cancel`), onSuccess: after });
  if (isLoading || !data) return <Skeleton className="h-48" />;
  const write = opp.permissions.write;

  return (
    <Card>
      <CardHeader
        title="Signatures"
        description="The customer must sign before submission. Each step is recorded in the timeline."
        actions={
          write && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> Request signature
            </Button>
          )
        }
      />
      {!data.length ? (
        <EmptyState icon={<PenLine />} title="No signature requests yet" />
      ) : (
        <ul className="divide-y divide-border">
          {data.map((r) => (
            <li key={r.id} className="space-y-2 px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="flex items-center gap-2 font-medium">
                    {r.title} <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  </p>
                  <p className="text-xs text-muted">
                    Requested {dateTime(r.requestedAt)}
                    {r.lastReminderAt && ` · Last reminder ${date(r.lastReminderAt)}`}
                    {r.completedAt && ` · Completed ${dateTime(r.completedAt)}`} · {r.provider === "manual" ? "Signed in person or by scan" : r.provider}
                  </p>
                </div>
                {write && ["sent", "partially_signed"].includes(r.status) && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => remind.mutate(r.id)}>
                      <BellRing /> Reminder sent
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>
                      <X /> Cancel
                    </Button>
                  </div>
                )}
              </div>
              <ul className="space-y-1">
                {r.signers.map((s) => (
                  <SignerRow key={s.id} request={r} signer={s} write={write} onDone={after} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {creating && <RequestDialog opp={opp} onClose={() => (setCreating(false), after())} />}
    </Card>
  );
}

function SignerRow({ request, signer, write, onDone }: { request: Request; signer: Signer; write: boolean; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const path = `/signatures/${request.id}/signers/${signer.id}/signed`;
      return file ? api.upload(path, file) : api.post(path);
    },
    onSuccess: onDone,
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  const open = ["sent", "partially_signed"].includes(request.status);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
      <span>
        {signer.name} <span className="text-muted">({signer.role === "customer" ? "customer" : "Utility Optimizer"}, {signer.email})</span>
      </span>
      {signer.status === "signed" ? (
        <Badge tone="success">Signed {dateTime(signer.signedAt)}</Badge>
      ) : signer.status === "declined" ? (
        <Badge tone="danger">Declined</Badge>
      ) : (
        write &&
        open &&
        request.provider === "manual" && (
          <span className="flex flex-wrap items-center gap-2">
            <input ref={input} type="file" accept=".pdf,image/*" className="sr-only" tabIndex={-1} onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Signed copy" />
            <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
              <Upload /> {file ? file.name : "Attach signed copy"}
            </Button>
            <Button size="sm" loading={m.isPending} onClick={() => m.mutate()}>
              Record signature
            </Button>
          </span>
        )
      )}
      {issues.length > 0 && <IssueList issues={issues} />}
    </li>
  );
}

function RequestDialog({ opp, onClose }: { opp: Workspace; onClose: () => void }) {
  const templates = useQuery({ queryKey: ["signature-templates"], queryFn: () => api.get<{ id: string; name: string; serviceType: string | null }[]>("/signature-templates") });
  const contact = opp.customer?.contacts[0];
  const [templateId, setTemplate] = useState("");
  const [title, setTitle] = useState(opp.serviceType === "merchant_services" ? "Worldpay merchant application" : "Supplier application & letter of authority");
  const [signers, setSigners] = useState([{ role: "customer" as const, name: contact ? `${contact.firstName} ${contact.lastName ?? ""}`.trim() : opp.contactName ?? "", email: contact?.email ?? opp.email ?? "" }]);
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post(`/opportunities/${opp.id}/signatures`, { templateId: templateId || null, title, signers }),
    onSuccess: onClose,
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Request signature"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} onClick={() => m.mutate()}>
            Create request
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Template">
            {(p) => (
              <Select
                {...p}
                value={templateId}
                onChange={(e) => {
                  setTemplate(e.target.value);
                  const t = templates.data?.find((x) => x.id === e.target.value);
                  if (t) setTitle(t.name);
                }}
              >
                <option value="">None</option>
                {templates.data?.filter((t) => !t.serviceType || t.serviceType === opp.serviceType || (t.serviceType !== "merchant_services" && opp.serviceType !== "merchant_services")).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Document title">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Signers</legend>
          {signers.map((s, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[140px_1fr_1fr_auto]">
              <Select aria-label="Signer role" value={s.role} onChange={(e) => setSigners((xs) => xs.map((x, j) => (j === i ? { ...x, role: e.target.value as "customer" } : x)))}>
                <option value="customer">Customer</option>
                <option value="broker">Utility Optimizer</option>
              </Select>
              <Input aria-label="Name" placeholder="Name" value={s.name} onChange={(e) => setSigners((xs) => xs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input aria-label="Email" type="email" placeholder="Email" value={s.email} onChange={(e) => setSigners((xs) => xs.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
              <Button variant="ghost" size="icon" aria-label="Remove signer" disabled={signers.length === 1} onClick={() => setSigners((xs) => xs.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setSigners((xs) => [...xs, { role: "broker" as never, name: "", email: "" }])}>
            <Plus /> Add signer
          </Button>
        </fieldset>
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}
