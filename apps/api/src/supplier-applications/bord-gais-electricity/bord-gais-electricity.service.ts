import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  BORD_GAIS_RATE_COLUMNS,
  BORD_GAIS_RATE_ROWS,
  BORD_GAIS_REGISTERS,
  type ApplicationAddress,
  type BordGaisAnswers,
  type BordGaisElectricityData,
  type BordGaisMeter,
  type BordGaisRateColumn,
  type BordGaisRates,
  type BordGaisRegister,
  type BordGaisSaveInput,
  EMPTY_ADDRESS,
  type PriceType,
  RATE_ROW_FOR,
  bordGaisAnswersSchema,
  bordGaisContactName,
  bordGaisElectricityApplies,
  bordGaisElectricityIssues,
  bordGaisSigners,
  can,
  emptyRates,
  meterPointErrors,
  normalizeIdentifier,
  sameAddress,
} from "@uo/shared";
import type { bordGaisSendSchema } from "@uo/shared";
import type { z } from "zod";
import { AuditService } from "../../audit/audit.service";
import { type Actor, actorRef } from "../../common/actor";
import { CryptoService } from "../../common/crypto.service";
import { Forbidden, RuleViolation } from "../../common/errors";
import { PrismaService } from "../../common/prisma.service";
import { dateOnly, isoDay, num, phoneKey } from "../../common/values";
import { fillAcroForm } from "../../forms/acroform";
import { OpportunityAccess } from "../../opportunities/access.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../../storage/storage";
import { type ApplicationFiller, ApplicationDocuments, type ApplicationKindInfo, dataHash } from "../application-documents";
import { BGE_LAYOUT as LAYOUT } from "./layout";
import { renderBordGaisElectricity } from "./render";

const KIND = "bord_gais_electricity" as const;
const INFO: ApplicationKindInfo = {
  kind: KIND,
  label: "Bord Gáis electricity",
  formName: "the Bord Gáis form",
  missingTemplate: "The Bord Gáis electricity form hasn't been set up yet. An administrator needs to upload the Bord Gáis Business Electricity Customer Agreement Form under Admin → Supplier forms.",
};
const METERS = { meterPoints: { include: { readings: { orderBy: [{ readingDate: "desc" as const }, { createdAt: "desc" as const }] } } } };
type Tx = Prisma.TransactionClient;

/** Registers were free text before, so normalise them the way supplier forms read them. */
const register = (r: string | null): BordGaisRegister | null => {
  const k = (r ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["24h", "24hr", "24hour", "24hours", "general"].includes(k)) return "24h";
  if (k === "nightstorage" || k === "storage") return "night_storage";
  return k === "day" || k === "night" || k === "wattless" ? k : null;
};
const cent = (euro: Prisma.Decimal | null | undefined) => {
  const n = num(euro);
  return n === null ? null : Math.round(n * 10_000) / 100;
};
const addressOf = (a: { line1: string | null; line2: string | null; city: string | null; county: string | null; postcode: string | null } | null | undefined): ApplicationAddress =>
  a ? { line1: a.line1, line2: a.line2, city: a.city, county: a.county, postcode: a.postcode } : { ...EMPTY_ADDRESS };
const fullAddress = (a: Partial<ApplicationAddress> | undefined): ApplicationAddress => ({ ...EMPTY_ADDRESS, ...a });
const noReadings = (): Record<BordGaisRegister, string | null> => ({ "24h": null, day: null, night: null, night_storage: null, wattless: null });

/** The contract columns that hold the cells of the rate type's row. The day rate is the 24-hour rate when there's no night rate. */
type ContractRate = "dayRate" | "nightRate" | "nightStorageRate" | "summerDayRate" | "winterDayRate" | "standingCharge";
function contractCells(night: number | null): Partial<Record<BordGaisRateColumn, ContractRate>> {
  return { [night !== null ? "day1" : "rate24h1"]: "dayRate", night: "nightRate", nightStorage: "nightStorageRate", summerDay: "summerDayRate", winterDay: "winterDayRate", standingCharge: "standingCharge" };
}

