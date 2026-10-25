"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type BillReading, type Fuel, needsElectricity, needsGas } from "@uo/shared";
import { Dialog } from "@/components/ui/overlays";
import { Button, Checkbox, IssueList, Skeleton } from "@/components/ui/primitives";
import { ApiError, api } from "@/lib/api";
import { date } from "@/lib/format";
import type { Workspace } from "@/lib/types";
import { useRefreshOpportunity } from "./common";

interface Meter {
  id: string;
  fuel: Fuel;
  meterType: string | null;
  mprn: string | null;
  gprn: string | null;
  meterNumber: string | null;
  mccCode: string | null;
  formatExceptionReason: string | null;
  mic: number | null;
  dgCode: string | null;
  voltage: string | null;
  profileClass: string | null;
  meterSerial2: string | null;
  supplyPointCapacityKwh: number | null;
  annualQuantityKwh: number | null;
  readings: { value: number; readingDate: string; register: string | null }[];
}
interface Site {
  id: string;
  line1: string;
  line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  annualConsumptionKwh: number | null;
  meterPoints: Meter[];
}
interface Contract {
  id: string;
  fuel: Fuel;
  status: string;
  existingSupplierName: string | null;
  existingSupplierAccount: string | null;
}
interface Energy {
  sites: Site[];
  contracts: Contract[];
}
interface ReadResult {
  versionId: string;
  documentItemId: string;
  reading: BillReading;
}

type Target = "address" | "consumption" | "identifier" | "meterNumber" | "mic" | "supplier" | "account" | `reading:${number}`;
interface Row {
  key: Target;
  label: string;
  bill: string;
  crm: string | null;
  /** Ticked to start with only when the CRM has nothing there yet. */
  suggested: boolean;
}

const address = (a: { line1: string; line2: string | null; city: string | null; county: string | null; postcode: string | null } | null) => (a ? [a.line1, a.line2, a.city, a.county, a.postcode].filter(Boolean).join(", ") : null);
const cent = (n: number | null) => (n == null ? null : `${(n * 100).toFixed(2)}c`);
const kwh = (n: number | null) => (n == null ? null : `${n.toLocaleString("en-IE")} kWh`);
const same = (a: string | null, b: string | null) => (a ?? "").replace(/\s/g, "").toLowerCase() === (b ?? "").replace(/\s/g, "").toLowerCase();

/**
 * "Read bill": the AI reads the uploaded bill and this dialog shows each value beside what the CRM
 * holds. Only the ticked values are saved, through the usual energy endpoints.
 */
