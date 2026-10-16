"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Circle, ClipboardCheck, FileCheck2, MapPin, Pencil, Search, Send, ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
  CUSTOMER_PATHS,
  CUSTOMER_PATH_LABELS,
  type CaseKind,
  type ChecklistItem,
  type CustomerPath,
  LEASE_STATUSES,
  LEASE_STATUS_LABELS,
  type LeaseStatus,
  RENEWAL_ROUTE_LABELS,
  REQUEST_CHANNELS,
  REQUEST_CHANNEL_LABELS,
  RESPONSE_OUTCOMES,
  RESPONSE_OUTCOME_LABELS,
  RESPONSE_SOURCES,
  RESPONSE_SOURCE_LABELS,
  type RenewalRoute,
  type RequestChannel,
  type ResponseOutcome,
  type ResponseSource,
  SUBMISSION_CHANNELS,
  SUBMISSION_CHANNEL_LABELS,
  SUPPLY_PATHS,
  SUPPLY_PATH_LABELS,
  type SubmissionChannel,
  type SupplyPath,
} from "@uo/shared";
import { useAssignableUsers } from "@/components/domain";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, IssueList, Select, Skeleton, Textarea, type Tone } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { cn, date, dateTime, ref, todayIso } from "@/lib/format";
import type { Workspace } from "@/lib/types";
import { useRefreshOpportunity } from "./common";

interface Response {
  id: string;
  outcome: ResponseOutcome;
  receivedVia: ResponseSource;
  receivedAt: string;
  externalReference: string | null;
  effectiveDate: string | null;
  reason: string | null;
  correctionOwner: string | null;
  correctionDueDate: string | null;
  recordedBy: string | null;
  recordedAt: string;
}
interface CaseOverview {
  kind: CaseKind;
  kindLabel: string;
  status: string;
  exception: "changes_required" | "rejected" | "cancelled" | null;
  steps: { key: string; label: string; done: boolean }[];
  checklist: ChecklistItem[];
  readyIssues: string[];
  case: {
    customerPath: CustomerPath | null;
    requestChannel: RequestChannel | null;
    requestReceivedAt: string | null;
    requestNote: string | null;
    supplyPath: SupplyPath | null;
    siteId: string | null;
    site: { id: string; label: string | null; line1: string; city: string | null; postcode: string | null; meterPoints: { fuel: string; mprn: string | null; gprn: string | null }[]; customer: { id: string; legalName: string } | null } | null;
    outgoingCustomer: { id: string; legalName: string } | null;
    outgoingAccountRef: string | null;
    outgoingContractRef: string | null;
    occupancyDate: string | null;
    supplySource: string | null;
    supplyVerifiedBy: string | null;
    supplyVerifiedAt: string | null;
    noticeDeadline: string | null;
    targetSubmissionDate: string | null;
  } | null;
  lease: {
    latest: { versionId: string; version: number; filename: string; uploadedAt: string; generatedDraft: boolean } | null;
    checks: { id: string; status: LeaseStatus; passed: boolean; landlordName: string; tenantName: string; notes: string | null; verifiedBy: string | null; verifiedAt: string; current: boolean }[];
  };
  terms: { complete: boolean; verified: boolean; current: { contractId: string; fuel: string; termMonths: number | null; startDate: string | null; rates: Record<string, number | null> }[]; checks: { id: string; verifiedAt: string; verifiedBy: string | null; current: boolean }[] };
  supplier: { id: string; name: string; renewalRoute: RenewalRoute; outgoingConsentRequired: boolean; monoCopyRequired: boolean; submissionEmail: string | null } | null;
  submissions: { id: string; recipient: string; channel: SubmissionChannel; sentAt: string; files: { documentVersionId: string; label: string; filename: string; version: number }[]; deliveryEvidence: string; note: string | null; recordedBy: string | null; recordedAt: string; responses: Response[] }[];
  files: { versionId: string; label: string; filename: string; version: number; role: string }[];
  permissions: { write: boolean; submit: boolean; verifyLease: boolean };
}

const issuesOf = (e: unknown) => ((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]);
const STATUS_TONE = (c: CaseOverview): Tone => (c.exception === "cancelled" ? "neutral" : c.exception ? "danger" : c.status === "Completed" ? "success" : c.status === "Ready to submit" ? "info" : "warning");
const OUTCOME_TONE: Record<ResponseOutcome, Tone> = { accepted: "success", change_confirmed: "success", changes_required: "warning", rejected: "danger" };
const caseKey = (id: string) => ["opportunity", id, "case"];