/** How changes are named in the audit trail and timeline (never their values). */
const LABELS: Record<string, string> = {
  legalName: "legal name",
  tradingName: "trading name",
  legalEntity: "organisation type",
  businessType: "main activity",
  incorporationDate: "date established",
  companyRegNumber: "CRO number",
  employees: "number of employees",
  priorityCustomer: "priority customer",
  marketing: "marketing preferences",
  contact: "contact",
  accountAddress: "account-holder address",
  homeAddress: "home address",
  billingAddress: "billing address",
  supplyAddress: "supply address",
  site: "site details",
  meter: "meter details",
  readings: "meter readings",
  contract: "agreement details",
  rates: "rates",
  bank: "bank details",
  accountHolderName: "account holder's name",
  premisesContact: "premises contact",
  billingContactName: "billing contact",
  billingSource: "where the bill goes",
  confirmationEndDate: "confirmation period end date",
  discounts: "discounts",
  broaderMarketing: "broader marketing",
  signatoryName: "signatory name",
  directDebit: "direct debit",
  mandateReference: "mandate reference",
  secondAccountHolder: "second account holder",
};

type Context = Awaited<ReturnType<BordGaisElectricityService["context"]>>;

/**
 * The Bord Gáis Energy electricity application on an opportunity (docs/bord-gais-electricity.md).
 * Its data is assembled from the CRM records plus the application's own answers, and saving writes
 * each value back to where it lives. The PDF's own fields are filled (forms/acroform.ts); versions,
 * signing and history are shared with every supplier application (ApplicationDocuments).
 */
