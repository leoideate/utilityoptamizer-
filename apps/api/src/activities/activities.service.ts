import { Injectable } from "@nestjs/common";
import type { ActivityType, Prisma, Priority, Role } from "@prisma/client";
import { type ActivityInput, can, canReadOpportunity, today } from "@uo/shared";
import { AuditService } from "../audit/audit.service";
import { type Actor, actorRef } from "../common/actor";
import { Forbidden, NotFound } from "../common/errors";
import type { Db } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";
import { type Page, dateOnly, pageArgs } from "../common/values";
import { NotificationsService } from "../notifications/notifications.service";

export interface AutomatedActivity {
  opportunityId: string;
  customerId?: string | null;
  type: ActivityType;
  summary: string;
  note?: string | null;
  dueDate: string;
  priority?: Priority;
  ownerId: string | null;
  automationKey: string;
}

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Creates the reminder unless an open one with the same key exists for the opportunity.
   * A partial unique index backs this up if two jobs race. Returns true when created.
   */
  async ensureAutomated(db: Db, a: AutomatedActivity): Promise<boolean> {
    const existing = await db.activity.findFirst({ where: { opportunityId: a.opportunityId, automationKey: a.automationKey, status: "open" }, select: { id: true } });
    if (existing) return false;
    try {
      await db.activity.create({
        data: {
          opportunityId: a.opportunityId,
          customerId: a.customerId ?? null,
          type: a.type,
          summary: a.summary,
          note: a.note ?? null,
          dueDate: dateOnly(a.dueDate),
          priority: a.priority ?? "normal",
          ownerId: a.ownerId,
          automationKey: a.automationKey,
          reminderAt: dateOnly(a.dueDate),
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return false;
      throw e;
    }
    await this.notifications.notify(a.ownerId, { title: a.summary, link: `/opportunities/${a.opportunityId}` }, db);
    return true;
  }

  async completeAutomated(db: Db, opportunityId: string, automationKey: string) {
    await db.activity.updateMany({ where: { opportunityId, automationKey, status: "open" }, data: { status: "done", completedAt: new Date() } });
  }

  /** Active user with `role` holding the fewest open activities (spreads the work). */
  async leastLoaded(db: Db, role: Role): Promise<string | null> {
    const users = await db.user.findMany({
      where: { active: true, roles: { some: { role } } },
      select: { id: true, _count: { select: { activities: { where: { status: "open" } } } } },
      orderBy: { createdAt: "asc" },
    });
    users.sort((a, b) => a._count.activities - b._count.activities);
    return users[0]?.id ?? null;
  }

  // --- User-facing CRUD -----------------------------------------------------

  private async checkLinks(actor: Actor, opportunityId?: string | null) {
    if (!opportunityId) return null;
    const opp = await this.prisma.opportunity.findUnique({ where: { id: opportunityId } });
    if (!opp || !canReadOpportunity(actor, { ownerId: opp.ownerId })) throw new NotFound("Opportunity");
    return opp;
  }

  async create(actor: Actor, input: ActivityInput) {
    const opp = await this.checkLinks(actor, input.opportunityId);
    const ownerId = input.ownerId ?? actor.id;
    if (ownerId !== actor.id && !can(actor, "opportunity.write_all")) throw new Forbidden("You can only schedule activities for yourself.");
    const act = await this.prisma.activity.create({
      data: {
        type: input.type,
        summary: input.summary,
        note: input.note ?? null,
        dueDate: dateOnly(input.dueDate),
        priority: input.priority,
        reminderAt: input.reminderAt ? new Date(input.reminderAt) : null,
        ownerId,
        opportunityId: input.opportunityId ?? null,
        customerId: input.customerId ?? opp?.customerId ?? null,
        createdById: actorRef(actor),
      },
    });
    if (opp) {
      await this.audit.timeline(actor, { opportunityId: opp.id, customerId: opp.customerId, kind: "activity", body: `Scheduled: ${input.summary} (due ${input.dueDate}).`, data: { activityId: act.id } });
    }
    if (ownerId !== actor.id) await this.notifications.notify(ownerId, { title: `New task: ${input.summary}`, link: opp ? `/opportunities/${opp.id}` : "/activities" });
    return act;
  }

  private async owned(actor: Actor, id: string) {
    const a = await this.prisma.activity.findUnique({ where: { id } });
    if (!a) throw new NotFound("Activity");
    if (a.ownerId !== actor.id && !can(actor, "opportunity.write_all")) throw new Forbidden("This activity belongs to someone else.");
    return a;
  }

  async update(actor: Actor, id: string, patch: Partial<ActivityInput>) {
    await this.owned(actor, id);
    return this.prisma.activity.update({
      where: { id },
      data: {
        summary: patch.summary,
        note: patch.note,
        priority: patch.priority,
        type: patch.type,
        dueDate: patch.dueDate ? dateOnly(patch.dueDate) : undefined,
        reminderAt: patch.reminderAt === undefined ? undefined : patch.reminderAt ? new Date(patch.reminderAt) : null,
        reminderSentAt: patch.reminderAt !== undefined ? null : undefined,
        ownerId: patch.ownerId && can(actor, "opportunity.write_all") ? patch.ownerId : undefined,
      },
    });
  }

  async complete(actor: Actor, id: string, outcomeNote?: string | null) {
    const a = await this.owned(actor, id);
    if (a.status !== "open") return a;
    const done = await this.prisma.activity.update({ where: { id }, data: { status: "done", completedAt: new Date() } });
    if (a.opportunityId) {
      await this.audit.timeline(actor, {
        opportunityId: a.opportunityId,
        customerId: a.customerId,
        kind: "activity",
        body: `Completed: ${a.summary}${outcomeNote ? ` — ${outcomeNote}` : ""}`,
        data: { activityId: a.id },
      });
      if (a.type === "call") await this.prisma.opportunity.update({ where: { id: a.opportunityId }, data: { lastContactAt: new Date() } });
    }
    return done;
  }

  async cancel(actor: Actor, id: string) {
    await this.owned(actor, id);
    return this.prisma.activity.update({ where: { id }, data: { status: "cancelled" } });
  }

  async list(actor: Actor, q: { scope: "mine" | "team"; status?: "open" | "done" | "cancelled"; due?: "overdue" | "today" | "week"; opportunityId?: string; page: number; pageSize: number }): Promise<Page<unknown>> {
    const t = today();
    const where: Prisma.ActivityWhereInput = {
      status: q.status ?? "open",
      ...(q.scope === "mine" || !can(actor, "opportunity.read_all") ? { ownerId: actor.id } : {}),
      ...(q.opportunityId ? { opportunityId: q.opportunityId } : {}),
      ...(q.due === "overdue" ? { dueDate: { lt: dateOnly(t) } } : {}),
      ...(q.due === "today" ? { dueDate: dateOnly(t) } : {}),
      ...(q.due === "week" ? { dueDate: { lte: dateOnly(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)) } } : {}),
    };
    if (q.opportunityId) {
      await this.checkLinks(actor, q.opportunityId);
      delete where.ownerId;
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.activity.findMany({
        where,
        orderBy: [{ dueDate: "asc" }, { priority: "desc" }],
        ...pageArgs(q.page, q.pageSize),
        include: { owner: { select: { id: true, name: true } }, opportunity: { select: { id: true, number: true, name: true } } },
      }),
      this.prisma.activity.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Background job: turns due reminders into notifications (once each). */
  async sendDueReminders(now = new Date()): Promise<number> {
    const due = await this.prisma.activity.findMany({ where: { status: "open", reminderAt: { lte: now }, reminderSentAt: null, ownerId: { not: null } }, take: 500 });
    for (const a of due) {
      await this.prisma.$transaction(async (tx) => {
        await this.notifications.notify(a.ownerId, { title: `Reminder: ${a.summary}`, link: a.opportunityId ? `/opportunities/${a.opportunityId}` : "/activities" }, tx);
        await tx.activity.update({ where: { id: a.id }, data: { reminderSentAt: now } });
      });
    }
    return due.length;
  }
}
