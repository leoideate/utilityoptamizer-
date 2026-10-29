import { Injectable } from "@nestjs/common";
import {
  type EnergyContractInput,
  type MeterPointInput,
  type SupplySiteInput,
  meterPointErrors,
  normalizeIdentifier,
} from "@uo/shared";
import type { comparisonQuoteSchema, meterReadingSchema } from "@uo/shared";
import type { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { type Actor, actorRef } from "../common/actor";
import { knownBusinessType, knownSupplyAddress } from "../common/irish-address";
import { NotFound, RuleViolation, assertRules } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { dateOnly, defined } from "../common/values";
import { OpportunityAccess } from "../opportunities/access.service";

/** Contract statuses that are history: they are never edited (a renewal creates a new contract). */
const HISTORICAL = new Set(["live", "ended"]);

@Injectable()
export class EnergyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
  ) {}

  private async energyOpp(actor: Actor, opportunityId: string) {
    const opp = await this.access.writable(actor, opportunityId);
    if (opp.serviceType === "merchant_services") throw new RuleViolation(["This is a Worldpay opportunity; energy details don't apply."]);
    return opp;
  }

  async workspace(actor: Actor, opportunityId: string) {
    const opp = await this.access.readable(actor, opportunityId);
    const [sites, contracts, quotes] = await Promise.all([
      this.prisma.supplySite.findMany({
        where: { OR: [{ opportunityId }, { contracts: { some: { opportunityId } } }] },
        include: { meterPoints: { include: { readings: { orderBy: { readingDate: "desc" }, take: 12 } }, orderBy: { fuel: "asc" } } },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.energyContract.findMany({ where: { opportunityId }, include: { selectedSupplier: true, site: { select: { id: true, label: true, line1: true } } }, orderBy: { createdAt: "asc" } }),
      this.prisma.comparisonQuote.findMany({ where: { opportunityId }, include: { supplier: true }, orderBy: [{ fuel: "asc" }, { estimatedAnnualCost: "asc" }] }),
    ]);
    const history = contracts.some((c) => c.previousContractId)
      ? await this.prisma.energyContract.findMany({ where: { id: { in: contracts.map((c) => c.previousContractId).filter((x): x is string => !!x) } }, include: { selectedSupplier: true } })
      : [];
    // What a new site starts with: the address and business type the CRM already holds.
    const customer = opp.customerId ? await this.prisma.customer.findUnique({ where: { id: opp.customerId }, select: { businessType: true, addresses: { where: { kind: { not: "home" } } } } }) : null;
    const address = knownSupplyAddress(opp, customer?.addresses);
    const suggestedSite = address ? { address, customerSector: knownBusinessType(opp, customer) } : null;
    return { serviceType: opp.serviceType, sites, contracts, quotes, previousContracts: history, suggestedSite };
  }

  // --- Sites ---------------------------------------------------------------

  async addSite(actor: Actor, opportunityId: string, input: SupplySiteInput) {
    const opp = await this.energyOpp(actor, opportunityId);
    const { address, ...rest } = input;
    const { kind: _kind, ...addressFields } = address;
    const site = await this.prisma.supplySite.create({
      data: { ...rest, ...addressFields, opportunityId, customerId: opp.customerId, annualConsumptionKwh: input.annualConsumptionKwh ?? null, occupiedSince: dateOnly(input.occupiedSince) ?? null },
    });
    await this.audit.record(
      actor,
      { action: "site.create", entityType: "supply_site", entityId: site.id, summary: `Added supply site ${site.label ?? site.line1}` },
      { opportunityId, customerId: opp.customerId, kind: "system", body: `Supply site added: ${site.label ?? site.line1}.` },
    );
    return site;
  }

  private async site(actor: Actor, siteId: string) {
    const site = await this.prisma.supplySite.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFound("Supply site");
    // A change-of-entity case that matched this supply point may also maintain it (e.g. the landlord's details).
    const viaCase = await this.prisma.workflowCase.findMany({ where: { siteId }, select: { opportunityId: true } });
    for (const c of viaCase) {
      try {
        await this.energyOpp(actor, c.opportunityId);
        return site;
      } catch {
        // fall through to the site's own deal
      }
    }
    if (site.opportunityId) await this.energyOpp(actor, site.opportunityId);
    else {
      const viaContract = await this.prisma.energyContract.findFirst({ where: { siteId } });
      if (!viaContract) throw new NotFound("Supply site");
      await this.energyOpp(actor, viaContract.opportunityId);
    }
    return site;
  }

  async updateSite(actor: Actor, siteId: string, input: Partial<SupplySiteInput>) {
    await this.site(actor, siteId);
    const { address, ...rest } = input;
    const { kind: _kind, ...addressFields } = address ?? {};
    await this.prisma.supplySite.update({ where: { id: siteId }, data: defined({ ...rest, ...addressFields, occupiedSince: dateOnly(input.occupiedSince) }) });
    await this.audit.log(actor, { action: "site.update", entityType: "supply_site", entityId: siteId, summary: "Updated supply site" });
  }

  /**
   * Removes a supply site added by mistake, with its meters and readings (the timeline and audit keep
   * its name and MPRN/GPRNs). Draft contracts on it are unlinked. A site that a live or ended contract,
   * another deal, a workflow case or an occupancy record relies on is kept.
   */
  async removeSite(actor: Actor, siteId: string, reason: string) {
    const site = await this.prisma.supplySite.findUnique({
      where: { id: siteId },
      include: { meterPoints: { select: { mprn: true, gprn: true } }, contracts: { select: { opportunityId: true, status: true } }, _count: { select: { cases: true, occupancies: true } } },
    });
    if (!site) throw new NotFound("Supply site");
    if (!site.opportunityId) throw new RuleViolation(["This site comes from an earlier contract and is kept as history."]);
    const opp = await this.energyOpp(actor, site.opportunityId);
    if (opp.outcome !== "open") throw new RuleViolation(["Won and lost deals keep their supply sites."]);
    const issues: string[] = [];
    if (site.contracts.some((c) => HISTORICAL.has(c.status))) issues.push("A live or ended contract is on this site, so it's kept as history.");
    if (site.contracts.some((c) => c.opportunityId !== site.opportunityId)) issues.push("Another deal's contract uses this site.");
    if (site._count.cases || site._count.occupancies) issues.push("A workflow case or occupancy record uses this site, so it's kept as evidence.");
    if (issues.length) throw new RuleViolation(issues);

    const name = site.label ?? site.line1;
    const identifiers = site.meterPoints.map((m) => m.mprn ?? m.gprn).filter((x): x is string => !!x);
    await this.prisma.$transaction(async (tx) => {
      await tx.energyContract.updateMany({ where: { siteId }, data: { siteId: null } });
      await tx.supplySite.delete({ where: { id: siteId } });
      await this.audit.record(
        actor,
        {
          action: "site.remove",
          entityType: "supply_site",
          entityId: siteId,
          summary: `Removed supply site ${name}`,
          data: { meterIdentifiers: identifiers, reason },
        },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "system", body: `Supply site removed: ${name}${identifiers.length ? ` (${identifiers.join(", ")})` : ""}. ${reason}` },
        tx,
      );
    });
  }

  // --- Meter points ------------------------------------------------------------

  private cleanMeter(input: MeterPointInput) {
    const v = {
      fuel: input.fuel,
      meterType: input.meterType ?? null,
      mprn: input.fuel === "electricity" ? normalizeIdentifier(input.mprn) : null,
      gprn: input.fuel === "gas" ? normalizeIdentifier(input.gprn) : null,
      meterNumber: input.meterNumber ?? null,
      mccCode: normalizeIdentifier(input.mccCode),
      formatExceptionReason: input.formatExceptionReason ?? null,
      // Electricity-only and gas-only details (cleared if the fuel doesn't match).
      mic: input.fuel === "electricity" ? (input.mic ?? null) : null,
      dgCode: input.fuel === "electricity" ? (input.dgCode?.toUpperCase() ?? null) : null,
      voltage: input.fuel === "electricity" ? (input.voltage ?? null) : null,
      profileClass: input.fuel === "electricity" ? (input.profileClass ?? null) : null,
      meterSerial2: input.fuel === "electricity" ? (input.meterSerial2 ?? null) : null,
      supplyPointCapacityKwh: input.fuel === "gas" ? (input.supplyPointCapacityKwh ?? null) : null,
      annualQuantityKwh: input.fuel === "gas" ? (input.annualQuantityKwh ?? null) : null,
    };
    if (input.fuel === "electricity" && input.gprn) throw new RuleViolation(["An electricity meter can't have a GPRN."]);
    if (input.fuel === "gas" && input.mprn) throw new RuleViolation(["A gas meter can't have an MPRN."]);
    assertRules(meterPointErrors(v));
    return v;
  }

  async addMeterPoint(actor: Actor, siteId: string, input: MeterPointInput) {
    const site = await this.site(actor, siteId);
    const v = this.cleanMeter(input);
    if ((site.serviceType === "electricity" && v.fuel === "gas") || (site.serviceType === "gas" && v.fuel === "electricity")) {
      throw new RuleViolation([`This is a ${site.serviceType} site, so it can't have a ${v.fuel} meter.`]);
    }
    const id = v.mprn ?? v.gprn;
    if (id) {
      const clash = await this.prisma.meterPoint.findFirst({ where: { OR: [{ mprn: id }, { gprn: id }], site: { opportunityId: site.opportunityId } } });
      if (clash) throw new RuleViolation([`${v.mprn ? "MPRN" : "GPRN"} ${id} is already on this opportunity.`]);
    }
    const m = await this.prisma.meterPoint.create({ data: { ...v, siteId } });
    await this.audit.log(actor, { action: "meter.create", entityType: "meter_point", entityId: m.id, summary: `Added ${v.fuel} meter ${id ?? ""}`.trim() });
    return m;
  }

  async updateMeterPoint(actor: Actor, meterId: string, input: MeterPointInput) {
    const m = await this.prisma.meterPoint.findUnique({ where: { id: meterId } });
    if (!m) throw new NotFound("Meter point");
    await this.site(actor, m.siteId);
    const updated = await this.prisma.meterPoint.update({ where: { id: meterId }, data: this.cleanMeter(input) });
    await this.audit.log(actor, { action: "meter.update", entityType: "meter_point", entityId: meterId, summary: "Updated meter point" });
    return updated;
  }

  async addReading(actor: Actor, meterId: string, input: z.infer<typeof meterReadingSchema>) {
    const m = await this.prisma.meterPoint.findUnique({ where: { id: meterId } });
    if (!m) throw new NotFound("Meter point");
    await this.site(actor, m.siteId);
    return this.prisma.meterReading.create({
      data: { meterPointId: meterId, readingType: input.readingType, register: input.register ?? null, value: input.value, readingDate: dateOnly(input.readingDate), documentItemId: input.documentId ?? null, createdById: actorRef(actor) },
    });
  }

  // --- Contracts -----------------------------------------------------------------

  private contractData(input: Partial<EnergyContractInput>) {
    return defined({
      siteId: input.siteId,
      fuel: input.fuel,
      existingSupplierName: input.existingSupplierName,
      existingSupplierAccount: input.existingSupplierAccount,
      selectedSupplierId: input.selectedSupplierId,
      currentContractStartDate: dateOnly(input.currentContractStartDate),
      currentContractEndDate: dateOnly(input.currentContractEndDate),
      proposedActivationDate: dateOnly(input.proposedActivationDate),
      termMonths: input.termMonths,
      pricingPlan: input.pricingPlan,
      dayRate: input.dayRate,
      nightRate: input.nightRate,
      peakRate: input.peakRate,
      otherRate: input.otherRate,
      gasRate: input.gasRate,
      standingCharge: input.standingCharge,
      priceType: input.priceType,
      nightStorageRate: input.nightStorageRate,
      summerDayRate: input.summerDayRate,
      winterDayRate: input.winterDayRate,
      supplierReference: input.supplierReference,
      status: input.status,
    });
  }

  private checkFuel(serviceType: string, fuel?: string) {
    if (serviceType === "electricity" && fuel === "gas") throw new RuleViolation(["This is an electricity opportunity, so it can't have a gas contract."]);
    if (serviceType === "gas" && fuel === "electricity") throw new RuleViolation(["This is a gas opportunity, so it can't have an electricity contract."]);
  }

  async addContract(actor: Actor, opportunityId: string, input: EnergyContractInput) {
    const opp = await this.energyOpp(actor, opportunityId);
    this.checkFuel(opp.serviceType, input.fuel);
    if (input.status && HISTORICAL.has(input.status)) throw new RuleViolation(["Contracts become live through activation."]);
    if (input.currentContractStartDate && input.currentContractEndDate && input.currentContractEndDate < input.currentContractStartDate) {
      throw new RuleViolation(["The current contract's end date is before its start date."]);
    }
    const c = await this.prisma.energyContract.create({
      data: { ...this.contractData(input), fuel: input.fuel, opportunityId, customerId: opp.customerId, selectedSupplierId: input.selectedSupplierId ?? opp.selectedSupplierId },
    });
    await this.audit.record(
      actor,
      { action: "contract.create", entityType: "energy_contract", entityId: c.id, summary: `Added ${c.fuel} contract` },
      { opportunityId, customerId: opp.customerId, kind: "system", body: `${c.fuel === "gas" ? "Gas" : "Electricity"} contract details added.` },
    );
    return c;
  }

  /** Live and ended contracts are historical records and can't be edited. */
  async updateContract(actor: Actor, contractId: string, input: Partial<EnergyContractInput>) {
    const c = await this.prisma.energyContract.findUnique({ where: { id: contractId } });
    if (!c) throw new NotFound("Contract");
    const opp = await this.energyOpp(actor, c.opportunityId);
    if (HISTORICAL.has(c.status)) throw new RuleViolation(["This contract is live or ended and is kept as history. Create a renewal to change it."]);
    if (input.status && HISTORICAL.has(input.status)) throw new RuleViolation(["Contracts become live through activation."]);
    this.checkFuel(opp.serviceType, input.fuel);
    const data = this.contractData(input);
    await this.prisma.energyContract.update({ where: { id: contractId }, data });
    await this.audit.log(actor, { action: "contract.update", entityType: "energy_contract", entityId: contractId, summary: `Updated ${Object.keys(data).join(", ")}` });
  }

  // --- Comparison quotes ------------------------------------------------------------

  async addQuote(actor: Actor, opportunityId: string, input: z.infer<typeof comparisonQuoteSchema>) {
    const opp = await this.energyOpp(actor, opportunityId);
    this.checkFuel(opp.serviceType, input.fuel);
    const supplier = await this.prisma.supplier.findUnique({ where: { id: input.supplierId } });
    if (!supplier || supplier.kind !== "energy") throw new RuleViolation(["Choose an energy supplier."]);
    return this.prisma.comparisonQuote.create({ data: { ...input, opportunityId, createdById: actorRef(actor) } });
  }

  /**
   * Selecting a quote records the chosen supplier on the opportunity and on draft contracts
   * for that fuel, and records the expected commission.
   */
  async selectQuote(actor: Actor, quoteId: string) {
    const q = await this.prisma.comparisonQuote.findUnique({ where: { id: quoteId }, include: { supplier: true } });
    if (!q) throw new NotFound("Quote");
    const opp = await this.energyOpp(actor, q.opportunityId);
    await this.prisma.$transaction(async (tx) => {
      await tx.comparisonQuote.updateMany({ where: { opportunityId: q.opportunityId, fuel: q.fuel }, data: { selected: false } });
      await tx.comparisonQuote.update({ where: { id: quoteId }, data: { selected: true } });
      await tx.opportunity.update({ where: { id: q.opportunityId }, data: { selectedSupplierId: q.supplierId } });
      await tx.energyContract.updateMany({
        where: { opportunityId: q.opportunityId, fuel: q.fuel, status: { in: ["draft", "quoted", "selected"] } },
        data: { selectedSupplierId: q.supplierId, termMonths: q.termMonths, dayRate: q.dayRate, nightRate: q.nightRate, gasRate: q.gasRate, standingCharge: q.standingCharge, status: "selected" },
      });
      const selected = await tx.comparisonQuote.findMany({ where: { opportunityId: q.opportunityId, selected: true } });
      const expected = selected.reduce((s, x) => s + Number(x.estimatedCommission ?? 0), 0);
      const existing = await tx.commission.findFirst({ where: { opportunityId: q.opportunityId, status: "expected" } });
      if (existing) await tx.commission.update({ where: { id: existing.id }, data: { amount: expected } });
      else if (expected > 0) await tx.commission.create({ data: { opportunityId: q.opportunityId, amount: expected, status: "expected", note: "From selected quote", createdById: actorRef(actor) } });
      await this.audit.record(
        actor,
        { action: "quote.select", entityType: "opportunity", entityId: q.opportunityId, summary: `Selected ${q.supplier.name} for ${q.fuel}` },
        { opportunityId: q.opportunityId, customerId: opp.customerId, kind: "system", body: `Customer chose ${q.supplier.name} (${q.fuel}, ${q.termMonths} months).` },
        tx,
      );
    });
  }
}
