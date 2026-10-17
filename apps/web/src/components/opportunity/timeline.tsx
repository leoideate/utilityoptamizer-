"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, FileText, GitBranch, Mail, MessageCircle, PenLine, Phone, Send, ShieldCheck, StickyNote, UserRound, Zap } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, Field, Input, IssueList, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { type ApiError, api, idempotencyKey } from "@/lib/api";
import { dateTime } from "@/lib/format";
import type { Workspace } from "@/lib/types";
import { useRefreshOpportunity } from "./common";

interface IntegrationStatus {
  email: boolean;
  whatsapp: boolean;
  mailbox: { address: string; provider: "microsoft" | "google" } | null;
}

interface Entry {
  id: string;
  kind: string;
  body: string;
  direction: "inbound" | "outbound" | null;
  occurredAt: string;
  actorName: string;
  correctsId: string | null;
  data?: { emailMessageId?: string } | null;
}

const ICONS: Record<string, typeof Phone> = {
  call: Phone,
  note: StickyNote,
  email: Mail,
  whatsapp: MessageCircle,
  stage_change: GitBranch,
  assignment: UserRound,
  activity: CheckCircle2,
  document: FileText,
  approval: ShieldCheck,
  signature: PenLine,
  submission: Send,
  compliance: ShieldCheck,
  activation: Zap,
  outcome: CheckCircle2,
  system: GitBranch,
};

const FILTERS = [
  { key: "", label: "Everything" },
  { key: "comms", label: "Calls, emails & messages" },
  { key: "stage_change", label: "Stage changes" },
  { key: "document", label: "Documents & signatures" },
];

