"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Copy, Download, Eye, FilePen, History, Mail, RotateCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { APPLICATION_STATUS_LABELS, FORM_SIGNER_ROLE_LABELS, FORM_STATUS_LABELS, type FormSignerRole, type FormStatus, SIGNING_LINK_STATUS_LABELS, type SigningLinkStatus } from "@uo/shared";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, Field, Input, IssueList, Skeleton, type Tone } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { date, dateTime } from "@/lib/format";
import { useUser } from "@/lib/session";
import type { ApplicationVersion, ApplicationViewBase } from "./types";

const LINK_TONE: Record<SigningLinkStatus, Tone> = { sent: "info", opened: "warning", signed: "success", declined: "danger", expired: "neutral", revoked: "neutral" };
const FORM_TONE: Record<FormStatus, Tone> = { generated: "info", awaiting_review: "warning", approved: "success", rejected: "danger", superseded: "neutral" };
const issuesOf = (e: unknown) => ((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]);

/** Opens a stored PDF through a short-lived signed link (the API checks access and logs the view). */
async function openVersion(versionId: string) {
  const { url } = await api.get<{ url: string }>(`/document-versions/${versionId}/url`);
  window.open(url, "_blank", "noopener");
}

/**
 * A supplier application's document: preview the draft, generate (or replace) a version, send it
 * for signature, follow its signers, review the signed copy, and every version and audit entry.
 * The same for every supplier; `base` is the application's API path.
 */
export function DocumentPanel({
  base,
  formLabel,
  missingTemplate,
  view,
  dirty,
  hasIssues,
  onInvalid,
  refresh,
  signerDefaults,
}: {
  base: string;
  /** Where the draft is shown: "the Flogas form". */
  formLabel: string;
  missingTemplate: string;
  view: ApplicationViewBase;
  dirty: boolean;
  hasIssues: boolean;
  onInvalid: () => void;
  refresh: () => void;
  signerDefaults: (role: FormSignerRole) => { name: string; email: string };
}) {
  const current = view.versions.find((v) => v.current) ?? null;
  const [confirming, setConfirming] = useState(false);
  const [genIssues, setGenIssues] = useState<string[]>([]);
  const generate = useMutation({
    meta: { silent: true },
    mutationFn: (confirmReplace: boolean) => api.post<{ version: number; unchanged: boolean }>(`${base}/versions`, { confirmReplace }),
    onSuccess: () => (setGenIssues([]), setConfirming(false), refresh()),
    onError: (e) => (setGenIssues(issuesOf(e)), setConfirming(false)),
  });
  const used = !!current && (current.status !== "generated" || current.signatures.length > 0 || current.links.some((l) => l.status !== "revoked"));
  const start = () => {
    if (hasIssues) return onInvalid();
    if (used) setConfirming(true);
    else generate.mutate(false);
  };

  return (
    <>
      <Card>
        <CardHeader
          title="Document"
          description={`Status: ${APPLICATION_STATUS_LABELS[view.status]}`}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" asChild>
                <a href={`/api${base}/preview`} target="_blank" rel="noreferrer">
                  <Eye /> Preview draft
                </a>
              </Button>
              {view.permissions.write && (
                <Button size="sm" disabled={dirty || !view.template} title={dirty ? "Save the draft first." : !view.template ? "The form hasn't been set up yet." : undefined} loading={generate.isPending} onClick={start}>
                  <FilePen /> {current ? "Generate new version" : "Generate PDF"}
                </Button>
              )}
            </div>
          }
        />
        <div className="space-y-4 p-5">
          {!view.template && <p className="rounded-lg bg-warning-soft p-3 text-sm text-warning">{missingTemplate}</p>}
          {dirty && <p className="text-sm text-warning">You have unsaved changes. Save the draft before generating.</p>}
          {view.stale && current && <p className="rounded-lg bg-warning-soft p-3 text-sm text-warning">The details have changed since version {current.version} was generated. That version stays exactly as it was; generate a new version to include the changes.</p>}
          <IssueList issues={genIssues} title="The PDF wasn't generated:" />
          {!current ? <p className="text-sm text-muted">No version generated yet. The preview shows the draft on {formLabel}; nothing is stored until you generate.</p> : <CurrentVersion base={base} version={current} view={view} signerDefaults={signerDefaults} refresh={refresh} />}
        </div>
      </Card>

      {view.versions.length > 0 && <Versions versions={view.versions} readSensitive={view.permissions.readSensitive} />}
      <AuditTrail base={base} />

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Replace version ${current?.version ?? ""}?`}
        description={`Version ${current?.version ?? ""} has already been ${current?.status === "approved" ? "signed and approved" : current?.status === "awaiting_review" ? "signed" : "sent for signature"}. A new version replaces it and cancels its open signing links. Version ${current?.version ?? ""} and its files are kept.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={generate.isPending} onClick={() => generate.mutate(true)}>
              Generate new version
            </Button>
          </>
        }
      >
        <p className="text-sm">Only do this if something on the form needs correcting.</p>
      </Dialog>
    </>
  );
}

