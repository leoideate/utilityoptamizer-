"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, CheckCircle2, Circle, Link2, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  PRODUCT_INTERESTS,
  PRODUCT_INTEREST_LABELS,
  type ProductInterest,
  SALE_TYPES,
  SALE_TYPE_LABELS,
  SERVICE_TYPE_LABELS,
  SUPPLY_CHANGES,
  SUPPLY_CHANGE_LABELS,
  type ServiceType,
  type SupplyChange,
  SUPPLIER_APPLICATION_LABELS,
  type SupplierApplicationKind,
  supplierApplicationApplies,
  isEnergyService,
  serviceTypeChoices,
} from "@uo/shared";
import { businessCategoryOptions } from "@/components/business-category";
import { type BusinessCategory } from "@uo/shared";
import { useSuppliers } from "@/components/domain";
import { CollectCard } from "./collect";
import { Dialog } from "@/components/ui/overlays";
import { Button, Card, CardHeader, CheckboxGroup, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { date, dateTime, isoDay, money } from "@/lib/format";
import type { Page, Workspace } from "@/lib/types";
import { blankToNull, numOrNull, useRefreshOpportunity } from "./common";

const GATE_LABELS: Record<keyof Workspace["gates"], string> = {
  proposal_sent: "Ready to send a proposal",
  supplier_selected: "Supplier or product selected",
  documents_prepared: "Ready to prepare documents",
  submitted: "Ready to submit",
  live_won: "Ready to complete (accepted by the external party)",
};

export function OverviewTab({ opp, onGoTo }: { opp: Workspace; onGoTo: (tab: string) => void }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0">
        <DetailsCard opp={opp} />
      </div>
      <div className="min-w-0 space-y-6">
        <NotesCard key={opp.id} opp={opp} />
        <CustomerCard opp={opp} />
        {opp.serviceType !== "merchant_services" && <CollectCard opp={opp} />}
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
            <dt className="hidden">Expected revenue</dt>
            <dd className="hidden">{money(opp.expectedRevenue)}</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function NotesCard({ opp }: { opp: Workspace }) {
  const qc = useQueryClient();
  const { register, handleSubmit, reset, formState } = useForm<{ notes: string }>({ defaultValues: { notes: opp.notes ?? "" } });
  useEffect(() => reset({ notes: opp.notes ?? "" }), [opp.notes, reset]);
  const save = useMutation({
    mutationFn: ({ notes }: { notes: string }) => api.patch(`/opportunities/${opp.id}`, { notes: blankToNull(notes) }),
    onSuccess: (_data, values) => {
      reset({ notes: values.notes.trim() });
      // Refetch on the next visit without resetting unsaved Details edits now.
      qc.invalidateQueries({ queryKey: ["opportunity", opp.id], refetchType: "none" });
    },
  });
  return (
    <Card>
      <form onSubmit={handleSubmit((values) => save.mutate(values))}>
        <CardHeader title="Notes" actions={opp.permissions.write && (
          <Button type="submit" size="sm" disabled={!formState.isDirty} loading={save.isPending}>Save notes</Button>
        )} />
        <div className="space-y-2 px-5 pb-5">
          <Field label="What happened?" hint="Add any useful details.">
            {(p) => <Textarea {...p} {...register("notes", { maxLength: 10000 })} rows={5} maxLength={10000} disabled={!opp.permissions.write || save.isPending} />}
          </Field>
          {save.isError && <p role="alert" className="text-sm text-danger">Notes could not be saved. Your changes are still here. Please try again.</p>}
          {save.isSuccess && !formState.isDirty && <p role="status" className="text-sm text-muted">Notes saved.</p>}
        </div>
      </form>
    </Card>
  );
}

interface DetailValues {
  businessCategory: BusinessCategory | "";
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
  expectedCloseDate: string;
  visitDate: string;
  contactRole: string;
  productInterest: ProductInterest[];
  supplyChanges: SupplyChange[];
  selectedSupplierId: string;
  applicationStatus: string;
}

function toValues(o: Workspace): DetailValues {
  return {
    name: o.name,
    businessCategory: o.businessCategory ?? "",
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
    expectedCloseDate: isoDay(o.expectedCloseDate),
    visitDate: isoDay(o.visitDate),
    contactRole: o.contactRole ?? "",
    productInterest: o.productInterest,
    supplyChanges: o.supplyChanges,
    selectedSupplierId: o.selectedSupplierId ?? "",
    applicationStatus: o.applicationStatus ?? "",
  };
}

function DetailsCard({ opp }: { opp: Workspace }) {
  const refresh = useRefreshOpportunity(opp.id);
  const { register, handleSubmit, reset, formState, watch, setValue } = useForm<DetailValues>({ defaultValues: toValues(opp) });
  const serviceType = watch("serviceType");
  const suppliers = useSuppliers(serviceType === "merchant_services" ? "merchant" : "energy");
  useEffect(() => reset(toValues(opp)), [opp, reset]);
  const save = useMutation({
    mutationFn: (v: DetailValues) =>
      api.patch(`/opportunities/${opp.id}`, {
        name: v.name,
        businessCategory: v.businessCategory || null,
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
        expectedCloseDate: v.expectedCloseDate || null,
        visitDate: v.visitDate || null,
        contactRole: blankToNull(v.contactRole),
        productInterest: v.productInterest,
        supplyChanges: isEnergyService(v.serviceType as ServiceType) ? v.supplyChanges : [],
        selectedSupplierId: v.selectedSupplierId || null,
        applicationStatus: blankToNull(v.applicationStatus),
      }),
    onSuccess: refresh,
  });
  const ro = !opp.permissions.write;
  // Changing product or supplier hides a supplier's own form (Flogas, Bord Gáis); when it already has a document, say so first.
  const [hiding, setHiding] = useState<{ values: DetailValues; kind: SupplierApplicationKind } | null>(null);
  const applies = (kind: SupplierApplicationKind, v: Pick<DetailValues, "productInterest" | "serviceType" | "selectedSupplierId">) =>
    supplierApplicationApplies(kind, {
      productInterest: v.productInterest,
      serviceType: v.serviceType as ServiceType,
      supplierName: suppliers.data?.find((s) => s.id === v.selectedSupplierId)?.name ?? (v.selectedSupplierId === opp.selectedSupplierId ? opp.selectedSupplier?.name : null),
    });
  const submit = (v: DetailValues) => {
    const hidden = opp.supplierApps.find((a) => a._count.versions > 0 && applies(a.kind as SupplierApplicationKind, toValues(opp)) && !applies(a.kind as SupplierApplicationKind, v));
    return hidden ? setHiding({ values: v, kind: hidden.kind as SupplierApplicationKind }) : save.mutate(v);
  };
  const supplierName = hiding?.kind === "bord_gais_electricity" ? "Bord Gáis" : "Flogas";

  return (
    <Card>
      <CardHeader
        title="Details"
        actions={
          !ro && (
            <Button size="sm" disabled={!formState.isDirty} loading={save.isPending} onClick={handleSubmit(submit)}>
              Save changes
            </Button>
          )
        }
      />
      <fieldset disabled={ro} className="grid gap-4 p-5 sm:grid-cols-2">
        <legend className="sr-only">Lead details</legend>
        <Field label="Lead name" className="sm:col-span-2">
          {(p) => <Input {...p} {...register("name", { required: true })} />}
        </Field>
        <Field label="Trading name">{(p) => <Input {...p} {...register("companyName")} />}</Field>
        <Field label="Business Category">{(p) => <Select {...p} {...register("businessCategory")}>{businessCategoryOptions()}</Select>}</Field>
        <Field label="Service" hint={opp.outcome === "won" ? "Can't change after activation." : undefined}>
          {(p) => (
            <Select {...p} disabled={opp.outcome === "won" || ro} {...register("serviceType", {
              onChange: (event) => {
                // Energy services share suppliers; switching provider categories clears the old choice.
                if ((serviceType === "merchant_services") !== (event.target.value === "merchant_services")) {
                  setValue("selectedSupplierId", "", { shouldDirty: true });
                }
              },
            })}>
              {serviceTypeChoices(opp.serviceType).map((s) => (
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
        <Field label={serviceType === "merchant_services" ? "Selected product provider" : "Selected supplier"}>
          {(p) => (
            <Select {...p} {...register("selectedSupplierId")} value={watch("selectedSupplierId")}>
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
        <Field label="Contact name">{(p) => <Input {...p} {...register("contactName")} />}</Field>
        <Field label="Email">{(p) => <Input {...p} type="email" {...register("email")} />}</Field>
        <Field label="Phone">{(p) => <Input {...p} type="tel" {...register("phone")} />}</Field>
        <Field label="Contact role" hint="e.g. Owner, manager, bookkeeper">{(p) => <Input {...p} {...register("contactRole")} />}</Field>
        {isEnergyService(watch("serviceType") as ServiceType) && (
          <CheckboxGroup
            className="sm:col-span-2"
            legend="Supply changes"
            hint="Each adds the documents it needs to the checklist (e.g. a signed lease for a change of legal entity)."
            options={SUPPLY_CHANGES}
            labels={SUPPLY_CHANGE_LABELS}
            value={watch("supplyChanges")}
            onChange={(v) => setValue("supplyChanges", v, { shouldDirty: true })}
          />
        )}
        <CheckboxGroup
          className="sm:col-span-2"
          legend="Product interest"
          options={PRODUCT_INTERESTS}
          labels={PRODUCT_INTEREST_LABELS}
          value={watch("productInterest")}
          onChange={(v) => setValue("productInterest", v, { shouldDirty: true })}
        />
        <Field label="Next action">{(p) => <Input {...p} placeholder="e.g. Call to get latest bill" {...register("nextAction")} />}</Field>
        <Field label="Follow-up date">{(p) => <Input {...p} type="date" {...register("followUpDate")} />}</Field>
        <Field label="Expected closing">{(p) => <Input {...p} type="date" {...register("expectedCloseDate")} />}</Field>
        <Field label="Date of visit">{(p) => <Input {...p} type="date" {...register("visitDate")} />}</Field>
        {/* Temporarily hidden; keep these fields mounted to preserve their existing save behavior. */}
        <Field label="Expected revenue (€)" className="hidden">{(p) => <Input {...p} inputMode="decimal" {...register("expectedRevenue")} />}</Field>
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
        <Field label="Campaign" className="hidden">{(p) => <Input {...p} {...register("campaign")} />}</Field>
        <Field label="Source details" className="hidden">{(p) => <Input {...p} {...register("leadSourceDetail")} />}</Field>
      </fieldset>
      <Dialog
        open={!!hiding}
        onOpenChange={(o) => !o && setHiding(null)}
        title={`Hide the ${supplierName} application?`}
        description={`A ${hiding ? SUPPLIER_APPLICATION_LABELS[hiding.kind] : ""} document has already been generated. With this change the ${supplierName} form no longer applies: its tab is hidden and nothing more can be generated or sent from it. Everything saved, generated and signed so far is kept.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setHiding(null)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={() => (save.mutate(hiding!.values), setHiding(null))}>
              Save anyway
            </Button>
          </>
        }
      >
        <p className="text-sm">Changing back to Electricity with {supplierName} shows it again.</p>
      </Dialog>
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
          <Link href={`/customers/${c.id}`} className="flex min-h-6 items-center gap-2 font-medium hover:underline">
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
      <CardHeader title="Customer" description="Not linked yet. Linking never changes this lead's stage, salesperson or status." />
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
