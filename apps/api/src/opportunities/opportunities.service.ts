import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  type CreateOpportunityInput,
  type OpportunityListQuery,
  type StageKey,
  type UpdateOpportunityInput,
  STAGES,
  SUPPLY_CHANGE_LABELS,
  addDays,
  addMonths,
  can,
  canWriteOpportunity,
  isAtOrAfter,
  stageDef,
  stageGateIssues,
  today,
} from "@uo/shared";
import { AuditService } from "../audit/audit.service";
import { type Actor, actorRef } from "../common/actor";
import { Forbidden, RuleViolation, assertRules } from "../common/errors";
import type { Tx } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";
import { type Page, dateOnly, defined, isoDay, pageArgs, phoneKey } from "../common/values";
import { ActivitiesService } from "../activities/activities.service";
import { DocumentsService } from "../documents/documents.service";
import { NotificationsService } from "../notifications/notifications.service";
import { OpportunityAccess, type OppWithStage } from "./access.service";
import { loadGateFacts } from "./facts";
import { StagesService } from "./stages.service";

const OPEN_STAGES_AFTER_SUBMISSION: StageKey[] = ["submitted", "compliance_query", "awaiting_confirmation"];
const RENEWAL_WINDOW_DAYS = 120;

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly stages: StagesService,
    private readonly audit: AuditService,
    private readonly activities: ActivitiesService,
    private readonly notifications: NotificationsService,
    private readonly documents: DocumentsService,
  ) {}

  // -------------------------------------------------------------------------
  // Create / update
  // -------------------------------------------------------------------------

  /** Only a name and service type are required, so leads can be captured in seconds. */
  async create(actor: Actor, input: CreateOpportunityInput, db: PrismaService | Tx = this.prisma): Promise<{ id: string }> {
    if (!can(actor, "opportunity.create")) throw new Forbidden();
    let ownerId: string | null = actor.roles.includes("salesperson") ? actor.id : null;
    if (input.ownerId !== undefined && can(actor, "opportunity.assign")) ownerId = input.ownerId;
    if (input.customerId) await this.access.linkableCustomer(actor, input.customerId, db);
    const stageId = await this.stages.idFor("new_lead", db);

    const run = async (tx: Tx) => {
      const opp = await tx.opportunity.create({
        data: {
          name: input.name,
          serviceType: input.serviceType,
          saleType: input.saleType,
          customerId: input.customerId ?? null,
          contactName: input.contactName ?? null,
          companyName: input.companyName ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          leadSource: input.leadSource,
          leadSourceDetail: input.leadSourceDetail ?? null,
          campaign: input.campaign ?? null,
          expectedRevenue: input.expectedRevenue ?? null,
          nextAction: input.nextAction ?? null,
          followUpDate: dateOnly(input.followUpDate) ?? null,
          expectedCloseDate: dateOnly(input.expectedCloseDate) ?? null,
          visitDate: dateOnly(input.visitDate) ?? null,
          contactRole: input.contactRole ?? null,
          productInterest: input.productInterest ?? [],
          supplyChanges: input.supplyChanges ?? [],
          ownerId,
          teamId: input.teamId ?? null,
          stageId,
          probability: stageDef("new_lead").probability,
          createdById: actorRef(actor),
        },
      });
      await tx.stageHistory.create({ data: { opportunityId: opp.id, stageId, userId: actorRef(actor) } });
      await this.audit.record(
        actor,
        { action: "opportunity.create", entityType: "opportunity", entityId: opp.id, summary: `Created opportunity ${opp.name}`, data: { serviceType: opp.serviceType, leadSource: opp.leadSource } },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "system", body: `Opportunity created (${input.leadSource.replace("_", " ")}).` },
        tx,
      );
      if (ownerId) {
        await this.activities.ensureAutomated(tx, {
          opportunityId: opp.id,
          customerId: opp.customerId,
          type: "call",
          summary: "Make first contact",
          dueDate: input.followUpDate ?? today(),
          priority: "high",
          ownerId,
          automationKey: "first_contact",
        });
      }
      return { id: opp.id };
    };
    return "$transaction" in db ? (db as PrismaService).$transaction(run) : run(db as Tx);
  }

  async update(actor: Actor, id: string, patch: UpdateOpportunityInput) {
    const opp = await this.access.writable(actor, id);
    const issues: string[] = [];
    if (opp.outcome === "won" && patch.serviceType && patch.serviceType !== opp.serviceType) issues.push("The service type of a won opportunity can't be changed.");
    if (patch.serviceType && patch.serviceType !== opp.serviceType) {
      const [sites, apps] = await Promise.all([
        this.prisma.supplySite.count({ where: { opportunityId: id } }),
        this.prisma.merchantApplication.count({ where: { opportunityId: id } }),
      ]);
      if (patch.serviceType === "merchant_services" && sites) issues.push("Remove the supply sites before switching to Worldpay.");
      if (patch.serviceType !== "merchant_services" && apps) issues.push("This opportunity has a Worldpay application, so it can't become an energy opportunity.");
    }
    if (patch.selectedSupplierId) {
      const s = await this.prisma.supplier.findUnique({ where: { id: patch.selectedSupplierId } });
      if (!s) issues.push("Choose a supplier from the list.");
    }
    assertRules(issues);

    const data = defined({ ...patch, followUpDate: dateOnly(patch.followUpDate), expectedCloseDate: dateOnly(patch.expectedCloseDate), visitDate: dateOnly(patch.visitDate) });
    const changed = Object.keys(data).filter((k) => String((opp as Record<string, unknown>)[k] ?? "") !== String((data as Record<string, unknown>)[k] ?? ""));
    if (!changed.length) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.opportunity.update({ where: { id }, data });
      await this.audit.log(actor, { action: "opportunity.update", entityType: "opportunity", entityId: id, summary: `Updated ${changed.join(", ")}`, data: { fields: changed } }, tx);
      if (patch.selectedSupplierId && patch.selectedSupplierId !== opp.selectedSupplierId) {
        // Contracts not yet signed follow the opportunity's chosen supplier.
        await tx.energyContract.updateMany({ where: { opportunityId: id, status: { in: ["draft", "quoted", "selected"] } }, data: { selectedSupplierId: patch.selectedSupplierId } });
        const s = await tx.supplier.findUniqueOrThrow({ where: { id: patch.selectedSupplierId } });
        await this.audit.timeline(actor, { opportunityId: id, customerId: opp.customerId, kind: "system", body: `Selected supplier: ${s.name}.` }, tx);
      }
      if (changed.includes("supplyChanges")) {
        const changes = patch.supplyChanges ?? [];
        await this.audit.timeline(actor, { opportunityId: id, customerId: opp.customerId, kind: "system", body: changes.length ? `Supply changes: ${changes.map((c) => SUPPLY_CHANGE_LABELS[c]).join(", ")}.` : "Supply changes cleared." }, tx);
        // Once the checklist exists, keep it in step with what the supply changes require.
        if (opp.stageKey && isAtOrAfter(opp.stageKey, "details_requested")) {
          const added = await this.documents.ensureStandardChecklist(tx, { ...opp, serviceType: patch.serviceType ?? opp.serviceType, supplyChanges: changes });
          if (added) await this.audit.timeline(actor, { opportunityId: id, customerId: opp.customerId, kind: "document", body: `Added ${added} document${added === 1 ? "" : "s"} the supply changes require.` }, tx);
        }
      }
    });
  }

  async assign(actor: Actor, id: string, ownerId: string | null) {
    const opp = await this.access.readable(actor, id);
    const selfClaim = opp.ownerId === null && ownerId === actor.id && actor.roles.includes("salesperson");
    if (!selfClaim && !can(actor, "opportunity.assign")) throw new Forbidden("Only a manager can assign opportunities.");
    if (ownerId === null && opp.outcome === "won") throw new RuleViolation(["A won opportunity keeps its salesperson."]);
    if (ownerId) {
      const u = await this.prisma.user.findUnique({ where: { id: ownerId }, include: { roles: true } });
      if (!u?.active) throw new RuleViolation(["Choose an active user."]);
    }
    if (ownerId === opp.ownerId) return;
    const owner = ownerId ? await this.prisma.user.findUniqueOrThrow({ where: { id: ownerId } }) : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.opportunity.update({ where: { id }, data: { ownerId } });
      await this.audit.record(
        actor,
        { action: "opportunity.assign", entityType: "opportunity", entityId: id, summary: `Assigned to ${owner?.name ?? "nobody"}`, data: { from: opp.ownerId, to: ownerId } },
        { opportunityId: id, customerId: opp.customerId, kind: "assignment", body: owner ? `Assigned to ${owner.name}.` : "Unassigned." },
        tx,
      );
      if (ownerId && ownerId !== actor.id) {
        await this.notifications.notify(ownerId, { title: `New opportunity assigned: ${opp.name}`, link: `/opportunities/${id}` }, tx);
      }
      if (ownerId && opp.outcome === "open" && opp.stageKey === "new_lead") {
        await this.activities.ensureAutomated(tx, { opportunityId: id, customerId: opp.customerId, type: "call", summary: "Make first contact", dueDate: today(), priority: "high", ownerId, automationKey: "first_contact" });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Stage changes
  // -------------------------------------------------------------------------

  /** Enforced by the server for every caller (UI, API, automations). */
  async moveStage(actor: Actor, id: string, target: StageKey) {
    const opp = await this.access.writable(actor, id);
    if (target === "live_won") throw new RuleViolation(["Use Activate to move an opportunity to Live / Won."]);
    if (opp.outcome === "won") throw new RuleViolation(["This opportunity is Live / Won. A manager can reopen it if it needs to change."]);
    if (opp.outcome === "lost") throw new RuleViolation(["This opportunity is lost. Reopen it before changing its stage."]);
    if (opp.stageKey === target) return;
    if (isAtOrAfter(target, "submitted") && target !== "renewal_scheduled" && !can(actor, "opportunity.submit")) {
      throw new Forbidden("Only Operations or a manager can submit applications.");
    }
    const issues = stageGateIssues(await loadGateFacts(this.prisma, id), target);
    if (issues.length) throw new RuleViolation(issues);

    await this.prisma.$transaction((tx) => this.enterStage(tx, actor, opp, target));
  }

  /** Writes the stage change, history and timeline, then runs the stage's side effects. */
  private async enterStage(tx: Tx, actor: Actor, opp: OppWithStage, target: StageKey, extra: Prisma.OpportunityUpdateInput = {}) {
    const stageId = await this.stages.idFor(target, tx);
    const now = new Date();
    await tx.stageHistory.updateMany({ where: { opportunityId: opp.id, leftAt: null }, data: { leftAt: now } });
    await tx.stageHistory.create({ data: { opportunityId: opp.id, stageId, userId: actorRef(actor), enteredAt: now } });
    await tx.opportunity.update({
      where: { id: opp.id },
      data: { stage: { connect: { id: stageId } }, stageEnteredAt: now, probability: stageDef(target).probability, ...extra },
    });
    const from = opp.stageKey ? stageDef(opp.stageKey).name : opp.stage.name;
    await this.audit.record(
      actor,
      { action: "opportunity.stage", entityType: "opportunity", entityId: opp.id, summary: `${from} → ${stageDef(target).name}`, data: { from: opp.stageKey, to: target } },
      { opportunityId: opp.id, customerId: opp.customerId, kind: "stage_change", body: `Stage changed from ${from} to ${stageDef(target).name}.`, data: { from: opp.stageKey, to: target } },
      tx,
    );
    await this.onStageEntered(tx, actor, opp, target);
  }

  private async onStageEntered(tx: Tx, actor: Actor, opp: OppWithStage, target: StageKey) {
    const merchant = opp.serviceType === "merchant_services";
    if (target !== "new_lead") await this.activities.completeAutomated(tx, opp.id, "first_contact");

    if (target === "details_requested") {
      await this.documents.ensureStandardChecklist(tx, opp);
      await this.activities.ensureAutomated(tx, { opportunityId: opp.id, customerId: opp.customerId, type: "request_documents", summary: merchant ? "Request business details and documents" : "Request recent bills and meter details", dueDate: today(), ownerId: opp.ownerId, automationKey: "request_details" });
    }
    if (target === "internal_review") {
      await tx.opportunity.update({ where: { id: opp.id }, data: { internalApproval: "pending" } });
      const approvers = await tx.user.findMany({ where: { active: true, roles: { some: { role: "manager" } } }, select: { id: true } });
      for (const a of approvers) await this.notifications.notify(a.id, { title: `Approval needed: ${opp.name}`, link: `/opportunities/${opp.id}` }, tx);
      await this.activities.ensureAutomated(tx, { opportunityId: opp.id, customerId: opp.customerId, type: "internal_review", summary: "Internal review and approval", dueDate: addDays(today(), 1), ownerId: approvers[0]?.id ?? opp.ownerId, automationKey: "internal_review" });
    }
    if (target === "submitted") {
      await tx.opportunity.update({ where: { id: opp.id }, data: { applicationStatus: "Submitted" } });
      await tx.merchantApplication.updateMany({ where: { opportunityId: opp.id, status: { in: ["draft", "ready"] } }, data: { status: "submitted", submissionDate: dateOnly(today()) } });
      await tx.energyContract.updateMany({ where: { opportunityId: opp.id, status: { notIn: ["cancelled", "live", "ended"] } }, data: { status: "submitted" } });
      await this.activities.completeAutomated(tx, opp.id, "internal_review");
      await this.audit.timeline(actor, { opportunityId: opp.id, customerId: opp.customerId, kind: "submission", body: merchant ? "Application submitted to Worldpay." : "Application submitted to the supplier." }, tx);
    }
    if (target === "compliance_query") {
      await tx.merchantApplication.updateMany({ where: { opportunityId: opp.id, status: "submitted" }, data: { status: "compliance_query" } });
      const owner = await this.activities.leastLoaded(tx, "compliance");
      await this.activities.ensureAutomated(tx, { opportunityId: opp.id, customerId: opp.customerId, type: "compliance_review", summary: "Answer compliance query", dueDate: addDays(today(), 1), priority: "high", ownerId: owner ?? opp.ownerId, automationKey: "compliance_query" });
      await this.notifications.notify(owner, { title: `Compliance query: ${opp.name}`, link: `/opportunities/${opp.id}` }, tx);
    } else {
      await this.activities.completeAutomated(tx, opp.id, "compliance_query");
    }
  }

  // -------------------------------------------------------------------------
  // Approval, outcome, activation
  // -------------------------------------------------------------------------

  async decideApproval(actor: Actor, id: string, decision: "approved" | "rejected" | "pending", note?: string | null) {
    if (!can(actor, "opportunity.approve")) throw new Forbidden("Only a manager can approve applications.");
    const opp = await this.access.readable(actor, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.opportunity.update({ where: { id }, data: { internalApproval: decision, internalApprovalById: actorRef(actor), internalApprovalAt: new Date() } });
      if (decision !== "pending") await this.activities.completeAutomated(tx, id, "internal_review");
      await this.audit.record(
        actor,
        { action: "opportunity.approval", entityType: "opportunity", entityId: id, summary: `Internal approval: ${decision}` },
        { opportunityId: id, customerId: opp.customerId, kind: "approval", body: `Internal approval ${decision}${note ? `: ${note}` : "."}` },
        tx,
      );
      if (opp.ownerId && opp.ownerId !== actor.id) await this.notifications.notify(opp.ownerId, { title: `${opp.name}: internal approval ${decision}`, link: `/opportunities/${id}` }, tx);
    });
  }

  async markLost(actor: Actor, id: string, reason: string) {
    const opp = await this.access.writable(actor, id);
    if (opp.outcome === "won") throw new RuleViolation(["A Live / Won opportunity can't be marked lost. A manager can reopen it first."]);
    if (opp.outcome === "lost") return;
    await this.prisma.$transaction(async (tx) => {
      // Lost is an outcome: the record keeps its stage and stays active and searchable.
      await tx.opportunity.update({ where: { id }, data: { outcome: "lost", lostAt: new Date(), lostReason: reason, probability: 0 } });
      await tx.activity.updateMany({ where: { opportunityId: id, status: "open" }, data: { status: "cancelled" } });
      await this.audit.record(
        actor,
        { action: "opportunity.lost", entityType: "opportunity", entityId: id, summary: "Marked lost", data: { reason } },
        { opportunityId: id, customerId: opp.customerId, kind: "outcome", body: `Marked lost: ${reason}` },
        tx,
      );
    });
  }

  /** Lost → open for the owner; Won → open only for managers (stage goes back to Awaiting Confirmation). */
  async reopen(actor: Actor, id: string) {
    const opp = await this.access.writable(actor, id);
    if (opp.outcome === "open") return;
    if (opp.outcome === "won" && !can(actor, "opportunity.reopen_completed")) throw new Forbidden("Only a manager can reopen a completed opportunity.");
    await this.prisma.$transaction(async (tx) => {
      if (opp.outcome === "won") {
        await this.enterStage(tx, actor, opp, "awaiting_confirmation", { outcome: "open", wonAt: null });
      } else {
        await tx.opportunity.update({ where: { id }, data: { outcome: "open", lostAt: null, lostReason: null, probability: opp.stageKey ? stageDef(opp.stageKey).probability : 10 } });
      }
      await this.audit.record(
        actor,
        { action: "opportunity.reopen", entityType: "opportunity", entityId: id, summary: `Reopened (was ${opp.outcome})` },
        { opportunityId: id, customerId: opp.customerId, kind: "outcome", body: `Reopened (was ${opp.outcome}).` },
        tx,
      );
    });
  }

  /**
   * Activation: the supply/service is live. Sets outcome Won, probability 100, stage Live / Won;
   * keeps the record active and its salesperson; links or creates the customer; records the
   * activation date; puts contracts live with end dates; schedules the renewal/follow-up.
   */
  async activate(actor: Actor, id: string, input: { activationDate: string; supplierReference?: string | null }) {
    if (!can(actor, "opportunity.activate")) throw new Forbidden("Only Operations or a manager can record activation.");
    const opp = await this.access.readable(actor, id);
    if (opp.outcome === "won") return;
    if (opp.outcome === "lost") throw new RuleViolation(["This opportunity is lost. Reopen it before activating."]);
    if (!opp.stageKey || !OPEN_STAGES_AFTER_SUBMISSION.includes(opp.stageKey)) throw new RuleViolation(["Only submitted opportunities can be activated."]);
    const issues = stageGateIssues(await loadGateFacts(this.prisma, id), "submitted");
    if (issues.length) throw new RuleViolation(issues);

    await this.prisma.$transaction(async (tx) => {
      const customerId = opp.customerId ?? (await this.createCustomerFromCapture(tx, actor, opp));
      const activation = input.activationDate;
      let renewalDate: string | null = null;
      const consider = (end: string | null) => {
        if (end && (!renewalDate || end < renewalDate)) renewalDate = end;
      };

      const contracts = await tx.energyContract.findMany({ where: { opportunityId: id, status: { notIn: ["cancelled", "ended"] } } });
      for (const c of contracts) {
        const end = isoDay(c.contractEndDate) ?? (c.termMonths ? addDays(addMonths(activation, c.termMonths), -1) : null);
        consider(end);
        await tx.energyContract.update({
          where: { id: c.id },
          data: { status: "live", activationDate: dateOnly(activation), contractEndDate: dateOnly(end), supplierReference: c.supplierReference ?? input.supplierReference ?? null, customerId },
        });
      }
      const apps = await tx.merchantApplication.findMany({ where: { opportunityId: id, status: { notIn: ["cancelled", "declined"] } } });
      for (const a of apps) {
        const end = isoDay(a.contractEndDate) ?? (a.termMonths ? addDays(addMonths(activation, a.termMonths), -1) : null);
        consider(end);
        await tx.merchantApplication.update({
          where: { id: a.id },
          data: { status: "live", activationDate: dateOnly(activation), approvalDate: a.approvalDate ?? dateOnly(activation), contractEndDate: dateOnly(end), applicationReference: a.applicationReference ?? input.supplierReference ?? null, customerId },
        });
      }

      const fresh = await this.access.load(id, tx);
      await this.enterStage(tx, actor, fresh, "live_won", {
        outcome: "won",
        probability: 100,
        active: true,
        wonAt: new Date(),
        convertedAt: new Date(),
        customer: { connect: { id: customerId } },
        activationDate: dateOnly(activation),
        renewalDate: dateOnly(renewalDate),
        applicationStatus: "Live",
      });

      for (const key of ["submission_follow_up", "signature_reminder", "missing_documents", "missing_information", "compliance_query", "activation_due"]) {
        await this.activities.completeAutomated(tx, id, key);
      }
      // Renewal review ~120 days before the end date (or a 30-day check-in when there's no term).
      const due = renewalDate ? addDays(renewalDate, -RENEWAL_WINDOW_DAYS) : addDays(activation, 30);
      await this.activities.ensureAutomated(tx, {
        opportunityId: id,
        customerId,
        type: renewalDate ? "renewal_review" : opp.serviceType === "merchant_services" ? "follow_up_worldpay" : "call",
        summary: renewalDate ? `Renewal review (contract ends ${renewalDate})` : "Post-activation check-in with customer",
        dueDate: due < today() ? today() : due,
        ownerId: opp.ownerId,
        automationKey: "post_activation",
      });
      await this.confirmCommission(tx, actor, id);
      await this.audit.record(
        actor,
        { action: "opportunity.activate", entityType: "opportunity", entityId: id, summary: `Activated on ${activation}` },
        { opportunityId: id, customerId, kind: "activation", body: `Activated on ${activation}. Opportunity is Live / Won.` },
        tx,
      );
      if (opp.ownerId) await this.notifications.notify(opp.ownerId, { title: `${opp.name} is live`, link: `/opportunities/${id}` }, tx);
    });
  }

  /** On activation, expected commission from the selected quote becomes confirmed. */
  private async confirmCommission(tx: Tx, actor: Actor, opportunityId: string) {
    const existing = await tx.commission.findFirst({ where: { opportunityId, status: { in: ["expected", "confirmed", "paid"] } } });
    if (existing) {
      if (existing.status === "expected") await tx.commission.update({ where: { id: existing.id }, data: { status: "confirmed" } });
      return;
    }
    const quotes = await tx.comparisonQuote.findMany({ where: { opportunityId, selected: true, estimatedCommission: { not: null } } });
    const total = quotes.reduce((s, q) => s + Number(q.estimatedCommission), 0);
    if (total > 0) await tx.commission.create({ data: { opportunityId, amount: total, status: "confirmed", note: "From selected quote(s) at activation", createdById: actorRef(actor) } });
  }

  // -------------------------------------------------------------------------
  // Customer linking (never touches outcome, stage, owner or active)
  // -------------------------------------------------------------------------

  async linkCustomer(actor: Actor, id: string, customerId: string) {
    await this.access.writable(actor, id);
    const c = await this.access.linkableCustomer(actor, customerId);
    await this.prisma.$transaction(async (tx) => {
      await tx.opportunity.update({ where: { id }, data: { customerId } });
      await tx.supplySite.updateMany({ where: { opportunityId: id, customerId: null }, data: { customerId } });
      await this.audit.record(
        actor,
        { action: "opportunity.link_customer", entityType: "opportunity", entityId: id, summary: `Linked to customer ${c.legalName}` },
        { opportunityId: id, customerId, kind: "system", body: `Linked to customer ${c.legalName}.` },
        tx,
      );
    });
  }

  /** Creates a Customer (and contact) from the details captured on the lead, then links it. */
  async createCustomerFromOpportunity(actor: Actor, id: string): Promise<{ customerId: string }> {
    const opp = await this.access.writable(actor, id);
    if (!can(actor, "customer.write")) throw new Forbidden();
    if (opp.customerId) return { customerId: opp.customerId };
    const customerId = await this.prisma.$transaction((tx) => this.createCustomerFromCapture(tx, actor, opp));
    return { customerId };
  }

  private async createCustomerFromCapture(tx: Tx, actor: Actor, opp: OppWithStage): Promise<string> {
    const legalName = opp.companyName?.trim() || opp.contactName?.trim();
    if (!legalName) throw new RuleViolation(["Enter a company or contact name on the opportunity first."]);
    const customer = await tx.customer.create({
      data: { legalName, email: opp.email, phone: opp.phone, phoneKey: phoneKey(opp.phone), createdById: actorRef(actor) },
    });
    if (opp.contactName) {
      const [first, ...rest] = opp.contactName.trim().split(/\s+/);
      await tx.customerContact.create({
        data: { customerId: customer.id, firstName: first, lastName: rest.join(" ") || null, email: opp.email, phone: opp.phone, phoneKey: phoneKey(opp.phone), isPrimary: true },
      });
    }
    await tx.opportunity.update({ where: { id: opp.id }, data: { customerId: customer.id } });
    await tx.supplySite.updateMany({ where: { opportunityId: opp.id, customerId: null }, data: { customerId: customer.id } });
    await this.audit.record(
      actor,
      { action: "customer.create", entityType: "customer", entityId: customer.id, summary: `Created customer ${legalName} from opportunity` },
      { opportunityId: opp.id, customerId: customer.id, kind: "system", body: `Customer ${legalName} created and linked.` },
      tx,
    );
    return customer.id;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  viewWhere(actor: Actor, q: OpportunityListQuery): Prisma.OpportunityWhereInput {
    const open = { outcome: "open" as const };
    const keys = (pred: (s: (typeof STAGES)[number]) => boolean) => ({ stage: { key: { in: STAGES.filter(pred).map((s) => s.key) } } });
    const supplierStages = keys((s) => s.key === "submitted" || s.key === "compliance_query" || s.key === "awaiting_confirmation");
    const views: Record<OpportunityListQuery["view"], Prisma.OpportunityWhereInput> = {
      my_open: { ...open, ownerId: actor.id },
      all: {},
      all_won: { outcome: "won" },
      energy: { serviceType: { in: ["electricity", "gas", "dual_fuel"] } },
      worldpay: { serviceType: "merchant_services" },
      renewals_due: { ...open, saleType: "renewal", renewalDate: { lte: dateOnly(addDays(today(), RENEWAL_WINDOW_DAYS)) } },
      awaiting_customer: { ...open, ...keys((s) => s.waitingOn === "customer") },
      awaiting_supplier: { ...open, ...supplierStages, serviceType: { in: ["electricity", "gas", "dual_fuel"] } },
      awaiting_worldpay: { ...open, ...supplierStages, serviceType: "merchant_services" },
      compliance_queries: {
        ...open,
        OR: [{ stage: { key: "compliance_query" } }, { merchantApps: { some: { risk: { complianceStatus: "query_raised" } } } }],
      },
      missing_documents: { ...open, documents: { some: { required: true, received: false } } },
      unsigned: {
        ...open,
        ...keys((s) => isAtOrAfter(s.key, "documents_prepared") && s.key !== "live_won" && s.key !== "renewal_scheduled"),
        signatures: { none: { status: "completed" } },
      },
      unassigned: { ...open, ownerId: null },
      lost: { outcome: "lost" },
    };
    const and: Prisma.OpportunityWhereInput[] = [this.access.visibleWhere(actor), views[q.view]];
    if (q.ownerId) and.push({ ownerId: q.ownerId });
    if (q.serviceType) and.push({ serviceType: q.serviceType });
    if (q.stage) and.push({ stage: { key: q.stage } });
    if (q.supplierId) and.push({ selectedSupplierId: q.supplierId });
    if (q.q) {
      const term = q.q.trim();
      const n = Number(term.replace(/^UO-?/i, ""));
      and.push({
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          { companyName: { contains: term, mode: "insensitive" } },
          { contactName: { contains: term, mode: "insensitive" } },
          { email: { contains: term, mode: "insensitive" } },
          { customer: { legalName: { contains: term, mode: "insensitive" } } },
          { customer: { tradingName: { contains: term, mode: "insensitive" } } },
          ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : []),
        ],
      });
    }
    return { AND: and };
  }

  async list(actor: Actor, q: OpportunityListQuery): Promise<Page<unknown>> {
    const where = this.viewWhere(actor, q);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.opportunity.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }],
        ...pageArgs(q.page, q.pageSize),
        include: {
          stage: { select: { key: true, name: true } },
          owner: { select: { id: true, name: true } },
          customer: { select: { id: true, legalName: true } },
          selectedSupplier: { select: { id: true, name: true } },
        },
      }),
      this.prisma.opportunity.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Kanban: every stage with its cards (capped per column) and totals. */
  async board(actor: Actor, q: OpportunityListQuery, perStage = 50) {
    const where = this.viewWhere(actor, q);
    const stages = await this.stages.list();
    const liveWon = stages.filter((s) => s.key === "live_won").map((s) => s.id);
    // Lost deals drop off the board, except in Live / Won.
    const shown = (stageIds: string[]): Prisma.OpportunityWhereInput => ({ AND: [where, { stageId: { in: stageIds } }, { OR: [{ stageId: { in: liveWon } }, { outcome: { not: "lost" } }] }] });
    // One grouped query for every column's count and value (was two queries per stage).
    const totals = new Map(
      (await this.prisma.opportunity.groupBy({ by: ["stageId"], where: shown(stages.map((s) => s.id)), _count: { _all: true }, _sum: { expectedRevenue: true } })).map((g) => [g.stageId, g]),
    );
    const columns = await Promise.all(
      stages.map(async (s) => {
        const cards = await this.prisma.opportunity.findMany({
          where: shown([s.id]),
          take: perStage,
          orderBy: { stageEnteredAt: "asc" },
          select: {
            id: true,
            number: true,
            name: true,
            serviceType: true,
            saleType: true,
            outcome: true,
            expectedRevenue: true,
            followUpDate: true,
            stageEnteredAt: true,
            companyName: true,
            owner: { select: { id: true, name: true } },
            customer: { select: { legalName: true } },
          },
        });
        const total = totals.get(s.id);
        return { stage: { id: s.id, key: s.key, name: s.name }, count: total?._count._all ?? 0, value: Number(total?._sum.expectedRevenue ?? 0), cards };
      }),
    );
    return { columns };
  }

  /** The opportunity workspace. Restricted values are masked unless the actor holds the capability. */
  async workspace(actor: Actor, id: string) {
    await this.access.readable(actor, id);
    const opp = await this.prisma.opportunity.findUniqueOrThrow({
      where: { id },
      include: {
        stage: true,
        owner: { select: { id: true, name: true, email: true } },
        team: true,
        customer: { include: { contacts: true, addresses: true } },
        selectedSupplier: true,
        previousOpportunity: { select: { id: true, number: true, name: true } },
        renewals: { select: { id: true, number: true, name: true, outcome: true } },
        _count: { select: { sites: true, contracts: true, merchantApps: true, documents: true, activities: { where: { status: "open" } } } },
      },
    });
    const facts = await loadGateFacts(this.prisma, id);
    // Outstanding requirements for the next gates, so the workspace can show a checklist.
    const gates = Object.fromEntries(GATE_STAGES.map((k) => [k, stageGateIssues(facts, k)]));
    return {
      ...opp,
      gates,
      permissions: {
        write: canWriteOpportunity(actor, { ownerId: opp.ownerId }),
        assign: can(actor, "opportunity.assign"),
        approve: can(actor, "opportunity.approve"),
        submit: can(actor, "opportunity.submit"),
        activate: can(actor, "opportunity.activate"),
        reopenCompleted: can(actor, "opportunity.reopen_completed"),
      },
    };
  }

  /** Lists what blocks a stage, so the UI can explain before the user tries. */
  async gatePreview(actor: Actor, id: string, target: StageKey) {
    await this.access.readable(actor, id);
    return { stage: target, issues: stageGateIssues(await loadGateFacts(this.prisma, id), target) };
  }
}

const GATE_STAGES = ["proposal_sent", "supplier_selected", "documents_prepared", "submitted"] as const;
