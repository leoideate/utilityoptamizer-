import { Injectable, Logger } from "@nestjs/common";
import { type StageKey, addDays, missingInformation, outstandingDocuments, stagesBetween, today } from "@uo/shared";
import { ActivitiesService } from "../activities/activities.service";
import { AuditService } from "../audit/audit.service";
import { SYSTEM } from "../common/actor";
import { PrismaService } from "../common/prisma.service";
import { dateOnly, isoDay } from "../common/values";
import { NotificationsService } from "../notifications/notifications.service";
import { loadGateFacts } from "../opportunities/facts";
import { RenewalsService } from "./renewals.service";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Thresholds, in one place so they're easy to find and document. */
export const AUTOMATION_RULES = {
  firstContactAfterHours: 24,
  unansweredAfterHours: 4,
  documentChaseAfterDays: 3,
  signatureReminderAfterDays: 3,
  supplierFollowUpAfterDays: 5,
  worldpayFollowUpAfterDays: 2,
  documentExpiryWarningDays: 30,
} as const;

export interface AutomationReport {
  leadsAssigned: number;
  firstContact: number;
  unanswered: number;
  missingInformation: number;
  missingDocuments: number;
  signatureReminders: number;
  supplierFollowUps: number;
  worldpayFollowUps: number;
  activationDue: number;
  documentExpiry: number;
  renewalsCreated: number;
  renewalsSkipped: number;
}

/**
 * Background automations. Every step is idempotent: reminders use automation keys (at most
 * one open reminder per kind per opportunity, enforced by a unique index) and renewals use a
 * unique source key, so a job can be retried or run twice safely.
 */
@Injectable()
export class AutomationsService {
  private readonly log = new Logger(AutomationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly notifications: NotificationsService,
    private readonly renewals: RenewalsService,
    private readonly audit: AuditService,
  ) {}

  private open(keys: StageKey[], extra: object = {}) {
    return this.prisma.opportunity.findMany({ where: { outcome: "open", stage: { key: { in: keys } }, ...extra }, include: { stage: true } });
  }

  async runAll(now = new Date()): Promise<AutomationReport> {
    const asOf = today(now);
    const report: AutomationReport = {
      leadsAssigned: await this.assignNewLeads(),
      firstContact: await this.firstContactReminders(now),
      unanswered: await this.unansweredMessages(now),
      missingInformation: await this.missingInformation(asOf),
      missingDocuments: await this.missingDocuments(asOf, now),
      signatureReminders: await this.signatureReminders(asOf, now),
      supplierFollowUps: await this.submissionFollowUps(asOf, now, "energy"),
      worldpayFollowUps: await this.submissionFollowUps(asOf, now, "merchant"),
      activationDue: await this.activationDue(asOf),
      documentExpiry: await this.documentExpiry(asOf),
      renewalsCreated: 0,
      renewalsSkipped: 0,
    };
    const r = await this.renewals.run(asOf);
    report.renewalsCreated = r.created.length;
    report.renewalsSkipped = r.skipped.length;
    this.log.log({ report }, "Automations run complete");
    return report;
  }

  /** Unassigned new leads go to the active salesperson with the fewest open opportunities. */
  async assignNewLeads(): Promise<number> {
    const setting = await this.prisma.setting.findUnique({ where: { key: "automation.autoAssignLeads" } });
    if (setting && setting.value === false) return 0;
    const leads = await this.open(["new_lead"], { ownerId: null });
    let n = 0;
    for (const lead of leads) {
      const people = await this.prisma.user.findMany({
        where: { active: true, roles: { some: { role: "salesperson" } }, ...(lead.teamId ? { teamId: lead.teamId } : {}) },
        select: { id: true, name: true, _count: { select: { ownedOpps: { where: { outcome: "open" } } } } },
      });
      if (!people.length) break;
      people.sort((a, b) => a._count.ownedOpps - b._count.ownedOpps || a.id.localeCompare(b.id));
      const owner = people[0];
      // Conditional update: skip if someone assigned it meanwhile.
      const { count } = await this.prisma.opportunity.updateMany({ where: { id: lead.id, ownerId: null }, data: { ownerId: owner.id } });
      if (!count) continue;
      await this.prisma.$transaction(async (tx) => {
        await this.audit.record(
          SYSTEM,
          { action: "opportunity.assign", entityType: "opportunity", entityId: lead.id, summary: `Auto-assigned to ${owner.name}` },
          { opportunityId: lead.id, customerId: lead.customerId, kind: "assignment", body: `Automatically assigned to ${owner.name}.` },
          tx,
        );
        await this.activities.ensureAutomated(tx, { opportunityId: lead.id, customerId: lead.customerId, type: "call", summary: "Make first contact", dueDate: today(), priority: "high", ownerId: owner.id, automationKey: "first_contact" });
      });
      n++;
    }
    return n;
  }

