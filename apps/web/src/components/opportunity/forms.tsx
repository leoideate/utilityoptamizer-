"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Eye, FilePen, FileSignature, PenLine, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  FORM_SIGNER_ROLE_LABELS,
  FORM_STATUS_LABELS,
  type FormField,
  type FormSignerRole,
  type FormStatus,
  SIGNATURE_AUTHORISATIONS,
  SIGNATURE_AUTHORISATION_LABELS,
  type SignatureAuthorisation,
  isEnergyService,
} from "@uo/shared";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, IssueList, Select, Skeleton, type Tone } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { cn, date, dateTime, ref } from "@/lib/format";
import { useCan, useUser } from "@/lib/session";
import type { Workspace } from "@/lib/types";
import { CaseCard } from "./case";
import { useRefreshOpportunity } from "./common";

interface TemplateOption {
  id: string;
  name: string;
  version: number;
  supplierId: string | null;
  supplier: { id: string; name: string } | null;
}
interface PrefillField extends FormField {
  restricted: boolean;
  value: string | boolean | null;
  hasCrmValue: boolean;
  /** On the customer's last approved copy of this form (returning customers). */
  previousValue?: string | boolean | null;
  changedSincePrevious?: boolean;
}
interface FormRow {
  id: string;
  name: string;
  templateVersion: number;
  status: FormStatus;
  qcPassed: boolean;
  qcIssues: string[];
  changedFields: string[];
  changedSincePrevious: string[];
  changeReason: string | null;
  ibanChangeConfirmed: boolean;
  versionId: string;
  signedVersionId: string | null;
  monoVersionId: string | null;
  requiredSigners: FormSignerRole[];
  signatures: { id: string; role: FormSignerRole; signerName: string; signerCapacity: string | null; authorisation: SignatureAuthorisation; note: string | null; uploadedAt: string; uploadedBy: string | null; uploadedById: string | null }[];
  createdAt: string;
  createdBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
}

const STATUS_TONE: Record<FormStatus, Tone> = { generated: "warning", awaiting_review: "info", approved: "success", rejected: "danger", superseded: "neutral" };
const issuesOf = (e: unknown) => ((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]);

export function FormsTab({ opp }: { opp: Workspace }) {
  const switching = isEnergyService(opp.serviceType) && opp.supplyChanges.includes("change_of_supplier");
  return (
    <div className="space-y-6">
      {isEnergyService(opp.serviceType) && <CaseCard opp={opp} />}
      {switching && <SwitchCard opp={opp} />}
      <FillCard opp={opp} />
      <FormsList opp={opp} />
    </div>
  );
}

// --- Change of supplier ------------------------------------------------------------

interface BillChecks {
  latestBill: { versionId: string; version: number; filename: string; uploadedAt: string } | null;
  checks: { id: string; previousSupplier: string; billDate: string | null; readable: boolean; customerNameMatches: boolean; supplyPointMatches: boolean; supplierMatches: boolean; passed: boolean; notes: string | null; verifiedBy: string | null; verifiedAt: string; current: boolean }[];
}