export function BillReadingDialog({ opp, versionId, onClose }: { opp: Workspace; versionId: string; onClose: () => void }) {
  const refresh = useRefreshOpportunity(opp.id);
  const read = useMutation({ meta: { silent: true }, mutationFn: () => api.post<ReadResult>(`/document-versions/${versionId}/read-bill`) });
  const energy = useQuery({ queryKey: ["opportunity", opp.id, "energy"], queryFn: () => api.get<Energy>(`/opportunities/${opp.id}/energy`) });
  const [chosen, setChosen] = useState<Set<Target> | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // Each read is a paid call: start it once, even when React runs effects twice in development.
  const started = useRef(false);
  const { mutate } = read;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);

  const r = read.data?.reading;
  const fuels: Fuel[] = [...(needsElectricity(opp.serviceType) ? (["electricity"] as const) : []), ...(needsGas(opp.serviceType) ? (["gas"] as const) : [])];
  const fuel: Fuel | null = r?.fuel ?? (fuels.length === 1 ? fuels[0] : null);
  const wrongFuel = !!fuel && !fuels.includes(fuel);
  const identifier = fuel === "gas" ? r?.gprn : r?.mprn;

  const { site, meter, contract } = useMemo(() => {
    const sites = energy.data?.sites ?? [];
    const meters = sites.flatMap((s) => s.meterPoints.map((m) => ({ s, m })));
    const byId = identifier ? meters.find(({ m }) => m.mprn === identifier || m.gprn === identifier) : undefined;
    const site = byId?.s ?? sites[0];
    const meter = byId?.m ?? site?.meterPoints.find((m) => m.fuel === fuel);
    const contract = energy.data?.contracts.find((c) => c.fuel === fuel && c.status !== "live" && c.status !== "ended");
    return { site, meter, contract };
  }, [energy.data, identifier, fuel]);

  const rows: Row[] = useMemo(() => {
    if (!r || !r.readable) return [];
    const out: Row[] = [];
    const add = (key: Target, label: string, bill: string | null, crm: string | null) => bill && out.push({ key, label, bill, crm, suggested: !crm });
    add("address", "Supply address", address(r.supplyAddress), address(site ?? null));
    add("consumption", "Annual consumption", kwh(r.annualConsumptionKwh), kwh(site?.annualConsumptionKwh ?? null));
    if (!wrongFuel && fuel) {
      add("identifier", fuel === "gas" ? "GPRN" : "MPRN", identifier ?? null, (fuel === "gas" ? meter?.gprn : meter?.mprn) ?? null);
      add("meterNumber", "Meter number", r.meterNumber, meter?.meterNumber ?? null);
      if (fuel === "electricity") add("mic", "MIC (kVA)", r.mic == null ? null : String(r.mic), meter?.mic == null ? null : String(meter.mic));
      add("supplier", "Current supplier", r.supplierName, contract?.existingSupplierName ?? null);
      add("account", "Account number with them", r.accountNumber, contract?.existingSupplierAccount ?? null);
      r.readings.forEach((x, i) => {
        if (!x.readingDate) return;
        const recorded = meter?.readings.some((m) => m.readingDate.slice(0, 10) === x.readingDate && Number(m.value) === Number(x.value));
        if (!recorded) out.push({ key: `reading:${i}`, label: `${x.register ?? "Meter"} reading, ${date(x.readingDate)} (${x.readingType})`, bill: x.value, crm: null, suggested: true });
      });
    }
    return out.filter((row) => !same(row.bill, row.crm));
  }, [r, site, meter, contract, fuel, identifier, wrongFuel]);

  const ticked = chosen ?? new Set(rows.filter((row) => row.suggested).map((row) => row.key));
  const toggle = (key: Target, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(key);
    else next.delete(key);
    setChosen(next);
  };

  /** Saves the ticked values: site first, then its meter, the contract and the readings. */
  const apply = async () => {
    if (!r || !fuel) return;
    setSaving(true);
    setIssues([]);
    try {
      const want = (k: Target) => ticked.has(k);
      let siteId = site?.id;
      const siteBody = {
        ...(want("address") && r.supplyAddress ? { address: { kind: "trading", ...r.supplyAddress } } : {}),
        ...(want("consumption") ? { annualConsumptionKwh: r.annualConsumptionKwh } : {}),
      };
      if (siteId && Object.keys(siteBody).length) await api.patch(`/sites/${siteId}`, siteBody);
      const needsSite = want("identifier") || want("meterNumber") || want("mic") || rows.some((row) => row.key.startsWith("reading:") && want(row.key));
      if (!siteId && (needsSite || Object.keys(siteBody).length)) {
        if (!r.supplyAddress) throw new ApiError(422, "", ["Add a supply site on the Energy tab first: the bill has no supply address to create one from."]);
        siteId = (await api.post<{ id: string }>(`/opportunities/${opp.id}/sites`, { serviceType: opp.serviceType, ...siteBody, address: { kind: "trading", ...r.supplyAddress } })).id;
      }

      let meterId = meter?.id;
      if (want("identifier") || want("meterNumber") || want("mic")) {
        const id = want("identifier") ? identifier : undefined;
        const changes = {
          ...(id ? (fuel === "gas" ? { gprn: id } : { mprn: id }) : {}),
          ...(want("meterNumber") ? { meterNumber: r.meterNumber } : {}),
          ...(want("mic") ? { mic: r.mic } : {}),
        };
        if (meter) {
          const { id: _id, readings: _readings, ...current } = meter;
          await api.patch(`/meters/${meter.id}`, { ...current, ...changes });
        } else meterId = (await api.post<{ id: string }>(`/sites/${siteId}/meters`, { fuel, ...changes })).id;
      }

      const contractBody = { ...(want("supplier") ? { existingSupplierName: r.supplierName } : {}), ...(want("account") ? { existingSupplierAccount: r.accountNumber } : {}) };
      if (Object.keys(contractBody).length) {
        if (contract) await api.patch(`/contracts/${contract.id}`, contractBody);
        else await api.post(`/opportunities/${opp.id}/contracts`, { fuel, siteId: siteId ?? null, ...contractBody });
      }

      const readings = r.readings.filter((x, i) => want(`reading:${i}`) && x.readingDate);
      if (readings.length && !meterId) throw new ApiError(422, "", [`Add the ${fuel === "gas" ? "GPRN" : "MPRN"} too: readings are saved on the meter.`]);
      for (const x of readings) {
        await api.post(`/meters/${meterId}/readings`, { readingType: x.readingType, register: x.register, value: Number(x.value), readingDate: x.readingDate, documentId: read.data!.documentItemId });
      }
      refresh();
      onClose();
    } catch (e) {
      setIssues(e instanceof ApiError ? (e.issues.length ? e.issues : [e.message]) : ["Saving failed. Try again."]);
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const failed = read.error ? (read.error instanceof ApiError ? (read.error.issues.length ? read.error.issues : [read.error.message]) : ["The bill couldn't be read."]) : [];
  const info: [string, string | null][] = r
    ? [
        ["Name on the bill", r.customerName],
        ["Bill date", r.billDate && date(r.billDate)],
        ["Billing period", r.periodStart && r.periodEnd ? `${date(r.periodStart)} to ${date(r.periodEnd)}` : null],
        ["Tariff", r.tariffName],
        ["Day rate", cent(r.dayRate)],
        ["Night rate", cent(r.nightRate)],
        ["Gas rate", cent(r.gasRate)],
        ["Standing charge", r.standingChargePerDay == null ? null : `${cent(r.standingChargePerDay)}/day`],
        ["Used this period", kwh(r.usageKwh)],
      ]
    : [];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Read bill with AI"
      description="Check each value against the bill before you use it. Only the ticked values are saved."
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {r?.readable && rows.length > 0 && (
            <Button onClick={apply} loading={saving} disabled={ticked.size === 0}>
              Use these details
            </Button>
          )}
        </>
      }
    >
      {(read.isPending || energy.isLoading) && (
        <div className="space-y-2" aria-live="polite">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Sparkles className="size-4 text-primary" aria-hidden /> Reading the bill…
          </p>
          <Skeleton className="h-40" />
        </div>
      )}
      {failed.length > 0 && <IssueList issues={failed} title="The bill couldn't be read:" />}
      {r && !r.readable && <IssueList issues={["This doesn't look like an energy bill the AI can read. Enter the details by hand on the Energy tab."]} title="Nothing to use:" />}
      {r?.readable && energy.data && (
        <div className="space-y-4">
          {wrongFuel && <IssueList issues={[`This is a ${fuel} bill, but the deal is ${opp.serviceType.replace("_", " ")}. Only the address can be used.`]} title="Check the bill:" />}
          {r.notes && (
            <p className="flex items-start gap-2 rounded-[var(--md-sys-shape-corner-small)] bg-warning-soft p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {r.notes}
            </p>
          )}
          {rows.length === 0 ? (
            <p className="text-sm text-muted">Everything the AI read from the bill is already in the CRM.</p>
          ) : (
            <div className="overflow-x-auto" tabIndex={0}>
              <table className="w-full min-w-[32rem] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="w-10 py-2 font-medium">
                      <span className="sr-only">Use</span>
                    </th>
                    <th className="py-2 pr-3 font-medium">Detail</th>
                    <th className="py-2 pr-3 font-medium">On the bill</th>
                    <th className="py-2 font-medium">In the CRM now</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className="border-t border-border align-top">
                      <td className="py-1">
                        <Checkbox label={`Use ${row.label}`} className="[&_label>span]:sr-only" checked={ticked.has(row.key)} onChange={(e) => toggle(row.key, e.target.checked)} />
                      </td>
                      <td className="py-2 pr-3">{row.label}</td>
                      <td className="py-2 pr-3 font-medium">{row.bill}</td>
                      <td className="py-2 text-muted">{row.crm ?? "Empty"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {info.some(([, v]) => v) && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Also on the bill (for comparing quotes; not saved)</p>
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                {info
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 border-b border-border py-1">
                      <dt className="text-muted">{k}</dt>
                      <dd className="text-right">{v}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          )}
          {issues.length > 0 && <IssueList issues={issues} title="Not everything was saved:" />}
        </div>
      )}
    </Dialog>
  );
}
