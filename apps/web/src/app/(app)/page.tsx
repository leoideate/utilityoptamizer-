"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Download, FileWarning, Plus, RefreshCw, ScanLine } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { LEAD_SOURCE_LABELS, type LeadSource, SERVICE_TYPE_LABELS, type ServiceType, addDays } from "@uo/shared";
import { BUCKETS, type Bucket } from "@/components/cases-board";
import { BarList, UserSelect, useSuppliers } from "@/components/domain";
import { Button, Card, CardHeader, Input, PageHeader, Select, Skeleton, Stat } from "@/components/ui/primitives";
import { api, qs } from "@/lib/api";
import { money, moneyCompact, num, pct, todayIso } from "@/lib/format";
import { useCan, useUser } from "@/lib/session";

interface Dashboard {
  range: { from: string; to: string };
  newLeads: number;
  leadsBySource: { source: LeadSource; count: number }[];
  opportunitiesByStage: { key: string; name: string; count: number; value: number }[];
  opportunitiesBySalesperson: { ownerId: string | null; name: string; open: number; won: number; lost: number; value: number }[];
  opportunitiesByService: { serviceType: ServiceType; open: number; won: number; lost: number }[];
  won: number;
  lost: number;
  winRate: number | null;
  conversionRate: number | null;
  pipelineValue: number;
  weightedPipelineValue: number;
  averageDaysInStage: { key: string; name: string; days: number; visits: number }[];
  averageDaysToActivation: number | null;
  supplierPerformance: { supplierId: string; name: string; won: number; lost: number; open: number; winRate: number | null }[];
  worldpay: { submitted: number; approved: number; declined: number; pending: number; approvalRate: number | null };
  outstandingDocuments: number;
  complianceQueries: number;
  renewalsDue: { openRenewals: number; contractsEndingWithoutRenewal: number };
  commission: { expected: number; confirmed: number; paid: number; clawedBack: number } | null;
}

const PRESETS = [
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Last 12 months", days: 365 },
];

