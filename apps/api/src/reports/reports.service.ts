import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { BUSINESS_TZ, STAGES, addDays, can, today } from "@uo/shared";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { PrismaService } from "../common/prisma.service";
import { dateOnly } from "../common/values";
import { OpportunityAccess } from "../opportunities/access.service";

export const reportFilterSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ownerId: z.string().uuid().optional(),
  serviceType: z.enum(["electricity", "gas", "dual_fuel", "merchant_services"]).optional(),
  supplierId: z.string().uuid().optional(),
  outcome: z.enum(["open", "won", "lost"]).optional(),
});
export type ReportFilter = z.infer<typeof reportFilterSchema>;

const pct = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);

/** The moment an Irish calendar day starts (Dublin is UTC or UTC+1, so midnight there is 00:00 or 23:00 UTC). */
export function dublinDayStart(iso: string): Date {
  const utcMidnight = new Date(`${iso}T00:00:00Z`);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TZ, hour: "2-digit", hourCycle: "h23" }).format(utcMidnight));
  return new Date(utcMidnight.getTime() - hour * 3_600_000);
}

export interface CallCount {
  made: number;
  connected: number;
}

/**
 * Dashboard metrics. Every figure respects the viewer's visibility (salespeople see their own
 * pipeline) and the filters. Commission figures need commission.read.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
  ) {}

  private base(actor: Actor, f: ReportFilter): Prisma.OpportunityWhereInput {
    return {
      AND: [
        this.access.visibleWhere(actor),
        f.ownerId ? { ownerId: f.ownerId } : {},
        f.serviceType ? { serviceType: f.serviceType } : {},
        f.supplierId ? { selectedSupplierId: f.supplierId } : {},
        f.outcome ? { outcome: f.outcome } : {},
      ],
    };
  }

  private range(f: ReportFilter) {
    const to = f.to ?? today();
    const from = f.from ?? addDays(to, -90);
    return { from: new Date(`${from}T00:00:00Z`), to: new Date(`${addDays(to, 1)}T00:00:00Z`), fromIso: from, toIso: to };
  }

  async dashboard(actor: Actor, f: ReportFilter) {
    const base = this.base(actor, f);
    const r = this.range(f);
    const inRange = (field: "createdAt" | "wonAt" | "lostAt") => ({ AND: [base, { [field]: { gte: r.from, lt: r.to } }] });
    const openWhere: Prisma.OpportunityWhereInput = { AND: [base, { outcome: "open" }] };

    const [newLeads, bySource, byService, wonInRange, lostInRange, createdCohortWon, open, stageGroups, owners, ownerLeads, ownerWon, ownerLost] = await Promise.all([
      this.prisma.opportunity.count({ where: inRange("createdAt") }),
      this.prisma.opportunity.groupBy({ by: ["leadSource"], where: inRange("createdAt"), _count: { _all: true } }),
      this.prisma.opportunity.groupBy({ by: ["serviceType", "outcome"], where: base, _count: { _all: true }, _sum: { expectedRevenue: true } }),
      this.prisma.opportunity.count({ where: inRange("wonAt") }),
      this.prisma.opportunity.count({ where: inRange("lostAt") }),
      this.prisma.opportunity.count({ where: { AND: [inRange("createdAt"), { outcome: "won" }] } }),
      this.prisma.opportunity.findMany({ where: openWhere, select: { expectedRevenue: true, probability: true } }),
      this.prisma.opportunity.groupBy({ by: ["stageId"], where: openWhere, _count: { _all: true }, _sum: { expectedRevenue: true } }),
      this.prisma.opportunity.groupBy({ by: ["ownerId", "outcome"], where: base, _count: { _all: true }, _sum: { expectedRevenue: true } }),
      // Each salesperson's figures for the period, counted the same way as the totals above.
      this.prisma.opportunity.groupBy({ by: ["ownerId"], where: inRange("createdAt"), _count: { _all: true } }),
      this.prisma.opportunity.groupBy({ by: ["ownerId"], where: inRange("wonAt"), _count: { _all: true }, _sum: { expectedRevenue: true } }),
      this.prisma.opportunity.groupBy({ by: ["ownerId"], where: inRange("lostAt"), _count: { _all: true } }),
    ]);

    const stages = await this.prisma.stage.findMany({ orderBy: { sequence: "asc" } });
    const ownerIds = [...owners, ...ownerLeads, ...ownerWon, ...ownerLost].map((o) => o.ownerId).filter((x): x is string => !!x);
    const users = await this.prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } });

    const pipelineValue = open.reduce((s, o) => s + Number(o.expectedRevenue ?? 0), 0);
    const weightedValue = open.reduce((s, o) => s + (Number(o.expectedRevenue ?? 0) * o.probability) / 100, 0);

    // open/won/lost/value: everything each person holds now; *InPeriod: leads created, deals won and lost in the period.
    type OwnerRow = { ownerId: string | null; name: string; open: number; won: number; lost: number; value: number; leadsInPeriod: number; wonInPeriod: number; lostInPeriod: number; wonValueInPeriod: number; winRate: number | null };
    const ownerMap = new Map<string, OwnerRow>();
    const ownerRow = (ownerId: string | null) => {
      const key = ownerId ?? "none";
      const row = ownerMap.get(key) ?? { ownerId, name: users.find((u) => u.id === ownerId)?.name ?? "Unassigned", open: 0, won: 0, lost: 0, value: 0, leadsInPeriod: 0, wonInPeriod: 0, lostInPeriod: 0, wonValueInPeriod: 0, winRate: null };
      ownerMap.set(key, row);
      return row;
    };
    for (const o of owners) {
      const row = ownerRow(o.ownerId);
      row[o.outcome] += o._count._all;
      if (o.outcome === "open") row.value += Number(o._sum.expectedRevenue ?? 0);
    }
    for (const o of ownerLeads) ownerRow(o.ownerId).leadsInPeriod = o._count._all;
    for (const o of ownerWon) Object.assign(ownerRow(o.ownerId), { wonInPeriod: o._count._all, wonValueInPeriod: Number(o._sum.expectedRevenue ?? 0) });
    for (const o of ownerLost) ownerRow(o.ownerId).lostInPeriod = o._count._all;
    for (const row of ownerMap.values()) row.winRate = pct(row.wonInPeriod, row.wonInPeriod + row.lostInPeriod);

    const [avgStage, avgActivation, supplierPerf, worldpay, outstandingDocs, complianceQueries, renewalsDue, commissions] = await Promise.all([
      this.averageTimeInStage(actor, f),
      this.averageDaysToActivation(actor, f),
      this.supplierPerformance(actor, f),
      this.worldpayApproval(actor, f),
      this.prisma.documentItem.count({ where: { required: true, received: false, opportunity: openWhere } }),
      this.prisma.opportunity.count({ where: { AND: [openWhere, { OR: [{ stage: { key: "compliance_query" } }, { merchantApps: { some: { risk: { complianceStatus: "query_raised" } } } }] }] } }),
      this.renewalsDue(actor, f),
      can(actor, "commission.read") ? this.commissions(actor, f) : Promise.resolve(null),
    ]);

    return {
      range: { from: r.fromIso, to: r.toIso },
      newLeads,
      leadsBySource: bySource.map((s) => ({ source: s.leadSource, count: s._count._all })).sort((a, b) => b.count - a.count),
      opportunitiesByStage: stages
        .map((s) => {
          const g = stageGroups.find((x) => x.stageId === s.id);
          return { key: s.key, name: s.name, count: g?._count._all ?? 0, value: Number(g?._sum.expectedRevenue ?? 0) };
        })
        .filter((s) => s.key !== "live_won"),
      opportunitiesBySalesperson: [...ownerMap.values()].sort((a, b) => b.wonInPeriod - a.wonInPeriod || b.leadsInPeriod - a.leadsInPeriod || b.open - a.open),
      opportunitiesByService: (["electricity", "gas", "dual_fuel", "merchant_services"] as const).map((s) => {
        const rows = byService.filter((x) => x.serviceType === s);
        const get = (o: string) => rows.find((x) => x.outcome === o)?._count._all ?? 0;
        return { serviceType: s, open: get("open"), won: get("won"), lost: get("lost") };
      }),
      won: wonInRange,
      lost: lostInRange,
      winRate: pct(wonInRange, wonInRange + lostInRange),
      conversionRate: pct(createdCohortWon, newLeads),
      pipelineValue,
      weightedPipelineValue: Math.round(weightedValue * 100) / 100,
      averageDaysInStage: avgStage,
      averageDaysToActivation: avgActivation,
      supplierPerformance: supplierPerf,
      worldpay,
      outstandingDocuments: outstandingDocs,
      complianceQueries,
      renewalsDue,
      commission: commissions,
    };
  }

  /** Visible opportunity ids as SQL, for raw aggregate queries. */
  private async visibleIds(actor: Actor, f: ReportFilter): Promise<string[] | null> {
    const where = this.base(actor, f);
    const unrestricted = can(actor, "opportunity.read_all") && !f.ownerId && !f.serviceType && !f.supplierId && !f.outcome;
    if (unrestricted) return null;
    return (await this.prisma.opportunity.findMany({ where, select: { id: true } })).map((o) => o.id);
  }

  private idFilter(ids: string[] | null, column: string) {
    if (ids === null) return Prisma.sql``;
    if (!ids.length) return Prisma.sql` AND false`;
    return Prisma.sql` AND ${Prisma.raw(column)} = ANY(${ids}::uuid[])`;
  }

  async averageTimeInStage(actor: Actor, f: ReportFilter) {
    const ids = await this.visibleIds(actor, f);
    const r = this.range(f);
    const rows = await this.prisma.$queryRaw<{ key: string; name: string; days: number; visits: bigint }[]>`
      SELECT s.key, s.name, AVG(EXTRACT(EPOCH FROM (h.left_at - h.entered_at)) / 86400)::float AS days, COUNT(*) AS visits
      FROM stage_history h JOIN stages s ON s.id = h.stage_id
      WHERE h.left_at IS NOT NULL AND h.left_at >= ${r.from} AND h.left_at < ${r.to} ${this.idFilter(ids, "h.opportunity_id")}
      GROUP BY s.key, s.name, s.sequence ORDER BY s.sequence`;
    return rows.map((x) => ({ key: x.key, name: x.name, days: Math.round(x.days * 10) / 10, visits: Number(x.visits) }));
  }

  async averageDaysToActivation(actor: Actor, f: ReportFilter) {
    const won = await this.prisma.opportunity.findMany({
      where: { AND: [this.base(actor, f), { outcome: "won", wonAt: { gte: this.range(f).from, lt: this.range(f).to } }] },
      select: { createdAt: true, wonAt: true },
    });
    if (!won.length) return null;
    const avg = won.reduce((s, o) => s + (o.wonAt!.getTime() - o.createdAt.getTime()), 0) / won.length / 86_400_000;
    return Math.round(avg * 10) / 10;
  }

  async supplierPerformance(actor: Actor, f: ReportFilter) {
    const groups = await this.prisma.opportunity.groupBy({
      by: ["selectedSupplierId", "outcome"],
      where: { AND: [this.base(actor, f), { selectedSupplierId: { not: null } }] },
      _count: { _all: true },
    });
    const suppliers = await this.prisma.supplier.findMany({ where: { id: { in: groups.map((g) => g.selectedSupplierId!) } } });
    return suppliers
      .map((s) => {
        const get = (o: string) => groups.find((g) => g.selectedSupplierId === s.id && g.outcome === o)?._count._all ?? 0;
        return { supplierId: s.id, name: s.name, kind: s.kind, open: get("open"), won: get("won"), lost: get("lost"), winRate: pct(get("won"), get("won") + get("lost")) };
      })
      .sort((a, b) => b.won - a.won);
  }

  async worldpayApproval(actor: Actor, f: ReportFilter) {
    const r = this.range(f);
    const apps = await this.prisma.merchantApplication.groupBy({
      by: ["status"],
      where: { submissionDate: { gte: dateOnly(r.fromIso), lte: dateOnly(r.toIso) }, opportunity: this.base(actor, f) },
      _count: { _all: true },
    });
    const get = (s: string) => apps.find((a) => a.status === s)?._count._all ?? 0;
    const approved = get("approved") + get("live");
    const declined = get("declined");
    const submitted = apps.reduce((s, a) => s + a._count._all, 0);
    return { submitted, approved, declined, pending: submitted - approved - declined, approvalRate: pct(approved, approved + declined) };
  }

  async renewalsDue(actor: Actor, f: ReportFilter) {
    const horizon = dateOnly(addDays(today(), 120));
    const [openRenewals, contractsEnding] = await Promise.all([
      this.prisma.opportunity.count({ where: { AND: [this.base(actor, f), { saleType: "renewal", outcome: "open", renewalDate: { lte: horizon } }] } }),
      this.prisma.opportunity.count({ where: { AND: [this.base(actor, f), { outcome: "won", renewalDate: { lte: horizon, gte: dateOnly(today()) }, renewals: { none: {} } }] } }),
    ]);
    return { openRenewals, contractsEndingWithoutRenewal: contractsEnding };
  }

  async commissions(actor: Actor, f: ReportFilter) {
    const rows = await this.prisma.commission.groupBy({ by: ["status"], where: { opportunity: this.base(actor, f) }, _sum: { amount: true } });
    const get = (s: string) => Number(rows.find((r) => r.status === s)?._sum.amount ?? 0);
    return { expected: get("expected"), confirmed: get("confirmed"), paid: get("paid"), clawedBack: get("clawed_back") };
  }

  /** Commission export for accounting (CSV). */
  /**
   * Outbound calls each person made today, this week (from Monday) and this month, Irish time:
   * click-to-calls, headset calls and calls from desk phones or the RingCentral app (call log).
   * "Connected" means the customer answered. report.read roles see everyone; others see themselves.
   */
  async callCounts(actor: Actor, now = new Date()) {
    const day = today(now);
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
    const starts = { today: day, week: addDays(day, -weekday), month: `${day.slice(0, 8)}01` };
    const from = { today: dublinDayStart(starts.today), week: dublinDayStart(starts.week), month: dublinDayStart(starts.month) };
    const earliest = from.week < from.month ? from.week : from.month;
    const everyone = can(actor, "report.read");
    const calls = await this.prisma.callLog.findMany({
      where: { direction: "outbound", userId: everyone ? { not: null } : actor.id, startedAt: { gte: earliest } },
      select: { userId: true, startedAt: true, status: true },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set([...calls.map((c) => c.userId!), ...(everyone ? [] : [actor.id])])] } }, select: { id: true, name: true } });
    const zero = (): CallCount => ({ made: 0, connected: 0 });
    const rows = new Map(users.map((u) => [u.id, { userId: u.id, name: u.name, today: zero(), week: zero(), month: zero() }]));
    const totals = { today: zero(), week: zero(), month: zero() };
    for (const c of calls) {
      const row = rows.get(c.userId!);
      if (!row) continue;
      for (const p of ["today", "week", "month"] as const) {
        if (c.startedAt < from[p]) continue;
        for (const t of [row[p], totals[p]]) {
          t.made++;
          if (c.status === "completed") t.connected++;
        }
      }
    }
    return {
      periods: starts,
      rows: [...rows.values()].sort((a, b) => b.today.made - a.today.made || b.week.made - a.week.made || b.month.made - a.month.made || a.name.localeCompare(b.name)),
      totals,
    };
  }

  async commissionCsv(actor: Actor, f: ReportFilter): Promise<string> {
    const rows = await this.prisma.commission.findMany({
      where: { opportunity: this.base(actor, f) },
      include: { opportunity: { include: { customer: true, owner: true, selectedSupplier: true } } },
      orderBy: { createdAt: "asc" },
    });
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      // Neutralise spreadsheet formulas and quote everything.
      return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
    };
    const header = ["Opportunity", "Customer", "Salesperson", "Service", "Supplier", "Status", "Amount", "Activation date", "Created"];
    const lines = rows.map((c) =>
      [
        `UO-${String(c.opportunity.number).padStart(6, "0")}`,
        c.opportunity.customer?.legalName ?? c.opportunity.companyName,
        c.opportunity.owner?.name,
        c.opportunity.serviceType,
        c.opportunity.selectedSupplier?.name,
        c.status,
        Number(c.amount).toFixed(2),
        c.opportunity.activationDate?.toISOString().slice(0, 10),
        c.createdAt.toISOString().slice(0, 10),
      ]
        .map(esc)
        .join(","),
    );
    return [header.map(esc).join(","), ...lines].join("\r\n");
  }

  stageNames() {
    return STAGES.map((s) => ({ key: s.key, name: s.name }));
  }
}
