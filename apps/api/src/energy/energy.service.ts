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
    return { serviceType: opp.serviceType, sites, contracts, quotes, previousContracts: history };
  }

  // --- Sites ---------------------------------------------------------------

  async addSite(actor: Actor, opportunityId: string, input: SupplySiteInput) {
    const opp = await this.energyOpp(actor, opportunityId);
    const { address, ...rest } = input;
    const { kind: _kind, ...addressFields } = address;
    const site = await this.prisma.supplySite.create({
      data: { ...rest, ...addressFields, opportunityId, customerId: opp.customerId, annualConsumptionKwh: input.annualConsumptionKwh ?? null },
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
    await this.prisma.supplySite.update({ where: { id: siteId }, data: defined({ ...rest, ...addressFields }) });
    await this.audit.log(actor, { action: "site.update", entityType: "supply_site", entityId: siteId, summary: "Updated supply site" });
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
