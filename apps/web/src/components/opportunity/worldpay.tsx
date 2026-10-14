"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { CreditCard, Lock, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { COMPLIANCE_STATUSES, LEGAL_ENTITIES, LEGAL_ENTITY_LABELS, MERCHANT_STATUS_LABELS, type MerchantStatus, PRINCIPAL_REQUIREMENTS, PRINCIPAL_ROLES, type LegalEntity } from "@uo/shared";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, IssueList, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { ApiError, api } from "@/lib/api";
import { date, money, pct } from "@/lib/format";
import { useCan } from "@/lib/session";
import type { Workspace } from "@/lib/types";
import { blankToNull, numOrNull, useRefreshOpportunity } from "./common";

interface Pricing {
  id: string;
  product: string;
  quantity: number;
  minimumMonthlyCharge: number | null;
  productMonthlyFee: number | null;
  debitRate: number | null;
  creditRate: number | null;
  commercialRate: number | null;
  amexRate: number | null;
  authorisationFee: number | null;
  offerType: string | null;
}
interface PrincipalView {
  id: string;
  role: string;
  title: string | null;
  firstName: string;
  middleName: string | null;
  lastName: string;
  ownershipPct: number | null;
  email: string | null;
  phone: string | null;
  hasDob: boolean;
  hasNationality: boolean;
  restricted: boolean;
  dateOfBirth: string | null;
  nationality: string | null;
  addressHistory: { id: string; fromDate: string; toDate: string | null; address: { line1: string; line2?: string; city?: string; postcode?: string } | null }[];
}
type Risk =
  | { restricted: true; complianceStatus: string }
  | {
      restricted?: false;
      thirdPartyFulfilment: boolean;
      stockStoredElsewhere: boolean;
      depositsAccepted: boolean;
      depositTxnPct: number | null;
      depositValuePct: number | null;
      depositLeadDays: number | null;
      balanceLeadDays: number | null;
      fullPrepaymentAccepted: boolean;
      fullPrepaymentPct: number | null;
      fullPaymentLeadDays: number | null;
      complianceStatus: string;
      restrictedNotes?: string | null;
      notesRestricted: boolean;
      reviewedAt: string | null;
    };
interface Application {
  id: string;
  campaign: string | null;
  legalEntity: LegalEntity | null;
  natureOfBusiness: string | null;
  estimatedAnnualTurnover: number | null;
  cardTurnoverPct: number | null;
  averageTransactionValue: number | null;
  settlementPeriod: string | null;
  dashboardRequested: boolean;
  website: string | null;
  advertisingMethod: string | null;
  applicationReference: string | null;
  customerAcceptedAt: string | null;
  submissionDate: string | null;
  approvalDate: string | null;
  activationDate: string | null;
  termMonths: number | null;
  status: MerchantStatus;
  pricing: Pricing[];
  principals: PrincipalView[];
  risk: Risk | null;
}

const COMPLIANCE_LABELS: Record<string, string> = { not_started: "Not started", in_review: "In review", query_raised: "Query raised", approved: "Approved", rejected: "Rejected" };

function useSave(oppId: string, after?: () => void) {
  const refresh = useRefreshOpportunity(oppId);
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: (fn: () => Promise<unknown>) => (setIssues([]), fn()),
    onSuccess: () => (refresh(), after?.()),
    onError: (e) => setIssues(e instanceof ApiError ? (e.issues.length ? e.issues : [e.message]) : ["Something went wrong."]),
  });
  return { save: m.mutate, saving: m.isPending, issues };
}

