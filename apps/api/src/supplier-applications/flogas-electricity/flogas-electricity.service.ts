import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  EMPTY_FLOGAS_ADDRESS,
  type FlogasAddress,
  type FlogasAnswers,
  type FlogasElectricityData,
  type FlogasMeterRow,
  type FlogasSaveInput,
  can,
  contactFullName,
  flogasAnswersSchema,
  flogasDefaultRequirements,
  flogasElectricityApplies,
  flogasElectricityIssues,
  flogasSigners,
  isFlogasSupplier,
  meterPointErrors,
  normalizeIdentifier,
  sameAddress,
} from "@uo/shared";
import type { flogasGenerateSchema, flogasSendSchema } from "@uo/shared";
import type { z } from "zod";
import { AuditService } from "../../audit/audit.service";
import { type Actor, actorRef } from "../../common/actor";
import { CryptoService } from "../../common/crypto.service";
import { Forbidden, RuleViolation } from "../../common/errors";
import { PrismaService } from "../../common/prisma.service";
import { dateOnly, isoDay, num, phoneKey } from "../../common/values";
import { fillPdf } from "../../forms/pdf";
import { OpportunityAccess } from "../../opportunities/access.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../../storage/storage";
import { type ApplicationFiller, ApplicationDocuments, type ApplicationKindInfo, dataHash } from "../application-documents";
import { FLOGAS_ELECTRICITY_LAYOUT as LAYOUT } from "./layout";
import { renderFlogasElectricity } from "./render";

const KIND = LAYOUT.workflow as "flogas_electricity";
const METERS = { meterPoints: { include: { readings: { orderBy: [{ readingDate: "desc" as const }, { createdAt: "desc" as const }] } } } };
type Tx = Prisma.TransactionClient;

/** Registers were free text before, so normalise them the way supplier forms read them. */
const register = (r: string | null) => {
  const k = (r ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["24h", "24hr", "24hour", "24hours", "general"].includes(k)) return "24h";
  return ["day", "night", "wattless"].includes(k) ? k : null;
};
const cent = (euro: Prisma.Decimal | null | undefined) => {
  const n = num(euro);
  return n === null ? null : Math.round(n * 10_000) / 100;
};
const addressOf = (a: { line1: string | null; line2: string | null; city: string | null; county: string | null; postcode: string | null } | null | undefined): FlogasAddress =>
  a ? { line1: a.line1, line2: a.line2, city: a.city, county: a.county, postcode: a.postcode } : { ...EMPTY_FLOGAS_ADDRESS };
const INFO: ApplicationKindInfo = {
  kind: KIND,
  label: "Flogas electricity",
  formName: "the Flogas form",
  missingTemplate: "The Flogas electricity form hasn't been set up yet. An administrator needs to upload the Flogas Commercial Agreement PDF under Admin → Supplier forms.",
};

/** How changes are named in the audit trail and timeline (never their values). */
const LABELS: Record<string, string> = {
  legalName: "legal entity",
  tradingName: "trading name",
  legalEntity: "legal entity type",
  vatExempt: "VAT exemption",
  vatExemptNumber: "VAT exempt number",
  priorityCustomer: "priority / special needs",
  businessType: "business type",
  companyRegNumber: "company registration number",
  vatNumber: "VAT number",
  phone: "telephone",
  contact: "account contact",
  billingAddress: "billing address",
  supplyAddress: "supply address",
  occupancyType: "premises ownership",
  occupiedSince: "moved-in date",
  leaseTerms: "terms of lease",
  landlordName: "landlord name",
  landlordContact: "landlord contact number",
  meters: "meter points",
  readings: "meter readings",
  contract: "contract details",
  bank: "bank details",
  debtorAddress: "debtor address",
  requirements: "actual requirement",
  billingSameAsSupply: "billing same as supply",
  existingFlogasCustomer: "existing Flogas customer",
  existingFlogasAccount: "existing Flogas account",
  sector: "sector",
  directDebit: "direct debit",
  debtorAddressSameAsBilling: "debtor address same as billing",
  mandateReference: "mandate reference",
  secondAccountHolder: "second account holder",
  signatoryName: "signatory name",
  signatoryPosition: "signatory position",
  agentSignature: "agent signature",
  flogasRepName: "Flogas representative",
  flogasActivationDate: "date of activation",
  excludedMeterPointIds: "meter rows",
  meterOrder: "meter row order",
};