/** The workflow case on an energy deal: where it stands, what's missing, and the evidence trail. */
export function CaseCard({ opp, readOnly = false }: { opp: Workspace; readOnly?: boolean }) {
  const kase = useQuery({ queryKey: caseKey(opp.id), queryFn: () => api.get<CaseOverview>(`/opportunities/${opp.id}/case`) });
  // Change of supplier shows these on its own card.
  const conflicts = useQuery({
    queryKey: ["opportunity", opp.id, "switch-conflicts"],
    enabled: !!kase.data && kase.data.kind !== "change_of_supplier",
    queryFn: () => api.get<{ conflicts: { id: string; number: number; name: string; stage: { name: string } }[]; hiddenCount: number }>(`/opportunities/${opp.id}/switch-conflicts`),
  });
  const [editing, setEditing] = useState(false);
  if (kase.isLoading) return <Skeleton className="h-40" />;
  if (!kase.data) return null;
  // Read-only: sales following a deal the back office has taken over.
  const c = readOnly ? { ...kase.data, permissions: { write: false, submit: false, verifyLease: false } } : kase.data;
  const missing = c.checklist.filter((i) => !i.done);
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.kindLabel} <Badge tone={STATUS_TONE(c)}>{c.status}</Badge>
          </span>
        }
        description="Each step is ticked from the evidence recorded on this deal, so none can be skipped."
        actions={
          c.permissions.write && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              <Pencil /> Case details
            </Button>
          )
        }
      />
      <div className="space-y-5 p-5 text-sm">
        <ol className="flex flex-wrap gap-2" aria-label="Case steps">
          {c.steps.map((s) => (
            <li key={s.key} className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", s.done ? "border-success/40 bg-success-soft text-success" : "border-border text-muted")}>
              {s.done ? <CheckCircle2 className="size-3.5" aria-hidden /> : <Circle className="size-3.5" aria-hidden />}
              {s.label}
              <span className="sr-only">{s.done ? "(done)" : "(not done)"}</span>
            </li>
          ))}
        </ol>

        {!!conflicts.data && conflicts.data.conflicts.length + conflicts.data.hiddenCount > 0 && (
          <div className="flex gap-2 rounded-lg bg-warning-soft p-3 text-warning" role="alert">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">Another open case is on the same supply point.</p>
              <ul className="mt-1 space-y-0.5">
                {conflicts.data.conflicts.map((x) => (
                  <li key={x.id}>
                    <a className="underline" href={`/opportunities/${x.id}`}>
                      {ref(x.number)} {x.name}
                    </a>{" "}
                    ({x.stage.name})
                  </li>
                ))}
                {!!conflicts.data.hiddenCount && <li>{conflicts.data.hiddenCount} you can&apos;t open; ask a manager.</li>}
              </ul>
            </div>
          </div>
        )}

        <CaseSummary c={c} />

        {!!c.checklist.length && (
          <div>
            <h3 className="mb-1 font-medium">{c.kind === "renewal" ? "Details to verify" : "Incoming customer and supply point"}</h3>
            {missing.length ? (
              <ul className="grid gap-1 sm:grid-cols-2">
                {c.checklist.map((i) => (
                  <li key={i.key} className={cn("flex items-start gap-1.5", i.done ? "text-muted" : "")}>
                    {i.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <Circle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />}
                    <span>
                      {i.label}
                      {!i.done && !i.issue && <span className="text-muted"> (optional)</span>}
                      <span className="sr-only">{i.done ? " (done)" : " (missing)"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-success">All details are in.</p>
            )}
          </div>
        )}

        {c.kind === "change_of_entity" && <LeaseSection opp={opp} c={c} />}
        {c.kind === "renewal" && <TermsSection opp={opp} c={c} />}
        {c.status === "Final checks" && <IssueList issues={c.readyIssues} title="Before it can be submitted:" />}
        <SubmissionsSection opp={opp} c={c} />
      </div>
      {editing && <CaseDialog opp={opp} c={c} onClose={() => setEditing(false)} />}
    </Card>
  );
}

function CaseSummary({ c }: { c: CaseOverview }) {
  const k = c.case;
  const rows: [string, React.ReactNode][] = [];
  if (k?.requestChannel) rows.push(["Request", `${REQUEST_CHANNEL_LABELS[k.requestChannel]}${k.requestReceivedAt ? `, ${date(k.requestReceivedAt)}` : ""}${k.requestNote ? ` – ${k.requestNote}` : ""}`]);
  if (c.kind === "renewal") rows.push(["Customer", k?.customerPath ? CUSTOMER_PATH_LABELS[k.customerPath] : "Existing client (from the previous contract)"]);
  if (c.kind === "change_of_entity") {
    rows.push(["Supply point", k?.site ? `${k.site.label || k.site.line1}${k.site.meterPoints.length ? ` · ${k.site.meterPoints.map((m) => m.mprn ?? m.gprn ?? "no MPRN/GPRN").join(", ")}` : ""}` : k?.supplyPath ? SUPPLY_PATH_LABELS[k.supplyPath] : "Not matched yet"]);
    if (k?.outgoingCustomer) rows.push(["Outgoing account", `${k.outgoingCustomer.legalName}${k.outgoingAccountRef ? ` · account ${k.outgoingAccountRef}` : ""}`]);
    if (k?.occupancyDate) rows.push(["Occupancy date", date(k.occupancyDate)]);
    if (k?.supplySource) rows.push(["Supply details from", `${k.supplySource} (verified by ${k.supplyVerifiedBy ?? "—"} ${dateTime(k.supplyVerifiedAt)})`]);
  }
  if (k?.noticeDeadline) rows.push(["Notice deadline", date(k.noticeDeadline)]);
  if (k?.targetSubmissionDate) rows.push(["Submit by", date(k.targetSubmissionDate)]);
  if (c.supplier) {
    const rules = [c.kind === "renewal" && RENEWAL_ROUTE_LABELS[c.supplier.renewalRoute], c.supplier.monoCopyRequired && "black and white copies", c.kind === "change_of_entity" && c.supplier.outgoingConsentRequired && "outgoing holder's consent"].filter(Boolean);
    rows.push(["Supplier", `${c.supplier.name}${rules.length ? ` · needs ${rules.join(", ")}` : ""}`]);
  }
  if (!rows.length) return null;
  return (
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// --- Case details -------------------------------------------------------------------------

interface SupplyMatch {
  siteId: string;
  label: string | null;
  address: string;
  meters: { fuel: string; mprn: string | null; gprn: string | null }[];
  customer: { id: string; legalName: string } | null;
  openCases: { id: string; number: number; name: string; kind: string }[];
  hiddenOpenCases: number;
}

function CaseDialog({ opp, c, onClose }: { opp: Workspace; c: CaseOverview; onClose: () => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const k = c.case;
  const [v, setV] = useState({
    customerPath: k?.customerPath ?? "",
    requestChannel: k?.requestChannel ?? "",
    requestReceivedAt: k?.requestReceivedAt ?? "",
    requestNote: k?.requestNote ?? "",
    supplyPath: k?.supplyPath ?? "",
    siteId: k?.siteId ?? "",
    outgoingAccountRef: k?.outgoingAccountRef ?? "",
    outgoingContractRef: k?.outgoingContractRef ?? "",
    occupancyDate: k?.occupancyDate ?? "",
    supplySource: k?.supplySource ?? "",
    noticeDeadline: k?.noticeDeadline ?? "",
    targetSubmissionDate: k?.targetSubmissionDate ?? "",
  });
  const [picked, setPicked] = useState<SupplyMatch | null>(null);
  const [q, setQ] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const search = useMutation({ mutationFn: () => api.get<{ matches: SupplyMatch[]; hiddenCount: number; ambiguous: boolean }>(`/supply-points?q=${encodeURIComponent(q)}`), onError: (e) => setIssues(issuesOf(e)) });
  const set = (key: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [key]: e.target.value });
  const entity = c.kind === "change_of_entity";
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const n = (s: string) => (s.trim() ? s.trim() : null);
      return api.put(`/opportunities/${opp.id}/case`, {
        requestChannel: n(v.requestChannel),
        requestReceivedAt: n(v.requestReceivedAt),
        requestNote: n(v.requestNote),
        noticeDeadline: n(v.noticeDeadline),
        targetSubmissionDate: n(v.targetSubmissionDate),
        ...(c.kind === "renewal" ? { customerPath: n(v.customerPath) } : {}),
        ...(entity
          ? { supplyPath: n(v.supplyPath), siteId: v.supplyPath === "new_supply_point" ? null : n(v.siteId), outgoingAccountRef: n(v.outgoingAccountRef), outgoingContractRef: n(v.outgoingContractRef), occupancyDate: n(v.occupancyDate), supplySource: n(v.supplySource) }
          : {}),
      });
    },
    onSuccess: () => (qc.invalidateQueries({ queryKey: caseKey(opp.id) }), refresh(), onClose()),
    onError: (e) => setIssues(issuesOf(e)),
  });
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title="Case details"
      description="How the request came in and what it covers. Every change is recorded on the timeline."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <IssueList issues={issues} title="Please check:" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Request came by">
            {(p) => (
              <Select {...p} value={v.requestChannel} onChange={set("requestChannel")}>
                <option value="">Not recorded</option>
                {REQUEST_CHANNELS.map((x) => (
                  <option key={x} value={x}>
                    {REQUEST_CHANNEL_LABELS[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Received on">{(p) => <Input {...p} type="date" max={todayIso()} value={v.requestReceivedAt} onChange={set("requestReceivedAt")} />}</Field>
          <Field label="Submit by">{(p) => <Input {...p} type="date" value={v.targetSubmissionDate} onChange={set("targetSubmissionDate")} />}</Field>
        </div>
        <Field label="Request note" hint="Who asked and what for; attach the message itself under Documents as “Broker request”.">
          {(p) => <Input {...p} value={v.requestNote} onChange={set("requestNote")} />}
        </Field>
        {c.kind === "renewal" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Customer">
              {(p) => (
                <Select {...p} value={v.customerPath} onChange={set("customerPath")}>
                  <option value="">Choose…</option>
                  {CUSTOMER_PATHS.map((x) => (
                    <option key={x} value={x}>
                      {CUSTOMER_PATH_LABELS[x]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Notice deadline">{(p) => <Input {...p} type="date" value={v.noticeDeadline} onChange={set("noticeDeadline")} />}</Field>
          </div>
        )}
        {entity && (
          <>
            <Field label="Supply point">
              {(p) => (
                <Select {...p} value={v.supplyPath} onChange={set("supplyPath")}>
                  <option value="">Choose…</option>
                  {SUPPLY_PATHS.map((x) => (
                    <option key={x} value={x}>
                      {SUPPLY_PATH_LABELS[x]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {v.supplyPath === "known_supply_point" && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (q.trim().length >= 3) search.mutate();
                  }}
                >
                  <Input aria-label="MPRN, GPRN, address, Eircode or customer name" placeholder="MPRN, GPRN, address, Eircode or customer" value={q} onChange={(e) => setQ(e.target.value)} />
                  <Button type="submit" variant="secondary" loading={search.isPending}>
                    <Search /> Find
                  </Button>
                </form>
                {search.data && (
                  <div className="space-y-2">
                    {search.data.ambiguous && (
                      <p className="flex gap-1.5 text-warning" role="alert">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> More than one supply point matches. Check the address and account before choosing.
                      </p>
                    )}
                    {!search.data.matches.length && <p className="text-muted">No supply point found{search.data.hiddenCount ? ` you can open (${search.data.hiddenCount} handled by another team; ask a manager)` : ""}. Choose “new to us” to add it.</p>}
                    <ul className="space-y-1">
                      {search.data.matches.map((m) => (
                        <li key={m.siteId}>
                          <label className={cn("flex min-h-9 cursor-pointer items-start gap-2 rounded-lg border p-2", v.siteId === m.siteId ? "border-primary bg-primary/5" : "border-border")}>
                            <input type="radio" name="site" className="mt-1 size-4" checked={v.siteId === m.siteId} onChange={() => (setV({ ...v, siteId: m.siteId }), setPicked(m))} />
                            <span className="min-w-0">
                              <span className="font-medium">{m.label || m.address}</span>
                              <span className="block text-xs text-muted">
                                {m.address} · {m.meters.map((x) => x.mprn ?? x.gprn ?? "no MPRN/GPRN").join(", ")} · {m.customer?.legalName ?? "no customer"}
                              </span>
                              {(m.openCases.length > 0 || m.hiddenOpenCases > 0) && (
                                <span className="block text-xs text-warning">
                                  Open on: {m.openCases.map((o) => `${ref(o.number)} ${o.kind}`).join(", ")}
                                  {m.hiddenOpenCases ? ` and ${m.hiddenOpenCases} other` : ""}
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!search.data && k?.site && (
                  <p className="flex items-center gap-1.5 text-muted">
                    <MapPin className="size-4" aria-hidden /> Matched: {k.site.label || k.site.line1} ({k.site.customer?.legalName ?? "no customer"})
                  </p>
                )}
                {picked && <p className="text-xs text-muted">{picked.customer ? `${picked.customer.legalName} becomes the outgoing account holder. Their details are never copied to the incoming customer.` : ""}</p>}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Outgoing account number">{(p) => <Input {...p} value={v.outgoingAccountRef} onChange={set("outgoingAccountRef")} />}</Field>
              <Field label="Outgoing contract reference">{(p) => <Input {...p} value={v.outgoingContractRef} onChange={set("outgoingContractRef")} />}</Field>
              <Field label="Incoming occupancy date">{(p) => <Input {...p} type="date" value={v.occupancyDate} onChange={set("occupancyDate")} />}</Field>
            </div>
            {v.supplyPath === "new_supply_point" && (
              <Field label="Where the MPRN/GPRN and address came from" hint="e.g. ESB Networks letter, meter photo, landlord's bill. A lease alone doesn't prove the meter. Saving records you as the verifier.">
                {(p) => <Input {...p} value={v.supplySource} onChange={set("supplySource")} />}
              </Field>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

// --- Lease -------------------------------------------------------------------------------

function LeaseSection({ opp, c }: { opp: Workspace; c: CaseOverview }) {
  const [checking, setChecking] = useState(false);
  const current = c.lease.checks.find((x) => x.current);
  const latest = c.lease.latest;
  const badge = !latest ? (
    <Badge tone="warning">No lease uploaded</Badge>
  ) : current ? (
    current.status === "draft" ? (
      <Badge tone="warning">Draft (not signed)</Badge>
    ) : current.passed ? (
      <Badge tone="success">Signed and checked</Badge>
    ) : (
      <Badge tone="danger">Signed copy failed its check</Badge>
    )
  ) : latest.generatedDraft ? (
    <Badge tone="warning">Draft prepared by us</Badge>
  ) : (
    <Badge tone="warning">Not checked</Badge>
  );
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex flex-wrap items-center gap-2 font-medium">
          Lease agreement {badge}
        </h3>
        {c.permissions.verifyLease && latest && (
          <Button size="sm" variant="secondary" onClick={() => setChecking(true)}>
            <ShieldCheck /> Check lease
          </Button>
        )}
      </div>
      {latest ? (
        <p className="text-muted">
          {latest.filename} (version {latest.version}, {date(latest.uploadedAt)}). A landlord name on a form is not a lease: only a copy signed by both parties can pass.
        </p>
      ) : (
        <p className="text-muted">Upload the lease under Documents as the “Signed lease agreement”. Prepare a draft from a lease template if the broker didn&apos;t send one.</p>
      )}
      {!!c.lease.checks.length && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {c.lease.checks.map((x) => (
            <li key={x.id} className={cn("px-3 py-2", !x.current && "text-muted")}>
              <span className="font-medium">{LEASE_STATUS_LABELS[x.status]}</span> · {x.passed ? "passed" : "not passed"} · landlord {x.landlordName}, tenant {x.tenantName} · {x.verifiedBy} {dateTime(x.verifiedAt)}
              {!x.current && " · for an older version"}
              {x.notes && <span className="block text-xs">{x.notes}</span>}
            </li>
          ))}
        </ul>
      )}
      {checking && <LeaseDialog opp={opp} onClose={() => setChecking(false)} />}
    </section>
  );
}

function LeaseDialog({ opp, onClose }: { opp: Workspace; onClose: () => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const [v, setV] = useState({ status: "signed" as LeaseStatus, landlordName: "", tenantName: opp.customer?.legalName ?? opp.companyName ?? "", tenancyStartDate: "", landlordMatches: false, tenantMatches: false, addressMatches: false, datesMatch: false, signedByLandlord: false, signedByTenant: false, notes: "" });
  const [issues, setIssues] = useState<string[]>([]);
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post(`/opportunities/${opp.id}/lease-checks`, { ...v, tenancyStartDate: v.tenancyStartDate || null, notes: v.notes || null }),
    onSuccess: () => (qc.invalidateQueries({ queryKey: caseKey(opp.id) }), refresh(), onClose()),
    onError: (e) => setIssues(issuesOf(e)),
  });
  type Tick = "landlordMatches" | "tenantMatches" | "addressMatches" | "datesMatch" | "signedByLandlord" | "signedByTenant";
  const tick = (k: Tick, label: string) => <Checkbox label={label} checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} />;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Check the lease"
      description="Open the latest lease under Documents and compare it with this case. The check is kept as evidence."
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
        <Field label="This copy is">
          {(p) => (
            <Select {...p} value={v.status} onChange={(e) => setV({ ...v, status: e.target.value as LeaseStatus })}>
              {LEASE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {LEASE_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Landlord on the lease" required>
            {(p) => <Input {...p} value={v.landlordName} onChange={(e) => setV({ ...v, landlordName: e.target.value })} />}
          </Field>
          <Field label="Tenant on the lease" required>
            {(p) => <Input {...p} value={v.tenantName} onChange={(e) => setV({ ...v, tenantName: e.target.value })} />}
          </Field>
          <Field label="Tenancy start">{(p) => <Input {...p} type="date" value={v.tenancyStartDate} onChange={(e) => setV({ ...v, tenancyStartDate: e.target.value })} />}</Field>
        </div>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium">The lease…</legend>
          {tick("landlordMatches", "names the landlord on the supply site")}
          {tick("tenantMatches", "names the incoming customer as tenant")}
          {tick("addressMatches", "is for this supply address")}
          {tick("datesMatch", "has dates that fit the occupancy date")}
          {v.status === "signed" && tick("signedByLandlord", "is signed by the landlord")}
          {v.status === "signed" && tick("signedByTenant", "is signed by the tenant")}
        </fieldset>
        <Field label="Notes">{(p) => <Input {...p} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

// --- Terms -------------------------------------------------------------------------------

function TermsSection({ opp, c }: { opp: Workspace; c: CaseOverview }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const [issues, setIssues] = useState<string[]>([]);
  const verify = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post(`/opportunities/${opp.id}/terms-checks`, {}),
    onSuccess: () => (setIssues([]), qc.invalidateQueries({ queryKey: caseKey(opp.id) }), refresh()),
    onError: (e) => setIssues(issuesOf(e)),
  });
  const last = c.terms.checks[0];
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex flex-wrap items-center gap-2 font-medium">
          Renewal terms {c.terms.verified ? <Badge tone="success">Verified</Badge> : last ? <Badge tone="warning">Changed since verified</Badge> : <Badge tone="warning">Not verified</Badge>}
        </h3>
        {c.permissions.submit && !c.terms.verified && (
          <Button size="sm" variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>
            <ClipboardCheck /> Verify terms
          </Button>
        )}
      </div>
      <IssueList issues={issues} title="Can't verify yet:" />
      {c.terms.current.length ? (
        <ul className="space-y-0.5">
          {c.terms.current.map((x) => (
            <li key={x.contractId}>
              <span className="capitalize">{x.fuel}</span>: {x.termMonths ? `${x.termMonths} months` : "no term"} from {x.startDate ? date(x.startDate) : "no start date"} ·{" "}
              {Object.entries(x.rates)
                .filter(([, r]) => r !== null)
                .map(([k, r]) => `${k} ${r}`)
                .join(", ") || "no rates"}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">Add the proposed contract under Energy first.</p>
      )}
      {last && <p className="text-xs text-muted">Last verified by {last.verifiedBy} {dateTime(last.verifiedAt)}. Any later change to the rates, term, start date or supplier needs verifying again.</p>}
    </section>
  );
}

// --- Submissions and responses ------------------------------------------------------------

function SubmissionsSection({ opp, c }: { opp: Workspace; c: CaseOverview }) {
  const [sending, setSending] = useState(false);
  const [responding, setResponding] = useState<string | null>(null);
  const latest = c.submissions[0];
  const open = opp.outcome === "open";
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Sent to the external party</h3>
        <div className="flex flex-wrap gap-2">
          {c.permissions.submit && open && latest && (
            <Button size="sm" variant="secondary" onClick={() => setResponding(latest.id)}>
              <FileCheck2 /> Record response
            </Button>
          )}
          {c.permissions.submit && open && (
            <Button size="sm" onClick={() => setSending(true)}>
              <Send /> {latest ? "Record resubmission" : "Record submission"}
            </Button>
          )}
        </div>
      </div>
      {!c.submissions.length ? (
        <p className="text-muted">Nothing sent yet. Record what was sent, to whom and the proof of delivery; the case stays pending until a response is recorded.</p>
      ) : (
        <ul className="space-y-3">
          {c.submissions.map((s, i) => (
            <li key={s.id} className={cn("rounded-lg border border-border p-3", i > 0 && "text-muted")}>
              <p>
                <span className="font-medium">
                  {date(s.sentAt)} to {s.recipient}
                </span>{" "}
                by {SUBMISSION_CHANNEL_LABELS[s.channel].toLowerCase()} · recorded by {s.recordedBy ?? "the CRM"} {dateTime(s.recordedAt)}
              </p>
              <p className="text-xs">Proof of delivery: {s.deliveryEvidence}</p>
              {s.note && <p className="text-xs">{s.note}</p>}
              <ul className="mt-1 list-disc pl-5 text-xs">
                {s.files.map((f) => (
                  <li key={f.documentVersionId}>
                    {f.label}: {f.filename} (v{f.version})
                  </li>
                ))}
              </ul>
              <ul className="mt-2 space-y-1">
                {s.responses.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone={OUTCOME_TONE[r.outcome]}>{RESPONSE_OUTCOME_LABELS[r.outcome]}</Badge>
                    <span className="text-xs">
                      {date(r.receivedAt)} by {RESPONSE_SOURCE_LABELS[r.receivedVia].toLowerCase()}
                      {r.externalReference && ` · ref ${r.externalReference}`}
                      {r.effectiveDate && ` · effective ${date(r.effectiveDate)}`}
                      {r.reason && ` · ${r.reason}`}
                      {r.correctionOwner && ` · correction: ${r.correctionOwner}, due ${date(r.correctionDueDate)}`}
                    </span>
                  </li>
                ))}
                {!s.responses.length && i === 0 && <li className="text-xs text-warning">Awaiting the external party&apos;s response.</li>}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {sending && <SubmissionDialog opp={opp} c={c} onClose={() => setSending(false)} />}
      {responding && <ResponseDialog opp={opp} c={c} submissionId={responding} onClose={() => setResponding(null)} />}
    </section>
  );
}

function SubmissionDialog({ opp, c, onClose }: { opp: Workspace; c: CaseOverview; onClose: () => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const [v, setV] = useState({ recipient: c.supplier?.submissionEmail ?? "", channel: "email" as SubmissionChannel, sentAt: todayIso(), deliveryEvidence: "", note: "" });
  const [files, setFiles] = useState<string[]>(() => c.files.map((f) => f.versionId));
  const [issues, setIssues] = useState<string[]>([]);
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post(`/opportunities/${opp.id}/submissions`, { ...v, note: v.note || null, documentVersionIds: files }),
    onSuccess: () => (qc.invalidateQueries({ queryKey: caseKey(opp.id) }), refresh(), onClose()),
    onError: (e) => setIssues(issuesOf(e)),
  });
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title="Record what was sent"
      description="Choose the exact files that went out. Sending is not acceptance: the case stays pending until the response is recorded."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!files.length} onClick={() => save.mutate()}>
            Record submission
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueList issues={issues} title="Not recorded:" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Sent to" required>
            {(p) => <Input {...p} value={v.recipient} onChange={(e) => setV({ ...v, recipient: e.target.value })} />}
          </Field>
          <Field label="How">
            {(p) => (
              <Select {...p} value={v.channel} onChange={(e) => setV({ ...v, channel: e.target.value as SubmissionChannel })}>
                {SUBMISSION_CHANNELS.map((x) => (
                  <option key={x} value={x}>
                    {SUBMISSION_CHANNEL_LABELS[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Sent on">{(p) => <Input {...p} type="date" max={todayIso()} value={v.sentAt} onChange={(e) => setV({ ...v, sentAt: e.target.value })} />}</Field>
        </div>
        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium">Files sent</legend>
          {c.files.map((f) => (
            <Checkbox
              key={f.versionId}
              label={`${f.label}: ${f.filename} (v${f.version})`}
              checked={files.includes(f.versionId)}
              onChange={(e) => setFiles(e.target.checked ? [...files, f.versionId] : files.filter((x) => x !== f.versionId))}
            />
          ))}
        </fieldset>
        <Field label="Proof of delivery" required hint="e.g. sent from submissions@ at 10:42, portal receipt number">
          {(p) => <Input {...p} value={v.deliveryEvidence} onChange={(e) => setV({ ...v, deliveryEvidence: e.target.value })} />}
        </Field>
        <Field label="Note">{(p) => <Textarea {...p} rows={2} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

function ResponseDialog({ opp, c, submissionId, onClose }: { opp: Workspace; c: CaseOverview; submissionId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const users = useAssignableUsers();
  const [v, setV] = useState({ outcome: "accepted" as ResponseOutcome, receivedVia: "email" as ResponseSource, receivedAt: todayIso(), externalReference: "", effectiveDate: "", reason: "", correctionOwnerId: opp.ownerId ?? "", correctionDueDate: "" });
  const [issues, setIssues] = useState<string[]>([]);
  const negative = v.outcome === "rejected" || v.outcome === "changes_required";
  const outcomes = RESPONSE_OUTCOMES.filter((o) => o !== "change_confirmed" || c.kind === "change_of_entity");
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const n = (s: string) => (s.trim() ? s.trim() : null);
      return api.post<{ stageIssues: string[] }>(`/submissions/${submissionId}/responses`, {
        outcome: v.outcome,
        receivedVia: v.receivedVia,
        receivedAt: n(v.receivedAt),
        externalReference: n(v.externalReference),
        effectiveDate: n(v.effectiveDate),
        reason: n(v.reason),
        ...(negative ? { correctionOwnerId: n(v.correctionOwnerId), correctionDueDate: n(v.correctionDueDate) } : {}),
      });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: caseKey(opp.id) });
      refresh();
      if (r?.stageIssues?.length) setIssues(["Recorded. The deal stays at its stage until these are resolved:", ...r.stageIssues]);
      else onClose();
    },
    onError: (e) => setIssues(issuesOf(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record the external party's response"
      description="Responses are kept as evidence. A rejection or query creates a correction task."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Record response
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueList issues={issues} title="Please check:" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Response">
            {(p) => (
              <Select {...p} value={v.outcome} onChange={(e) => setV({ ...v, outcome: e.target.value as ResponseOutcome })}>
                {outcomes.map((x) => (
                  <option key={x} value={x}>
                    {RESPONSE_OUTCOME_LABELS[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Received by">
            {(p) => (
              <Select {...p} value={v.receivedVia} onChange={(e) => setV({ ...v, receivedVia: e.target.value as ResponseSource })}>
                {RESPONSE_SOURCES.map((x) => (
                  <option key={x} value={x}>
                    {RESPONSE_SOURCE_LABELS[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Received on">{(p) => <Input {...p} type="date" max={todayIso()} value={v.receivedAt} onChange={(e) => setV({ ...v, receivedAt: e.target.value })} />}</Field>
        </div>
        {(v.outcome === "accepted" || v.outcome === "change_confirmed") && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="External reference" required={v.outcome === "accepted"}>
              {(p) => <Input {...p} value={v.externalReference} onChange={(e) => setV({ ...v, externalReference: e.target.value })} />}
            </Field>
            {v.outcome === "change_confirmed" && (
              <Field label="Confirmed effective date" required>
                {(p) => <Input {...p} type="date" value={v.effectiveDate} onChange={(e) => setV({ ...v, effectiveDate: e.target.value })} />}
              </Field>
            )}
          </div>
        )}
        {negative && (
          <>
            <Field label="Reason given" required>
              {(p) => <Textarea {...p} rows={2} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Correction owner">
                {(p) => (
                  <Select {...p} value={v.correctionOwnerId} onChange={(e) => setV({ ...v, correctionOwnerId: e.target.value })}>
                    <option value="">The deal owner</option>
                    {users.data?.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Correct by" hint="Defaults to tomorrow">
                {(p) => <Input {...p} type="date" min={todayIso()} value={v.correctionDueDate} onChange={(e) => setV({ ...v, correctionDueDate: e.target.value })} />}
              </Field>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
