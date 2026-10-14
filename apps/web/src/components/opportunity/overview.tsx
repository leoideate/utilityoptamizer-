"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Building2, CheckCircle2, Circle, Link2, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS, SALE_TYPES, SALE_TYPE_LABELS, SERVICE_TYPES, SERVICE_TYPE_LABELS } from "@uo/shared";
import { useSuppliers } from "@/components/domain";
import { Dialog } from "@/components/ui/overlays";
import { Button, Card, CardHeader, Field, Input, Select } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { date, dateTime, isoDay, money } from "@/lib/format";
import type { Page, Workspace } from "@/lib/types";
import { blankToNull, numOrNull, useRefreshOpportunity } from "./common";

const GATE_LABELS: Record<keyof Workspace["gates"], string> = {
  proposal_sent: "Ready to send a proposal",
  supplier_selected: "Supplier or product selected",
  documents_prepared: "Ready to prepare documents",
  submitted: "Ready to submit",
};

export function OverviewTab({ opp, onGoTo }: { opp: Workspace; onGoTo: (tab: string) => void }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <DetailsCard opp={opp} />
      <div className="space-y-6">
        <CustomerCard opp={opp} />
        <Card>
          <CardHeader title="Checklist" description="What's needed for the next milestones." />
          <ul className="divide-y divide-border">
            {(Object.keys(GATE_LABELS) as (keyof Workspace["gates"])[]).map((g) => {
              const issues = opp.gates[g];
              return (
                <li key={g} className="px-5 py-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {issues.length ? <Circle className="size-4 text-muted" aria-hidden /> : <CheckCircle2 className="size-4 text-success" aria-hidden />}
                    {GATE_LABELS[g]}
                    <span className="sr-only">{issues.length ? "(incomplete)" : "(complete)"}</span>
                  </div>
                  {issues.length > 0 && (
                    <ul className="ml-6 mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted">
                      {issues.slice(0, 6).map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                      {issues.length > 6 && <li>…and {issues.length - 6} more</li>}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
            <Button size="sm" variant="secondary" onClick={() => onGoTo(opp.serviceType === "merchant_services" ? "worldpay" : "energy")}>
              {opp.serviceType === "merchant_services" ? "Worldpay application" : "Sites & contracts"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onGoTo("documents")}>
              Documents
            </Button>
          </div>
        </Card>
        <Card className="p-5 text-sm">
          <dl className="grid grid-cols-2 gap-y-2">
            <dt className="text-muted">Created</dt>
            <dd>{date(opp.createdAt)}</dd>
            <dt className="text-muted">First contact</dt>
            <dd>{dateTime(opp.firstContactAt)}</dd>
            <dt className="text-muted">Last contact</dt>
            <dd>{dateTime(opp.lastContactAt)}</dd>
            <dt className="text-muted">In this stage since</dt>
            <dd>{date(opp.stageEnteredAt)}</dd>
            <dt className="text-muted">Probability</dt>
            <dd>{opp.probability}%</dd>
            <dt className="text-muted">Expected revenue</dt>
            <dd>{money(opp.expectedRevenue)}</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}

interface DetailValues {
  name: string;
  serviceType: string;
  saleType: string;
  leadSource: string;
  leadSourceDetail: string;
  campaign: string;
  contactName: string;
  companyName: string;
  email: string;
  phone: string;
  expectedRevenue: string;
  nextAction: string;
  followUpDate: string;
  selectedSupplierId: string;
  applicationStatus: string;
}

function toValues(o: Workspace): DetailValues {
  return {
    name: o.name,
    serviceType: o.serviceType,
    saleType: o.saleType,
    leadSource: o.leadSource,
    leadSourceDetail: o.leadSourceDetail ?? "",
    campaign: o.campaign ?? "",
    contactName: o.contactName ?? "",
    companyName: o.companyName ?? "",
    email: o.email ?? "",
    phone: o.phone ?? "",
    expectedRevenue: o.expectedRevenue?.toString() ?? "",
    nextAction: o.nextAction ?? "",
    followUpDate: isoDay(o.followUpDate),
    selectedSupplierId: o.selectedSupplierId ?? "",
    applicationStatus: o.applicationStatus ?? "",
  };
}

function DetailsCard({ opp }: { opp: Workspace }) {
  const refresh = useRefreshOpportunity(opp.id);
  const suppliers = useSuppliers(opp.serviceType === "merchant_services" ? "merchant" : "energy");
  const { register, handleSubmit, reset, formState } = useForm<DetailValues>({ defaultValues: toValues(opp) });
  useEffect(() => reset(toValues(opp)), [opp, reset]);
  const save = useMutation({
    mutationFn: (v: DetailValues) =>
      api.patch(`/opportunities/${opp.id}`, {
        name: v.name,
        serviceType: v.serviceType,
        saleType: v.saleType,
        leadSource: v.leadSource,
        leadSourceDetail: blankToNull(v.leadSourceDetail),
        campaign: blankToNull(v.campaign),
        contactName: blankToNull(v.contactName),
        companyName: blankToNull(v.companyName),
        email: blankToNull(v.email),
        phone: blankToNull(v.phone),
        expectedRevenue: numOrNull(v.expectedRevenue),
        nextAction: blankToNull(v.nextAction),
        followUpDate: v.followUpDate || null,
        selectedSupplierId: v.selectedSupplierId || null,
        applicationStatus: blankToNull(v.applicationStatus),
      }),
    onSuccess: refresh,
  });
  const ro = !opp.permissions.write;

  return (
    <Card>
      <CardHeader
        title="Details"
        actions={
          !ro && (
            <Button size="sm" disabled={!formState.isDirty} loading={save.isPending} onClick={handleSubmit((v) => save.mutate(v))}>
              Save changes
            </Button>
          )
        }
      />
      <fieldset disabled={ro} className="grid gap-4 p-5 sm:grid-cols-2">
        <legend className="sr-only">Opportunity details</legend>
        <Field label="Name" className="sm:col-span-2">
          {(p) => <Input {...p} {...register("name", { required: true })} />}
        </Field>
        <Field label="Service" hint={opp.outcome === "won" ? "Can't change after activation." : undefined}>
          {(p) => (
            <Select {...p} disabled={opp.outcome === "won" || ro} {...register("serviceType")}>
              {SERVICE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {SERVICE_TYPE_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Sale type">
          {(p) => (
            <Select {...p} {...register("saleType")}>
              {SALE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {SALE_TYPE_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={opp.serviceType === "merchant_services" ? "Selected product provider" : "Selected supplier"}>
          {(p) => (
            <Select {...p} {...register("selectedSupplierId")}>
              <option value="">Not selected yet</option>
              {suppliers.data?.filter((s) => s.active || s.id === opp.selectedSupplierId).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Application status" hint="Free text, e.g. what the supplier last said.">
          {(p) => <Input {...p} {...register("applicationStatus")} />}
        </Field>
        <Field label="Next action">{(p) => <Input {...p} {...register("nextAction")} />}</Field>
        <Field label="Follow-up date">{(p) => <Input {...p} type="date" {...register("followUpDate")} />}</Field>
        <Field label="Expected revenue (€)">{(p) => <Input {...p} inputMode="decimal" {...register("expectedRevenue")} />}</Field>
        <Field label="Lead source">
          {(p) => (
            <Select {...p} {...register("leadSource")}>
              {LEAD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {LEAD_SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Campaign">{(p) => <Input {...p} {...register("campaign")} />}</Field>
        <Field label="Source details">{(p) => <Input {...p} {...register("leadSourceDetail")} />}</Field>
        <h3 className="pt-2 text-sm font-semibold sm:col-span-2">Captured contact details</h3>
        <Field label="Business name">{(p) => <Input {...p} {...register("companyName")} />}</Field>
        <Field label="Contact name">{(p) => <Input {...p} {...register("contactName")} />}</Field>
        <Field label="Email">{(p) => <Input {...p} type="email" {...register("email")} />}</Field>
        <Field label="Phone">{(p) => <Input {...p} type="tel" {...register("phone")} />}</Field>
      </fieldset>
    </Card>
  );
}

interface CustomerHit {
  id: string;
  legalName: string;
  tradingName: string | null;
  email: string | null;
}

function CustomerCard({ opp }: { opp: Workspace }) {
  const refresh = useRefreshOpportunity(opp.id);
  const [linking, setLinking] = useState(false);
  const [q, setQ] = useState(opp.companyName ?? "");
  const search = useQuery({ queryKey: ["customers", "search", q], queryFn: () => api.get<Page<CustomerHit>>(`/customers?q=${encodeURIComponent(q)}&pageSize=8`), enabled: linking });
  const link = useMutation({ mutationFn: (customerId: string) => api.post(`/opportunities/${opp.id}/customer`, { customerId }), onSuccess: () => (refresh(), setLinking(false)) });
  const create = useMutation({ mutationFn: () => api.post(`/opportunities/${opp.id}/customer/create`), onSuccess: refresh });
  const dupes = useQuery({
    queryKey: ["dupes", opp.id],
    queryFn: () => api.post<{ customer: CustomerHit; reasons: string[] }[]>("/customers/duplicates", { email: opp.email, phone: opp.phone, legalName: opp.companyName }),
    enabled: !opp.customer && !!(opp.email || opp.phone),
  });

  if (opp.customer) {
    const c = opp.customer;
    return (
      <Card>
        <CardHeader
          title="Customer"
          actions={
            opp.permissions.write && (
              <Button size="sm" variant="ghost" onClick={() => setLinking(true)}>
                Change
              </Button>
            )
          }
        />
        <div className="space-y-2 p-5 text-sm">
          <Link href={`/customers/${c.id}`} className="flex items-center gap-2 font-medium hover:underline">
            <Building2 className="size-4 text-muted" aria-hidden /> {c.legalName}
          </Link>
          {c.tradingName && <p className="text-muted">Trading as {c.tradingName}</p>}
          {c.contacts.slice(0, 3).map((ct) => (
            <p key={ct.id}>
              {ct.firstName} {ct.lastName} <span className="text-muted">{ct.mobile ?? ct.phone ?? ct.email}</span>
            </p>
          ))}
        </div>
        <LinkDialog open={linking} onClose={() => setLinking(false)} q={q} setQ={setQ} hits={search.data?.items} onPick={(id) => link.mutate(id)} />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Customer" description="Not linked yet. Linking never changes this opportunity's stage, salesperson or status." />
      <div className="space-y-3 p-5">
        {!!dupes.data?.length && (
          <div className="rounded-lg bg-info-soft p-3 text-sm">
            <p className="font-medium text-info">Possible existing customer</p>
            {dupes.data.map((d) => (
              <div key={d.customer.id} className="mt-2 flex items-center justify-between gap-2">
                <span>
                  {d.customer.legalName} <span className="text-xs text-muted">({d.reasons.join(", ").toLowerCase()})</span>
                </span>
                {opp.permissions.write && (
                  <Button size="sm" variant="secondary" onClick={() => link.mutate(d.customer.id)}>
                    Link
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {opp.permissions.write && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => create.mutate()} loading={create.isPending} disabled={!opp.companyName && !opp.contactName}>
              <Plus /> Create from these details
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setLinking(true)}>
              <Link2 /> Link existing
            </Button>
          </div>
        )}
      </div>
      <LinkDialog open={linking} onClose={() => setLinking(false)} q={q} setQ={setQ} hits={search.data?.items} onPick={(id) => link.mutate(id)} />
    </Card>
  );
}

function LinkDialog({ open, onClose, q, setQ, hits, onPick }: { open: boolean; onClose: () => void; q: string; setQ: (v: string) => void; hits?: CustomerHit[]; onPick: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Link a customer">
      <Input type="search" autoFocus placeholder="Search by name, email, VAT or company number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
      <ul className="mt-3 divide-y divide-border">
        {hits?.map((h) => (
          <li key={h.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <span>
              {h.legalName}
              {h.tradingName && <span className="text-muted"> · {h.tradingName}</span>}
            </span>
            <Button size="sm" variant="secondary" onClick={() => onPick(h.id)}>
              Link
            </Button>
          </li>
        ))}
        {hits && !hits.length && <li className="py-4 text-center text-sm text-muted">No customers found.</li>}
      </ul>
    </Dialog>
  );
}