  /** Leads not contacted within 24 hours of creation. */
  async firstContactReminders(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - AUTOMATION_RULES.firstContactAfterHours * HOUR);
    const leads = await this.open(["new_lead", "call_scheduled"], { firstContactAt: null, createdAt: { lt: cutoff }, ownerId: { not: null } });
    let n = 0;
    for (const o of leads) {
      if (
        await this.activities.ensureAutomated(this.prisma, {
          opportunityId: o.id,
          customerId: o.customerId,
          type: "call",
          summary: "First contact overdue: call this lead today",
          dueDate: today(now),
          priority: "urgent",
          ownerId: o.ownerId,
          automationKey: "first_contact_overdue",
        })
      )
        n++;
    }
    return n;
  }

  /** Inbound emails/WhatsApp messages with no outbound reply after 4 hours. */
  async unansweredMessages(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - AUTOMATION_RULES.unansweredAfterHours * HOUR);
    const inbound = await this.prisma.timelineEntry.findMany({
      where: { kind: { in: ["email", "whatsapp"] }, direction: "inbound", occurredAt: { lt: cutoff, gt: new Date(now.getTime() - 14 * DAY) }, opportunityId: { not: null } },
      orderBy: { occurredAt: "desc" },
      distinct: ["opportunityId"],
    });
    let n = 0;
    for (const msg of inbound) {
      const replied = await this.prisma.timelineEntry.findFirst({
        where: { opportunityId: msg.opportunityId, kind: { in: ["email", "whatsapp", "call"] }, direction: "outbound", occurredAt: { gt: msg.occurredAt } },
      });
      if (replied) {
        await this.activities.completeAutomated(this.prisma, msg.opportunityId!, "reply_needed");
        continue;
      }
      const opp = await this.prisma.opportunity.findUnique({ where: { id: msg.opportunityId! } });
      if (!opp || opp.outcome === "lost") continue;
      if (
        await this.activities.ensureAutomated(this.prisma, {
          opportunityId: opp.id,
          customerId: opp.customerId,
          type: msg.kind === "whatsapp" ? "whatsapp" : "email",
          summary: `Reply to the customer's ${msg.kind === "whatsapp" ? "WhatsApp message" : "email"}`,
          dueDate: today(now),
          priority: "high",
          ownerId: opp.ownerId,
          automationKey: "reply_needed",
        })
      )
        n++;
    }
    return n;
  }

  async missingInformation(asOf: string): Promise<number> {
    let n = 0;
    for (const o of await this.open(stagesBetween("details_requested", "client_reviewing"))) {
      const missing = missingInformation(await loadGateFacts(this.prisma, o.id));
      if (!missing.length) {
        await this.activities.completeAutomated(this.prisma, o.id, "missing_information");
        continue;
      }
      if (
        await this.activities.ensureAutomated(this.prisma, {
          opportunityId: o.id,
          customerId: o.customerId,
          type: "request_documents",
          summary: `Missing information: ${missing.join(", ")}`,
          dueDate: asOf,
          ownerId: o.ownerId,
          automationKey: "missing_information",
        })
      )
        n++;
    }
    return n;
  }

  /** Required documents outstanding 3+ days after they were requested (or never requested). */
  async missingDocuments(asOf: string, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - AUTOMATION_RULES.documentChaseAfterDays * DAY);
    let n = 0;
    for (const o of await this.open(stagesBetween("details_requested", "internal_review"))) {
      const docs = await this.prisma.documentItem.findMany({ where: { opportunityId: o.id } });
      const missing = outstandingDocuments({ documents: docs.map((d) => ({ ...d })) }).filter((d) => {
        const row = docs.find((x) => x.documentType === d.documentType)!;
        return !row.requestedAt || row.requestedAt < cutoff;
      });
      if (!missing.length) {
        if (!outstandingDocuments({ documents: docs }).length) await this.activities.completeAutomated(this.prisma, o.id, "missing_documents");
        continue;
      }
      if (
        await this.activities.ensureAutomated(this.prisma, {
          opportunityId: o.id,
          customerId: o.customerId,
          type: "request_documents",
          summary: `Chase ${missing.length} outstanding document${missing.length === 1 ? "" : "s"}`,
          dueDate: asOf,
          ownerId: o.ownerId,
          automationKey: "missing_documents",
        })
      )
        n++;
    }
    return n;
  }

  async signatureReminders(asOf: string, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - AUTOMATION_RULES.signatureReminderAfterDays * DAY);
    const pending = await this.prisma.signatureRequest.findMany({
      where: { status: { in: ["sent", "partially_signed"] }, requestedAt: { lt: cutoff }, OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: cutoff } }] },
      include: { opportunity: true },
    });
    let n = 0;
    for (const s of pending) {
      if (s.opportunity.outcome !== "open") continue;
      const created = await this.activities.ensureAutomated(this.prisma, {
        opportunityId: s.opportunityId,
        customerId: s.opportunity.customerId,
        type: "obtain_signature",
        summary: `Signature still outstanding: ${s.title}`,
        dueDate: asOf,
        priority: "high",
        ownerId: s.opportunity.ownerId,
        automationKey: "signature_reminder",
      });
      await this.prisma.signatureRequest.update({ where: { id: s.id }, data: { lastReminderAt: now } });
      if (created) n++;
    }
    return n;
  }

  /** Energy: chase the supplier after 5 days. Worldpay: chase after 2 days (compliance queries move fast). */
  async submissionFollowUps(asOf: string, now: Date, kind: "energy" | "merchant"): Promise<number> {
    const days = kind === "energy" ? AUTOMATION_RULES.supplierFollowUpAfterDays : AUTOMATION_RULES.worldpayFollowUpAfterDays;
    const cutoff = new Date(now.getTime() - days * DAY);
    const opps = await this.open(["submitted", "compliance_query", "awaiting_confirmation"], {
      stageEnteredAt: { lt: cutoff },
      serviceType: kind === "energy" ? { in: ["electricity", "gas", "dual_fuel"] } : "merchant_services",
    });
    let n = 0;
    for (const o of opps) {
      const owner = (await this.activities.leastLoaded(this.prisma, "operations")) ?? o.ownerId;
      if (
        await this.activities.ensureAutomated(this.prisma, {
          opportunityId: o.id,
          customerId: o.customerId,
          type: kind === "energy" ? "follow_up_supplier" : "follow_up_worldpay",
          summary: kind === "energy" ? `Follow up with the supplier (${o.stage.name})` : `Follow up with Worldpay (${o.stage.name})`,
          dueDate: asOf,
          ownerId: owner,
          automationKey: "submission_follow_up",
        })
      )
        n++;
    }
    return n;
  }

  /** The proposed activation date has passed: ask Operations to confirm activation. */
  async activationDue(asOf: string): Promise<number> {
    const opps = await this.open(["submitted", "awaiting_confirmation"], {
      contracts: { some: { proposedActivationDate: { lte: dateOnly(asOf) }, status: { in: ["submitted", "signed"] } } },
    });
    let n = 0;
    for (const o of opps) {
      const owner = (await this.activities.leastLoaded(this.prisma, "operations")) ?? o.ownerId;
      if (
        await this.activities.ensureAutomated(this.prisma, {
          opportunityId: o.id,
          customerId: o.customerId,
          type: "follow_up_supplier",
          summary: "Confirm activation with the supplier and record it",
          dueDate: asOf,
          priority: "high",
          ownerId: owner,
          automationKey: "activation_due",
        })
      )
        n++;
    }
    return n;
  }

  /** Approved documents expiring within 30 days (e.g. photo ID) on open or live deals. */
  async documentExpiry(asOf: string): Promise<number> {
    const items = await this.prisma.documentItem.findMany({
      where: { approval: "approved", expiryDate: { gte: dateOnly(asOf), lte: dateOnly(addDays(asOf, AUTOMATION_RULES.documentExpiryWarningDays)) }, opportunity: { outcome: { not: "lost" } } },
      include: { opportunity: true },
    });
    let n = 0;
    for (const d of items) {
      if (
        await this.activities.ensureAutomated(this.prisma, {
          opportunityId: d.opportunityId,
          customerId: d.customerId,
          type: "request_documents",
          summary: `Document expires on ${isoDay(d.expiryDate)}: request a new copy`,
          dueDate: asOf,
          ownerId: d.opportunity.ownerId,
          automationKey: `document_expiry:${d.id}`,
        })
      )
        n++;
    }
    return n;
  }

  /** Called by the hourly job: reminders → notifications, expired sessions. */
  async hourly(now = new Date()) {
    const reminders = await this.activities.sendDueReminders(now);
    const sessions = (await this.prisma.session.deleteMany({ where: { expiresAt: { lt: now } } })).count;
    return { reminders, sessions };
  }
}