export function TimelineTab({ opp }: { opp: Workspace }) {
  const { data, isLoading, refetch } = useQuery({ queryKey: ["opportunity", opp.id, "timeline"], queryFn: () => api.get<Entry[]>(`/opportunities/${opp.id}/timeline`) });
  const [filter, setFilter] = useState("");
  const [composer, setComposer] = useState<null | "log" | "email" | "whatsapp">(null);
  const [correcting, setCorrecting] = useState<Entry | null>(null);
  const status = useQuery({ queryKey: ["integrations", "status"], queryFn: () => api.get<IntegrationStatus>("/integrations/status"), staleTime: 10 * 60_000 });
  const shown = data?.filter((e) =>
    !filter ? true : filter === "comms" ? ["call", "email", "whatsapp", "note"].includes(e.kind) : filter === "document" ? ["document", "signature"].includes(e.kind) : e.kind === filter,
  );
  const corrected = new Set(data?.map((e) => e.correctsId).filter(Boolean));

  return (
    <Card>
      <CardHeader
        title="Timeline"
        description="Everything that happened, newest first. Entries can't be edited; add a correction instead."
        actions={
          opp.permissions.write && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setComposer("log")}>
                <Phone /> Log call or note
              </Button>
              {status.data?.email && (
                <Button size="sm" variant="secondary" onClick={() => setComposer("email")}>
                  <Mail /> Send email
                </Button>
              )}
              {status.data?.whatsapp && (
                <Button size="sm" variant="secondary" onClick={() => setComposer("whatsapp")}>
                  <MessageCircle /> WhatsApp
                </Button>
              )}
            </>
          )
        }
      />
      <div className="border-b border-border px-5 py-2">
        <Select className="w-auto" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter timeline">
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </Select>
      </div>
      {isLoading || !shown ? (
        <Skeleton className="m-5 h-48" />
      ) : (
        <ol className="space-y-0 px-5 py-4">
          {shown.map((e) => {
            const Icon = ICONS[e.kind] ?? GitBranch;
            return (
              <li key={e.id} className="relative flex gap-3 pb-5 last:pb-0">
                <span className="absolute left-4 top-8 h-full w-px bg-border last:hidden" aria-hidden />
                <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 pt-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="font-medium text-text">{e.actorName}</span>
                    <span>{dateTime(e.occurredAt)}</span>
                    {e.direction === "inbound" && (
                      <Badge tone="info">
                        <ArrowDownLeft className="size-3" aria-hidden /> Inbound
                      </Badge>
                    )}
                    {e.direction === "outbound" && (
                      <Badge>
                        <ArrowUpRight className="size-3" aria-hidden /> Outbound
                      </Badge>
                    )}
                    {e.correctsId && <Badge tone="warning">Correction</Badge>}
                    {corrected.has(e.id) && <Badge>Corrected below</Badge>}
                  </p>
                  <p className="mt-0.5 whitespace-pre-line text-sm">{e.body}</p>
                  {e.data?.emailMessageId && (
                    <Link className="mt-1 inline-block text-xs text-primary hover:underline" href={`/inbox?id=${e.data.emailMessageId}`}>
                      Open email
                    </Link>
                  )}
                  {opp.permissions.write && ["call", "note", "email", "whatsapp"].includes(e.kind) && (
                    <button className="mt-1 text-xs text-primary hover:underline" onClick={() => setCorrecting(e)}>
                      Add correction
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {composer === "log" && <LogDialog opp={opp} onClose={() => (setComposer(null), refetch())} />}
      {correcting && <LogDialog opp={opp} corrects={correcting} onClose={() => (setCorrecting(null), refetch())} />}
      {composer === "email" && <EmailDialog opp={opp} from={status.data?.mailbox?.address ?? null} onClose={() => (setComposer(null), refetch())} />}
      {composer === "whatsapp" && <WhatsAppDialog opp={opp} onClose={() => (setComposer(null), refetch())} />}
    </Card>
  );
}

function useSend(opp: Workspace, onClose: () => void) {
  const refresh = useRefreshOpportunity(opp.id);
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => (refresh(), onClose()),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return { send: m.mutate, sending: m.isPending, issues };
}

function LogDialog({ opp, corrects, onClose }: { opp: Workspace; corrects?: Entry; onClose: () => void }) {
  const { send, sending, issues } = useSend(opp, onClose);
  const [kind, setKind] = useState<"call" | "note" | "email" | "whatsapp">((corrects?.kind as "call") ?? "call");
  const [direction, setDirection] = useState<"outbound" | "inbound">(corrects?.direction ?? "outbound");
  const [body, setBody] = useState(corrects ? `Correction: ${corrects.body}` : "");
  const [when, setWhen] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={corrects ? "Add a correction" : "Log a call, note or message"}
      description={corrects ? "The original entry stays; this one is shown as its correction." : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={sending}
            onClick={() =>
              send(() =>
                api.post(`/opportunities/${opp.id}/timeline`, {
                  kind,
                  body,
                  direction: kind === "note" ? null : direction,
                  occurredAt: when ? new Date(when).toISOString() : undefined,
                  correctsId: corrects?.id,
                }),
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} disabled={!!corrects}>
              <option value="call">Call</option>
              <option value="note">Note</option>
              <option value="email">Email (sent outside the CRM)</option>
              <option value="whatsapp">WhatsApp (sent outside the CRM)</option>
            </Select>
          )}
        </Field>
        {kind !== "note" && (
          <Field label="Direction">
            {(p) => (
              <Select {...p} value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
                <option value="outbound">We contacted them</option>
                <option value="inbound">They contacted us</option>
              </Select>
            )}
          </Field>
        )}
        <Field label="What happened?" required className="sm:col-span-2">
          {(p) => <Textarea {...p} value={body} onChange={(e) => setBody(e.target.value)} rows={5} autoFocus />}
        </Field>
        {!corrects && <Field label="When" hint="Leave blank for now.">{(p) => <Input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>}
      </div>
      <div className="mt-4">
        <IssueList issues={issues} />
      </div>
    </Dialog>
  );
}

function EmailDialog({ opp, from, onClose }: { opp: Workspace; from: string | null; onClose: () => void }) {
  const { send, sending, issues } = useSend(opp, onClose);
  const [key] = useState(idempotencyKey);
  const [to, setTo] = useState(opp.customer?.contacts.find((c) => c.email)?.email ?? opp.email ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Send email"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={sending} onClick={() => send(() => api.post(`/opportunities/${opp.id}/emails`, { to, subject, body, idempotencyKey: key }))}>
            <Send /> Send
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="To">{(p) => <Input {...p} type="email" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="Subject">{(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
        <Field label="Message">{(p) => <Textarea {...p} rows={8} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        <p className="text-xs text-muted">{from ? `Sent from your mailbox, ${from}. It appears in your Sent folder.` : "Sent from the CRM's shared address. Connect your mailbox on your account page to send as yourself."}</p>
        <IssueList issues={issues} />
      </div>
    </Dialog>
  );
}

function WhatsAppDialog({ opp, onClose }: { opp: Workspace; onClose: () => void }) {
  const { send, sending, issues } = useSend(opp, onClose);
  const [key] = useState(idempotencyKey);
  const mobile = opp.customer?.contacts.find((c) => c.mobile)?.mobile ?? opp.phone ?? "";
  const [to, setTo] = useState(mobile.replace(/[^\d+]/g, "").replace(/^0/, "+353"));
  const [body, setBody] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Send WhatsApp message"
      description="Free-text messages only reach customers who've messaged you in the last 24 hours."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={sending} onClick={() => send(() => api.post(`/opportunities/${opp.id}/whatsapp`, { to, body, idempotencyKey: key }))}>
            <Send /> Send
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Mobile (international format)">{(p) => <Input {...p} type="tel" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="Message">{(p) => <Textarea {...p} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        <IssueList issues={issues} />
      </div>
    </Dialog>
  );
}
