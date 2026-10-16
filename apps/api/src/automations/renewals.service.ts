import { Injectable } from "@nestjs/common";
import type { Opportunity, ServiceType } from "@prisma/client";
import { addDays, stageDef, today } from "@uo/shared";
import { ActivitiesService } from "../activities/activities.service";
import { AuditService } from "../audit/audit.service";
import { SYSTEM } from "../common/actor";
import type { Tx } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";
import { dateOnly, isoDay } from "../common/values";
import { StagesService } from "../opportunities/stages.service";

/** Renewal opportunities open between 120 and 90 days before the contract ends. */
export const RENEWAL_WINDOW = { maxDays: 120, minDays: 90 } as const;

export interface RenewalRun {
  created: string[];
  skipped: string[];
}

const isUnique = (e: unknown) => (e as { code?: string }).code === "P2002";

/**
 * Creates renewal opportunities for live contracts ending in the window.
 *
 * - One renewal per original opportunity and end date (dual fuel renews as one deal);
 *   one per Worldpay application.
 * - The original opportunity and contract are never modified. New draft records point back
 *   to them (previousOpportunityId, previousContractId, previousApplicationId).
 * - `renewalSourceKey` is unique in the database, so re-runs (even concurrent) can't duplicate.
 * - Contracts already past the 90-day point (e.g. the job was down) are still picked up.
 */