export function WorldpayTab({ opp }: { opp: Workspace }) {
  const { data, isLoading } = useQuery({ queryKey: ["opportunity", opp.id, "merchant"], queryFn: () => api.get<Application[]>(`/opportunities/${opp.id}/merchant`) });
  const create = useSave(opp.id);
  if (isLoading || !data) return <Skeleton className="h-64" />;
  if (!data.length) {
    return (
      <Card>
        <EmptyState
          icon={<CreditCard />}
          title="No Worldpay application yet"
          action={
            opp.permissions.write && (
              <Button loading={create.saving} onClick={() => create.save(() => api.post(`/opportunities/${opp.id}/merchant-applications`, { campaign: opp.campaign ?? null }))}>
                <Plus /> Start application
              </Button>
            )
          }
        >
          The application holds the business details, pricing, principals and underwriting answers Worldpay needs.
        </EmptyState>
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      {data.map((app) => (
        <ApplicationView key={app.id} opp={opp} app={app} />
      ))}
    </div>
  );
}

function ApplicationView({ opp, app }: { opp: Workspace; app: Application }) {
  const can = useCan();
  const write = opp.permissions.write && app.status !== "live";
  const actions = useSave(opp.id);
  return (
    <>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Worldpay application <Badge tone={app.status === "live" || app.status === "approved" ? "success" : app.status === "declined" ? "danger" : app.status === "compliance_query" ? "warning" : "info"}>{MERCHANT_STATUS_LABELS[app.status]}</Badge>
            </span>
          }
          description={[app.applicationReference && `Ref ${app.applicationReference}`, app.submissionDate && `Submitted ${date(app.submissionDate)}`, app.approvalDate && `Approved ${date(app.approvalDate)}`, app.customerAcceptedAt && `Customer accepted ${date(app.customerAcceptedAt)}`].filter(Boolean).join(" · ") || undefined}
          actions={
            <>
              {write && !app.customerAcceptedAt && (
                <Button size="sm" variant="secondary" loading={actions.saving} onClick={() => actions.save(() => api.post(`/merchant-applications/${app.id}/accept`))}>
                  Record customer acceptance
                </Button>
              )}
              {can("opportunity.submit") && ["submitted", "compliance_query"].includes(app.status) && (
                <Button size="sm" loading={actions.saving} onClick={() => actions.save(() => api.post(`/merchant-applications/${app.id}/approve`, { reference: app.applicationReference ?? undefined }))}>
                  Record Worldpay approval
                </Button>
              )}
            </>
          }
        />
        <BusinessForm opp={opp} app={app} write={write} />
      </Card>
      <PricingCard opp={opp} app={app} write={write} />
      <PrincipalsCard opp={opp} app={app} write={write} />
      <RiskCard opp={opp} app={app} write={write} />
    </>
  );
}

