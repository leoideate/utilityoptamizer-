"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Flame, Gauge, MapPin, Plus, Star, Zap } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { type Fuel, OCCUPANCY_LABELS, OCCUPANCY_TYPES, occupancyNeedsLandlord, READING_TYPES, needsElectricity, needsGas } from "@uo/shared";
import { useSuppliers } from "@/components/domain";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, IssueList, Select, Skeleton } from "@/components/ui/primitives";
import { ApiError, api } from "@/lib/api";
import { date, isoDay, money, num, todayIso } from "@/lib/format";
import type { Workspace } from "@/lib/types";
import { blankToNull, numOrNull, useRefreshOpportunity } from "./common";

interface MeterPoint {
  id: string;
  fuel: Fuel;
  meterType: string | null;
  mprn: string | null;
  gprn: string | null;
  meterNumber: string | null;
  mccCode: string | null;
  formatExceptionReason: string | null;
  readings: { id: string; readingType: string; value: number; readingDate: string; register: string | null }[];
}
interface Site {
  id: string;
  label: string | null;
  line1: string;
  line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  serviceType: string;
  occupancyType: string | null;
  landlordName: string | null;
  landlordContact: string | null;
  customerSector: string | null;
  annualConsumptionKwh: number | null;
  meterPoints: MeterPoint[];
}
interface Contract {
  id: string;
  fuel: Fuel;
  siteId: string | null;
  site: { id: string; label: string | null; line1: string } | null;
  existingSupplierName: string | null;
  existingSupplierAccount: string | null;
  selectedSupplier: { id: string; name: string } | null;
  currentContractStartDate: string | null;
  currentContractEndDate: string | null;
  proposedActivationDate: string | null;
  activationDate: string | null;
  contractEndDate: string | null;
  termMonths: number | null;
  pricingPlan: string | null;
  dayRate: number | null;
  nightRate: number | null;
  peakRate: number | null;
  otherRate: number | null;
  gasRate: number | null;
  standingCharge: number | null;
  supplierReference: string | null;
  status: string;
  previousContractId: string | null;
}
interface Quote {
  id: string;
  fuel: Fuel;
  supplier: { id: string; name: string };
  termMonths: number;
  dayRate: number | null;
  nightRate: number | null;
  gasRate: number | null;
  standingCharge: number | null;
  estimatedAnnualCost: number | null;
  estimatedCommission: number | null;
  selected: boolean;
  notes: string | null;
}
interface EnergyWorkspace {
  sites: Site[];
  contracts: Contract[];
  quotes: Quote[];
  previousContracts: Contract[];
}