@Injectable()
export class BordGaisElectricityService {
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
        selectedSupplier: { select: { id: true, name: true } },
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
    // A single-site form: the site's first electricity meter point (one MPRN, up to two meters).
    const meter = site?.meterPoints.find((m) => m.fuel === "electricity") ?? null;
    const app = opp.supplierApps[0] ?? null;
    const parsed = bordGaisAnswersSchema.safeParse(app?.answers ?? {});
    const answers: BordGaisAnswers = parsed.success ? parsed.data : {};
    const customer = opp.customer;
    const addr = (kind: string) => customer?.addresses.find((a) => a.kind === kind) ?? null;
    return {
      opp,
      customer,
      contact: customer?.contacts[0] ?? null,
      accountAddress: addr("registered") ?? addr("trading"),
      homeAddress: addr("home"),
      billing: addr("billing"),
      bank: customer?.bankAccounts[0] ?? null,
      site,
      meter,
      contract: opp.contracts.find((c) => c.fuel === "electricity" && c.status !== "cancelled") ?? null,
      app,
      answers,
    };
  }

  private applies(ctx: Context) {
    return bordGaisElectricityApplies({ productInterest: ctx.opp.productInterest, serviceType: ctx.opp.serviceType, supplierName: ctx.opp.selectedSupplier?.name });
  }

  private assertApplies(ctx: Context) {
    if (!this.applies(ctx)) throw new RuleViolation(["The Bord Gáis electricity application only applies when Electricity is a product of interest and Bord Gáis Energy is the selected supplier."]);
  }

  /** The readings of one meter (by serial), latest per register, as read. */
  private meterReadings(ctx: Context, serial: string | null, first: boolean): Record<BordGaisRegister, string | null> {
    const out = noReadings();
    // Readings recorded before meters had serials belong to the first meter.
    for (const r of ctx.meter?.readings ?? []) {
      const reg = register(r.register);
      if (!reg || out[reg] !== null) continue;
      if (r.meterSerial ? r.meterSerial !== serial : !first) continue;
      out[reg] = r.rawValue ?? String(num(r.value));
    }
    return out;
  }

  /** The rate table: the rate type's row from the contract, every other cell from the answers. */
  private rates(ctx: Context): BordGaisRates {
    const rates = emptyRates();
    for (const row of BORD_GAIS_RATE_ROWS) for (const col of BORD_GAIS_RATE_COLUMNS) rates[row][col] = ctx.answers.rates?.[row]?.[col] ?? null;
    const c = ctx.contract;
    if (c?.priceType) {
      const row = RATE_ROW_FOR[c.priceType];
      for (const [col, column] of Object.entries(contractCells(cent(c.nightRate)))) rates[row][col as BordGaisRateColumn] = cent(c[column as ContractRate]);
    }
    return rates;
  }

  /** The application as the form shows and prints it. Bank values are decrypted only when `reveal` is set. */
  private assemble(ctx: Context, reveal: boolean): BordGaisElectricityData {
    const { opp, customer: c, contact, site, meter, contract, bank, answers: a } = ctx;
    const contactName = bordGaisContactName({ contactFirstName: contact?.firstName ?? null, contactLastName: contact?.lastName ?? null }) ?? opp.contactName;
    const accountAddress = addressOf(ctx.accountAddress);
    const supplyAddress = addressOf(site);
    const billingAddress = addressOf(ctx.billing);
    const telephone = contact?.phone ?? c?.phone ?? opp.phone;
    const email = contact?.email ?? c?.email ?? opp.email;
    const meters: [BordGaisMeter, BordGaisMeter] = [
      { serial: meter?.meterNumber ?? null, readings: this.meterReadings(ctx, meter?.meterNumber ?? null, true) },
      { serial: meter?.meterSerial2 ?? null, readings: this.meterReadings(ctx, meter?.meterSerial2 ?? null, false) },
    ];
    const shown = (meter?.readings ?? []).filter((r) => register(r.register));
    return {
      legalName: c?.legalName ?? opp.companyName,
      tradingName: c?.tradingName ?? null,
      accountHolderName: a.accountHolderName ?? c?.legalName ?? opp.companyName,
      accountAddress,
      mainActivity: c?.businessType ?? null,
      dateEstablished: isoDay(c?.incorporationDate),
      organisationType: c?.legalEntity ?? null,
      croNumber: c?.companyRegNumber ?? null,
      employees: c?.employees ?? null,
      homeAddress: addressOf(ctx.homeAddress),
      contactFirstName: contact?.firstName ?? (contact ? null : opp.contactName),
      contactLastName: contact?.lastName ?? null,
      position: contact?.jobTitle ?? opp.contactRole,
      email,
      telephone,
      mobile: contact?.mobile ?? null,
      siteName: site?.label ?? null,
      supplyAddress,
      premisesContactName: a.premisesContact?.name ?? contactName,
      premisesTelephone: a.premisesContact?.telephone ?? telephone,
      premisesFax: a.premisesContact?.fax ?? null,
      premisesEmail: a.premisesContact?.email ?? email,
      premisesMobile: a.premisesContact?.mobile ?? contact?.mobile ?? null,
      priorityCustomer: c?.priorityCustomer ?? null,
      billingContactName: a.billingContactName ?? contactName,
      billingSource: a.billingSource ?? (!ctx.billing || sameAddress(billingAddress, accountAddress) ? "account_holder" : sameAddress(billingAddress, supplyAddress) ? "supply" : "separate"),
      billingAddress,
      mprn: meter?.mprn ?? null,
      mprnFormatException: !!meter?.formatExceptionReason?.trim(),
      mic: num(meter?.mic),
      dgCode: meter?.dgCode ?? null,
      voltage: meter?.voltage ?? null,
      mcc: meter?.mccCode ?? null,
      profileClass: meter?.profileClass ?? null,
      existingSupplier: contract?.existingSupplierName ?? null,
      annualConsumptionKwh: num(site?.annualConsumptionKwh),
      meters,
      readingDate: shown.length ? shown.map((r) => isoDay(r.readingDate)!).sort().pop()! : null,
      pricePlan: contract?.pricingPlan ?? null,
      startDate: isoDay(contract?.proposedActivationDate),
      confirmationEndDate: a.confirmationEndDate ?? null,
      commitmentMonths: contract?.termMonths ?? null,
      rateType: contract?.priceType ?? null,
      rates: this.rates(ctx),
      discounts: { y1_12: null, y1_24: null, y1_36: null, y2_24: null, y2_36: null, y3_36: null, ...a.discounts },
      signatoryName: a.signatoryName ?? contactName,
      marketing: { email: c?.marketingEmail ?? null, post: c?.marketingPost ?? null, phone: c?.marketingPhone ?? null, sms: c?.marketingSms ?? null },
      broaderMarketing: a.broaderMarketing ?? null,
      agentName: opp.owner?.name ?? null,
      directDebit: a.directDebit ?? true,
      mandateReference: a.mandateReference ?? null,
      bankAccountName: bank && reveal ? this.crypto.decrypt(bank.accountNameEnc) : null,
      iban: bank && reveal ? this.crypto.decrypt(bank.ibanEnc) : null,
      bic: bank?.bicEnc && reveal ? this.crypto.decrypt(bank.bicEnc) : null,
      bankOnFile: !!bank,
      bicOnFile: !!bank?.bicEnc,
      ibanLast4: bank?.ibanLast4 ?? null,
      secondAccountHolder: a.secondAccountHolder ? { name: a.secondAccountHolder.name ?? null, email: a.secondAccountHolder.email ?? null } : null,
    };
  }

  // --- Reading ------------------------------------------------------------------------

  /** Whether the application applies and what still stops it going for signature; messages only, no values (for the assistant). */
  async outstanding(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    const ctx = await this.context(opportunityId);
    return { applies: this.applies(ctx), issues: bordGaisElectricityIssues(this.assemble(ctx, true)).map((i) => ({ tab: i.tab, message: i.message })) };
  }

  async view(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    const ctx = await this.context(opportunityId);
    const permissions = this.docs.permissions(actor, ctx.opp);
    const full = this.assemble(ctx, true);
    const data = permissions.bankRead ? full : this.assemble(ctx, false);
    if (permissions.bankRead && ctx.bank) await this.audit.sensitiveAccess(actor, "opportunity", opportunityId, "bank details for the Bord Gáis electricity application");
    const [template, docs] = await Promise.all([this.docs.template(KIND), this.docs.describe(ctx.app?.id, dataHash(full))]);
    return {
      applies: this.applies(ctx),
      needsCustomer: !ctx.customer,
      template: template ? { id: template.id, name: template.name, version: template.version } : null,
      layoutVersion: LAYOUT.version,
      data,
      answered: Object.keys(ctx.answers),
      issues: bordGaisElectricityIssues(full),
      signers: bordGaisSigners(full),
      ...docs,
      contract: ctx.contract ? { id: ctx.contract.id, readOnly: ctx.contract.status === "live" || ctx.contract.status === "ended" } : null,
      permissions,
    };
  }

  async history(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    return this.docs.history(opportunityId, KIND);
  }

  // --- Saving a draft -------------------------------------------------------------------

  async save(actor: Actor, opportunityId: string, input: BordGaisSaveInput) {
    const opp = await this.access.writable(actor, opportunityId);
    if (opp.outcome !== "open") throw new RuleViolation(["Only open opportunities can be changed."]);
    const ctx = await this.context(opportunityId);
    this.assertApplies(ctx);
    const customer = ctx.customer;
    if (!customer) throw new RuleViolation(["Create or link the customer first, so the application is filled from their record."]);
    if ((input.customer || input.contact || input.accountAddress || input.homeAddress || input.billingAddress) && !can(actor, "customer.write")) throw new Forbidden("You can't change customer details.");
    if (input.bank && !can(actor, "bank.write")) throw new Forbidden("You can't change bank details.");
    const changed = new Set<string>();

    await this.prisma.$transaction(async (tx) => {
      // Customer
      if (input.customer) {
        const k = input.customer;
        const next: Record<string, unknown> = {
          legalName: k.legalName,
          tradingName: k.tradingName,
          legalEntity: k.legalEntity,
          businessType: k.businessType,
          incorporationDate: k.incorporationDate === undefined ? undefined : dateOnly(k.incorporationDate),
          companyRegNumber: k.companyRegNumber,
          employees: k.employees,
          priorityCustomer: k.priorityCustomer,
          phone: k.telephone,
          marketingEmail: k.marketingEmail,
          marketingPost: k.marketingPost,
          marketingPhone: k.marketingPhone,
          marketingSms: k.marketingSms,
        };
        const same = (key: string, v: unknown) => {
          const cur = (customer as Record<string, unknown>)[key];
          return cur instanceof Date ? isoDay(cur) === isoDay(v as Date | null) : cur === v;
        };
        const data = Object.fromEntries(Object.entries(next).filter(([key, v]) => v !== undefined && !same(key, v)));
        if (Object.keys(data).length) {
          if ("phone" in data) data.phoneKey = phoneKey(data.phone as string | null);
          await tx.customer.update({ where: { id: customer.id }, data });
          for (const key of Object.keys(data)) if (key !== "phoneKey") changed.add(key.startsWith("marketing") ? "marketing" : key);
        }
      }
      // Contact
      if (input.contact) {
        const k = input.contact;
        const cur = ctx.contact;
        const fields = { firstName: k.firstName, lastName: k.lastName, jobTitle: k.jobTitle, email: k.email, phone: k.phone, mobile: k.mobile };
        if (cur) {
          const data = Object.fromEntries(Object.entries(fields).filter(([key, v]) => v !== undefined && v !== (cur as Record<string, unknown>)[key]));
          if (Object.keys(data).length) {
            await tx.customerContact.update({
              where: { id: cur.id },
              data: { ...data, ...(data.phone !== undefined ? { phoneKey: phoneKey(data.phone as string | null) } : {}), ...(data.mobile !== undefined ? { mobileKey: phoneKey(data.mobile as string | null) } : {}) },
            });
            changed.add("contact");
          }
        } else if (Object.values(fields).some((v) => v)) {
          if (!k.firstName) throw new RuleViolation(["Enter the contact's first name."]);
          await tx.customerContact.create({
            data: { customerId: customer.id, firstName: k.firstName, lastName: k.lastName ?? null, jobTitle: k.jobTitle ?? null, email: k.email ?? null, phone: k.phone ?? null, phoneKey: phoneKey(k.phone), mobile: k.mobile ?? null, mobileKey: phoneKey(k.mobile), isPrimary: true },
          });
          changed.add("contact");
        }
      }
      // Customer addresses: the account holder's (registered, else the trading one it was read from), home and billing.
      await this.saveAddress(tx, customer.id, input.accountAddress, ctx.accountAddress, "registered", "account-holder address", "accountAddress", changed);
      await this.saveAddress(tx, customer.id, input.homeAddress, ctx.homeAddress, "home", "home address", "homeAddress", changed);
      await this.saveAddress(tx, customer.id, input.billingAddress, ctx.billing, "billing", "billing address", "billingAddress", changed);
      // Site, meter, readings, contract and rates
      const siteId = await this.saveSite(tx, ctx, input, changed);
      const meter = await this.saveMeter(tx, ctx, siteId, input, changed);
      if (input.readings) await this.saveReadings(tx, actor, ctx, meter, input, changed);
      const answerRates = await this.saveContract(tx, ctx, siteId, input, changed);
      // Bank details: a change is a new bank account; the old one is kept.
      if (input.bank) {
        const cur = ctx.bank ? { name: this.crypto.decrypt(ctx.bank.accountNameEnc), iban: this.crypto.decrypt(ctx.bank.ibanEnc), bic: ctx.bank.bicEnc ? this.crypto.decrypt(ctx.bank.bicEnc) : null } : null;
        const b = input.bank;
        if (!cur || cur.name !== b.accountName || cur.iban !== b.iban || (cur.bic ?? null) !== b.bic) {
          if (cur && cur.iban !== b.iban && !input.confirmIbanChange) throw new RuleViolation(["The IBAN differs from the one on file. Confirm the change with the customer, then tick to confirm it."]);
          await tx.bankAccount.create({
            data: { customerId: customer.id, accountNameEnc: this.crypto.encrypt(b.accountName), ibanEnc: this.crypto.encrypt(b.iban), ibanLast4: b.iban.slice(-4), bicEnc: this.crypto.encrypt(b.bic), createdById: actorRef(actor) },
          });
          changed.add("bank");
        }
      }
      // The application's own answers
      const answers = bordGaisAnswersSchema.parse({ ...ctx.answers, ...input.answers, ...(answerRates ? { rates: answerRates } : {}) });
      for (const k of Object.keys(answers) as (keyof BordGaisAnswers)[]) if (JSON.stringify(answers[k]) !== JSON.stringify(ctx.answers[k])) changed.add(k);
      const app = ctx.app
        ? await tx.supplierApplication.update({ where: { id: ctx.app.id }, data: { answers: answers as Prisma.InputJsonValue, updatedById: actorRef(actor) } })
        : await tx.supplierApplication.create({ data: { opportunityId, kind: KIND, answers: answers as Prisma.InputJsonValue, createdById: actorRef(actor), updatedById: actorRef(actor) } });
      if (changed.size) {
        const names = [...new Set([...changed].map((k) => LABELS[k] ?? k))];
        await this.audit.record(
          actor,
          { action: "supplier_application.save", entityType: "supplier_application", entityId: app.id, summary: "Saved the Bord Gáis electricity application draft", data: { changed: names } },
          { opportunityId, customerId: customer.id, kind: "document", body: `Bord Gáis electricity application saved: ${names.join(", ")} updated.` },
          tx,
        );
      }
    });
    return this.view(actor, opportunityId);
  }

  private async saveAddress(
    tx: Tx,
    customerId: string,
    input: Partial<ApplicationAddress> | undefined,
    current: { id: string } & ApplicationAddress | null,
    kind: "registered" | "home" | "billing",
    label: string,
    key: string,
    changed: Set<string>,
  ) {
    if (!input) return;
    const next = fullAddress(input);
    if (sameAddress(next, addressOf(current))) return;
    if (!next.line1) throw new RuleViolation([`Enter the first line of the ${label}.`]);
    const data = { line1: next.line1, line2: next.line2, city: next.city, county: next.county, postcode: next.postcode };
    if (current) await tx.customerAddress.update({ where: { id: current.id }, data });
    else await tx.customerAddress.create({ data: { ...data, customerId, kind } });
    changed.add(key);
  }

  /** Updates (or creates) the deal's electricity supply site. Returns its id, or null if there is none yet. */
  private async saveSite(tx: Tx, ctx: Context, input: BordGaisSaveInput, changed: Set<string>): Promise<string | null> {
    const site = ctx.site;
    const data: Prisma.SupplySiteUncheckedUpdateInput = {};
    if (input.supplyAddress && !sameAddress(fullAddress(input.supplyAddress), addressOf(site))) {
      const a = fullAddress(input.supplyAddress);
      if (!a.line1) throw new RuleViolation(["Enter the first line of the supply address."]);
      Object.assign(data, { line1: a.line1, line2: a.line2, city: a.city, county: a.county, postcode: a.postcode });
      changed.add("supplyAddress");
    }
    const s = input.site ?? {};
    if (s.siteName !== undefined && s.siteName !== (site?.label ?? null)) data.label = s.siteName;
    if (s.annualConsumptionKwh !== undefined && s.annualConsumptionKwh !== num(site?.annualConsumptionKwh)) data.annualConsumptionKwh = s.annualConsumptionKwh;
    if (data.label !== undefined || data.annualConsumptionKwh !== undefined) changed.add("site");
    if (!Object.keys(data).length) return site?.id ?? null;
    if (site) {
      await tx.supplySite.update({ where: { id: site.id }, data });
      return site.id;
    }
    if (!data.line1) throw new RuleViolation(["Enter the supply address first."]);
    const created = await tx.supplySite.create({
      data: { ...(data as Prisma.SupplySiteUncheckedCreateInput), opportunityId: ctx.opp.id, customerId: ctx.opp.customerId, serviceType: ctx.opp.serviceType === "dual_fuel" ? "dual_fuel" : "electricity" },
    });
    return created.id;
  }

  /** The site's electricity meter point: MPRN, technical details and both meter serials. */
  private async saveMeter(tx: Tx, ctx: Context, siteId: string | null, input: BordGaisSaveInput, changed: Set<string>) {
    const m = input.meter;
    const cur = ctx.meter;
    if (!m) return cur ? { id: cur.id, serial1: cur.meterNumber, serial2: cur.meterSerial2 } : null;
    const next = {
      mprn: m.mprn === undefined ? (cur?.mprn ?? null) : normalizeIdentifier(m.mprn),
      mic: m.mic === undefined ? num(cur?.mic) : m.mic,
      dgCode: m.dgCode === undefined ? (cur?.dgCode ?? null) : (m.dgCode?.toUpperCase() ?? null),
      voltage: m.voltage === undefined ? (cur?.voltage ?? null) : m.voltage,
      mccCode: m.mcc === undefined ? (cur?.mccCode ?? null) : normalizeIdentifier(m.mcc),
      profileClass: m.profileClass === undefined ? (cur?.profileClass ?? null) : m.profileClass,
      meterNumber: m.serial1 === undefined ? (cur?.meterNumber ?? null) : (m.serial1?.toUpperCase() ?? null),
      meterSerial2: m.serial2 === undefined ? (cur?.meterSerial2 ?? null) : (m.serial2?.toUpperCase() ?? null),
    };
    const unchanged = cur && Object.entries(next).every(([k, v]) => (k === "mic" ? num(cur.mic) === v : (cur as Record<string, unknown>)[k] === v));
    if (unchanged) return { id: cur.id, serial1: cur.meterNumber, serial2: cur.meterSerial2 };
    const errors = meterPointErrors({ fuel: "electricity", mprn: next.mprn, gprn: null, formatExceptionReason: cur?.formatExceptionReason });
    if (errors.length) throw new RuleViolation(errors);
    changed.add("meter");
    if (cur) {
      await tx.meterPoint.update({ where: { id: cur.id }, data: next });
      return { id: cur.id, serial1: next.meterNumber, serial2: next.meterSerial2 };
    }
    if (!siteId) throw new RuleViolation(["Enter the supply address first, so the meter has a site."]);
    const created = await tx.meterPoint.create({ data: { ...next, siteId, fuel: "electricity" } });
    return { id: created.id, serial1: next.meterNumber, serial2: next.meterSerial2 };
  }

  /** Readings are history: a different value or date is a new reading, kept exactly as read and tagged with its meter. */
  private async saveReadings(tx: Tx, actor: Actor, ctx: Context, meter: { id: string; serial1: string | null; serial2: string | null } | null, input: BordGaisSaveInput, changed: Set<string>) {
    const r = input.readings!;
    const before = this.assemble(ctx, false);
    const readingDate = r.readingDate !== undefined ? r.readingDate : before.readingDate;
    for (const [i, given] of [r.meter1, r.meter2].entries()) {
      if (!given) continue;
      for (const reg of BORD_GAIS_REGISTERS) {
        const value = given[reg];
        if (value === undefined || value === null) continue;
        const was = before.meters[i].readings[reg];
        if (was === value && before.readingDate === readingDate) continue;
        if (!meter) throw new RuleViolation(["Enter the MPRN first, so the readings have a meter."]);
        const serial = i === 0 ? meter.serial1 : meter.serial2;
        if (i === 1 && !serial) throw new RuleViolation(["Enter meter serial number 2 before its readings."]);
        if (!readingDate) throw new RuleViolation(["Enter the date of the meter readings."]);
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) throw new RuleViolation([`The ${reg.replace("_", " ")} reading isn't a number.`]);
        await tx.meterReading.create({
          data: { meterPointId: meter.id, readingType: "actual", register: reg, value: numeric, rawValue: value, meterSerial: serial, readingDate: dateOnly(readingDate), createdById: actorRef(actor) },
        });
        changed.add("readings");
      }
    }
  }

  /**
   * The electricity contract: existing supplier, price plan, commitment, rate type, and the rate type's
   * row of the rate table. Returns the other rate cells for the application's answers (or undefined
   * when the rates weren't given). Live and ended contracts are history.
   */
  private async saveContract(tx: Tx, ctx: Context, siteId: string | null, input: BordGaisSaveInput, changed: Set<string>) {
    const k = input.contract ?? {};
    const c = ctx.contract;
    const data: Prisma.EnergyContractUncheckedUpdateInput = {};
    if (k.existingSupplier !== undefined && k.existingSupplier !== (c?.existingSupplierName ?? null)) data.existingSupplierName = k.existingSupplier;
    if (k.pricePlan !== undefined && k.pricePlan !== (c?.pricingPlan ?? null)) data.pricingPlan = k.pricePlan;
    if (k.commitmentMonths !== undefined && k.commitmentMonths !== (c?.termMonths ?? null)) data.termMonths = k.commitmentMonths;
    if (k.rateType !== undefined && k.rateType !== (c?.priceType ?? null)) data.priceType = k.rateType;
    if (Object.keys(data).length) changed.add("contract");

    let answerRates: BordGaisAnswers["rates"] | undefined;
    if (input.rates) {
      const priceType: PriceType | null = k.rateType !== undefined ? k.rateType : (c?.priceType ?? null);
      const table = emptyRates();
      for (const row of BORD_GAIS_RATE_ROWS) for (const col of BORD_GAIS_RATE_COLUMNS) table[row][col] = input.rates[row]?.[col] ?? null;
      const bound = priceType ? contractCells(table[RATE_ROW_FOR[priceType]].night) : {};
      const row = priceType ? RATE_ROW_FOR[priceType] : null;
      // The rate type's row goes to the contract; every column it has no cell for is cleared.
      if (row) {
        const columns: ContractRate[] = ["dayRate", "nightRate", "nightStorageRate", "summerDayRate", "winterDayRate", "standingCharge"];
        for (const column of columns) {
          const col = (Object.entries(bound) as [BordGaisRateColumn, ContractRate][]).find(([, v]) => v === column)?.[0];
          const value = col ? table[row][col] : null;
          if (value !== cent(c?.[column])) data[column] = value === null ? null : value / 100;
        }
      }
      answerRates = Object.fromEntries(
        BORD_GAIS_RATE_ROWS.map((r) => [r, Object.fromEntries(BORD_GAIS_RATE_COLUMNS.filter((col) => !(r === row && bound[col])).map((col) => [col, table[r][col]]))]),
      ) as BordGaisAnswers["rates"];
      if (JSON.stringify(this.rates(ctx)) !== JSON.stringify(table)) changed.add("rates");
    }
    if (!Object.keys(data).length) return answerRates;
    if (c && (c.status === "live" || c.status === "ended")) throw new RuleViolation(["The electricity contract is live or ended and is kept as history, so its details can't change here."]);
    if (c) await tx.energyContract.update({ where: { id: c.id }, data });
    else {
      await tx.energyContract.create({
        data: { ...(data as Prisma.EnergyContractUncheckedCreateInput), opportunityId: ctx.opp.id, customerId: ctx.opp.customerId, fuel: "electricity", selectedSupplierId: ctx.opp.selectedSupplierId, siteId },
      });
    }
    return answerRates;
  }

  // --- Documents ------------------------------------------------------------------------

  async generate(actor: Actor, opportunityId: string, input: { confirmReplace?: boolean }) {
    const opp = await this.access.writable(actor, opportunityId);
    if (opp.outcome !== "open") throw new RuleViolation(["Forms can only be generated for open opportunities."]);
    const ctx = await this.context(opportunityId);
    this.assertApplies(ctx);
    if (!ctx.customer) throw new RuleViolation(["Create or link the customer first, so the application is filled from their record."]);
    const data = this.assemble(ctx, true);
    const issues = bordGaisElectricityIssues(data);
    if (issues.length) throw new RuleViolation(issues.map((i) => i.message));
    return this.docs.generate(actor, INFO, {
      opp: ctx.opp,
      appId: ctx.app?.id ?? null,
      data,
      layoutVersion: LAYOUT.version,
      filler: this.filler(data),
      sensitive: (values) => !!values.directDebit_iban,
      confirmReplace: input.confirmReplace,
    });
  }

  /** Fills the PDF's own fields; the generated version stays fillable (the signed copy is flattened). */
  private filler(data: BordGaisElectricityData): ApplicationFiller {
    return {
      fill: async (template, title) => {
        const r = await renderBordGaisElectricity(data, bordGaisSigners(data));
        if (r.issues.length) return { fields: r.fields, values: r.values, bytes: new Uint8Array(), issues: r.issues };
        const filled = await fillAcroForm({ template, fields: r.fields, values: r.values, untouched: r.untouched, title });
        return { fields: r.fields, values: r.values, bytes: filled.bytes, issues: filled.issues };
      },
    };
  }

  /** A draft preview on the original PDF, marked as a draft; nothing is stored, bank details masked without bank.read. */
  async preview(actor: Actor, opportunityId: string): Promise<Buffer> {
    await this.access.readable(actor, opportunityId);
    const ctx = await this.context(opportunityId);
    this.assertApplies(ctx);
    const t = await this.docs.template(KIND);
    if (!t) throw new RuleViolation([INFO.missingTemplate]);
    const reveal = can(actor, "bank.read");
    const data = this.assemble(ctx, reveal);
    if (!reveal && data.bankOnFile) Object.assign(data, { iban: `${"X".repeat(18)}${data.ibanLast4 ?? ""}`, bankAccountName: "On file (restricted)", bic: null });
    const filled = await this.filler(data).fill(await this.storage.get(t.storageKey), "Bord Gáis electricity application (draft preview)");
    if (!filled.bytes.length) throw new RuleViolation(filled.issues);
    await this.audit.log(actor, { action: "supplier_application.preview", entityType: "supplier_application", entityId: ctx.app?.id ?? null, summary: `Previewed the Bord Gáis electricity draft${reveal && data.bankOnFile ? " with bank details" : ""}` });
    return this.docs.markDraft(filled.bytes);
  }

  private async currentHash(actor: Actor, opportunityId: string) {
    const opp = await this.access.writable(actor, opportunityId);
    if (opp.outcome !== "open") throw new RuleViolation(["Only open opportunities can be sent for signature."]);
    const ctx = await this.context(opportunityId);
    this.assertApplies(ctx);
    return dataHash(this.assemble(ctx, true));
  }

  async send(actor: Actor, opportunityId: string, formId: string, input: z.infer<typeof bordGaisSendSchema>) {
    return this.docs.send(actor, opportunityId, formId, await this.currentHash(actor, opportunityId), input);
  }

  async resend(actor: Actor, opportunityId: string, linkId: string) {
    return this.docs.resend(actor, opportunityId, linkId, await this.currentHash(actor, opportunityId));
  }
}