@Injectable()
export class RenewalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stages: StagesService,
    private readonly audit: AuditService,
    private readonly activities: ActivitiesService,
  ) {}

  async run(asOf: string = today()): Promise<RenewalRun> {
    const result: RenewalRun = { created: [], skipped: [] };
    const from = dateOnly(asOf);
    const to = dateOnly(addDays(asOf, RENEWAL_WINDOW.maxDays));

    const contracts = await this.prisma.energyContract.findMany({
      where: { status: "live", contractEndDate: { gte: from, lte: to } },
      include: { selectedSupplier: true },
      orderBy: { createdAt: "asc" },
    });
    const groups = new Map<string, typeof contracts>();
    for (const c of contracts) {
      const key = `energy:${c.opportunityId}:${isoDay(c.contractEndDate)}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const [key, group] of groups) {
      await this.once(key, result, async (tx) => {
        const orig = await tx.opportunity.findUniqueOrThrow({ where: { id: group[0].opportunityId } });
        const fuels = new Set(group.map((c) => c.fuel));
        const serviceType: ServiceType = fuels.size === 2 ? "dual_fuel" : fuels.has("gas") ? "gas" : "electricity";
        const opp = await this.createOpportunity(tx, orig, key, isoDay(group[0].contractEndDate)!, serviceType);
        for (const c of group) {
          // Reusable facts only: site, fuel, today's supplier and account, end date, term. No rates or references.
          await tx.energyContract.create({
            data: {
              opportunityId: opp.id,
              customerId: c.customerId ?? orig.customerId,
              siteId: c.siteId,
              fuel: c.fuel,
              existingSupplierName: c.selectedSupplier?.name ?? c.existingSupplierName,
              existingSupplierAccount: c.supplierReference ?? c.existingSupplierAccount,
              currentContractStartDate: c.activationDate,
              currentContractEndDate: c.contractEndDate,
              termMonths: c.termMonths,
              status: "draft",
              previousContractId: c.id,
            },
          });
        }
        return opp.id;
      });
    }

    const apps = await this.prisma.merchantApplication.findMany({
      where: { status: "live", contractEndDate: { gte: from, lte: to } },
      include: { principals: { include: { addresses: true } } },
      orderBy: { createdAt: "asc" },
    });
    for (const app of apps) {
      await this.once(`merchant:${app.id}`, result, async (tx) => {
        const orig = await tx.opportunity.findUniqueOrThrow({ where: { id: app.opportunityId } });
        const opp = await this.createOpportunity(tx, orig, `merchant:${app.id}`, isoDay(app.contractEndDate)!, "merchant_services");
        await tx.merchantApplication.create({
          data: {
            opportunityId: opp.id,
            customerId: app.customerId ?? orig.customerId,
            campaign: "Renewal",
            legalEntity: app.legalEntity,
            natureOfBusiness: app.natureOfBusiness,
            settlementPeriod: app.settlementPeriod,
            dashboardRequested: app.dashboardRequested,
            website: app.website,
            advertisingMethod: app.advertisingMethod,
            termMonths: app.termMonths,
            status: "draft",
            previousApplicationId: app.id,
            // Underwriting must be re-confirmed: a blank risk record. Principals (people) carry over.
            risk: { create: {} },
            principals: {
              create: app.principals.map((p) => ({
                role: p.role,
                title: p.title,
                firstName: p.firstName,
                middleName: p.middleName,
                lastName: p.lastName,
                dobEnc: p.dobEnc,
                nationalityEnc: p.nationalityEnc,
                hasDob: p.hasDob,
                hasNationality: p.hasNationality,
                ownershipPct: p.ownershipPct,
                email: p.email,
                phone: p.phone,
                addresses: { create: p.addresses.map((a) => ({ addressEnc: a.addressEnc, fromDate: a.fromDate, toDate: a.toDate })) },
              })),
            },
          },
        });
        return opp.id;
      });
    }
    return result;
  }

  private async once(key: string, result: RenewalRun, create: (tx: Tx) => Promise<string>) {
    if (await this.prisma.opportunity.findUnique({ where: { renewalSourceKey: key }, select: { id: true } })) {
      result.skipped.push(key);
      return;
    }
    try {
      result.created.push(await this.prisma.$transaction(create));
    } catch (e) {
      if (!isUnique(e)) throw e;
      result.skipped.push(key);
    }
  }

  private async createOpportunity(tx: Tx, orig: Opportunity, key: string, endDate: string, serviceType: ServiceType) {
    const stageId = await this.stages.idFor("renewal_scheduled", tx);
    // The responsible salesperson is the original owner; if they've left, the deal is unassigned for a manager.
    const owner = orig.ownerId ? await tx.user.findUnique({ where: { id: orig.ownerId } }) : null;
    const ownerId = owner?.active ? owner.id : null;
    const opp = await tx.opportunity.create({
      data: {
        name: `Renewal: ${orig.name.replace(/^Renewal: /, "")}`,
        customerId: orig.customerId,
        contactName: orig.contactName,
        companyName: orig.companyName,
        email: orig.email,
        phone: orig.phone,
        ownerId,
        teamId: orig.teamId,
        stageId,
        probability: stageDef("renewal_scheduled").probability,
        serviceType,
        saleType: "renewal",
        leadSource: "renewal",
        leadSourceDetail: `Contract ending ${endDate}`,
        campaign: orig.campaign,
        renewalDate: dateOnly(endDate),
        // A renewal stays with the current supplier unless the customer decides to switch.
        selectedSupplierId: serviceType === "merchant_services" ? null : orig.selectedSupplierId,
        previousOpportunityId: orig.id,
        renewalSourceKey: key,
        nextAction: "Contact customer about renewal",
      },
    });
    await tx.stageHistory.create({ data: { opportunityId: opp.id, stageId } });
    const callDue = addDays(endDate, -RENEWAL_WINDOW.minDays);
    await this.activities.ensureAutomated(tx, {
      opportunityId: opp.id,
      customerId: opp.customerId,
      type: "renewal_review",
      summary: `Renewal: contact customer (contract ends ${endDate})`,
      dueDate: callDue < today() ? today() : callDue,
      priority: "high",
      ownerId,
      automationKey: "renewal_call",
    });
    await this.audit.record(
      SYSTEM,
      { action: "renewal.create", entityType: "opportunity", entityId: opp.id, summary: `Renewal created from UO-${orig.number}`, data: { previousOpportunityId: orig.id, key } },
      { opportunityId: opp.id, customerId: opp.customerId, kind: "system", body: `Renewal created from opportunity UO-${String(orig.number).padStart(6, "0")} (contract ends ${endDate}).` },
      tx,
    );
    await this.audit.timeline(SYSTEM, { opportunityId: orig.id, customerId: orig.customerId, kind: "system", body: `Renewal opportunity UO-${String(opp.number).padStart(6, "0")} created.` }, tx);
    return opp;
  }
}
