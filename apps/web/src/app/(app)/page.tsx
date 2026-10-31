"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Download, FileWarning, Phone, Plus, RefreshCw, ScanLine } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { LEAD_SOURCE_LABELS, type LeadSource, SELECTABLE_SERVICE_TYPES, SERVICE_TYPE_LABELS, type ServiceType, addDays } from "@uo/shared";
import { BUCKETS, type Bucket } from "@/components/cases-board";
import { BarList, UserSelect, useSuppliers } from "@/components/domain";
import { NeedsAttention } from "@/components/needs-attention";
import { Button, Card, CardHeader, Input, PageHeader, Select, Skeleton, Stat } from "@/components/ui/primitives";
import { api, qs } from "@/lib/api";
import { money, moneyCompact, num, pct, todayIso } from "@/lib/format";
import { useCan, useUser } from "@/lib/session";

interface Dashboard {
  range: { from: string; to: string };
  newLeads: number;
  leadsBySource: { source: LeadSource; count: number }[];
  opportunitiesByStage: { key: string; name: string; count: number; value: number }[];
  opportunitiesBySalesperson: {
    ownerId: string | null;
    name: string;
    open: number;
    won: number;
    lost: number;
    value: number;
    leadsInPeriod: number;
    wonInPeriod: number;
    lostInPeriod: number;
    wonValueInPeriod: number;
    winRate: number | null;
  }[];
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
  // Each figure opens the deals behind it: the opportunities list with the same filters and period.
  const drill = (extra: Record<string, string | null | undefined>) =>
    `/opportunities${qs({ view: "all", ownerId: filters.ownerId, serviceType: filters.serviceType, supplierId: filters.supplierId, ...extra })}`;
  const period = data ? { from: data.range.from, to: data.range.to } : {};

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

      <NeedsAttention />

      {can("opportunity.submit") && <WorkQueue />}