export default function HomePage() {
  const user = useUser();
  const can = useCan();
  const seesAll = can("report.read");
  const [filters, setFilters] = useState({ from: addDays(todayIso(), -90), to: todayIso(), ownerId: "", serviceType: "", supplierId: "" });
  const suppliers = useSuppliers();
  const query = qs(filters);
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: ["dashboard", query], queryFn: () => api.get<Dashboard>(`/reports/dashboard${query}`) });
  const set = (k: keyof typeof filters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <>
      <PageHeader
        title={`Good ${new Date().getHours() < 12 ? "Morning" : new Date().getHours() < 18 ? "Afternoon" : "Evening"}, ${user.name.split(" ")[0]}`}
        description={seesAll ? "How the whole business is doing." : "Your pipeline at a glance."}
        actions={
          <>
            <Button variant="secondary" onClick={() => refetch()} loading={isFetching} aria-label="Refresh">
              <RefreshCw /> Refresh
            </Button>
            {can("commission.read") && (
              <Button variant="secondary" asChild>
                <a href={`/api/reports/commissions.csv${query}`}>
                  <Download /> Commissions CSV
                </a>
              </Button>
            )}
            {can("opportunity.create") && (
              <>
                <Button variant="secondary" asChild>
                  <Link href="/scan">
                    <ScanLine /> Scan business card
                  </Link>
                </Button>
                <Button asChild>
                  <Link href="/opportunities/new">
                    <Plus /> New lead
                  </Link>
                </Button>
              </>
            )}
          </>
        }
      />

      {can("opportunity.submit") && <WorkQueue />}

      <Card className="mb-6 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 [&>*]:min-w-0">
          <div className="lg:col-span-2">
            <span className="mb-1.5 block text-sm font-medium">Period</span>
            <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2 [&>*]:min-w-0">
              <Input type="date" aria-label="From" value={filters.from} onChange={(e) => set("from")(e.target.value)} />
              <Input type="date" aria-label="To" value={filters.to} onChange={(e) => set("to")(e.target.value)} />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button key={p.days} className="min-h-6 py-1 text-xs text-primary hover:underline" onClick={() => setFilters((f) => ({ ...f, from: addDays(todayIso(), -p.days), to: todayIso() }))}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {seesAll && (
            <label className="block text-sm font-medium">
              <span className="mb-1.5 block">Salesperson</span>
              <UserSelect value={filters.ownerId} onChange={set("ownerId")} />
            </label>
          )}
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block">Service</span>
            <Select value={filters.serviceType} onChange={(e) => set("serviceType")(e.target.value)}>
              <option value="">All services</option>
              {Object.entries(SERVICE_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block">Supplier</span>
            <Select value={filters.supplierId} onChange={(e) => set("supplierId")(e.target.value)}>
              <option value="">All suppliers</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </Card>

      {isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          <section aria-label="Key figures" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Stat label="New leads" value={num(data.newLeads)} sub="in this period" />
            <Stat label="Open pipeline" value={moneyCompact(data.pipelineValue)} sub={`${moneyCompact(data.weightedPipelineValue)} weighted by probability`} />
            <Stat label="Won / lost" value={`${data.won} / ${data.lost}`} sub={`Win rate ${pct(data.winRate)} · conversion ${pct(data.conversionRate)}`} tone="success" />
            <Stat label="Avg. days to activation" value={data.averageDaysToActivation ?? "—"} sub="lead created → live" />
          </section>

          <section aria-label="Needs attention" className="grid gap-4 sm:grid-cols-3">
            <AttentionCard href="/opportunities?view=missing_documents" icon={<FileWarning />} label="Outstanding documents" value={data.outstandingDocuments} />
            <AttentionCard href="/opportunities?view=compliance_queries" icon={<AlertTriangle />} label="Compliance queries" value={data.complianceQueries} />
            <AttentionCard
              href="/opportunities?view=renewals_due"
              icon={<RefreshCw />}
              label="Renewals due (120 days)"
              value={data.renewalsDue.openRenewals}
              sub={data.renewalsDue.contractsEndingWithoutRenewal ? `${data.renewalsDue.contractsEndingWithoutRenewal} live contract(s) ending with no renewal yet` : undefined}
            />
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Open opportunities by stage" description="Count and value of deals currently at each stage." />
              <div className="p-5">
                <BarList rows={data.opportunitiesByStage.filter((s) => s.count > 0).map((s) => ({ label: s.name, value: s.count, hint: s.value ? money(s.value) : undefined, href: `/opportunities?view=all&stage=${s.key}` }))} />
              </div>
            </Card>
            <Card>
              <CardHeader title="Leads by source" />
              <div className="p-5">
                <BarList rows={data.leadsBySource.map((s) => ({ label: LEAD_SOURCE_LABELS[s.source], value: s.count }))} />
              </div>
            </Card>
            {seesAll && (
              <Card>
                <CardHeader title="By salesperson" />
                <div className="overflow-x-auto" tabIndex={0}>
                  <table className="w-full text-sm">
                    <thead className="text-left text-muted">
                      <tr>
                        <th className="px-5 py-2 font-medium">Salesperson</th>
                        <th className="px-3 py-2 text-right font-medium">Open</th>
                        <th className="px-3 py-2 text-right font-medium">Won</th>
                        <th className="px-3 py-2 text-right font-medium">Lost</th>
                        <th className="px-5 py-2 text-right font-medium">Pipeline</th>
                      </tr>
                    </thead>
                    <tbody className="tabular">
                      {data.opportunitiesBySalesperson.map((r) => (
                        <tr key={r.ownerId ?? "none"} className="border-t border-border">
                          <td className="px-5 py-2">{r.name}</td>
                          <td className="px-3 py-2 text-right">{r.open}</td>
                          <td className="px-3 py-2 text-right">{r.won}</td>
                          <td className="px-3 py-2 text-right">{r.lost}</td>
                          <td className="px-5 py-2 text-right">{money(r.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
            <Card>
              <CardHeader title="By service" />
              <div className="p-5">
                <BarList rows={data.opportunitiesByService.map((s) => ({ label: SERVICE_TYPE_LABELS[s.serviceType], value: s.open + s.won, hint: `${s.won} won` }))} />
              </div>
            </Card>
            <Card>
              <CardHeader title="Average days in each stage" description="For stage visits completed in this period." />
              <div className="p-5">
                <BarList rows={data.averageDaysInStage.map((s) => ({ label: s.name, value: s.days, hint: `${s.visits} visits` }))} format={(n) => `${n} d`} />
              </div>
            </Card>
            <Card>
              <CardHeader title="Supplier performance" />
              <div className="p-5">
                <BarList rows={data.supplierPerformance.map((s) => ({ label: s.name, value: s.won, hint: `win rate ${pct(s.winRate)}` }))} format={(n) => `${n} won`} empty="No supplier selected on any deal yet." />
              </div>
            </Card>
            <Card>
              <CardHeader title="Worldpay" description="Applications submitted in this period." />
              <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
                <MiniStat label="Submitted" value={data.worldpay.submitted} />
                <MiniStat label="Approved" value={data.worldpay.approved} />
                <MiniStat label="Declined" value={data.worldpay.declined} />
                <MiniStat label="Approval rate" value={pct(data.worldpay.approvalRate)} />
              </div>
            </Card>
            {data.commission && (
              <Card>
                <CardHeader title="Commission" />
                <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
                  <MiniStat label="Expected" value={money(data.commission.expected)} />
                  <MiniStat label="Confirmed" value={money(data.commission.confirmed)} />
                  <MiniStat label="Paid" value={money(data.commission.paid)} />
                  <MiniStat label="Clawed back" value={money(data.commission.clawedBack)} />
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** Deals handed over at Supplier selected, by where they stand; each figure opens that part of the queue under Cases. */
function WorkQueue() {
  const { data } = useQuery({ queryKey: ["cases", "?scope=back_office"], queryFn: () => api.get<{ counts: Record<Bucket, number> }>("/cases?scope=back_office") });
  return (
    <Card className="mb-6">
      <CardHeader
        title="Work queue"
        description="Deals handed over at Supplier selected: forms, checks, signatures, submission and the external party's answer."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/cases?scope=back_office">
              Open work queue <ArrowRight />
            </Link>
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-3 p-5 pt-2 md:grid-cols-4">
        {BUCKETS.map((b) => (
          <Link key={b.key} href={`/cases?scope=back_office&bucket=${b.key}`} className="min-w-0 rounded-xl outline-offset-2">
            <Stat label={b.label} value={data?.counts[b.key] ?? "—"} tone={data?.counts[b.key] ? b.tone : undefined} />
          </Link>
        ))}
      </div>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="tabular text-lg font-semibold">{value}</p>
    </div>
  );
}

function AttentionCard({ href, icon, label, value, sub }: { href: string; icon: React.ReactNode; label: string; value: number; sub?: string }) {
  return (
    <Link href={href} className="group">
      <Card className="flex items-center gap-4 p-4 transition-colors group-hover:border-primary">
        <span className={value ? "rounded-lg bg-warning-soft p-2 text-warning [&_svg]:size-5" : "rounded-lg bg-surface-2 p-2 text-muted [&_svg]:size-5"}>{icon}</span>
        <div>
          <p className="tabular text-xl font-semibold">{value}</p>
          <p className="text-sm text-muted">{label}</p>
          {sub && <p className="text-xs text-warning">{sub}</p>}
        </div>
      </Card>
    </Link>
  );
}
