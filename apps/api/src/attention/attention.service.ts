import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ATTENTION_LIMIT, type AttentionCounts, MIN_STUCK_DAYS, STUCK_AFTER_DAYS, type Role, type StageKey, attentionSummary, daysAtStage, daysBetween, isStuck, opportunityListQuerySchema, today } from "@uo/shared";
import type { Actor } from "../common/actor";
import { PrismaService } from "../common/prisma.service";
import { dateOnly, isoDay } from "../common/values";
import { NotificationsService } from "../notifications/notifications.service";
import { OpportunityAccess } from "../opportunities/access.service";
import { OpportunitiesService } from "../opportunities/opportunities.service";

const DAY = 86_400_000;

export interface AttentionItem {
  /** The opportunity's id, or the task's when it isn't on a deal. */
  id: string;
  number: number | null;
  name: string;
  stage: string | null;
  /** Stuck: days at the stage. Tasks and follow-ups: days overdue (0 = today). Renewals: days until the renewal date (negative once passed). */
  days: number;
  link: string;
  /** Tasks only: what to do. */
  summary?: string;
}

export interface AttentionList {
  items: AttentionItem[];
  total: number;
}

export interface Attention {
  stuck: AttentionList;
  overdueTasks: AttentionList;
  followUps: AttentionList;
  renewals: AttentionList;
}

const oppSelect = { id: true, number: true, name: true, stage: { select: { key: true, name: true } } } satisfies Prisma.OpportunitySelect;
type OppRow = Prisma.OpportunityGetPayload<{ select: typeof oppSelect }>;
const item = (o: OppRow, days: number): AttentionItem => ({ id: o.id, number: o.number, name: o.name, stage: o.stage.name, days, link: `/opportunities/${o.id}` });

/** "Needs your attention" on Home and the morning summary notification. The rules are in `@uo/shared` (attention.ts). */
@Injectable()
export class AttentionService {
  private readonly log = new Logger(AttentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly opportunities: OpportunitiesService,
    private readonly notifications: NotificationsService,
  ) {}

  async forUser(actor: Actor, now = new Date()): Promise<Attention> {
    const asOf = today(now);
    const visible = this.access.visibleWhere(actor);
    const [stuck, overdueTasks, followUps, renewals] = await Promise.all([
      this.stuck(visible, now),
      this.overdueTasks(actor, asOf),
      this.followUps(visible, asOf),
      this.renewals(actor, asOf),
    ]);
    return { stuck, overdueTasks, followUps, renewals };
  }

  /** Whether the user gets the morning summary (Account page). */
  async morningSummaryEnabled(actor: Actor) {
    return (await this.prisma.user.findUnique({ where: { id: actor.id }, select: { morningSummary: true } }))?.morningSummary ?? false;
  }

  async setMorningSummary(actor: Actor, enabled: boolean) {
    await this.prisma.user.update({ where: { id: actor.id }, data: { morningSummary: enabled } });
    return { enabled };
  }

  private async stuck(visible: Prisma.OpportunityWhereInput, now: Date): Promise<AttentionList> {
    const stages = (Object.entries(STUCK_AFTER_DAYS) as [StageKey, number | null][]).filter(([, d]) => d !== null).map(([k]) => k);
    // Narrowed by the shortest limit here, then each stage's own limit in isStuck.
    const candidates = await this.prisma.opportunity.findMany({
      where: { AND: [visible, { outcome: "open", stage: { key: { in: stages } }, stageEnteredAt: { lt: new Date(now.getTime() - MIN_STUCK_DAYS * DAY) }, activities: { none: { status: "open" } } }] },
      orderBy: { stageEnteredAt: "asc" },
      select: { ...oppSelect, outcome: true, stageEnteredAt: true },
    });
    const rows = candidates.filter((o) => isStuck({ stage: o.stage.key as StageKey, outcome: o.outcome, stageEnteredAt: o.stageEnteredAt, hasOpenActivity: false }, now));
    return { items: rows.slice(0, ATTENTION_LIMIT).map((o) => item(o, daysAtStage(o.stageEnteredAt, now))), total: rows.length };
  }

  private async overdueTasks(actor: Actor, asOf: string): Promise<AttentionList> {
    const where: Prisma.ActivityWhereInput = { ownerId: actor.id, status: "open", dueDate: { lt: dateOnly(asOf) } };
    const [rows, total] = await Promise.all([
      this.prisma.activity.findMany({ where, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }], take: ATTENTION_LIMIT, include: { opportunity: { select: oppSelect } } }),
      this.prisma.activity.count({ where }),
    ]);
    return {
      items: rows.map((a) => ({
        ...(a.opportunity ? item(a.opportunity, 0) : { id: a.id, number: null, name: a.summary, stage: null, link: "/activities" }),
        days: daysBetween(isoDay(a.dueDate)!, asOf),
        summary: a.summary,
      })),
      total,
    };
  }

  private async followUps(visible: Prisma.OpportunityWhereInput, asOf: string): Promise<AttentionList> {
    const where: Prisma.OpportunityWhereInput = { AND: [visible, { outcome: "open", followUpDate: { lte: dateOnly(asOf) } }] };
    const [rows, total] = await Promise.all([
      this.prisma.opportunity.findMany({ where, orderBy: [{ followUpDate: "asc" }, { number: "asc" }], take: ATTENTION_LIMIT, select: { ...oppSelect, followUpDate: true } }),
      this.prisma.opportunity.count({ where }),
    ]);
    return { items: rows.map((o) => item(o, daysBetween(isoDay(o.followUpDate)!, asOf))), total };
  }

  private async renewals(actor: Actor, asOf: string): Promise<AttentionList> {
    const where = this.opportunities.viewWhere(actor, opportunityListQuerySchema.parse({ view: "renewals_due" }));
    const [rows, total] = await Promise.all([
      this.prisma.opportunity.findMany({ where, orderBy: [{ renewalDate: "asc" }, { number: "asc" }], take: ATTENTION_LIMIT, select: { ...oppSelect, renewalDate: true } }),
      this.prisma.opportunity.count({ where }),
    ]);
    return { items: rows.map((o) => item(o, daysBetween(asOf, isoDay(o.renewalDate)!))), total };
  }

  /**
   * The 07:30 job: one notification per active user who has something needing attention and
   * hasn't switched the summary off. The digest row (unique per user and Irish day) is written in
   * the same transaction as the notification, so a retried or repeated run sends nothing new.
   */
  async morningSummary(now = new Date()) {
    const asOf = today(now);
    const users = await this.prisma.user.findMany({
      where: { active: true, morningSummary: true, attentionDigests: { none: { day: dateOnly(asOf) } } },
      select: { id: true, name: true, roles: { select: { role: true } } },
    });
    let sent = 0;
    for (const u of users) {
      const actor: Actor = { id: u.id, name: u.name, roles: u.roles.map((r) => r.role as Role) };
      const a = await this.forUser(actor, now);
      const counts: AttentionCounts = { stuck: a.stuck.total, overdueTasks: a.overdueTasks.total, followUps: a.followUps.total, renewals: a.renewals.total };
      const body = attentionSummary(counts);
      if (!body) continue;
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.attentionDigest.create({ data: { userId: u.id, day: dateOnly(asOf), counts: { ...counts } } });
          await this.notifications.notify(u.id, { title: "Needs your attention today", body, link: "/" }, tx);
        });
        sent++;
      } catch (e) {
        // Another run got there first.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
        throw e;
      }
    }
    this.log.log({ sent, day: asOf }, "Morning summary sent");
    return { sent };
  }
}