      <CallCounts everyone={seesAll} />

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
              {SELECTABLE_SERVICE_TYPES.map((k) => (
                <option key={k} value={k}>
                  {SERVICE_TYPE_LABELS[k]}
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
          <section aria-label="Key figures" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
            <StatLink href={drill({ dated: "created", ...period })} label="New leads" value={num(data.newLeads)} sub="created in this period" />
            <StatLink href={drill({ outcome: "open" })} label="Open pipeline" value={moneyCompact(data.pipelineValue)} sub={`${moneyCompact(data.weightedPipelineValue)} weighted by probability`} />
            <StatLink href={drill({ outcome: "won", dated: "won", ...period })} label="Won" value={num(data.won)} sub={`Win rate ${pct(data.winRate)} · conversion ${pct(data.conversionRate)}`} tone="success" />
            <StatLink href={drill({ outcome: "lost", dated: "lost", ...period })} label="Lost" value={num(data.lost)} sub="lost in this period" />
            <StatLink href={drill({ outcome: "won", dated: "won", ...period })} label="Avg. days to activation" value={data.averageDaysToActivation ?? "—"} sub="lead created → live" />
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
              <CardHeader title="Open leads by stage" description="Count and value of deals currently at each stage." />
              <div className="p-5">
                <BarList rows={data.opportunitiesByStage.filter((s) => s.count > 0).map((s) => ({ label: s.name, value: s.count, hint: s.value ? money(s.value) : undefined, href: drill({ stage: s.key, outcome: "open" }) }))} />
              </div>
            </Card>
            <Card>
              <CardHeader title="Leads by source" />
              <div className="p-5">
                <BarList rows={data.leadsBySource.map((s) => ({ label: LEAD_SOURCE_LABELS[s.source], value: s.count, href: drill({ leadSource: s.source, dated: "created", ...period }) }))} />
              </div>
            </Card>
            {seesAll && <TeamPerformance rows={data.opportunitiesBySalesperson} drill={drill} period={period} />}
            <Card>
              <CardHeader title="By service" />
              <div className="p-5">
                <BarList
                  rows={data.opportunitiesByService.map((s) => ({ label: SERVICE_TYPE_LABELS[s.serviceType], value: s.open + s.won + s.lost, hint: `${s.open} open · ${s.won} won`, href: drill({ serviceType: s.serviceType }) }))}
                />
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
                <BarList
                  rows={data.supplierPerformance.map((s) => ({ label: s.name, value: s.won, hint: `win rate ${pct(s.winRate)}`, href: drill({ supplierId: s.supplierId, outcome: "won" }) }))}
                  format={(n) => `${n} won`}
                  empty="No supplier selected on any deal yet."
                />
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

interface CallCount {
  made: number;
  connected: number;
}
interface CallCountsReport {
  mine: { userId: string; name: string; today: CallCount; week: CallCount; month: CallCount };
  rows: { userId: string; name: string; today: CallCount; week: CallCount; month: CallCount }[];
  totals: { today: CallCount; week: CallCount; month: CallCount };
}
const CALL_PERIODS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
] as const;

/** Calls made today, this week (from Monday) and this month, Irish time: your own for everyone, plus each salesperson for managers. */
function CallCounts({ everyone }: { everyone: boolean }) {
  const { data } = useQuery({ queryKey: ["reports", "calls"], queryFn: () => api.get<CallCountsReport>("/reports/calls"), refetchInterval: 60_000 });
  return (
    <Card className="mb-6">
      <CardHeader title="My calls" description="Calls made from the CRM, a desk phone or the RingCentral app. Connected means the customer answered." />
      {!data ? (
        <div className="p-5 pt-2">
          <Skeleton className="h-20" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-5 pt-2 min-[400px]:grid-cols-3">
          {CALL_PERIODS.map((p) => (
            <Stat key={p.key} label={p.label} value={num(data.mine[p.key].made)} sub={`${num(data.mine[p.key].connected)} connected`} />
          ))}
        </div>
      )}
      {data && everyone && <TeamCalls data={data} />}
    </Card>
  );
}

/** Managers: each salesperson who made calls this month, with a total. */
function TeamCalls({ data }: { data: CallCountsReport }) {
  return (
    <>
      <h3 className="border-t border-border px-5 pb-1 pt-4 text-sm font-medium">Calls by salesperson</h3>
      {data.rows.length === 0 ? (
        <p className="flex items-center gap-2 px-5 pb-5 text-sm text-muted">
          <Phone className="size-4" aria-hidden /> No calls made this month yet.
        </p>
      ) : (
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">Salesperson</th>
                {CALL_PERIODS.map((p) => (
                  <th key={p.key} className="px-3 py-2 text-right font-medium last:pr-5">
                    {p.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular">
              {data.rows.map((r) => (
                <tr key={r.userId} className="border-t border-border">
                  <td className="whitespace-nowrap px-5 py-2">{r.name}</td>
                  {CALL_PERIODS.map((p) => (
                    <CallCell key={p.key} count={r[p.key]} />
                  ))}
                </tr>
              ))}
              {data.rows.length > 1 && (
                <tr className="border-t border-border font-semibold">
                  <td className="px-5 py-2">Total</td>
                  {CALL_PERIODS.map((p) => (
                    <CallCell key={p.key} count={data.totals[p.key]} />
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CallCell({ count }: { count: CallCount }) {
  return (
    <td className="whitespace-nowrap px-3 py-2 text-right last:pr-5">
      {num(count.made)} <span className="text-xs font-normal text-muted">({num(count.connected)} connected)</span>
    </td>
  );
}

/** A key figure that opens the deals it counts. */
function StatLink({ href, ...stat }: { href: string } & React.ComponentProps<typeof Stat>) {
  return (
    <Link href={href} className="group min-w-0 rounded-xl outline-offset-2 [&>*]:h-full [&>*]:transition-colors hover:[&>*]:border-primary" aria-label={`${stat.label}: open the list`}>
      <Stat {...stat} />
    </Link>
  );
}

/** A count that opens the deals behind it; zero, or no list to open, stays plain. */
function CountLink({ href, value, children }: { href?: string; value: number; children?: React.ReactNode }) {
  if (!href || !value) return <>{children ?? value}</>;
  return (
    <Link href={href} className="inline-block min-h-6 min-w-6 py-0.5 font-medium text-primary hover:underline">
      {children ?? value}
    </Link>
  );
}

/**
 * Each salesperson's results: leads, wins and losses in the period, and what they hold now. Every
 * figure opens those deals.
 */
function TeamPerformance({ rows, drill, period }: { rows: Dashboard["opportunitiesBySalesperson"]; drill: (extra: Record<string, string | null | undefined>) => string; period: { from?: string; to?: string } }) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Team performance" description="New leads, won and lost in the selected period; open deals and pipeline as they stand now. Click a figure to see the deals." />
      {rows.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted">No deals in this period.</p>
      ) : (
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">Salesperson</th>
                <th className="px-3 py-2 text-right font-medium">New leads</th>
                <th className="px-3 py-2 text-right font-medium">Won</th>
                <th className="px-3 py-2 text-right font-medium">Won value</th>
                <th className="px-3 py-2 text-right font-medium">Lost</th>
                <th className="px-3 py-2 text-right font-medium">Win rate</th>
                <th className="px-3 py-2 text-right font-medium">Open now</th>
                <th className="px-5 py-2 text-right font-medium">Pipeline</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {rows.map((r) => {
                // Unassigned deals have no owner to filter on; only the open ones have a list (the Unassigned view).
                const own = (extra: Record<string, string | undefined>) => (r.ownerId ? drill({ ownerId: r.ownerId, ...extra }) : undefined);
                return (
                  <tr key={r.ownerId ?? "none"} className="border-t border-border">
                    <td className="whitespace-nowrap px-5 py-2">{r.ownerId ? <CountLink href={own({})} value={1}>{r.name}</CountLink> : r.name}</td>
                    <td className="px-3 py-2 text-right">
                      <CountLink href={own({ dated: "created", ...period })} value={r.leadsInPeriod} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <CountLink href={own({ outcome: "won", dated: "won", ...period })} value={r.wonInPeriod} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{money(r.wonValueInPeriod)}</td>
                    <td className="px-3 py-2 text-right">
                      <CountLink href={own({ outcome: "lost", dated: "lost", ...period })} value={r.lostInPeriod} />
                    </td>
                    <td className="px-3 py-2 text-right">{pct(r.winRate)}</td>
                    <td className="px-3 py-2 text-right">
                      <CountLink href={r.ownerId ? own({ outcome: "open" }) : "/opportunities?view=unassigned"} value={r.open} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-2 text-right">{money(r.value)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