function BusinessForm({ opp, app, write }: { opp: Workspace; app: Application; write: boolean }) {
  const { save, saving, issues } = useSave(opp.id);
  const values = () => ({
    legalEntity: app.legalEntity ?? "",
    natureOfBusiness: app.natureOfBusiness ?? "",
    campaign: app.campaign ?? "",
    estimatedAnnualTurnover: app.estimatedAnnualTurnover?.toString() ?? "",
    cardTurnoverPct: app.cardTurnoverPct?.toString() ?? "",
    averageTransactionValue: app.averageTransactionValue?.toString() ?? "",
    settlementPeriod: app.settlementPeriod ?? "",
    dashboardRequested: app.dashboardRequested,
    website: app.website ?? "",
    advertisingMethod: app.advertisingMethod ?? "",
    applicationReference: app.applicationReference ?? "",
    termMonths: app.termMonths?.toString() ?? "",
  });
  const { register, handleSubmit, reset, watch, formState } = useForm({ defaultValues: values() });
  useEffect(() => reset(values()), [app]); // eslint-disable-line react-hooks/exhaustive-deps
  const noWebsite = !watch("website")?.trim();
  const submit = handleSubmit((v) =>
    save(() =>
      api.patch(`/merchant-applications/${app.id}`, {
        legalEntity: v.legalEntity || null,
        natureOfBusiness: blankToNull(v.natureOfBusiness),
        campaign: blankToNull(v.campaign),
        estimatedAnnualTurnover: numOrNull(v.estimatedAnnualTurnover),
        cardTurnoverPct: numOrNull(v.cardTurnoverPct),
        averageTransactionValue: numOrNull(v.averageTransactionValue),
        settlementPeriod: blankToNull(v.settlementPeriod),
        dashboardRequested: v.dashboardRequested,
        website: blankToNull(v.website),
        advertisingMethod: blankToNull(v.advertisingMethod),
        applicationReference: blankToNull(v.applicationReference),
        termMonths: numOrNull(v.termMonths),
      }),
    ),
  );
  return (
    <form onSubmit={submit}>
      <fieldset disabled={!write} className="grid gap-4 p-5 sm:grid-cols-3">
        <legend className="sr-only">Business details</legend>
        <Field label="Legal entity">
          {(p) => (
            <Select {...p} {...register("legalEntity")}>
              <option value="">Choose…</option>
              {LEGAL_ENTITIES.map((l) => (
                <option key={l} value={l}>
                  {LEGAL_ENTITY_LABELS[l]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Nature of business" className="sm:col-span-2">{(p) => <Input {...p} {...register("natureOfBusiness")} />}</Field>
        <Field label="Campaign">{(p) => <Input {...p} {...register("campaign")} />}</Field>
        <Field label="Estimated annual turnover (€)" hint="Needed before the proposal.">{(p) => <Input {...p} inputMode="decimal" {...register("estimatedAnnualTurnover")} />}</Field>
        <Field label="Card turnover (%)">{(p) => <Input {...p} inputMode="decimal" {...register("cardTurnoverPct")} />}</Field>
        <Field label="Average transaction (€)">{(p) => <Input {...p} inputMode="decimal" {...register("averageTransactionValue")} />}</Field>
        <Field label="Settlement period">{(p) => <Input {...p} placeholder="e.g. Next day" {...register("settlementPeriod")} />}</Field>
        <Field label="Contract term (months)">{(p) => <Input {...p} inputMode="numeric" {...register("termMonths")} />}</Field>
        <Field label="Website">{(p) => <Input {...p} type="url" {...register("website")} />}</Field>
        <Field label="Advertising method" hint={noWebsite ? "Required when there's no website." : undefined}>
          {(p) => <Input {...p} placeholder="e.g. Facebook, shop front" {...register("advertisingMethod")} />}
        </Field>
        <Field label="Worldpay reference">{(p) => <Input {...p} {...register("applicationReference")} />}</Field>
        <div className="flex items-end pb-2">
          <Checkbox label="Online dashboard requested" {...register("dashboardRequested")} />
        </div>
        {write && (
          <div className="flex items-center justify-end gap-3 sm:col-span-3">
            <IssueList issues={issues} title="Please check:" />
            <Button type="submit" size="sm" disabled={!formState.isDirty} loading={saving}>
              Save business details
            </Button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

function PricingCard({ opp, app, write }: { opp: Workspace; app: Application; write: boolean }) {
  const [adding, setAdding] = useState(false);
  const remove = useSave(opp.id);
  return (
    <Card>
      <CardHeader
        title="Products & pricing"
        description="Terminals or products and the agreed rates. At least one line is needed before documents are prepared."
        actions={
          write && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus /> Add product
            </Button>
          )
        }
      />
      {!app.pricing.length ? (
        <EmptyState title="No products yet" />
      ) : (
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">Product</th>
                <th className="px-3 py-2 text-right font-medium">Monthly fee</th>
                <th className="px-3 py-2 text-right font-medium">Min. monthly</th>
                <th className="px-3 py-2 text-right font-medium">Debit</th>
                <th className="px-3 py-2 text-right font-medium">Credit</th>
                <th className="px-3 py-2 text-right font-medium">Commercial</th>
                <th className="px-3 py-2 text-right font-medium">Amex</th>
                <th className="px-3 py-2 text-right font-medium">Auth fee</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody className="tabular">
              {app.pricing.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-5 py-2">
                    {p.quantity > 1 && `${p.quantity} × `}
                    {p.product}
                    {p.offerType && <span className="block text-xs text-muted">{p.offerType}</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{money(p.productMonthlyFee, true)}</td>
                  <td className="px-3 py-2 text-right">{money(p.minimumMonthlyCharge, true)}</td>
                  <td className="px-3 py-2 text-right">{pct(p.debitRate)}</td>
                  <td className="px-3 py-2 text-right">{pct(p.creditRate)}</td>
                  <td className="px-3 py-2 text-right">{pct(p.commercialRate)}</td>
                  <td className="px-3 py-2 text-right">{pct(p.amexRate)}</td>
                  <td className="px-3 py-2 text-right">{p.authorisationFee == null ? "—" : `€${p.authorisationFee}`}</td>
                  <td className="px-5 py-2 text-right">
                    {write && (
                      <Button size="icon" variant="ghost" aria-label={`Remove ${p.product}`} onClick={() => remove.save(() => api.del(`/merchant-pricing/${p.id}`))}>
                        <Trash2 />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <PricingDialog opp={opp} app={app} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function PricingDialog({ opp, app, onClose }: { opp: Workspace; app: Application; onClose: () => void }) {
  const { save, saving, issues } = useSave(opp.id, onClose);
  const { register, handleSubmit } = useForm({ defaultValues: { product: "", quantity: "1", productMonthlyFee: "", minimumMonthlyCharge: "", debitRate: "", creditRate: "", commercialRate: "", amexRate: "", authorisationFee: "", offerType: "" } });
  const submit = handleSubmit((v) =>
    save(() =>
      api.post(`/merchant-applications/${app.id}/pricing`, {
        product: v.product,
        quantity: numOrNull(v.quantity) ?? 1,
        productMonthlyFee: numOrNull(v.productMonthlyFee),
        minimumMonthlyCharge: numOrNull(v.minimumMonthlyCharge),
        debitRate: numOrNull(v.debitRate),
        creditRate: numOrNull(v.creditRate),
        commercialRate: numOrNull(v.commercialRate),
        amexRate: numOrNull(v.amexRate),
        authorisationFee: numOrNull(v.authorisationFee),
        offerType: blankToNull(v.offerType),
      }),
    ),
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add product"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={submit}>
            Add
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Product / terminal" required className="sm:col-span-3">{(p) => <Input {...p} placeholder="e.g. Countertop terminal" {...register("product")} />}</Field>
        <Field label="Quantity">{(p) => <Input {...p} inputMode="numeric" {...register("quantity")} />}</Field>
        <Field label="Monthly fee (€)">{(p) => <Input {...p} inputMode="decimal" {...register("productMonthlyFee")} />}</Field>
        <Field label="Min. monthly charge (€)">{(p) => <Input {...p} inputMode="decimal" {...register("minimumMonthlyCharge")} />}</Field>
        <Field label="Authorisation fee (€)">{(p) => <Input {...p} inputMode="decimal" {...register("authorisationFee")} />}</Field>
        <Field label="Offer type">{(p) => <Input {...p} {...register("offerType")} />}</Field>
        <Field label="Debit rate (%)">{(p) => <Input {...p} inputMode="decimal" {...register("debitRate")} />}</Field>
        <Field label="Credit rate (%)">{(p) => <Input {...p} inputMode="decimal" {...register("creditRate")} />}</Field>
        <Field label="Commercial rate (%)">{(p) => <Input {...p} inputMode="decimal" {...register("commercialRate")} />}</Field>
        <Field label="Amex rate (%)">{(p) => <Input {...p} inputMode="decimal" {...register("amexRate")} />}</Field>
      </div>
      <div className="mt-4">
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}

function PrincipalsCard({ opp, app, write }: { opp: Workspace; app: Application; write: boolean }) {
  const [editing, setEditing] = useState<PrincipalView | "new" | null>(null);
  const remove = useSave(opp.id);
  const rule = app.legalEntity ? PRINCIPAL_REQUIREMENTS[app.legalEntity] : null;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Principals <Lock className="size-4 text-muted" aria-label="Restricted information" />
          </span>
        }
        description={rule ? `A ${LEGAL_ENTITY_LABELS[app.legalEntity!].toLowerCase()} needs ${rule.describe}, each with date of birth, nationality and 3 years of address history.` : "Choose the legal entity to see who's needed."}
        actions={
          write && (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus /> Add principal
            </Button>
          )
        }
      />
      {!app.principals.length ? (
        <EmptyState icon={<UserRound />} title="No principals yet" />
      ) : (
        <ul className="divide-y divide-border">
          {app.principals.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3 text-sm">
              <div>
                <p className="font-medium">
                  {[p.title, p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ")} <Badge className="ml-1 capitalize">{p.role}</Badge>
                  {p.ownershipPct != null && <span className="ml-2 text-muted">{p.ownershipPct}% ownership</span>}
                </p>
                {p.restricted ? (
                  <p className="mt-1 text-muted">
                    Date of birth {p.hasDob ? "recorded ✓" : <span className="text-warning">missing</span>} · Nationality {p.hasNationality ? "recorded ✓" : <span className="text-warning">missing</span>} · {p.addressHistory.length} address{p.addressHistory.length === 1 ? "" : "es"} on file
                  </p>
                ) : (
                  <div className="mt-1 text-muted">
                    <p>
                      Born {date(p.dateOfBirth)} · {p.nationality ?? "nationality missing"}
                    </p>
                    {p.addressHistory.map((a) => (
                      <p key={a.id}>
                        {a.address && [a.address.line1, a.address.city, a.address.postcode].filter(Boolean).join(", ")} ({date(a.fromDate)} – {a.toDate ? date(a.toDate) : "now"})
                      </p>
                    ))}
                  </div>
                )}
              </div>
              {write && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                    {p.restricted ? "Update" : "Edit"}
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Remove ${p.firstName} ${p.lastName}`} onClick={() => remove.save(() => api.del(`/principals/${p.id}`))}>
                    <Trash2 />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <PrincipalDialog opp={opp} app={app} principal={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function PrincipalDialog({ opp, app, principal, onClose }: { opp: Workspace; app: Application; principal?: PrincipalView; onClose: () => void }) {
  const { save, saving, issues } = useSave(opp.id, onClose);
  const p = principal;
  const [addresses, setAddresses] = useState(
    p && !p.restricted ? p.addressHistory.map((a) => ({ line1: a.address?.line1 ?? "", city: a.address?.city ?? "", postcode: a.address?.postcode ?? "", fromDate: a.fromDate, toDate: a.toDate ?? "" })) : [{ line1: "", city: "", postcode: "", fromDate: "", toDate: "" }],
  );
  const { register, handleSubmit } = useForm({
    defaultValues: { role: p?.role ?? "director", title: p?.title ?? "", firstName: p?.firstName ?? "", middleName: p?.middleName ?? "", lastName: p?.lastName ?? "", dateOfBirth: p?.dateOfBirth ?? "", nationality: p?.nationality ?? "", ownershipPct: p?.ownershipPct?.toString() ?? "", email: p?.email ?? "", phone: p?.phone ?? "" },
  });
  const restricted = p?.restricted;
  const submit = handleSubmit((v) => {
    const history = addresses.filter((a) => a.line1.trim() && a.fromDate).map((a) => ({ line1: a.line1, city: blankToNull(a.city), postcode: blankToNull(a.postcode), country: "IE", fromDate: a.fromDate, toDate: a.toDate || null }));
    const body: Record<string, unknown> = {
      role: v.role,
      title: blankToNull(v.title),
      firstName: v.firstName,
      middleName: blankToNull(v.middleName),
      lastName: v.lastName,
      ownershipPct: numOrNull(v.ownershipPct),
      email: blankToNull(v.email),
      phone: blankToNull(v.phone),
    };
    // Restricted viewers can replace personal details but never see the current values; blank means "leave as is".
    if (!restricted || v.dateOfBirth) body.dateOfBirth = v.dateOfBirth || null;
    if (!restricted || v.nationality) body.nationality = blankToNull(v.nationality);
    if (!restricted || history.length) body.addressHistory = history;
    save(() => (p ? api.patch(`/principals/${p.id}`, body) : api.post(`/merchant-applications/${app.id}/principals`, body)));
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={p ? "Update principal" : "Add principal"}
      description={restricted ? "Personal details are restricted: you can enter new values, but existing ones aren't shown. Leave a field blank to keep it." : "Personal details are encrypted and only visible to Compliance."}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Role">
          {(f) => (
            <Select {...f} {...register("role")}>
              {PRINCIPAL_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r[0].toUpperCase() + r.slice(1)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Title">{(f) => <Input {...f} {...register("title")} />}</Field>
        <Field label="Ownership (%)">{(f) => <Input {...f} inputMode="decimal" {...register("ownershipPct")} />}</Field>
        <div />
        <Field label="First name" required>{(f) => <Input {...f} {...register("firstName")} />}</Field>
        <Field label="Middle name">{(f) => <Input {...f} {...register("middleName")} />}</Field>
        <Field label="Last name" required className="sm:col-span-2">{(f) => <Input {...f} {...register("lastName")} />}</Field>
        <Field label="Date of birth" hint={restricted && p?.hasDob ? "Recorded — enter only to change" : undefined}>{(f) => <Input {...f} type="date" {...register("dateOfBirth")} />}</Field>
        <Field label="Nationality" hint={restricted && p?.hasNationality ? "Recorded — enter only to change" : undefined}>{(f) => <Input {...f} {...register("nationality")} />}</Field>
        <Field label="Email">{(f) => <Input {...f} type="email" {...register("email")} />}</Field>
        <Field label="Phone">{(f) => <Input {...f} type="tel" {...register("phone")} />}</Field>
      </div>
      <fieldset className="mt-5 space-y-3">
        <legend className="text-sm font-semibold">Residential addresses (last 3 years){restricted && p?.addressHistory.length ? " — replaces what's on file" : ""}</legend>
        {addresses.map((a, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-5">
            {(["line1", "city", "postcode"] as const).map((k) => (
              <Input key={k} aria-label={k === "line1" ? "Address" : k === "city" ? "Town" : "Eircode"} placeholder={k === "line1" ? "Address" : k === "city" ? "Town" : "Eircode"} value={a[k]} onChange={(e) => setAddresses((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} className={k === "line1" ? "sm:col-span-2" : ""} />
            ))}
            <Input type="date" aria-label="From" value={a.fromDate} onChange={(e) => setAddresses((xs) => xs.map((x, j) => (j === i ? { ...x, fromDate: e.target.value } : x)))} />
            <Input type="date" aria-label="To (blank if current)" value={a.toDate} onChange={(e) => setAddresses((xs) => xs.map((x, j) => (j === i ? { ...x, toDate: e.target.value } : x)))} />
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={() => setAddresses((xs) => [...xs, { line1: "", city: "", postcode: "", fromDate: "", toDate: "" }])}>
          <Plus /> Add previous address
        </Button>
      </fieldset>
      <div className="mt-4">
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}

function RiskCard({ opp, app, write }: { opp: Workspace; app: Application; write: boolean }) {
  const can = useCan();
  const risk = app.risk;
  const { save, saving, issues } = useSave(opp.id);
  const review = useSave(opp.id);
  const editable = risk && !risk.restricted ? risk : null;
  const values = () => ({
    thirdPartyFulfilment: editable?.thirdPartyFulfilment ?? false,
    stockStoredElsewhere: editable?.stockStoredElsewhere ?? false,
    depositsAccepted: editable?.depositsAccepted ?? false,
    depositTxnPct: editable?.depositTxnPct?.toString() ?? "",
    depositValuePct: editable?.depositValuePct?.toString() ?? "",
    depositLeadDays: editable?.depositLeadDays?.toString() ?? "",
    balanceLeadDays: editable?.balanceLeadDays?.toString() ?? "",
    fullPrepaymentAccepted: editable?.fullPrepaymentAccepted ?? false,
    fullPrepaymentPct: editable?.fullPrepaymentPct?.toString() ?? "",
    fullPaymentLeadDays: editable?.fullPaymentLeadDays?.toString() ?? "",
  });
  const { register, handleSubmit, watch, reset, formState } = useForm({ defaultValues: values() });
  useEffect(() => reset(values()), [app]); // eslint-disable-line react-hooks/exhaustive-deps
  const [status, setStatus] = useState(risk?.complianceStatus ?? "not_started");
  const [notes, setNotes] = useState(editable?.restrictedNotes ?? "");

  if (risk?.restricted) {
    return (
      <Card className="p-5 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <Lock className="size-4" aria-hidden /> Underwriting & risk
        </p>
        <p className="mt-1 text-muted">Restricted. Compliance review: {COMPLIANCE_LABELS[risk.complianceStatus]}</p>
      </Card>
    );
  }

  const submit = handleSubmit((v) =>
    save(() =>
      api.put(`/merchant-applications/${app.id}/risk`, {
        thirdPartyFulfilment: v.thirdPartyFulfilment,
        stockStoredElsewhere: v.stockStoredElsewhere,
        depositsAccepted: v.depositsAccepted,
        depositTxnPct: v.depositsAccepted ? numOrNull(v.depositTxnPct) : undefined,
        depositValuePct: v.depositsAccepted ? numOrNull(v.depositValuePct) : undefined,
        depositLeadDays: v.depositsAccepted ? numOrNull(v.depositLeadDays) : undefined,
        balanceLeadDays: v.depositsAccepted ? numOrNull(v.balanceLeadDays) : undefined,
        fullPrepaymentAccepted: v.fullPrepaymentAccepted,
        fullPrepaymentPct: v.fullPrepaymentAccepted ? numOrNull(v.fullPrepaymentPct) : undefined,
        fullPaymentLeadDays: v.fullPrepaymentAccepted ? numOrNull(v.fullPaymentLeadDays) : undefined,
      }),
    ),
  );

  return (
    <Card>
      <CardHeader
        title="Underwriting & risk"
        description="Partial answers can be saved; completeness is checked when documents are prepared."
        actions={<Badge tone={risk?.complianceStatus === "approved" ? "success" : risk?.complianceStatus === "query_raised" || risk?.complianceStatus === "rejected" ? "warning" : "neutral"}>Compliance: {COMPLIANCE_LABELS[risk?.complianceStatus ?? "not_started"]}</Badge>}
      />
      <form onSubmit={submit}>
        <fieldset disabled={!write} className="space-y-4 p-5">
          <legend className="sr-only">Underwriting answers</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Checkbox label="Uses a third party to fulfil orders" {...register("thirdPartyFulfilment")} />
            <Checkbox label="Stock is stored at another address" {...register("stockStoredElsewhere")} />
          </div>
          <Checkbox label="Takes deposits" {...register("depositsAccepted")} />
          {watch("depositsAccepted") && (
            <div className="grid gap-4 rounded-lg bg-surface-2 p-4 sm:grid-cols-4">
              <Field label="% of transactions that are deposits">{(p) => <Input {...p} inputMode="decimal" {...register("depositTxnPct")} />}</Field>
              <Field label="Deposit as % of price">{(p) => <Input {...p} inputMode="decimal" {...register("depositValuePct")} />}</Field>
              <Field label="Days before delivery: deposit">{(p) => <Input {...p} inputMode="numeric" {...register("depositLeadDays")} />}</Field>
              <Field label="Days before delivery: balance">{(p) => <Input {...p} inputMode="numeric" {...register("balanceLeadDays")} />}</Field>
            </div>
          )}
          <Checkbox label="Takes full payment in advance" {...register("fullPrepaymentAccepted")} />
          {watch("fullPrepaymentAccepted") && (
            <div className="grid gap-4 rounded-lg bg-surface-2 p-4 sm:grid-cols-2">
              <Field label="% of turnover paid in advance">{(p) => <Input {...p} inputMode="decimal" {...register("fullPrepaymentPct")} />}</Field>
              <Field label="Days between payment and delivery">{(p) => <Input {...p} inputMode="numeric" {...register("fullPaymentLeadDays")} />}</Field>
            </div>
          )}
          {write && (
            <div className="flex flex-wrap items-center justify-end gap-3">
              <IssueList issues={issues} title="Please check:" />
              <Button type="submit" size="sm" disabled={!formState.isDirty} loading={saving}>
                Save answers
              </Button>
            </div>
          )}
        </fieldset>
      </form>
      {can("risk.review") && (
        <div className="space-y-3 border-t border-border bg-surface-2/50 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4" aria-hidden /> Compliance review (restricted)
          </p>
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            <Field label="Status">
              {(p) => (
                <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>
                  {COMPLIANCE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {COMPLIANCE_LABELS[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Restricted notes" hint="Visible to Compliance and administrators only. Never copied to the timeline.">
              {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} />}
            </Field>
          </div>
          <div className="flex justify-end gap-3">
            <IssueList issues={review.issues} />
            <Button size="sm" loading={review.saving} onClick={() => review.save(() => api.post(`/merchant-applications/${app.id}/compliance-review`, { status, restrictedNotes: notes || null }))}>
              Save review
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
