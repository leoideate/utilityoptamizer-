import { Injectable } from "@nestjs/common";
import type { MerchantApplication } from "@prisma/client";
import {
  type MerchantApplicationInput,
  type MerchantPricingInput,
  type PrincipalInput,
  type RiskInput,
  can,
  canWriteOpportunity,
  today,
} from "@uo/shared";
import type { complianceReviewSchema } from "@uo/shared";
import type { z } from "zod";
import { ActivitiesService } from "../activities/activities.service";
import { AuditService } from "../audit/audit.service";
import { type Actor, actorRef } from "../common/actor";
import { CryptoService } from "../common/crypto.service";
import { Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { dateOnly, defined, isoDay } from "../common/values";
import { NotificationsService } from "../notifications/notifications.service";
import { OpportunityAccess } from "../opportunities/access.service";

type AddressEntry = NonNullable<PrincipalInput["addressHistory"]>[number];

@Injectable()
export class MerchantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly activities: ActivitiesService,
    private readonly notifications: NotificationsService,
  ) {}

  private async merchantOpp(actor: Actor, opportunityId: string) {
    const opp = await this.access.writable(actor, opportunityId);
    if (opp.serviceType !== "merchant_services") throw new RuleViolation(["Worldpay applications belong to Merchant Services opportunities."]);
    return opp;
  }

  private async app(actor: Actor, applicationId: string, write = true) {
    const app = await this.prisma.merchantApplication.findUnique({ where: { id: applicationId } });
    if (!app) throw new NotFound("Worldpay application");
    const opp = write ? await this.merchantOpp(actor, app.opportunityId) : await this.access.readable(actor, app.opportunityId);
    return { app, opp };
  }

  private assertEditable(app: MerchantApplication) {
    if (app.status === "live") throw new RuleViolation(["This application is live and kept as history. Start a renewal to change its terms."]);
  }

  /**
   * The Worldpay workspace. Principal personal details are masked unless the viewer holds
   * principal.read_sensitive; restricted compliance notes need risk.review. Unmasked views are logged.
   */
  async workspace(actor: Actor, opportunityId: string) {
    const opp = await this.access.readable(actor, opportunityId);
    const apps = await this.prisma.merchantApplication.findMany({
      where: { opportunityId },
      include: { pricing: true, risk: true, principals: { include: { addresses: { orderBy: { fromDate: "desc" } } }, orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    });
    const seeSensitive = can(actor, "principal.read_sensitive");
    const seeRisk = can(actor, "risk.read") || canWriteOpportunity(actor, { ownerId: opp.ownerId });
    const seeNotes = can(actor, "risk.review");
    if (seeSensitive && apps.some((a) => a.principals.length)) {
      await this.audit.sensitiveAccess(actor, "opportunity", opportunityId, "Worldpay principal details");
    }
    return apps.map((a) => ({
      ...a,
      risk: !a.risk
        ? null
        : seeRisk
          ? { ...a.risk, restrictedNotesEnc: undefined, restrictedNotes: seeNotes ? this.crypto.decrypt(a.risk.restrictedNotesEnc) : undefined, notesRestricted: !seeNotes }
          : { restricted: true, complianceStatus: a.risk.complianceStatus },
      principals: a.principals.map((p) => ({
        id: p.id,
        role: p.role,
        title: p.title,
        firstName: p.firstName,
        middleName: p.middleName,
        lastName: p.lastName,
        ownershipPct: p.ownershipPct,
        email: p.email,
        phone: p.phone,
        hasDob: p.hasDob,
        hasNationality: p.hasNationality,
        restricted: !seeSensitive,
        dateOfBirth: seeSensitive ? this.crypto.decrypt(p.dobEnc) : null,
        nationality: seeSensitive ? this.crypto.decrypt(p.nationalityEnc) : null,
        addressHistory: p.addresses.map((ad) => ({
          id: ad.id,
          fromDate: isoDay(ad.fromDate),
          toDate: isoDay(ad.toDate),
          address: seeSensitive ? this.crypto.decryptJson<AddressEntry>(ad.addressEnc) : null,
        })),
      })),
    }));
  }

  // --- Application ---------------------------------------------------------

  private appData(input: Partial<MerchantApplicationInput>) {
    return defined({
      campaign: input.campaign,
      legalEntity: input.legalEntity,
      natureOfBusiness: input.natureOfBusiness,
      estimatedAnnualTurnover: input.estimatedAnnualTurnover,
      cardTurnoverPct: input.cardTurnoverPct,
      averageTransactionValue: input.averageTransactionValue,
      settlementPeriod: input.settlementPeriod,
      dashboardRequested: input.dashboardRequested,
      website: input.website,
      advertisingMethod: input.advertisingMethod,
      applicationReference: input.applicationReference,
      termMonths: input.termMonths,
    });
  }

  async createApplication(actor: Actor, opportunityId: string, input: MerchantApplicationInput) {
    const opp = await this.merchantOpp(actor, opportunityId);
    const customer = opp.customerId ? await this.prisma.customer.findUnique({ where: { id: opp.customerId } }) : null;
    const app = await this.prisma.$transaction(async (tx) => {
      const a = await tx.merchantApplication.create({
        data: {
          ...this.appData(input),
          opportunityId,
          customerId: opp.customerId,
          campaign: input.campaign ?? opp.campaign,
          website: input.website ?? customer?.website ?? null,
          advertisingMethod: input.advertisingMethod ?? customer?.advertisingMethod ?? null,
          risk: { create: {} },
        },
      });
      await this.audit.record(
        actor,
        { action: "merchant.create", entityType: "merchant_application", entityId: a.id, summary: "Created Worldpay application" },
        { opportunityId, customerId: opp.customerId, kind: "system", body: "Worldpay application created." },
        tx,
      );
      return a;
    });
    return app;
  }

  async updateApplication(actor: Actor, applicationId: string, input: Partial<MerchantApplicationInput>) {
    const { app } = await this.app(actor, applicationId);
    this.assertEditable(app);
    if (input.status && !["draft", "ready", "cancelled"].includes(input.status)) {
      throw new RuleViolation(["Submission, approval and activation are recorded with their own actions."]);
    }
    const data = { ...this.appData(input), ...(input.status ? { status: input.status } : {}) };
    await this.prisma.merchantApplication.update({ where: { id: applicationId }, data });
    await this.audit.log(actor, { action: "merchant.update", entityType: "merchant_application", entityId: applicationId, summary: `Updated ${Object.keys(data).join(", ")}` });
  }

  async recordCustomerAcceptance(actor: Actor, applicationId: string) {
    const { app, opp } = await this.app(actor, applicationId);
    await this.prisma.merchantApplication.update({ where: { id: applicationId }, data: { customerAcceptedAt: new Date() } });
    await this.audit.record(
      actor,
      { action: "merchant.accepted", entityType: "merchant_application", entityId: app.id, summary: "Customer accepted the Worldpay offer" },
      { opportunityId: opp.id, customerId: opp.customerId, kind: "system", body: "Customer accepted the Worldpay offer." },
    );
  }

  /** Worldpay approved the application (before activation). Operations/managers. */
  async recordApproval(actor: Actor, applicationId: string, reference?: string | null) {
    if (!can(actor, "opportunity.submit")) throw new Forbidden();
    const { app, opp } = await this.app(actor, applicationId, false);
    if (!["submitted", "compliance_query"].includes(app.status)) throw new RuleViolation(["Only submitted applications can be approved."]);
    await this.prisma.$transaction(async (tx) => {
      await tx.merchantApplication.update({ where: { id: applicationId }, data: { status: "approved", approvalDate: dateOnly(today()), applicationReference: reference ?? app.applicationReference } });
      await this.audit.record(
        actor,
        { action: "merchant.approved", entityType: "merchant_application", entityId: app.id, summary: "Worldpay approved the application" },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "submission", body: `Worldpay approved the application${reference ? ` (ref ${reference})` : ""}.` },
        tx,
      );
    });
  }

  // --- Pricing ---------------------------------------------------------------

  async addPricing(actor: Actor, applicationId: string, input: MerchantPricingInput) {
    const { app } = await this.app(actor, applicationId);
    this.assertEditable(app);
    return this.prisma.merchantPricing.create({ data: { ...input, applicationId } });
  }

  async removePricing(actor: Actor, pricingId: string) {
    const p = await this.prisma.merchantPricing.findUnique({ where: { id: pricingId } });
    if (!p) throw new NotFound("Pricing line");
    const { app } = await this.app(actor, p.applicationId);
    this.assertEditable(app);
    await this.prisma.merchantPricing.delete({ where: { id: pricingId } });
  }

  // --- Principals (restricted) -----------------------------------------------------

  private principalData(input: Partial<PrincipalInput>) {
    return defined({
      role: input.role,
      title: input.title,
      firstName: input.firstName,
      middleName: input.middleName,
      lastName: input.lastName,
      ownershipPct: input.ownershipPct,
      email: input.email,
      phone: input.phone,
      ...(input.dateOfBirth !== undefined ? { dobEnc: this.crypto.encrypt(input.dateOfBirth), hasDob: !!input.dateOfBirth } : {}),
      ...(input.nationality !== undefined ? { nationalityEnc: this.crypto.encrypt(input.nationality), hasNationality: !!input.nationality } : {}),
    });
  }

  private checkPrincipal(input: Partial<PrincipalInput>) {
    const issues: string[] = [];
    if (input.dateOfBirth && input.dateOfBirth > today()) issues.push("Date of birth can't be in the future.");
    for (const a of input.addressHistory ?? []) if (a.toDate && a.toDate < a.fromDate) issues.push(`Address "${a.line1}": the end date is before the start date.`);
    if (issues.length) throw new RuleViolation(issues);
  }

  /** Salespeople may record principal details; reading them back requires principal.read_sensitive. */
  async addPrincipal(actor: Actor, applicationId: string, input: PrincipalInput) {
    if (!can(actor, "principal.write")) throw new Forbidden();
    const { app, opp } = await this.app(actor, applicationId);
    this.assertEditable(app);
    this.checkPrincipal(input);
    const total = await this.prisma.principal.aggregate({ where: { applicationId }, _sum: { ownershipPct: true } });
    if (input.ownershipPct != null && Number(total._sum.ownershipPct ?? 0) + input.ownershipPct > 100) {
      throw new RuleViolation(["Total ownership across principals can't exceed 100%."]);
    }
    const p = await this.prisma.principal.create({
      data: {
        ...this.principalData(input),
        role: input.role,
        firstName: input.firstName,
        lastName: input.lastName,
        applicationId,
        addresses: { create: (input.addressHistory ?? []).map((a) => ({ addressEnc: this.crypto.encryptJson(a), fromDate: dateOnly(a.fromDate), toDate: dateOnly(a.toDate) ?? null })) },
      },
    });
    await this.audit.record(
      actor,
      { action: "principal.create", entityType: "merchant_application", entityId: applicationId, summary: `Added principal (${input.role})` },
      { opportunityId: opp.id, customerId: opp.customerId, kind: "system", body: `Principal added: ${input.firstName} ${input.lastName} (${input.role}).` },
    );
    return { id: p.id };
  }

  async updatePrincipal(actor: Actor, principalId: string, input: Partial<PrincipalInput>) {
    if (!can(actor, "principal.write")) throw new Forbidden();
    const p = await this.prisma.principal.findUnique({ where: { id: principalId } });
    if (!p) throw new NotFound("Principal");
    const { app } = await this.app(actor, p.applicationId);
    this.assertEditable(app);
    this.checkPrincipal(input);
    await this.prisma.$transaction(async (tx) => {
      await tx.principal.update({ where: { id: principalId }, data: this.principalData(input) });
      if (input.addressHistory) {
        await tx.principalAddress.deleteMany({ where: { principalId } });
        await tx.principalAddress.createMany({
          data: input.addressHistory.map((a) => ({ principalId, addressEnc: this.crypto.encryptJson(a), fromDate: dateOnly(a.fromDate), toDate: dateOnly(a.toDate) ?? null })),
        });
      }
      // The log names which restricted fields changed, never their values.
      await this.audit.log(actor, { action: "principal.update", entityType: "merchant_application", entityId: p.applicationId, summary: `Updated principal: ${Object.keys(input).join(", ")}` }, tx);
    });
  }

  async removePrincipal(actor: Actor, principalId: string) {
    const p = await this.prisma.principal.findUnique({ where: { id: principalId } });
    if (!p) throw new NotFound("Principal");
    const { app } = await this.app(actor, p.applicationId);
    this.assertEditable(app);
    await this.prisma.principal.delete({ where: { id: principalId } });
    await this.audit.log(actor, { action: "principal.delete", entityType: "merchant_application", entityId: p.applicationId, summary: "Removed principal" });
  }

  // --- Risk & compliance ---------------------------------------------------------

  /** Underwriting answers. Completeness is enforced at Documents Prepared, so partial saves are fine. */
  async saveRisk(actor: Actor, applicationId: string, input: RiskInput) {
    const { app } = await this.app(actor, applicationId);
    this.assertEditable(app);
    const data = defined({
      ...input,
      // Clearing a "yes" clears its dependent details so stale numbers don't linger.
      ...(input.depositsAccepted === false ? { depositTxnPct: null, depositValuePct: null, depositLeadDays: null, balanceLeadDays: null } : {}),
      ...(input.fullPrepaymentAccepted === false ? { fullPrepaymentPct: null, fullPaymentLeadDays: null } : {}),
    });
    await this.prisma.merchantRisk.upsert({ where: { applicationId }, create: { ...data, applicationId }, update: data });
    await this.audit.log(actor, { action: "risk.update", entityType: "merchant_application", entityId: applicationId, summary: "Updated underwriting answers" });
  }

  /** Compliance decision. Raising a query creates a task for the salesperson. */
  async review(actor: Actor, applicationId: string, input: z.infer<typeof complianceReviewSchema>) {
    if (!can(actor, "risk.review")) throw new Forbidden("Only Compliance can review Worldpay risk.");
    const { app, opp } = await this.app(actor, applicationId, false);
    await this.prisma.$transaction(async (tx) => {
      await tx.merchantRisk.upsert({
        where: { applicationId },
        create: { applicationId, complianceStatus: input.status, restrictedNotesEnc: this.crypto.encrypt(input.restrictedNotes ?? null), reviewedById: actorRef(actor), reviewedAt: new Date() },
        update: {
          complianceStatus: input.status,
          ...(input.restrictedNotes !== undefined ? { restrictedNotesEnc: this.crypto.encrypt(input.restrictedNotes) } : {}),
          reviewedById: actorRef(actor),
          reviewedAt: new Date(),
        },
      });
      // Timeline text stays generic: the restricted notes are never copied into it.
      const labels = { not_started: "not started", in_review: "in review", query_raised: "query raised", approved: "approved", rejected: "rejected" } as const;
      await this.audit.record(
        actor,
        { action: "compliance.review", entityType: "merchant_application", entityId: app.id, summary: `Compliance review: ${labels[input.status]}` },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "compliance", body: `Compliance review ${labels[input.status]}.` },
        tx,
      );
      if (input.status === "query_raised") {
        await this.activities.ensureAutomated(tx, {
          opportunityId: opp.id,
          customerId: opp.customerId,
          type: "compliance_review",
          summary: "Compliance has a question about this Worldpay application",
          dueDate: today(),
          priority: "high",
          ownerId: opp.ownerId,
          automationKey: "compliance_question",
        });
      } else {
        await this.activities.completeAutomated(tx, opp.id, "compliance_question");
      }
      if (opp.ownerId) await this.notifications.notify(opp.ownerId, { title: `Compliance review ${labels[input.status]}: ${opp.name}`, link: `/opportunities/${opp.id}` }, tx);
    });
  }
}