function SwitchCard({ opp }: { opp: Workspace }) {
  const [checking, setChecking] = useState(false);
  const bills = useQuery({ queryKey: ["opportunity", opp.id, "bill-checks"], queryFn: () => api.get<BillChecks>(`/opportunities/${opp.id}/bill-checks`) });
  const conflicts = useQuery({
    queryKey: ["opportunity", opp.id, "switch-conflicts"],
    queryFn: () => api.get<{ conflicts: { id: string; number: number; name: string; stage: { name: string } }[]; hiddenCount: number }>(`/opportunities/${opp.id}/switch-conflicts`),
  });
  const current = bills.data?.checks.find((c) => c.current);
  const others = (conflicts.data?.conflicts.length ?? 0) + (conflicts.data?.hiddenCount ?? 0);
  return (
    <Card>
      <CardHeader
        title="Change of supplier"
        description="A readable bill from the previous supplier, matching this customer and supply point, is needed before submission."
        actions={
          opp.permissions.write &&
          bills.data?.latestBill && (
            <Button size="sm" onClick={() => setChecking(true)}>
              <ShieldCheck /> Check bill
            </Button>
          )
        }
      />
      <div className="space-y-3 p-5 text-sm">
        {others > 0 && (
          <div className="flex gap-2 rounded-lg bg-warning-soft p-3 text-warning" role="alert">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">Another open deal is switching the same meter.</p>
              <ul className="mt-1 space-y-0.5">
                {conflicts.data?.conflicts.map((c) => (
                  <li key={c.id}>
                    <a className="underline" href={`/opportunities/${c.id}`}>
                      {ref(c.number)} {c.name}
                    </a>{" "}
                    ({c.stage.name})
                  </li>
                ))}
                {!!conflicts.data?.hiddenCount && <li>{conflicts.data.hiddenCount} you can&apos;t open; ask a manager.</li>}
              </ul>
            </div>
          </div>
        )}
        {bills.isLoading ? (
          <Skeleton className="h-10" />
        ) : !bills.data?.latestBill ? (
          <p className="text-muted">No previous supplier bill yet. Upload it under Documents as the “Recent energy bill”.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span>
              Bill: {bills.data.latestBill.filename} (version {bills.data.latestBill.version}, {date(bills.data.latestBill.uploadedAt)})
            </span>
            {current ? (
              current.passed ? (
                <Badge tone="success">
                  <CheckCircle2 className="size-3" aria-hidden /> Checked by {current.verifiedBy}
                </Badge>
              ) : (
                <Badge tone="danger">
                  <XCircle className="size-3" aria-hidden /> Failed check
                </Badge>
              )
            ) : (
              <Badge tone="warning">Not checked</Badge>
            )}
          </div>
        )}
        {!!bills.data?.checks.length && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {bills.data.checks.map((c) => (
              <li key={c.id} className={cn("px-3 py-2", !c.current && "text-muted")}>
                <span className="font-medium">{c.passed ? "Passed" : "Failed"}</span> · {c.previousSupplier}
                {c.billDate && ` · bill dated ${date(c.billDate)}`} · {c.verifiedBy} {dateTime(c.verifiedAt)}
                {!c.current && " · for an older bill"}
                {!c.passed && (
                  <span className="block text-xs">
                    {[!c.readable && "not readable", !c.customerNameMatches && "customer name differs", !c.supplyPointMatches && "MPRN/GPRN or address differs", !c.supplierMatches && "supplier differs"].filter(Boolean).join(", ")}
                  </span>
                )}
                {c.notes && <span className="block text-xs">{c.notes}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {checking && <BillCheckDialog opp={opp} onClose={() => setChecking(false)} />}
    </Card>
  );
}

function BillCheckDialog({ opp, onClose }: { opp: Workspace; onClose: () => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const [v, setV] = useState({ previousSupplier: "", billDate: "", readable: false, customerNameMatches: false, supplyPointMatches: false, supplierMatches: false, notes: "" });
  const [issues, setIssues] = useState<string[]>([]);
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post(`/opportunities/${opp.id}/bill-checks`, { ...v, billDate: v.billDate || null, notes: v.notes || null }),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ["opportunity", opp.id, "bill-checks"] }), refresh(), onClose()),
    onError: (e) => setIssues(issuesOf(e)),
  });
  const tick = (k: "readable" | "customerNameMatches" | "supplyPointMatches" | "supplierMatches", label: string) => <Checkbox label={label} checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} />;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Check the previous supplier's bill"
      description="Open the bill under Documents and compare it with this deal. Untick anything that doesn't match; the check is kept as evidence."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Record check
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueList issues={issues} title="Please check:" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Previous supplier on the bill" required>
            {(p) => <Input {...p} value={v.previousSupplier} onChange={(e) => setV({ ...v, previousSupplier: e.target.value })} />}
          </Field>
          <Field label="Bill date">{(p) => <Input {...p} type="date" value={v.billDate} onChange={(e) => setV({ ...v, billDate: e.target.value })} />}</Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">The bill…</legend>
          {tick("readable", "is clear and readable")}
          {tick("customerNameMatches", `is in the customer's name (${opp.customer?.legalName ?? opp.companyName ?? "this customer"})`)}
          {tick("supplyPointMatches", "shows the same MPRN/GPRN and supply address")}
          {tick("supplierMatches", "is from the current supplier on this deal")}
        </fieldset>
        <Field label="Notes">{(p) => <Input {...p} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

// --- Filling ---------------------------------------------------------------------------

function FillCard({ opp }: { opp: Workspace }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const templates = useQuery({ queryKey: ["form-templates", opp.selectedSupplierId], queryFn: () => api.get<TemplateOption[]>(`/form-templates${opp.selectedSupplierId ? `?supplierId=${opp.selectedSupplierId}` : ""}`) });
  const [templateId, setTemplateId] = useState("");
  const prefill = useQuery({
    queryKey: ["opportunity", opp.id, "prefill", templateId],
    enabled: !!templateId,
    queryFn: () =>
      api.get<{ template: { name: string; version: number }; previousForm: { opportunityNumber: number; createdAt: string } | null; fields: PrefillField[] }>(`/opportunities/${opp.id}/forms/prefill?templateId=${templateId}`),
  });
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [confirmIban, setConfirmIban] = useState(false);
  const [changeReason, setChangeReason] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [result, setResult] = useState<{ qcPassed: boolean; qcIssues: string[] } | null>(null);
  const [showTyped, setShowTyped] = useState(false);
  useEffect(() => (setValues({}), setConfirmIban(false), setChangeReason(""), setIssues([]), setResult(null), setShowTyped(false)), [templateId]);

  // Fields filled from the CRM first; boxes with no CRM link are typed only when needed.
  const editable = useMemo(() => {
    const all = prefill.data?.fields.filter((f) => f.kind === "text" || f.kind === "check") ?? [];
    return [...all.filter((f) => f.source || f.required), ...all.filter((f) => !f.source && !f.required)];
  }, [prefill.data]);
  const typedCount = editable.filter((f) => !f.source && !f.required).length;
  const signatureBoxes = prefill.data?.fields.filter((f) => f.kind === "signature") ?? [];
  const changed = (f: PrefillField) => f.id in values && values[f.id] !== (f.value ?? (f.kind === "check" ? false : ""));
  const ibanChanged = editable.some((f) => f.source === "bank.iban" && changed(f) && (f.value || f.restricted));
  const missingRequired = editable.filter((f) => f.required && f.kind === "text" && !(f.id in values ? values[f.id] : f.value) && !f.restricted);

  const generate = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const sent: Record<string, string | boolean> = {};
      for (const f of editable) if (changed(f)) sent[f.id] = values[f.id];
      return api.post<{ id: string; qcPassed: boolean; qcIssues: string[] }>(`/opportunities/${opp.id}/forms`, { templateId, values: sent, confirmIbanChange: confirmIban || undefined, changeReason: changeReason.trim() || null });
    },
    onSuccess: (r) => (setIssues([]), setResult(r), qc.invalidateQueries({ queryKey: ["opportunity", opp.id, "forms"] }), refresh()),
    onError: (e) => setIssues(issuesOf(e)),
  });

  const previous = prefill.data?.previousForm;
  const differs = (f: PrefillField) =>
    !!previous && f.previousValue !== undefined && (changed(f) ? (values[f.id] ?? null) !== (f.previousValue ?? (f.kind === "check" ? false : "")) : !!f.changedSincePrevious);
  const changedSince = editable.filter((f) => differs(f));

  if (!opp.permissions.write) return null;
  return (
    <Card>
      <CardHeader title="Fill a supplier form" description="Values come from this deal and its customer. Anything you change here is recorded against the form." />
      <div className="space-y-4 p-5">
        <Field label="Form">
          {(p) => (
            <Select {...p} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Choose a form…</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.supplier ? ` (${t.supplier.name})` : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {templates.data && !templates.data.length && <p className="text-sm text-muted">No forms have been set up{opp.selectedSupplierId ? " for this supplier" : ""} yet. Ask an administrator to add one under Supplier forms.</p>}
        {templateId && prefill.isLoading && <Skeleton className="h-40" />}
        {prefill.data && (
          <>
            <div className="min-w-0 overflow-x-auto rounded-lg border border-border" tabIndex={0}>
              <table className="w-full min-w-[520px] text-sm">
                <thead className="bg-surface-2 text-left text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Field</th>
                    <th className="px-3 py-2 font-medium">Value on the form</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    {previous && <th className="px-3 py-2 font-medium">Last time ({ref(previous.opportunityNumber)})</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {editable.map((f) => {
                    if (!showTyped && !f.source && !f.required && !(f.id in values)) return null;
                    const v = f.id in values ? values[f.id] : f.value;
                    return (
                      <tr key={f.id} className={cn(changed(f) && "bg-warning-soft/60")}>
                        <td className="px-3 py-1.5">
                          {f.label}
                          {f.required && <span className="text-danger"> *</span>}
                        </td>
                        <td className="px-3 py-1.5">
                          {f.kind === "check" ? (
                            <Checkbox label={v ? "Ticked" : "Not ticked"} checked={!!v} onChange={(e) => setValues({ ...values, [f.id]: e.target.checked })} />
                          ) : (
                            <Input
                              aria-label={f.label}
                              className="h-8"
                              value={typeof v === "string" ? v : ""}
                              placeholder={f.restricted ? "On file (restricted); type only to change" : ""}
                              onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                            />
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-xs">
                          {changed(f) ? <Badge tone="warning">Changed by you</Badge> : f.restricted ? <Badge>Restricted</Badge> : f.hasCrmValue ? <span className="text-muted">CRM</span> : <span className="text-muted">{f.source ? "Not in the CRM" : "Typed"}</span>}
                        </td>
                        {previous && (
                          <td className="px-3 py-1.5 text-xs">
                            {f.previousValue === undefined ? (
                              <span className="text-muted">—</span>
                            ) : differs(f) ? (
                              <Badge tone="info">Was: {f.restricted && f.previousValue === null ? "restricted" : typeof f.previousValue === "boolean" ? (f.previousValue ? "ticked" : "not ticked") : f.previousValue || "empty"}</Badge>
                            ) : (
                              <span className="text-muted">Unchanged</span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {typedCount > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setShowTyped(!showTyped)}>
                {showTyped ? "Hide" : "Show"} {typedCount} field{typedCount === 1 ? "" : "s"} not linked to the CRM
              </Button>
            )}
            {!!signatureBoxes.length && (
              <p className="text-sm text-muted">Signature boxes: {[...new Set(signatureBoxes.map((f) => FORM_SIGNER_ROLE_LABELS[f.signer ?? "customer"]))].join(", ")}. Add signatures after generating.</p>
            )}
            {ibanChanged && <Checkbox label="I've confirmed the new IBAN with the customer" checked={confirmIban} onChange={(e) => setConfirmIban(e.target.checked)} />}
            {!!changedSince.length && (
              <Field label="Why these changed since last time" hint={`Changed: ${changedSince.map((f) => f.label).join(", ")}. Kept with the form and on the timeline.`}>
                {(p) => <Input {...p} value={changeReason} onChange={(e) => setChangeReason(e.target.value)} />}
              </Field>
            )}
            {missingRequired.length > 0 && <p className="text-sm text-warning">Required but empty: {missingRequired.map((f) => f.label).join(", ")}.</p>}
            <IssueList issues={issues} title="The form wasn't generated:" />
            {result && (
              <div className={cn("rounded-lg p-3 text-sm", result.qcPassed ? "bg-success-soft text-success" : "bg-danger-soft text-danger")} role="status">
                {result.qcPassed ? "Generated. The quality check passed; add the signatures below." : "Generated, but the quality check failed:"}
                {!result.qcPassed && (
                  <ul className="ml-4 list-disc">
                    {result.qcIssues.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex justify-end">
              <Button loading={generate.isPending} onClick={() => generate.mutate()}>
                <FilePen /> Generate PDF
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

// --- Generated forms ------------------------------------------------------------------

function FormsList({ opp }: { opp: Workspace }) {
  const can = useCan();
  const user = useUser();
  const forms = useQuery({ queryKey: ["opportunity", opp.id, "forms"], queryFn: () => api.get<FormRow[]>(`/opportunities/${opp.id}/forms`) });
  const [showOld, setShowOld] = useState(false);
  const [signing, setSigning] = useState<{ form: FormRow; role: FormSignerRole } | null>(null);
  const [reviewing, setReviewing] = useState<FormRow | null>(null);
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  const open = useMutation({
    mutationFn: async ({ versionId, title }: { versionId: string; title: string }) => ({ ...(await api.get<{ url: string }>(`/document-versions/${versionId}/url`)), title }),
    onSuccess: (r) => setPreview(r),
  });

  const visible = forms.data?.filter((f) => showOld || f.status !== "superseded") ?? [];
  const old = (forms.data?.length ?? 0) - (forms.data?.filter((f) => f.status !== "superseded").length ?? 0);
  return (
    <Card>
      <CardHeader title="Filled forms" actions={old > 0 && <Checkbox label={`Show ${old} superseded`} checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />} />
      {forms.isLoading ? (
        <Skeleton className="m-5 h-20" />
      ) : !visible.length ? (
        <EmptyState icon={<FileSignature />} title="No forms filled yet">
          Choose a supplier form above to fill it from this deal.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((f) => {
            const latest = new Map(f.signatures.map((s) => [s.role, s]));
            const uploadedByMe = f.signatures.some((s) => s.uploadedById === user.id);
            return (
              <li key={f.id} className="space-y-2 px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{f.name}</span>{" "}
                    <Badge tone={STATUS_TONE[f.status]}>{FORM_STATUS_LABELS[f.status]}</Badge> {f.qcPassed ? <Badge tone="success">Quality check passed</Badge> : <Badge tone="danger">Quality check failed</Badge>}
                    <span className="block text-xs text-muted">
                      Template version {f.templateVersion} · generated by {f.createdBy ?? "system"} {dateTime(f.createdAt)}
                      {!!f.changedFields.length && ` · changed by hand: ${f.changedFields.join(", ")}`}
                      {!!f.changedSincePrevious.length && ` · changed since the previous form: ${f.changedSincePrevious.join(", ")}${f.changeReason ? ` (${f.changeReason})` : ""}`}
                      {f.ibanChangeConfirmed && " · IBAN change confirmed"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => open.mutate({ versionId: f.versionId, title: f.name })}>
                      <Eye /> Unsigned
                    </Button>
                    {f.signedVersionId && (
                      <Button size="sm" variant="secondary" onClick={() => open.mutate({ versionId: f.signedVersionId!, title: `${f.name} (signed)` })}>
                        <Eye /> Signed
                      </Button>
                    )}
                    {f.monoVersionId && (
                      <Button size="sm" variant="secondary" onClick={() => open.mutate({ versionId: f.monoVersionId!, title: `${f.name} (black and white)` })}>
                        <Eye /> B&amp;W
                      </Button>
                    )}
                    {opp.permissions.write && f.qcPassed && (f.status === "approved" || (f.status === "generated" && !f.requiredSigners.length)) && <MonoButton opp={opp} form={f} />}
                    {f.status === "awaiting_review" && can("document.review") && (
                      <Button size="sm" disabled={uploadedByMe} title={uploadedByMe ? "Someone else must review signatures you uploaded." : undefined} onClick={() => setReviewing(f)}>
                        <ShieldCheck /> Review
                      </Button>
                    )}
                  </div>
                </div>
                {!f.qcPassed && (
                  <ul className="ml-4 list-disc text-sm text-danger">
                    {f.qcIssues.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                )}
                {!!f.requiredSigners.length && (
                  <div className="flex flex-wrap gap-2">
                    {f.requiredSigners.map((role) => {
                      const s = latest.get(role);
                      return (
                        <div key={role} className="flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 py-1 text-sm">
                          <span className="font-medium">{FORM_SIGNER_ROLE_LABELS[role]}:</span>
                          {s ? (
                            <span title={`${SIGNATURE_AUTHORISATION_LABELS[s.authorisation]}. Uploaded by ${s.uploadedBy} ${dateTime(s.uploadedAt)}.`}>
                              {s.signerName}
                              {s.signerCapacity ? ` (${s.signerCapacity})` : ""}
                            </span>
                          ) : (
                            <span className="text-muted">not signed</span>
                          )}
                          {opp.permissions.write && f.qcPassed && (f.status === "generated" || f.status === "awaiting_review") && (
                            <Button size="sm" variant="ghost" onClick={() => setSigning({ form: f, role })}>
                              <PenLine /> {s ? "Replace" : "Add signature"}
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {f.reviewedAt && (
                  <p className="text-xs text-muted">
                    {f.status === "approved" ? "Approved" : "Reviewed"} by {f.reviewedBy} {dateTime(f.reviewedAt)}
                    {f.reviewNote ? `: ${f.reviewNote}` : ""}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {signing && <SignatureDialog opp={opp} form={signing.form} role={signing.role} onClose={() => setSigning(null)} />}
      {reviewing && <ReviewDialog opp={opp} form={reviewing} onClose={() => setReviewing(null)} onOpen={() => open.mutate({ versionId: reviewing.signedVersionId!, title: `${reviewing.name} (signed)` })} />}
      <Dialog
        open={!!preview}
        onOpenChange={(o) => !o && setPreview(null)}
        title={preview?.title ?? ""}
        description="This link expires in a few minutes."
        wide
        footer={
          preview && (
            <Button asChild variant="secondary">
              <a href={preview.url} target="_blank" rel="noreferrer">
                Open in new tab
              </a>
            </Button>
          )
        }
      >
        {preview && <iframe src={preview.url} title={preview.title} className="h-[65vh] w-full rounded-lg border border-border" />}
      </Dialog>
    </Card>
  );
}

/** Makes the black and white copy some suppliers need, directly from the PDF (no printing or rescanning). */
function MonoButton({ opp, form }: { opp: Workspace; form: FormRow }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const make = useMutation({
    mutationFn: () => api.post<{ versionId: string }>(`/forms/${form.id}/mono`, {}),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ["opportunity", opp.id, "forms"] }), qc.invalidateQueries({ queryKey: ["opportunity", opp.id, "case"] }), refresh()),
  });
  return (
    <Button size="sm" variant="ghost" loading={make.isPending} onClick={() => make.mutate()}>
      {form.monoVersionId ? "Remake B&W copy" : "Make B&W copy"}
    </Button>
  );
}

/**
 * Turns a photo of a signature into a transparent PNG: pixels lighter than the threshold become
 * transparent, the rest become ink, and the result is cropped to the signature.
 */
async function cleanSignature(file: File, threshold: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let [minX, minY, maxX, maxY] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (d[i + 3] < 10 || lum > threshold) {
        d[i + 3] = 0;
        continue;
      }
      // Darker ink is more opaque, which keeps pen strokes smooth.
      d[i] = 20;
      d[i + 1] = 24;
      d[i + 2] = 60;
      d[i + 3] = Math.min(255, Math.round(((threshold - lum) / Math.max(1, threshold)) * 255 * 1.6) + 60);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("No signature found. Lower the background removal or use a darker photo.");
  ctx.putImageData(img, 0, 0);
  const pad = 6;
  const cw = Math.min(w, maxX - minX + 1 + pad * 2);
  const ch = Math.min(h, maxY - minY + 1 + pad * 2);
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d")!.drawImage(canvas, Math.max(0, minX - pad), Math.max(0, minY - pad), cw, ch, 0, 0, cw, ch);
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("The image couldn't be prepared."))), "image/png"));
}

function SignatureDialog({ opp, form, role, onClose }: { opp: Workspace; form: FormRow; role: FormSignerRole; onClose: () => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const contact = opp.customer?.contacts[0];
  const [signerName, setSignerName] = useState(role === "customer" ? (contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") : (opp.contactName ?? "")) : (opp.owner?.name ?? ""));
  const [capacity, setCapacity] = useState("");
  const [authorisation, setAuthorisation] = useState<SignatureAuthorisation>(role === "broker" ? "broker_own_signature" : "signed_in_person");
  const [note, setNote] = useState("");
  const [attest, setAttest] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [threshold, setThreshold] = useState(170);
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  useEffect(() => {
    if (!file) return;
    let url = "";
    let cancelled = false;
    cleanSignature(file, threshold)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPng({ blob, url });
        setIssues([]);
      })
      .catch((e: Error) => !cancelled && (setPng(null), setIssues([e.message.includes("decode") || e.name === "InvalidStateError" ? "This image type can't be read here. Use a JPG or PNG photo." : e.message])));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, threshold]);

  const upload = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const fd = new FormData();
      fd.append("role", role);
      fd.append("signerName", signerName);
      fd.append("signerCapacity", capacity);
      fd.append("authorisation", authorisation);
      fd.append("note", note);
      fd.append("attest", String(attest));
      fd.append("file", png!.blob, "signature.png");
      return api.postForm<{ signed: boolean; qcPassed?: boolean; qcIssues?: string[] }>(`/forms/${form.id}/signatures`, fd);
    },
    onSuccess: () => (qc.invalidateQueries({ queryKey: ["opportunity", opp.id, "forms"] }), refresh(), onClose()),
    onError: (e) => setIssues(issuesOf(e)),
  });
  const options = SIGNATURE_AUTHORISATIONS.filter((a) => (role === "broker" ? true : a !== "broker_own_signature"));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${FORM_SIGNER_ROLE_LABELS[role]} signature for ${form.name}`}
      description="Use a signature the signer gave for this form only. It's placed on this version of the PDF and a colleague reviews it before submission."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!png || !attest || !signerName.trim()} loading={upload.isPending} onClick={() => upload.mutate()}>
            Add signature
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueList issues={issues} title="Please check:" />
        <Field label="Photo or scan of the signature" hint="Sign on white paper with a dark pen. The background is removed automatically.">
          {(p) => <Input {...p} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
        </Field>
        {file && (
          <div className="space-y-2">
            <div className="flex min-h-24 items-center justify-center rounded-lg border border-border bg-[repeating-conic-gradient(#e5e7eb_0_25%,#fff_0_50%)] bg-[length:16px_16px] p-3">
              {/* A local blob preview; next/image can't optimise object URLs. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {png ? <img src={png.url} alt="Cleaned signature preview" className="max-h-28 max-w-full" /> : <Skeleton className="h-16 w-48" />}
            </div>
            <Field label={`Background removal (${threshold})`} hint="Move right if paper shows; left if strokes are missing.">
              {(p) => <input {...p} type="range" min={90} max={240} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="h-6 w-full accent-[var(--primary)]" />}
            </Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Signer's name" required>
            {(p) => <Input {...p} value={signerName} onChange={(e) => setSignerName(e.target.value)} />}
          </Field>
          <Field label="Capacity" hint="e.g. Director, owner">
            {(p) => <Input {...p} value={capacity} onChange={(e) => setCapacity(e.target.value)} />}
          </Field>
        </div>
        <Field label="How was it authorised?">
          {(p) => (
            <Select {...p} value={authorisation} onChange={(e) => setAuthorisation(e.target.value as SignatureAuthorisation)}>
              {options.map((a) => (
                <option key={a} value={a}>
                  {SIGNATURE_AUTHORISATION_LABELS[a]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Note" hint="Optional, e.g. which email or message it came in">
          {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Checkbox label={`${signerName || "The signer"} authorised this signature for this form, and it is genuinely theirs.`} checked={attest} onChange={(e) => setAttest(e.target.checked)} />
      </div>
    </Dialog>
  );
}

function ReviewDialog({ opp, form, onClose, onOpen }: { opp: Workspace; form: FormRow; onClose: () => void; onOpen: () => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const review = useMutation({
    meta: { silent: true },
    mutationFn: (decision: "approved" | "rejected") => api.post(`/forms/${form.id}/review`, { decision, note: note || null }),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ["opportunity", opp.id, "forms"] }), refresh(), onClose()),
    onError: (e) => setIssues(issuesOf(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Review ${form.name}`}
      description="Open the signed copy and check the details, the signatures and the previous supplier's bill before approving."
      footer={
        <>
          <Button variant="secondary" loading={review.isPending && review.variables === "rejected"} onClick={() => review.mutate("rejected")}>
            Reject
          </Button>
          <Button loading={review.isPending && review.variables === "approved"} onClick={() => review.mutate("approved")}>
            Approve
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <IssueList issues={issues} title="Please check:" />
        <Button size="sm" variant="secondary" onClick={onOpen}>
          <Eye /> Open signed copy
        </Button>
        <ul className="space-y-1">
          {form.signatures.map((s) => (
            <li key={s.id}>
              <span className="font-medium">{FORM_SIGNER_ROLE_LABELS[s.role]}:</span> {s.signerName}
              {s.signerCapacity ? ` (${s.signerCapacity})` : ""}. {SIGNATURE_AUTHORISATION_LABELS[s.authorisation]}. Uploaded by {s.uploadedBy} {dateTime(s.uploadedAt)}
              {s.note ? `. ${s.note}` : ""}
            </li>
          ))}
        </ul>
        {!!form.changedFields.length && <p>Changed by hand: {form.changedFields.join(", ")}</p>}
        <Field label="Note" hint="Required when rejecting">
          {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