type Context = Awaited<ReturnType<FlogasElectricityService["context"]>>;

/**
 * The Flogas electricity application on an opportunity (docs/flogas-electricity.md). Its data is
 * assembled from the CRM records plus the application's own answers; saving writes each value back
 * to where it lives. Generated versions go through the normal supplier-form pipeline (stored PDF,
 * online signing, second-person review) and are linked as append-only application versions.
 */
@Injectable()
export class FlogasElectricityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly docs: ApplicationDocuments,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // --- Loading ------------------------------------------------------------------------

  private async context(opportunityId: string) {
    const opp = await this.prisma.opportunity.findUniqueOrThrow({
      where: { id: opportunityId },
      include: {
        owner: { select: { name: true } },
        selectedSupplier: { select: { id: true, name: true, agencyId: true } },
        customer: { include: { contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }, addresses: true, bankAccounts: { orderBy: { createdAt: "desc" }, take: 1 } } },
        sites: { include: METERS, orderBy: { createdAt: "asc" } },
        contracts: { include: { site: { include: METERS } }, orderBy: { createdAt: "asc" } },
        workflowCase: { include: { site: { include: METERS } } },
        supplierApps: { where: { kind: KIND } },
      },
    });
    // The deal's own sites, then the supply point its case matched, then the sites its contracts renew.
    const sites = [...opp.sites, ...(opp.workflowCase?.site ? [opp.workflowCase.site] : []), ...opp.contracts.flatMap((c) => (c.site ? [c.site] : []))].filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i);
    const site = sites.find((s) => s.serviceType === "electricity" || s.serviceType === "dual_fuel") ?? sites[0] ?? null;
    const app = opp.supplierApps[0] ?? null;
    const parsed = flogasAnswersSchema.safeParse(app?.answers ?? {});
    const answers: FlogasAnswers = parsed.success ? parsed.data : {};
    const restricted = app?.restrictedEnc ? (this.crypto.decryptJson<{ debtorAddress?: FlogasAddress }>(app.restrictedEnc) ?? {}) : {};
    const allMeters = [site, ...sites.filter((s) => s !== site)].flatMap((s) => (s ? s.meterPoints.filter((m) => m.fuel === "electricity") : []));
    const order = answers.meterOrder ?? [];
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length + allMeters.findIndex((m) => m.id === id));
    const meters = allMeters.filter((m) => !answers.excludedMeterPointIds?.includes(m.id)).sort((a, b) => rank(a.id) - rank(b.id));
    const contract = opp.contracts.find((c) => c.fuel === "electricity" && c.status !== "cancelled") ?? null;
    const customer = opp.customer;
    return {
      opp,
      customer,
      contact: customer?.contacts[0] ?? null,
      billing: customer?.addresses.find((a) => a.kind === "billing") ?? null,
      bank: customer?.bankAccounts[0] ?? null,
      site,
      allMeters,
      meters,
      contract,
      app,
      answers,
      restricted,
      broker: await this.docs.brokerProfile(),
    };
  }

  private applies(ctx: Context) {
    return flogasElectricityApplies({ productInterest: ctx.opp.productInterest, serviceType: ctx.opp.serviceType, supplierName: ctx.opp.selectedSupplier?.name });
  }

  private assertApplies(ctx: Context) {
    if (!this.applies(ctx)) throw new RuleViolation(["The Flogas electricity application only applies when Electricity is a product of interest and Flogas is the selected supplier."]);
  }

  /** The application as the form shows and prints it. Bank values are decrypted only when `reveal` is set. */
  private assemble(ctx: Context, reveal: boolean): FlogasElectricityData {
    const { opp, customer: c, contact, billing, bank, site, contract, answers: a } = ctx;
    const supplyAddress = addressOf(site);
    const billingAddress = addressOf(billing);
    const rows: FlogasMeterRow[] = ctx.meters.map((m) => {
      const latest = (regs: string[]) => m.readings.find((r) => regs.includes(register(r.register) ?? ""));
      const value = (regs: string[]) => num(latest(regs)?.value);
      return { id: m.id, mprn: m.mprn, mccCode: m.mccCode, formatException: !!m.formatExceptionReason?.trim(), day: value(["24h", "day"]), night: value(["night"]), wattless: value(["wattless"]) };
    });
    const shown = ctx.meters.flatMap((m) => m.readings.filter((r) => ["24h", "day", "night", "wattless"].includes(register(r.register) ?? "")).slice(0, 1));
    const readingDate = shown.map((r) => isoDay(r.readingDate)!).sort().pop() ?? null;
    const existingIsFlogas = isFlogasSupplier(contract?.existingSupplierName);
    const night = cent(contract?.nightRate);
    const day = cent(contract?.dayRate);
    return {
      legalName: c?.legalName ?? opp.companyName,
      tradingName: c?.tradingName ?? null,
      supplyAddress,
      billingSameAsSupply: a.billingSameAsSupply ?? (!billing || sameAddress(billingAddress, supplyAddress)),
      billingAddress,
      legalEntity: c?.legalEntity ?? null,
      vatExempt: c?.vatExempt ?? null,
      vatExemptNumber: c?.vatExemptNumber ?? null,
      priorityCustomer: c?.priorityCustomer ?? null,
      businessType: c?.businessType ?? null,
      companyRegNumber: c?.companyRegNumber ?? null,
      vatNumber: c?.vatNumber ?? null,
      contactFirstName: contact?.firstName ?? (contact ? null : opp.contactName),
      contactLastName: contact?.lastName ?? null,
      telephone: c?.phone ?? contact?.phone ?? opp.phone,
      mobile: contact?.mobile ?? null,
      email: contact?.email ?? c?.email ?? opp.email,
      occupancyType: site?.occupancyType ?? null,
      occupiedSince: isoDay(site?.occupiedSince),
      leaseTerms: site?.leaseTerms ?? null,
      landlordName: site?.landlordName ?? null,
      landlordContact: site?.landlordContact ?? null,
      requirements: a.requirements ?? flogasDefaultRequirements({ supplyChanges: opp.supplyChanges, saleType: opp.saleType, newSupplyPoint: opp.workflowCase?.supplyPath === "new_supply_point" }),
      meters: rows,
      readingDate,
      existingFlogasCustomer: a.existingFlogasCustomer !== undefined ? a.existingFlogasCustomer : existingIsFlogas ? true : null,
      existingFlogasAccount: a.existingFlogasAccount !== undefined ? a.existingFlogasAccount : existingIsFlogas ? (contract?.existingSupplierAccount ?? null) : null,
      expectedChangeover: isoDay(contract?.proposedActivationDate),
      termMonths: contract?.termMonths ?? null,
      sector: a.sector !== undefined ? a.sector : night !== null ? "gp_night_saver" : day !== null ? "gp_24h" : null,
      priceType: contract?.priceType ?? null,
      dayRateCent: day,
      nightRateCent: night,
      directDebit: a.directDebit ?? true,
      debtorName: bank && reveal ? this.crypto.decrypt(bank.accountNameEnc) : null,
      debtorAddressSameAsBilling: a.debtorAddressSameAsBilling ?? true,
      debtorAddress: ctx.restricted.debtorAddress ?? { ...EMPTY_FLOGAS_ADDRESS },
      iban: bank && reveal ? this.crypto.decrypt(bank.ibanEnc) : null,
      bic: bank?.bicEnc && reveal ? this.crypto.decrypt(bank.bicEnc) : null,
      bankOnFile: !!bank,
      ibanLast4: bank?.ibanLast4 ?? null,
      mandateReference: a.mandateReference ?? null,
      secondAccountHolder: a.secondAccountHolder ? { name: a.secondAccountHolder.name ?? null, email: a.secondAccountHolder.email ?? null } : null,
      signatoryName: a.signatoryName !== undefined ? a.signatoryName : (contactFullName({ contactFirstName: contact?.firstName ?? null, contactLastName: contact?.lastName ?? null }) ?? opp.contactName),
      signatoryPosition: a.signatoryPosition !== undefined ? a.signatoryPosition : (contact?.jobTitle ?? opp.contactRole),
      agentSignature: a.agentSignature ?? false,
      agencyId: opp.selectedSupplier?.agencyId ?? null,
      agencyName: ctx.broker.companyName,
      agentName: opp.owner?.name ?? null,
      flogasRepName: a.flogasRepName ?? null,
      flogasActivationDate: a.flogasActivationDate ?? null,
    };
  }

  // --- Reading ------------------------------------------------------------------------

  async view(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    const ctx = await this.context(opportunityId);
    const permissions = this.docs.permissions(actor, ctx.opp);
    const full = this.assemble(ctx, true);
    const data = permissions.bankRead ? full : this.assemble(ctx, false);
    if (permissions.bankRead && ctx.bank) await this.audit.sensitiveAccess(actor, "opportunity", opportunityId, "bank details for the Flogas electricity application");
    const [template, docs] = await Promise.all([this.docs.template(KIND), this.docs.describe(ctx.app?.id, dataHash(full))]);
    return {
      applies: this.applies(ctx),
      needsCustomer: !ctx.customer,
      template: template ? { id: template.id, name: template.name, version: template.version } : null,
      layoutVersion: LAYOUT.version,
      data,
      /** Answers given on this application; the rest still show their CRM-derived defaults. */
      answered: Object.keys(ctx.answers),
      issues: flogasElectricityIssues(full),
      signers: flogasSigners(full),
      ...docs,
      contract: ctx.contract ? { id: ctx.contract.id, readOnly: ctx.contract.status === "live" || ctx.contract.status === "ended" } : null,
      permissions,
    };
  }

  /** Who did what to this application, its versions, their signing and downloads, newest first. */
  async history(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    return this.docs.history(opportunityId, KIND);
  }

  // --- Saving a draft -------------------------------------------------------------------

  async save(actor: Actor, opportunityId: string, input: FlogasSaveInput) {
    const opp = await this.access.writable(actor, opportunityId);
    if (opp.outcome !== "open") throw new RuleViolation(["Only open opportunities can be changed."]);
    const ctx = await this.context(opportunityId);
    this.assertApplies(ctx);
    const customer = ctx.customer;
    if (!customer) throw new RuleViolation(["Create or link the customer first, so the application is filled from their record."]);
    if ((input.customer || input.contact || input.billingAddress) && !can(actor, "customer.write")) throw new Forbidden("You can't change customer details.");
    if ((input.bank || input.debtorAddress) && !can(actor, "bank.write")) throw new Forbidden("You can't change bank details.");
    const before = this.assemble(ctx, true);
    const changed = new Set<string>();

    await this.prisma.$transaction(async (tx) => {
      // Customer
      if (input.customer) {
        const c = input.customer;
        const next: Record<string, unknown> = {
          legalName: c.legalName,
          tradingName: c.tradingName,
          legalEntity: c.legalEntity,
          vatExempt: c.vatExempt,
          vatExemptNumber: c.vatExemptNumber,
          priorityCustomer: c.priorityCustomer,
          businessType: c.businessType,
          companyRegNumber: c.companyRegNumber,
          vatNumber: c.vatNumber,
          phone: c.telephone,
        };
        const data = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== undefined && v !== (customer as Record<string, unknown>)[k]));
        if (Object.keys(data).length) {
          if ("phone" in data) data.phoneKey = phoneKey(data.phone as string | null);
          await tx.customer.update({ where: { id: customer.id }, data });
          Object.keys(data).filter((k) => k !== "phoneKey").forEach((k) => changed.add(k));
        }
      }
      // Account contact
      if (input.contact) {
        const k = input.contact;
        const cur = ctx.contact;
        if (cur) {
          const data = Object.fromEntries(Object.entries({ firstName: k.firstName, lastName: k.lastName, mobile: k.mobile, email: k.email }).filter(([key, v]) => v !== undefined && v !== (cur as Record<string, unknown>)[key]));
          if (Object.keys(data).length) {
            await tx.customerContact.update({ where: { id: cur.id }, data: { ...data, ...(data.mobile !== undefined ? { mobileKey: phoneKey(data.mobile as string | null) } : {}) } });
            changed.add("contact");
          }
        } else if (k.firstName || k.lastName || k.mobile || k.email) {
          if (!k.firstName) throw new RuleViolation(["Enter the account contact's first name."]);
          await tx.customerContact.create({ data: { customerId: customer.id, firstName: k.firstName, lastName: k.lastName ?? null, mobile: k.mobile ?? null, mobileKey: phoneKey(k.mobile), email: k.email ?? null, isPrimary: true } });
          changed.add("contact");
        }
      }
      // Billing address
      if (input.billingAddress && !sameAddress(addressOf({ ...EMPTY_FLOGAS_ADDRESS, ...input.billingAddress } as FlogasAddress), addressOf(ctx.billing))) {
        const b = input.billingAddress;
        if (!b.line1) throw new RuleViolation(["Enter the first line of the billing address."]);
        const data = { line1: b.line1, line2: b.line2 ?? null, city: b.city ?? null, county: b.county ?? null, postcode: b.postcode ?? null };
        if (ctx.billing) await tx.customerAddress.update({ where: { id: ctx.billing.id }, data });
        else await tx.customerAddress.create({ data: { ...data, customerId: customer.id, kind: "billing" } });
        changed.add("billingAddress");
      }
      // Supply site and premises
      const siteId = await this.saveSite(tx, ctx, input, changed);
      // Meters and readings
      const meterAnswers = input.meters ? await this.saveMeters(tx, actor, ctx, siteId, input, before, changed) : {};
      // Contract
      await this.saveContract(tx, ctx, siteId, input, changed);
      // Bank details: a change is a new bank account; the old one is kept.
      if (input.bank) {
        const cur = ctx.bank ? { name: this.crypto.decrypt(ctx.bank.accountNameEnc), iban: this.crypto.decrypt(ctx.bank.ibanEnc), bic: ctx.bank.bicEnc ? this.crypto.decrypt(ctx.bank.bicEnc) : null } : null;
        const b = input.bank;
        if (!cur || cur.name !== b.accountName || cur.iban !== b.iban || (cur.bic ?? null) !== (b.bic ?? null)) {
          if (cur && cur.iban !== b.iban && !input.confirmIbanChange) throw new RuleViolation(["The IBAN differs from the one on file. Confirm the change with the customer, then tick to confirm it."]);
          await tx.bankAccount.create({
            data: { customerId: customer.id, accountNameEnc: this.crypto.encrypt(b.accountName), ibanEnc: this.crypto.encrypt(b.iban), ibanLast4: b.iban.slice(-4), bicEnc: this.crypto.encrypt(b.bic ?? null), createdById: actorRef(actor) },
          });
          changed.add("bank");
        }
      }
      // The application's own answers
      const answers = flogasAnswersSchema.parse({ ...ctx.answers, ...input.answers, ...meterAnswers });
      for (const k of Object.keys(answers) as (keyof FlogasAnswers)[]) if (JSON.stringify(answers[k]) !== JSON.stringify(ctx.answers[k])) changed.add(k);
      let restrictedEnc = ctx.app?.restrictedEnc ?? null;
      if (input.debtorAddress && !sameAddress(addressOf({ ...EMPTY_FLOGAS_ADDRESS, ...input.debtorAddress } as FlogasAddress), ctx.restricted.debtorAddress ?? EMPTY_FLOGAS_ADDRESS)) {
        restrictedEnc = this.crypto.encryptJson({ debtorAddress: addressOf({ ...EMPTY_FLOGAS_ADDRESS, ...input.debtorAddress } as FlogasAddress) });
        changed.add("debtorAddress");
      }
      const app = ctx.app
        ? await tx.supplierApplication.update({ where: { id: ctx.app.id }, data: { answers: answers as Prisma.InputJsonValue, restrictedEnc, updatedById: actorRef(actor) } })
        : await tx.supplierApplication.create({ data: { opportunityId, kind: KIND, answers: answers as Prisma.InputJsonValue, restrictedEnc, createdById: actorRef(actor), updatedById: actorRef(actor) } });
      if (changed.size) {
        const names = [...new Set([...changed].map((k) => LABELS[k] ?? k))];
        await this.audit.record(
          actor,
          { action: "supplier_application.save", entityType: "supplier_application", entityId: app.id, summary: "Saved the Flogas electricity application draft", data: { changed: names } },
          { opportunityId, customerId: customer.id, kind: "document", body: `Flogas electricity application saved: ${names.join(", ")} updated.` },
          tx,
        );
      }
    });
    return this.view(actor, opportunityId);
  }

  /** Updates (or creates) the deal's electricity supply site. Returns its id, or null if there is none yet. */
  private async saveSite(tx: Tx, ctx: Context, input: FlogasSaveInput, changed: Set<string>): Promise<string | null> {
    const site = ctx.site;
    const a = input.supplyAddress;
    const p = input.premises;
    const data: Record<string, unknown> = {};
    if (a && !sameAddress(addressOf({ ...EMPTY_FLOGAS_ADDRESS, ...a } as FlogasAddress), addressOf(site))) {
      if (!a.line1) throw new RuleViolation(["Enter the first line of the supply address."]);
      Object.assign(data, { line1: a.line1, line2: a.line2 ?? null, city: a.city ?? null, county: a.county ?? null, postcode: a.postcode ?? null });
      changed.add("supplyAddress");
    }
    if (p) {
      const cur = { occupancyType: site?.occupancyType ?? null, occupiedSince: isoDay(site?.occupiedSince), leaseTerms: site?.leaseTerms ?? null, landlordName: site?.landlordName ?? null, landlordContact: site?.landlordContact ?? null };
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined || v === cur[k as keyof typeof cur]) continue;
        data[k] = k === "occupiedSince" ? dateOnly(v as string | null) : v;
        changed.add(k);
      }
    }
    if (!Object.keys(data).length) return site?.id ?? null;
    if (site) {
      await tx.supplySite.update({ where: { id: site.id }, data });
      return site.id;
    }
    if (!data.line1) throw new RuleViolation(["Enter the supply address first."]);
    const created = await tx.supplySite.create({
      data: { ...(data as { line1: string }), opportunityId: ctx.opp.id, customerId: ctx.opp.customerId, serviceType: ctx.opp.serviceType === "dual_fuel" ? "dual_fuel" : "electricity" },
    });
    return created.id;
  }

  /** Meter rows: existing meter points are updated, new rows become meter points, removed rows are left off this application (kept on the deal). */
  private async saveMeters(tx: Tx, actor: Actor, ctx: Context, siteId: string | null, input: FlogasSaveInput, before: FlogasElectricityData, changed: Set<string>): Promise<Partial<FlogasAnswers>> {
    const rows = input.meters!;
    const known = new Map(ctx.allMeters.map((m) => [m.id, m]));
    const mprns = new Set<string>();
    const ids: string[] = [];
    const sector = input.answers?.sector !== undefined ? input.answers.sector : before.sector;
    const readingDate = input.readingDate !== undefined ? input.readingDate : before.readingDate;
    for (const [i, row] of rows.entries()) {
      const mprn = normalizeIdentifier(row.mprn);
      const mccCode = normalizeIdentifier(row.mccCode);
      if (mprn) {
        if (mprns.has(mprn)) throw new RuleViolation([`MPRN ${mprn} is on the form twice.`]);
        mprns.add(mprn);
      }
      let meter = row.id ? known.get(row.id) : undefined;
      if (row.id && !meter) throw new RuleViolation([`Meter row ${i + 1} isn't on this opportunity.`]);
      const errors = meterPointErrors({ fuel: "electricity", mprn, gprn: null, formatExceptionReason: meter?.formatExceptionReason });
      if (errors.length) throw new RuleViolation(errors.map((e) => `Meter row ${i + 1}: ${e}`));
      if (meter) {
        if (meter.mprn !== mprn || meter.mccCode !== mccCode) {
          await tx.meterPoint.update({ where: { id: meter.id }, data: { mprn, mccCode } });
          changed.add("meters");
        }
      } else {
        if (!siteId) throw new RuleViolation(["Enter the supply address first, so the meter has a site."]);
        if (mprn && ctx.allMeters.some((m) => m.mprn === mprn)) throw new RuleViolation([`MPRN ${mprn} is already on this opportunity.`]);
        const created = await tx.meterPoint.create({ data: { siteId, fuel: "electricity", mprn, mccCode } });
        meter = { ...created, readings: [] };
        changed.add("meters");
      }
      ids.push(meter.id);
      // Readings are history: a different value or date is a new reading.
      const regs: [string, number | null | undefined][] = [
        [sector === "gp_24h" ? "24h" : "day", row.day],
        ["night", row.night],
        ["wattless", i === 0 ? row.wattless : null],
      ];
      for (const [reg, value] of regs) {
        if (value === null || value === undefined) continue;
        const latest = meter.readings.find((r) => register(r.register) === reg || (reg === "day" && register(r.register) === "24h") || (reg === "24h" && register(r.register) === "day"));
        if (latest && num(latest.value) === value && isoDay(latest.readingDate) === readingDate) continue;
        if (!readingDate) throw new RuleViolation(["Enter the date of the meter reading."]);
        await tx.meterReading.create({ data: { meterPointId: meter.id, readingType: "actual", register: reg, value, readingDate: dateOnly(readingDate), createdById: actorRef(actor) } });
        changed.add("readings");
      }
    }
    return { meterOrder: ids, excludedMeterPointIds: ctx.allMeters.map((m) => m.id).filter((id) => !ids.includes(id)) };
  }

  /** The deal's electricity contract: updated, or created for Flogas. Live and ended contracts are history. */
  private async saveContract(tx: Tx, ctx: Context, siteId: string | null, input: FlogasSaveInput, changed: Set<string>) {
    const k = input.contract ?? {};
    const c = ctx.contract;
    const data: Prisma.EnergyContractUncheckedUpdateInput = {};
    if (k.expectedChangeover !== undefined && k.expectedChangeover !== isoDay(c?.proposedActivationDate)) data.proposedActivationDate = dateOnly(k.expectedChangeover);
    if (k.termMonths !== undefined && k.termMonths !== (c?.termMonths ?? null)) data.termMonths = k.termMonths;
    // "Fixed" keeps a fully fixed contract fully fixed.
    if (k.priceType !== undefined && !(k.priceType === "fixed" && c?.priceType === "fully_fixed") && k.priceType !== (c?.priceType ?? null)) data.priceType = k.priceType;
    if (k.dayRateCent !== undefined && k.dayRateCent !== cent(c?.dayRate)) data.dayRate = k.dayRateCent === null ? null : k.dayRateCent / 100;
    if (k.nightRateCent !== undefined && k.nightRateCent !== cent(c?.nightRate)) data.nightRate = k.nightRateCent === null ? null : k.nightRateCent / 100;
    // A GP 24HR contract has no night rate.
    if (input.answers?.sector === "gp_24h" && c?.nightRate != null) data.nightRate = null;
    if (!Object.keys(data).length) return;
    if (c && (c.status === "live" || c.status === "ended")) throw new RuleViolation(["The electricity contract is live or ended and is kept as history, so its details can't change here."]);
    if (c) await tx.energyContract.update({ where: { id: c.id }, data });
    else {
      await tx.energyContract.create({
        data: { ...(data as Prisma.EnergyContractUncheckedCreateInput), opportunityId: ctx.opp.id, customerId: ctx.opp.customerId, fuel: "electricity", selectedSupplierId: ctx.opp.selectedSupplierId, siteId },
      });
    }
    changed.add("contract");
  }

  // --- Documents ------------------------------------------------------------------------

  /** Generates the next version on the original Flogas PDF (see ApplicationDocuments.generate). */
  async generate(actor: Actor, opportunityId: string, input: z.infer<typeof flogasGenerateSchema>) {
    const opp = await this.access.writable(actor, opportunityId);
    if (opp.outcome !== "open") throw new RuleViolation(["Forms can only be generated for open opportunities."]);
    const ctx = await this.context(opportunityId);
    this.assertApplies(ctx);
    if (!ctx.customer) throw new RuleViolation(["Create or link the customer first, so the application is filled from their record."]);
    const data = this.assemble(ctx, true);
    const issues = flogasElectricityIssues(data);
    if (issues.length) throw new RuleViolation(issues.map((i) => i.message));
    return this.docs.generate(actor, INFO, {
      opp: ctx.opp,
      appId: ctx.app?.id ?? null,
      data,
      layoutVersion: LAYOUT.version,
      filler: this.filler(data),
      sensitive: (values) => !!values.iban,
      confirmReplace: input.confirmReplace,
    });
  }

  private filler(data: FlogasElectricityData): ApplicationFiller {
    return {
      fill: async (template, title) => {
        const rendered = await renderFlogasElectricity(data, flogasSigners(data));
        if (rendered.issues.length) return { fields: rendered.fields, values: rendered.values, bytes: new Uint8Array(), issues: rendered.issues };
        const filled = await fillPdf({ template, fields: rendered.fields, values: rendered.values, title });
        return { fields: rendered.fields, values: rendered.values, bytes: filled.bytes, issues: filled.issues };
      },
    };
  }

  /**
   * A preview of the draft as it stands, on the original PDF and marked as a draft. Nothing is
   * stored. Bank details are masked for anyone who can't read them.
   */
  async preview(actor: Actor, opportunityId: string): Promise<Buffer> {
    await this.access.readable(actor, opportunityId);
    const ctx = await this.context(opportunityId);
    this.assertApplies(ctx);
    const t = await this.docs.template(KIND);
    if (!t) throw new RuleViolation([INFO.missingTemplate]);
    const reveal = can(actor, "bank.read");
    const data = this.assemble(ctx, reveal);
    if (!reveal && data.bankOnFile) Object.assign(data, { iban: `${"X".repeat(18)}${data.ibanLast4 ?? ""}`, debtorName: "On file (restricted)", bic: null });
    const filled = await this.filler(data).fill(await this.storage.get(t.storageKey), "Flogas electricity application (draft preview)");
    if (!filled.bytes.length) throw new RuleViolation(filled.issues);
    await this.audit.log(actor, { action: "supplier_application.preview", entityType: "supplier_application", entityId: ctx.app?.id ?? null, summary: `Previewed the Flogas electricity draft${reveal && data.bankOnFile ? " with bank details" : ""}` });
    return this.docs.markDraft(filled.bytes);
  }

  /** The current data's hash, after the checks every send needs: write access, open deal, still Flogas + Electricity. */
  private async currentHash(actor: Actor, opportunityId: string) {
    const opp = await this.access.writable(actor, opportunityId);
    if (opp.outcome !== "open") throw new RuleViolation(["Only open opportunities can be sent for signature."]);
    const ctx = await this.context(opportunityId);
    this.assertApplies(ctx);
    return dataHash(this.assemble(ctx, true));
  }

  async send(actor: Actor, opportunityId: string, formId: string, input: z.infer<typeof flogasSendSchema>) {
    return this.docs.send(actor, opportunityId, formId, await this.currentHash(actor, opportunityId), input);
  }

  async resend(actor: Actor, opportunityId: string, linkId: string) {
    return this.docs.resend(actor, opportunityId, linkId, await this.currentHash(actor, opportunityId));
  }
}