function CurrentVersion({ base, version: v, view, signerDefaults, refresh }: { base: string; version: ApplicationVersion; view: ApplicationViewBase; signerDefaults: (role: FormSignerRole) => { name: string; email: string }; refresh: () => void }) {
  const user = useUser();
  const [sending, setSending] = useState<FormSignerRole | null>(null);
  const [issued, setIssued] = useState<{ url: string; emailed: boolean } | null>(null);
  const [linkIssues, setLinkIssues] = useState<string[]>([]);
  const resend = useMutation({ meta: { silent: true }, mutationFn: (id: string) => api.post<{ url: string; emailed: boolean }>(`${base}/signing-links/${id}/resend`), onSuccess: (r) => (setIssued(r), refresh()), onError: (e) => setLinkIssues(issuesOf(e)) });
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/signing-links/${id}/revoke`), onSuccess: refresh });
  const [reviewNote, setReviewNote] = useState("");
  const [reviewIssues, setReviewIssues] = useState<string[]>([]);
  const review = useMutation({
    meta: { silent: true },
    mutationFn: (decision: "approved" | "rejected") => api.post(`/forms/${v.formId}/review`, { decision, note: reviewNote.trim() || null }),
    onSuccess: refresh,
    onError: (e) => setReviewIssues(issuesOf(e)),
  });
  const restricted = v.sensitive && !view.permissions.readSensitive;
  const signable = view.permissions.write && (v.status === "generated" || v.status === "awaiting_review") && !view.stale;
  const involved = v.signatures.some((s) => s.uploadedById === user.id) || v.links.some((l) => l.sentById === user.id);
  const latest = (role: FormSignerRole) => v.links.find((l) => l.role === role);
  const signed = (role: FormSignerRole) => v.signatures.find((s) => s.role === role);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Version {v.version}</span>
        <Badge tone={FORM_TONE[v.status]}>{FORM_STATUS_LABELS[v.status]}</Badge>
        <span className="text-xs text-muted">
          Generated by {v.createdBy ?? "system"} {dateTime(v.createdAt)} · template version {v.templateVersion} · layout {v.layoutVersion}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={restricted} onClick={() => openVersion(v.versionId)}>
          <Download /> Preview or download PDF
        </Button>
        {v.signedVersionId && (
          <Button size="sm" variant="secondary" disabled={restricted} onClick={() => openVersion(v.signedVersionId!)}>
            <Download /> Signed PDF
          </Button>
        )}
      </div>
      {restricted && <p className="text-xs text-muted">This PDF contains bank details, so only Finance, Compliance or an administrator can open it. Use “Preview draft” to see the form with the bank details masked.</p>}

      <div className="space-y-2">
        <p className="text-sm font-medium">Signatures</p>
        <ul className="space-y-2">
          {v.requiredSigners.map((role) => {
            const link = latest(role);
            const sig = signed(role);
            const live = link && (link.status === "sent" || link.status === "opened");
            return (
              <li key={role} className="space-y-1 rounded-lg border border-border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{FORM_SIGNER_ROLE_LABELS[role]}:</span>
                  {sig ? (
                    <Badge tone="success">
                      Signed by {sig.signerName} {dateTime(sig.uploadedAt)}
                    </Badge>
                  ) : link ? (
                    <Badge tone={LINK_TONE[link.status]}>{SIGNING_LINK_STATUS_LABELS[link.status]}</Badge>
                  ) : (
                    <Badge>Not sent</Badge>
                  )}
                  {!sig && signable && (
                    <Button size="sm" variant="ghost" onClick={() => (setLinkIssues([]), setSending(role))}>
                      <Mail /> {link ? "Send a new link" : "Send for signature"}
                    </Button>
                  )}
                  {!sig && signable && live && (
                    <>
                      <Button size="sm" variant="ghost" loading={resend.isPending && resend.variables === link.id} onClick={() => resend.mutate(link.id)}>
                        <RotateCw /> Resend
                      </Button>
                      <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === link.id} onClick={() => revoke.mutate(link.id)}>
                        <Ban /> Cancel link
                      </Button>
                    </>
                  )}
                </div>
                {link && (
                  <p className="break-words text-xs text-muted">
                    {link.signerName} ({link.signerEmail}) · sent {dateTime(link.sentAt)}
                    {link.openedAt && ` · viewed ${dateTime(link.openedAt)}`}
                    {link.signedAt && ` · signed ${dateTime(link.signedAt)}`}
                    {link.declinedAt && ` · declined ${dateTime(link.declinedAt)}${link.declineReason ? `: “${link.declineReason}”` : ""}`}
                    {live && ` · expires ${date(link.expiresAt)}`}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <IssueList issues={linkIssues} title="The link wasn't sent:" />
        {issued && <LinkResult {...issued} />}
      </div>

      {v.status === "awaiting_review" && view.permissions.review && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">Review the signed copy</p>
          {involved ? (
            <p className="text-sm text-muted">Someone other than the person who sent the links or uploaded signatures must review it.</p>
          ) : (
            <>
              <IssueList issues={reviewIssues} title="Please check:" />
              <Field label="Note" hint="Required when rejecting">
                {(p) => <Input {...p} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />}
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={review.isPending && review.variables === "approved"} onClick={() => review.mutate("approved")}>
                  <ShieldCheck /> Approve
                </Button>
                <Button size="sm" variant="secondary" loading={review.isPending && review.variables === "rejected"} onClick={() => review.mutate("rejected")}>
                  Reject
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {v.reviewedAt && (
        <p className="text-xs text-muted">
          {v.status === "approved" ? "Approved" : "Reviewed"} by {v.reviewedBy} {dateTime(v.reviewedAt)}
          {v.reviewNote ? `: ${v.reviewNote}` : ""}
        </p>
      )}
      {sending && (
        <SendDialog
          base={base}
          formId={v.formId}
          role={sending}
          defaults={signerDefaults(sending)}
          onClose={() => setSending(null)}
          onSent={(r) => (setIssued(r), setSending(null), refresh())}
        />
      )}
    </div>
  );
}

function SendDialog({ base, formId, role, defaults, onClose, onSent }: { base: string; formId: string; role: FormSignerRole; defaults: { name: string; email: string }; onClose: () => void; onSent: (r: { url: string; emailed: boolean }) => void }) {
  const [signerName, setName] = useState(defaults.name);
  const [email, setEmail] = useState(defaults.email);
  const [issues, setIssues] = useState<string[]>([]);
  const send = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<{ url: string; emailed: boolean }>(`${base}/versions/${formId}/send`, { role, signerName, email }),
    onSuccess: onSent,
    onError: (e) => setIssues(issuesOf(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Send for ${FORM_SIGNER_ROLE_LABELS[role].toLowerCase()} signature`}
      description="The signer gets a private link by email to read this exact version and sign it online. The link works once and expires after 14 days."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!signerName.trim() || !email.trim()} loading={send.isPending} onClick={() => send.mutate()}>
            <Mail /> Send link
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueList issues={issues} title="Please check:" />
        <Field label="Signer's name" required>
          {(p) => <Input {...p} value={signerName} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Signer's email" required hint="Any earlier open link for this signer stops working.">
          {(p) => <Input {...p} type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** A new link is shown once (only its hash is stored), so it can also be sent another way. */
function LinkResult({ url, emailed }: { url: string; emailed: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3 text-sm">
      <p>{emailed ? "The link has been emailed. You can also copy it and send it another way:" : "Email isn't set up, so copy this link and send it to the signer yourself:"}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-surface px-2 py-1 text-xs">{url}</code>
        <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(url).then(() => setCopied(true))}>
          <Copy /> {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      <p className="text-xs text-muted">This is the only time the link is shown. If it gets lost, use Resend for a new one.</p>
    </div>
  );
}

function Versions({ versions, readSensitive }: { versions: ApplicationVersion[]; readSensitive: boolean }) {
  return (
    <Card>
      <CardHeader title="All versions" description="Every generated version is kept, with the exact data it was made from." />
      <div className="min-w-0 overflow-x-auto" tabIndex={0}>
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Version</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Generated</th>
              <th className="px-3 py-2 font-medium">Files</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {versions.map((v) => (
              <tr key={v.formId}>
                <td className="px-3 py-2">{v.version}</td>
                <td className="px-3 py-2">
                  <Badge tone={FORM_TONE[v.status]}>{FORM_STATUS_LABELS[v.status]}</Badge>
                </td>
                <td className="px-3 py-2">
                  {dateTime(v.createdAt)} by {v.createdBy ?? "system"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" disabled={v.sensitive && !readSensitive} onClick={() => openVersion(v.versionId)}>
                      PDF
                    </Button>
                    {v.signedVersionId && (
                      <Button size="sm" variant="ghost" disabled={v.sensitive && !readSensitive} onClick={() => openVersion(v.signedVersionId!)}>
                        Signed PDF
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AuditTrail({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: ["application-history", base],
    enabled: open,
    queryFn: () => api.get<{ id: string; at: string; action: string; summary: string; actor: string }[]>(`${base}/history`),
  });
  const qc = useQueryClient();
  return (
    <Card>
      <CardHeader
        title="Audit trail"
        description="Saves, generated versions, signing links, signatures, reviews and downloads."
        actions={
          <Button size="sm" variant="secondary" onClick={() => (setOpen(!open), open || qc.invalidateQueries({ queryKey: ["application-history", base] }))}>
            <History /> {open ? "Hide" : "Show"}
          </Button>
        }
      />
      {open && (
        <div className="p-5">
          {history.isLoading ? (
            <Skeleton className="h-20" />
          ) : !history.data?.length ? (
            <p className="text-sm text-muted">Nothing recorded yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {history.data.map((h) => (
                <li key={h.id} className="py-2">
                  <span className="font-medium">{h.summary}</span>
                  <span className="block text-xs text-muted">
                    {h.actor} · {dateTime(h.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