const FuelIcon = ({ fuel }: { fuel: Fuel }) => (fuel === "gas" ? <Flame className="size-4 text-warning" aria-hidden /> : <Zap className="size-4 text-primary" aria-hidden />);
const rate = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(2)}c`);

export function EnergyTab({ opp }: { opp: Workspace }) {
  const { data, isLoading } = useQuery({ queryKey: ["opportunity", opp.id, "energy"], queryFn: () => api.get<EnergyWorkspace>(`/opportunities/${opp.id}/energy`) });
  const [dialog, setDialog] = useState<null | { kind: "site" } | { kind: "meter"; site: Site } | { kind: "reading"; meter: MeterPoint } | { kind: "contract"; contract?: Contract } | { kind: "quote" }>(null);
  const fuels: Fuel[] = [...(needsElectricity(opp.serviceType) ? (["electricity"] as const) : []), ...(needsGas(opp.serviceType) ? (["gas"] as const) : [])];
  const write = opp.permissions.write && opp.outcome !== "won";

  if (isLoading || !data) return <Skeleton className="h-64" />;
  const close = () => setDialog(null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Supply sites & meters"
          description={fuels.length === 2 ? "Dual fuel: add an electricity meter (MPRN) and a gas meter (GPRN)." : fuels[0] === "gas" ? "Gas: each site needs a GPRN." : "Electricity: each site needs an MPRN."}
          actions={
            write && (
              <Button size="sm" onClick={() => setDialog({ kind: "site" })}>
                <Plus /> Add site
              </Button>
            )
          }
        />
        {!data.sites.length ? (
          <EmptyState icon={<MapPin />} title="No supply sites yet">
            Add the premises being supplied. Its meter details come from the customer's latest bill.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {data.sites.map((s) => (
              <li key={s.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{s.label || s.line1}</p>
                    <p className="text-sm text-muted">{[s.line1, s.line2, s.city, s.county, s.postcode].filter(Boolean).join(", ")}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {s.occupancyType && <Badge>{OCCUPANCY_LABELS[s.occupancyType as keyof typeof OCCUPANCY_LABELS]}</Badge>}
                      {occupancyNeedsLandlord(s.occupancyType as never) && <Badge tone={s.landlordName ? "neutral" : "warning"}>Landlord: {s.landlordName ?? "missing"}</Badge>}
                      {s.customerSector && <Badge>{s.customerSector}</Badge>}
                      {s.annualConsumptionKwh != null && <Badge tone="info">{num(s.annualConsumptionKwh)} kWh/yr</Badge>}
                    </div>
                  </div>
                  {write && (
                    <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "meter", site: s })}>
                      <Plus /> Add meter
                    </Button>
                  )}
                </div>
                {s.meterPoints.length > 0 ? (
                  <div className="mt-3 overflow-x-auto" tabIndex={0}>
                    <table className="w-full min-w-[560px] text-sm">
                      <thead className="text-left text-xs text-muted">
                        <tr>
                          <th className="py-1.5 pr-3 font-medium">Fuel</th>
                          <th className="py-1.5 pr-3 font-medium">{fuels.includes("electricity") && fuels.includes("gas") ? "MPRN / GPRN" : fuels[0] === "gas" ? "GPRN" : "MPRN"}</th>
                          <th className="py-1.5 pr-3 font-medium">Meter no.</th>
                          <th className="py-1.5 pr-3 font-medium">Type / MCC</th>
                          <th className="py-1.5 pr-3 font-medium">Latest reading</th>
                          <th className="py-1.5" />
                        </tr>
                      </thead>
                      <tbody>
                        {s.meterPoints.map((m) => (
                          <tr key={m.id} className="border-t border-border">
                            <td className="py-2 pr-3">
                              <span className="inline-flex items-center gap-1.5 capitalize">
                                <FuelIcon fuel={m.fuel} /> {m.fuel}
                              </span>
                            </td>
                            <td className="tabular py-2 pr-3 font-mono">
                              {m.mprn ?? m.gprn ?? <span className="text-warning">missing</span>}
                              {m.formatExceptionReason && <span className="block font-sans text-xs text-muted">Exception: {m.formatExceptionReason}</span>}
                            </td>
                            <td className="py-2 pr-3">{m.meterNumber ?? "—"}</td>
                            <td className="py-2 pr-3">{[m.meterType, m.mccCode].filter(Boolean).join(" · ") || "—"}</td>
                            <td className="tabular py-2 pr-3">{m.readings[0] ? `${num(m.readings[0].value)} (${date(m.readings[0].readingDate)})` : "—"}</td>
                            <td className="py-2 text-right">
                              {write && (
                                <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "reading", meter: m })}>
                                  <Gauge /> Reading
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-warning">No meters yet.</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Contracts"
          description="Current supply and the contract we're placing. Live contracts are kept as history and can't be edited."
          actions={
            write && (
              <Button size="sm" onClick={() => setDialog({ kind: "contract" })}>
                <Plus /> Add contract
              </Button>
            )
          }
        />
        {!data.contracts.length ? (
          <EmptyState title="No contract details yet">Record the current supplier, account number and end date from the bill.</EmptyState>
        ) : (
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-surface-2 text-left text-xs text-muted">
                <tr>
                  <th className="px-5 py-2 font-medium">Fuel</th>
                  <th className="px-3 py-2 font-medium">Current supplier</th>
                  <th className="px-3 py-2 font-medium">Current end</th>
                  <th className="px-3 py-2 font-medium">New supplier</th>
                  <th className="px-3 py-2 font-medium">Rates</th>
                  <th className="px-3 py-2 font-medium">Term</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {data.contracts.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-5 py-2.5">
                      <span className="inline-flex items-center gap-1.5 capitalize">
                        <FuelIcon fuel={c.fuel} /> {c.fuel}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {c.existingSupplierName ?? "—"}
                      {c.existingSupplierAccount && <span className="block text-xs text-muted">Acct {c.existingSupplierAccount}</span>}
                    </td>
                    <td className="px-3 py-2.5">{date(c.currentContractEndDate)}</td>
                    <td className="px-3 py-2.5">
                      {c.selectedSupplier?.name ?? "—"}
                      {c.supplierReference && <span className="block text-xs text-muted">Ref {c.supplierReference}</span>}
                    </td>
                    <td className="tabular px-3 py-2.5 text-xs">
                      {c.fuel === "gas" ? `Unit ${rate(c.gasRate)}` : `Day ${rate(c.dayRate)} · Night ${rate(c.nightRate)}`}
                      <span className="block">Standing {rate(c.standingCharge)}/day</span>
                    </td>
                    <td className="px-3 py-2.5">{c.termMonths ? `${c.termMonths} mths` : "—"}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={c.status === "live" ? "success" : c.status === "cancelled" ? "danger" : "neutral"}>{c.status}</Badge>
                      {c.contractEndDate && <span className="block text-xs text-muted">Ends {date(c.contractEndDate)}</span>}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      {write && !["live", "ended"].includes(c.status) && (
                        <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "contract", contract: c })}>
                          Edit
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.previousContracts.length > 0 && (
          <p className="border-t border-border px-5 py-3 text-xs text-muted">
            Renewing {data.previousContracts.length} previous contract(s) with {data.previousContracts.map((p) => p.selectedSupplier?.name ?? p.existingSupplierName).join(", ")}, ending {data.previousContracts.map((p) => date(p.contractEndDate)).join(", ")}.
          </p>
        )}
      </Card>

      <ComparisonCard opp={opp} quotes={data.quotes} fuels={fuels} onAdd={() => setDialog({ kind: "quote" })} write={write} />

      {dialog?.kind === "site" && <SiteDialog opp={opp} onClose={close} />}
      {dialog?.kind === "meter" && <MeterDialog opp={opp} site={dialog.site} fuels={fuels} onClose={close} />}
      {dialog?.kind === "reading" && <ReadingDialog opp={opp} meter={dialog.meter} onClose={close} />}
      {dialog?.kind === "contract" && <ContractDialog opp={opp} contract={dialog.contract} sites={data.sites} fuels={fuels} onClose={close} />}
      {dialog?.kind === "quote" && <QuoteDialog opp={opp} fuels={fuels} onClose={close} />}
    </div>
  );
}

function ComparisonCard({ opp, quotes, fuels, onAdd, write }: { opp: Workspace; quotes: Quote[]; fuels: Fuel[]; onAdd: () => void; write: boolean }) {
  const refresh = useRefreshOpportunity(opp.id);
  const select = useMutation({ mutationFn: (id: string) => api.post(`/quotes/${id}/select`), onSuccess: refresh });
  return (
    <Card>
      <CardHeader
        title="Price comparison"
        description="Record supplier quotes side by side. Choosing one sets the selected supplier and expected commission."
        actions={
          write && (
            <Button size="sm" onClick={onAdd}>
              <Plus /> Add quote
            </Button>
          )
        }
      />
      {!quotes.length ? (
        <EmptyState title="No quotes yet">Add quotes from each supplier to build the comparison for the proposal.</EmptyState>
      ) : (
        fuels.map((fuel) => {
          const rows = quotes.filter((q) => q.fuel === fuel);
          if (!rows.length) return null;
          const cheapest = Math.min(...rows.map((r) => r.estimatedAnnualCost ?? Infinity));
          return (
            <div key={fuel} className="overflow-x-auto border-t border-border first:border-t-0" tabIndex={0}>
              <p className="flex items-center gap-1.5 px-5 pt-3 text-sm font-medium capitalize">
                <FuelIcon fuel={fuel} /> {fuel}
              </p>
              <table className="w-full min-w-[680px] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-5 py-2 font-medium">Supplier</th>
                    <th className="px-3 py-2 font-medium">Term</th>
                    <th className="px-3 py-2 font-medium">Rates</th>
                    <th className="px-3 py-2 text-right font-medium">Est. annual cost</th>
                    <th className="px-3 py-2 text-right font-medium">Commission</th>
                    <th className="px-5 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((q) => (
                    <tr key={q.id} className={q.selected ? "border-t border-border bg-primary-soft/50" : "border-t border-border"}>
                      <td className="px-5 py-2">
                        {q.supplier.name}
                        {q.estimatedAnnualCost === cheapest && <Badge tone="success" className="ml-2">Cheapest</Badge>}
                      </td>
                      <td className="px-3 py-2">{q.termMonths} mths</td>
                      <td className="tabular px-3 py-2 text-xs">{fuel === "gas" ? `Unit ${rate(q.gasRate)}` : `Day ${rate(q.dayRate)} · Night ${rate(q.nightRate)}`} · SC {rate(q.standingCharge)}</td>
                      <td className="tabular px-3 py-2 text-right">{money(q.estimatedAnnualCost)}</td>
                      <td className="tabular px-3 py-2 text-right">{money(q.estimatedCommission)}</td>
                      <td className="px-5 py-2 text-right">
                        {q.selected ? (
                          <Badge tone="primary">
                            <Star className="size-3" aria-hidden /> Chosen
                          </Badge>
                        ) : (
                          write && (
                            <Button size="sm" variant="secondary" loading={select.isPending && select.variables === q.id} onClick={() => select.mutate(q.id)}>
                              Choose
                            </Button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })
      )}
    </Card>
  );
}

// --- Dialogs -----------------------------------------------------------------------------

function useSave(opp: Workspace, onClose: () => void) {
  const refresh = useRefreshOpportunity(opp.id);
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => (refresh(), onClose()),
    onError: (e) => setIssues(e instanceof ApiError ? (e.issues.length ? e.issues : [e.message]) : ["Something went wrong."]),
  });
  return { save: m.mutate, saving: m.isPending, issues };
}

function DialogFooter({ onClose, saving, onSave, label = "Save" }: { onClose: () => void; saving: boolean; onSave: () => void; label?: string }) {
  return (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button loading={saving} onClick={onSave}>
        {label}
      </Button>
    </>
  );
}

function SiteDialog({ opp, onClose }: { opp: Workspace; onClose: () => void }) {
  const { save, saving, issues } = useSave(opp, onClose);
  const { register, handleSubmit, watch } = useForm({ defaultValues: { label: "", line1: "", line2: "", city: "", county: "", postcode: "", occupancyType: "", landlordName: "", landlordContact: "", customerSector: "", annualConsumptionKwh: "" } });
  const rented = occupancyNeedsLandlord(watch("occupancyType") as never);
  const submit = handleSubmit((v) =>
    save(() =>
      api.post(`/opportunities/${opp.id}/sites`, {
        label: blankToNull(v.label),
        serviceType: opp.serviceType,
        address: { kind: "trading", line1: v.line1, line2: blankToNull(v.line2), city: blankToNull(v.city), county: blankToNull(v.county), postcode: blankToNull(v.postcode), country: "IE" },
        occupancyType: v.occupancyType || null,
        landlordName: blankToNull(v.landlordName),
        landlordContact: blankToNull(v.landlordContact),
        customerSector: blankToNull(v.customerSector),
        annualConsumptionKwh: numOrNull(v.annualConsumptionKwh),
      }),
    ),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add supply site" wide footer={<DialogFooter onClose={onClose} saving={saving} onSave={submit} />}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Site name" hint="e.g. Main shop, Warehouse">{(p) => <Input {...p} {...register("label")} />}</Field>
        <Field label="Address line 1" required>{(p) => <Input {...p} {...register("line1")} />}</Field>
        <Field label="Address line 2">{(p) => <Input {...p} {...register("line2")} />}</Field>
        <Field label="Town / city">{(p) => <Input {...p} {...register("city")} />}</Field>
        <Field label="County">{(p) => <Input {...p} {...register("county")} />}</Field>
        <Field label="Eircode / postcode">{(p) => <Input {...p} {...register("postcode")} />}</Field>
        <Field label="Occupancy">
          {(p) => (
            <Select {...p} {...register("occupancyType")}>
              <option value="">Not known yet</option>
              {OCCUPANCY_TYPES.map((o) => (
                <option key={o} value={o}>
                  {OCCUPANCY_LABELS[o]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Customer sector">{(p) => <Input {...p} placeholder="e.g. Hospitality" {...register("customerSector")} />}</Field>
        {rented && (
          <>
            <Field label="Landlord name" hint="Required for rented premises before documents are prepared.">
              {(p) => <Input {...p} {...register("landlordName")} />}
            </Field>
            <Field label="Landlord contact">{(p) => <Input {...p} {...register("landlordContact")} />}</Field>
          </>
        )}
        <Field label="Annual consumption (kWh)">{(p) => <Input {...p} inputMode="numeric" {...register("annualConsumptionKwh")} />}</Field>
      </div>
      <div className="mt-4">
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}

function MeterDialog({ opp, site, fuels, onClose }: { opp: Workspace; site: Site; fuels: Fuel[]; onClose: () => void }) {
  const { save, saving, issues } = useSave(opp, onClose);
  const [exception, setException] = useState(false);
  const { register, handleSubmit, watch } = useForm({ defaultValues: { fuel: fuels[0], id: "", meterNumber: "", meterType: "", mccCode: "", formatExceptionReason: "" } });
  const fuel = watch("fuel");
  const label = fuel === "gas" ? "GPRN" : "MPRN";
  const submit = handleSubmit((v) =>
    save(() =>
      api.post(`/sites/${site.id}/meters`, {
        fuel: v.fuel,
        mprn: v.fuel === "electricity" ? v.id : null,
        gprn: v.fuel === "gas" ? v.id : null,
        meterNumber: blankToNull(v.meterNumber),
        meterType: blankToNull(v.meterType),
        mccCode: blankToNull(v.mccCode),
        formatExceptionReason: exception ? blankToNull(v.formatExceptionReason) : null,
      }),
    ),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Add meter to ${site.label || site.line1}`} footer={<DialogFooter onClose={onClose} saving={saving} onSave={submit} />}>
      <div className="space-y-4">
        {fuels.length > 1 && (
          <Field label="Fuel">
            {(p) => (
              <Select {...p} {...register("fuel")}>
                <option value="electricity">Electricity</option>
                <option value="gas">Gas</option>
              </Select>
            )}
          </Field>
        )}
        <Field label={label} hint={fuel === "gas" ? "7 digits, on the gas bill." : "11 digits starting 10, on the electricity bill."}>
          {(p) => <Input {...p} inputMode="numeric" className="font-mono" {...register("id")} />}
        </Field>
        <Checkbox label={`This ${label} is a genuine exception (new connection, Northern Ireland site…)`} checked={exception} onChange={(e) => setException(e.target.checked)} />
        {exception && <Field label="Reason">{(p) => <Input {...p} {...register("formatExceptionReason")} />}</Field>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Meter number">{(p) => <Input {...p} {...register("meterNumber")} />}</Field>
          <Field label="Meter type">{(p) => <Input {...p} placeholder={fuel === "gas" ? "Standard" : "24hr, Day/Night…"} {...register("meterType")} />}</Field>
          {fuel === "electricity" && <Field label="MCC code">{(p) => <Input {...p} {...register("mccCode")} />}</Field>}
        </div>
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}

function ReadingDialog({ opp, meter, onClose }: { opp: Workspace; meter: MeterPoint; onClose: () => void }) {
  const { save, saving, issues } = useSave(opp, onClose);
  const { register, handleSubmit } = useForm({ defaultValues: { readingType: "actual", register: "", value: "", readingDate: todayIso() } });
  const submit = handleSubmit((v) => save(() => api.post(`/meters/${meter.id}/readings`, { readingType: v.readingType, register: blankToNull(v.register), value: numOrNull(v.value), readingDate: v.readingDate })));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Meter reading · ${meter.mprn ?? meter.gprn ?? meter.fuel}`} footer={<DialogFooter onClose={onClose} saving={saving} onSave={submit} />}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Reading">{(p) => <Input {...p} inputMode="decimal" {...register("value")} />}</Field>
        <Field label="Date">{(p) => <Input {...p} type="date" {...register("readingDate")} />}</Field>
        <Field label="Type">
          {(p) => (
            <Select {...p} {...register("readingType")}>
              {READING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Register" hint="e.g. Day, Night">{(p) => <Input {...p} {...register("register")} />}</Field>
      </div>
      <div className="mt-4">
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}

function ContractDialog({ opp, contract, sites, fuels, onClose }: { opp: Workspace; contract?: Contract; sites: Site[]; fuels: Fuel[]; onClose: () => void }) {
  const { save, saving, issues } = useSave(opp, onClose);
  const suppliers = useSuppliers("energy");
  const c = contract;
  const pence = (n: number | null | undefined) => (n == null ? "" : String(Math.round(n * 10000) / 100));
  const { register, handleSubmit, watch } = useForm({
    defaultValues: {
      fuel: c?.fuel ?? fuels[0],
      siteId: c?.siteId ?? sites[0]?.id ?? "",
      existingSupplierName: c?.existingSupplierName ?? "",
      existingSupplierAccount: c?.existingSupplierAccount ?? "",
      currentContractStartDate: isoDay(c?.currentContractStartDate),
      currentContractEndDate: isoDay(c?.currentContractEndDate),
      proposedActivationDate: isoDay(c?.proposedActivationDate),
      selectedSupplierId: c?.selectedSupplier?.id ?? opp.selectedSupplierId ?? "",
      termMonths: c?.termMonths?.toString() ?? "",
      pricingPlan: c?.pricingPlan ?? "",
      dayRate: pence(c?.dayRate),
      nightRate: pence(c?.nightRate),
      peakRate: pence(c?.peakRate),
      otherRate: pence(c?.otherRate),
      gasRate: pence(c?.gasRate),
      standingCharge: pence(c?.standingCharge),
      supplierReference: c?.supplierReference ?? "",
    },
  });
  const fuel = watch("fuel");
  /** Rates are entered in cent and stored in euro. */
  const euro = (v: string) => {
    const n = numOrNull(v);
    return n == null ? null : n / 100;
  };
  const submit = handleSubmit((v) => {
    const body = {
      fuel: v.fuel,
      siteId: v.siteId || null,
      existingSupplierName: blankToNull(v.existingSupplierName),
      existingSupplierAccount: blankToNull(v.existingSupplierAccount),
      currentContractStartDate: v.currentContractStartDate || null,
      currentContractEndDate: v.currentContractEndDate || null,
      proposedActivationDate: v.proposedActivationDate || null,
      selectedSupplierId: v.selectedSupplierId || null,
      termMonths: numOrNull(v.termMonths),
      pricingPlan: blankToNull(v.pricingPlan),
      dayRate: v.fuel === "electricity" ? euro(v.dayRate) : null,
      nightRate: v.fuel === "electricity" ? euro(v.nightRate) : null,
      peakRate: v.fuel === "electricity" ? euro(v.peakRate) : null,
      otherRate: v.fuel === "electricity" ? euro(v.otherRate) : null,
      gasRate: v.fuel === "gas" ? euro(v.gasRate) : null,
      standingCharge: euro(v.standingCharge),
      supplierReference: blankToNull(v.supplierReference),
    };
    save(() => (c ? api.patch(`/contracts/${c.id}`, body) : api.post(`/opportunities/${opp.id}/contracts`, body)));
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={c ? "Edit contract" : "Add contract"} wide footer={<DialogFooter onClose={onClose} saving={saving} onSave={submit} />}>
      <div className="grid gap-4 sm:grid-cols-3">
        {fuels.length > 1 && (
          <Field label="Fuel">
            {(p) => (
              <Select {...p} {...register("fuel")}>
                <option value="electricity">Electricity</option>
                <option value="gas">Gas</option>
              </Select>
            )}
          </Field>
        )}
        <Field label="Supply site">
          {(p) => (
            <Select {...p} {...register("siteId")}>
              <option value="">—</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label || s.line1}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <h3 className="text-sm font-semibold sm:col-span-3">Current supply (from the bill)</h3>
        <Field label="Current supplier">{(p) => <Input {...p} {...register("existingSupplierName")} />}</Field>
        <Field label="Account number">{(p) => <Input {...p} {...register("existingSupplierAccount")} />}</Field>
        <div />
        <Field label="Current contract start">{(p) => <Input {...p} type="date" {...register("currentContractStartDate")} />}</Field>
        <Field label="Current contract end">{(p) => <Input {...p} type="date" {...register("currentContractEndDate")} />}</Field>
        <div />
        <h3 className="text-sm font-semibold sm:col-span-3">New contract</h3>
        <Field label="New supplier">
          {(p) => (
            <Select {...p} {...register("selectedSupplierId")}>
              <option value="">Not chosen yet</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Term (months)">{(p) => <Input {...p} inputMode="numeric" {...register("termMonths")} />}</Field>
        <Field label="Proposed activation">{(p) => <Input {...p} type="date" {...register("proposedActivationDate")} />}</Field>
        <Field label="Pricing plan">{(p) => <Input {...p} {...register("pricingPlan")} />}</Field>
        {fuel === "electricity" ? (
          <>
            <Field label="Day rate (c/kWh)">{(p) => <Input {...p} inputMode="decimal" {...register("dayRate")} />}</Field>
            <Field label="Night rate (c/kWh)">{(p) => <Input {...p} inputMode="decimal" {...register("nightRate")} />}</Field>
            <Field label="Peak rate (c/kWh)">{(p) => <Input {...p} inputMode="decimal" {...register("peakRate")} />}</Field>
            <Field label="Other / wattless (c/kVArh)">{(p) => <Input {...p} inputMode="decimal" {...register("otherRate")} />}</Field>
          </>
        ) : (
          <Field label="Gas unit rate (c/kWh)">{(p) => <Input {...p} inputMode="decimal" {...register("gasRate")} />}</Field>
        )}
        <Field label="Standing charge (c/day)">{(p) => <Input {...p} inputMode="decimal" {...register("standingCharge")} />}</Field>
        <Field label="Supplier reference">{(p) => <Input {...p} {...register("supplierReference")} />}</Field>
      </div>
      <div className="mt-4">
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}

function QuoteDialog({ opp, fuels, onClose }: { opp: Workspace; fuels: Fuel[]; onClose: () => void }) {
  const { save, saving, issues } = useSave(opp, onClose);
  const suppliers = useSuppliers("energy");
  const { register, handleSubmit, watch } = useForm({ defaultValues: { supplierId: "", fuel: fuels[0], termMonths: "24", dayRate: "", nightRate: "", gasRate: "", standingCharge: "", estimatedAnnualCost: "", estimatedCommission: "", notes: "" } });
  const fuel = watch("fuel");
  const euro = (v: string) => {
    const n = numOrNull(v);
    return n == null ? null : n / 100;
  };
  const submit = handleSubmit((v) =>
    save(() =>
      api.post(`/opportunities/${opp.id}/quotes`, {
        supplierId: v.supplierId,
        fuel: v.fuel,
        termMonths: numOrNull(v.termMonths),
        dayRate: euro(v.dayRate),
        nightRate: euro(v.nightRate),
        gasRate: euro(v.gasRate),
        standingCharge: euro(v.standingCharge),
        estimatedAnnualCost: numOrNull(v.estimatedAnnualCost),
        estimatedCommission: numOrNull(v.estimatedCommission),
        notes: blankToNull(v.notes),
      }),
    ),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add supplier quote" wide footer={<DialogFooter onClose={onClose} saving={saving} onSave={submit} />}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Supplier">
          {(p) => (
            <Select {...p} {...register("supplierId")}>
              <option value="">Choose…</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {fuels.length > 1 && (
          <Field label="Fuel">
            {(p) => (
              <Select {...p} {...register("fuel")}>
                <option value="electricity">Electricity</option>
                <option value="gas">Gas</option>
              </Select>
            )}
          </Field>
        )}
        <Field label="Term (months)">{(p) => <Input {...p} inputMode="numeric" {...register("termMonths")} />}</Field>
        {fuel === "electricity" ? (
          <>
            <Field label="Day rate (c/kWh)">{(p) => <Input {...p} inputMode="decimal" {...register("dayRate")} />}</Field>
            <Field label="Night rate (c/kWh)">{(p) => <Input {...p} inputMode="decimal" {...register("nightRate")} />}</Field>
          </>
        ) : (
          <Field label="Unit rate (c/kWh)">{(p) => <Input {...p} inputMode="decimal" {...register("gasRate")} />}</Field>
        )}
        <Field label="Standing charge (c/day)">{(p) => <Input {...p} inputMode="decimal" {...register("standingCharge")} />}</Field>
        <Field label="Est. annual cost (€)">{(p) => <Input {...p} inputMode="decimal" {...register("estimatedAnnualCost")} />}</Field>
        <Field label="Est. commission (€)">{(p) => <Input {...p} inputMode="decimal" {...register("estimatedCommission")} />}</Field>
        <Field label="Notes" className="sm:col-span-3">{(p) => <Input {...p} {...register("notes")} />}</Field>
      </div>
      <div className="mt-4">
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}
