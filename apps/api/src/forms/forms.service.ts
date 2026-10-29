import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  DOCUMENT_TYPES,
  FORM_SIGNER_ROLE_LABELS,
  type FormField,
  type FormSignerRole,
  type FormSource,
  SIGNATURE_AUTHORISATION_LABELS,
  type SignatureAuthorisation,
  SUPPLY_CHANGE_LABELS,
  billCheckPassed,
  can,
  caseKind,
  formFieldSchema,
  isRestrictedSource,
  LEGAL_ENTITY_LABELS,
  sourceMatches,
  addDays,
  addMonths,
  today,
} from "@uo/shared";
import type { SaleType, ServiceType, SupplyChange } from "@uo/shared";
import type { billCheckSchema, formReviewSchema, formSignatureSchema, formTemplateMetaSchema, formTemplateUpdateSchema, generateFormSchema } from "@uo/shared";
import type { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { type Actor, actorRef } from "../common/actor";
import { CryptoService } from "../common/crypto.service";
import { Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { dateOnly, isoDay, num } from "../common/values";
import { ENV, type Env } from "../config/env";
import { DocumentsService, type UploadedFile, sniffMatches } from "../documents/documents.service";
import { OpportunityAccess } from "../opportunities/access.service";
import { loadGateFacts } from "../opportunities/facts";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { fillAcroForm } from "./acroform";
import { type FillValue, fillPdf, greyscaleCopy, inspectTemplate } from "./pdf";
import { workflowTemplateFor } from "../supplier-applications/templates";
import { presetFor } from "./presets";

type Values = Record<string, FillValue>;
const normIban = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() : "");
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

/** Problems with a signature image: it must be a real PNG of at most 2 MB. */
export function signatureImageIssues(png: Buffer, mimetype = "image/png"): string[] {
  const issues: string[] = [];
  if (mimetype !== "image/png" || !sniffMatches("image/png", png)) issues.push("Upload the signature as a PNG image.");
  if (png.length > MAX_SIGNATURE_BYTES) issues.push("Signature images must be 2 MB or smaller.");
  return issues;
}

const dublinTime = (d: Date) => new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", dateStyle: "long", timeStyle: "long" }).format(d);

/** Evidence stored with a signature drawn on the online signing page. */
export interface OnlineSignatureEvidence {
  signingLinkId: string;
  signerEmail: string;
  signerIp: string | null;
  signerUserAgent: string | null;
  consentText: string;
  documentSha256: string;
}

/**
 * Supplier PDF forms: templates with positioned fields, filling them from the CRM, uploaded
 * signatures (authorised per form and reviewed by a second person) and the previous-supplier
 * bill check for a change of supplier.
 */
@Injectable()
export class FormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly documents: DocumentsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // --- Templates -------------------------------------------------------------------

  templates(supplierId?: string) {
    return this.prisma.formTemplate.findMany({
      // Templates with their own application (e.g. Flogas electricity) are filled from that application.
      where: { active: true, workflow: null, ...(supplierId ? { OR: [{ supplierId }, { supplierId: null }] } : {}) },
      select: { id: true, name: true, documentType: true, version: true, supplierId: true, supplier: { select: { id: true, name: true } }, updatedAt: true },
      orderBy: [{ name: "asc" }],
    });
  }

  allTemplates(actor: Actor) {
    if (!can(actor, "form.template_manage")) throw new Forbidden();
    return this.prisma.formTemplate.findMany({
      select: { id: true, name: true, documentType: true, version: true, active: true, filename: true, workflow: true, supplier: { select: { id: true, name: true } }, updatedAt: true, _count: { select: { forms: true } } },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    });
  }

  async template(id: string) {
    const t = await this.prisma.formTemplate.findUnique({ where: { id }, include: { supplier: { select: { id: true, name: true } } } });
    if (!t) throw new NotFound("Form template");
    return t;
  }

  async templateFile(id: string): Promise<Buffer> {
    return this.storage.get((await this.template(id)).storageKey);
  }

  async createTemplate(actor: Actor, meta: z.infer<typeof formTemplateMetaSchema>, file: UploadedFile) {
    if (!can(actor, "form.template_manage")) throw new Forbidden();
    const issues: string[] = [];
    if (file.mimetype !== "application/pdf" || !sniffMatches("application/pdf", file.buffer)) issues.push("Upload the supplier's form as a PDF.");
    if (file.size > this.env.MAX_UPLOAD_MB * 1024 * 1024) issues.push(`Files must be ${this.env.MAX_UPLOAD_MB} MB or smaller.`);
    if (issues.length) throw new RuleViolation(issues);
    if (meta.supplierId && !(await this.prisma.supplier.findUnique({ where: { id: meta.supplierId } }))) throw new RuleViolation(["Choose a supplier from the list."]);
    let inspected: Awaited<ReturnType<typeof inspectTemplate>>;
    try {
      inspected = await inspectTemplate(file.buffer);
    } catch {
      throw new RuleViolation(["This PDF can't be used as a template (it may be password-protected or damaged)."]);
    }
    // A supplier form we've already set up: its fields arrive placed and linked to the CRM. A form
    // with its own application (Flogas electricity) keeps its layout in code.
    const sha256 = CryptoService.sha256(file.buffer);
    const workflow = workflowTemplateFor(sha256);
    if (workflow && inspected.pages.length !== workflow.pageCount) throw new RuleViolation([`This PDF should have ${workflow.pageCount} pages.`]);
    const preset = workflow ? { name: workflow.name, supplier: workflow.supplier, fields: workflow.fields() } : presetFor(sha256);
    const fields = preset && preset.fields.every((f) => inspected.pages[f.page]) ? preset.fields.map((f) => formFieldSchema.parse(f)) : inspected.fields;
    const presetSupplier = preset && !meta.supplierId ? await this.prisma.supplier.findFirst({ where: { name: { equals: preset.supplier, mode: "insensitive" }, kind: "energy" }, select: { id: true } }) : null;
    const storageKey = `form-templates/${randomUUID()}.pdf`;
    await this.storage.put(storageKey, file.buffer, "application/pdf");
    const t = await this.prisma.formTemplate.create({
      data: {
        name: meta.name,
        supplierId: meta.supplierId ?? presetSupplier?.id ?? null,
        documentType: meta.documentType,
        storageKey,
        filename: file.originalname.slice(0, 200),
        sha256,
        pages: inspected.pages as unknown as Prisma.InputJsonValue,
        fields: fields as unknown as Prisma.InputJsonValue,
        workflow: workflow?.workflow ?? null,
        createdById: actorRef(actor),
      },
    });
    const recognised = fields === inspected.fields ? null : preset!.name;
    await this.audit.log(actor, {
      action: "form_template.create",
      entityType: "form_template",
      entityId: t.id,
      summary: recognised ? `Added form template ${t.name} (recognised ${recognised}: ${fields.length} fields)` : `Added form template ${t.name} (${fields.length} fields found)`,
    });
    return { id: t.id, fieldsFound: fields.length, preset: recognised };
  }

  async updateTemplate(actor: Actor, id: string, input: z.infer<typeof formTemplateUpdateSchema>) {
    if (!can(actor, "form.template_manage")) throw new Forbidden();
    const t = await this.template(id);
    const issues: string[] = [];
    const pages = t.pages as unknown as { width: number; height: number }[];
    if (t.workflow && input.fields && JSON.stringify(input.fields) !== JSON.stringify(t.fields)) {
      issues.push("This form's layout is maintained with its application and can't be edited here.");
    }
    if (input.fields) {
      const ids = new Set<string>();
      for (const f of input.fields) {
        if (ids.has(f.id)) issues.push(`Two fields share the id ${f.id}.`);
        ids.add(f.id);
        if (!pages[f.page]) issues.push(`"${f.label}" is on page ${f.page + 1}, which this PDF doesn't have.`);
      }
    }
    if (input.supplierId && !(await this.prisma.supplier.findUnique({ where: { id: input.supplierId } }))) issues.push("Choose a supplier from the list.");
    if (issues.length) throw new RuleViolation(issues);
    const fieldsChanged = !!input.fields && JSON.stringify(input.fields) !== JSON.stringify(t.fields);
    await this.prisma.formTemplate.update({
      where: { id },
      data: {
        name: input.name,
        supplierId: input.supplierId,
        documentType: input.documentType,
        active: input.active,
        ...(fieldsChanged ? { fields: input.fields as unknown as Prisma.InputJsonValue, version: { increment: 1 } } : {}),
      },
    });
    await this.audit.log(actor, { action: "form_template.update", entityType: "form_template", entityId: id, summary: `Updated form template ${t.name}${fieldsChanged ? ` (fields, now version ${t.version + 1})` : ""}` });
  }

  // --- Filling ---------------------------------------------------------------------

  /** CRM values for every source. Restricted (bank) values are included; callers decide who sees them. */
  private async crmValues(opportunityId: string): Promise<Record<FormSource, FillValue>> {
    const opp = await this.prisma.opportunity.findUniqueOrThrow({
      where: { id: opportunityId },
      include: {
        owner: { select: { name: true } },
        selectedSupplier: { select: { name: true, agencyId: true } },
        customer: { include: { contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }, addresses: true, bankAccounts: { orderBy: { createdAt: "desc" }, take: 1 } } },
        sites: { include: { meterPoints: { include: { readings: { orderBy: { readingDate: "desc" } } } } }, orderBy: { createdAt: "asc" } },
        contracts: { include: { selectedSupplier: { select: { name: true, agencyId: true } }, site: { include: { meterPoints: { include: { readings: { orderBy: { readingDate: "desc" } } } } } } }, orderBy: { createdAt: "asc" } },
        workflowCase: { include: { site: { include: { meterPoints: { include: { readings: { orderBy: { readingDate: "desc" } } } } } }, outgoingCustomer: { select: { legalName: true } } } },
      },
    });
    // Only the incoming customer (this deal's customer) fills customer, contact, billing and bank
    // fields. The outgoing occupier of a known supply point has separate "previous occupier" fields.
    const c = opp.customer;
    const contact = c?.contacts[0];
    const billing = c?.addresses.find((a) => a.kind === "billing") ?? c?.addresses.find((a) => a.kind === "registered") ?? c?.addresses.find((a) => a.kind === "trading") ?? c?.addresses[0];
    // The deal's own site, else the supply point the case matched, else the site its contracts renew.
    const sites = opp.sites.length ? opp.sites : opp.workflowCase?.site ? [opp.workflowCase.site] : opp.contracts.flatMap((k) => (k.site ? [k.site] : [])).filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i);
    const site = sites[0];
    const meters = sites.flatMap((s) => s.meterPoints);
    const elec = meters.find((m) => m.fuel === "electricity");
    const gas = meters.find((m) => m.fuel === "gas");
    const contract = opp.contracts.find((k) => k.status !== "cancelled") ?? opp.contracts[0];
    const bank = c?.bankAccounts[0];
    const full = (a?: { line1: string; line2: string | null; city: string | null; county: string | null; postcode: string | null } | null) =>
      a ? [a.line1, a.line2, a.city, a.county, a.postcode].filter(Boolean).join(", ") : null;
    const rate = (v: unknown) => (num(v as Prisma.Decimal | null) === null ? null : String(num(v as Prisma.Decimal | null)));
    const fullName = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") : opp.contactName;
    const home = c?.addresses.find((a) => a.kind === "home");
    const cent = (v: unknown) => {
      const n = num(v as Prisma.Decimal | null);
      return n === null ? null : String(Math.round(n * 100 * 10_000) / 10_000);
    };
    const qty = (v: unknown) => {
      const n = num(v as Prisma.Decimal | null);
      return n === null ? null : String(n);
    };
    // Latest reading per register across the deal's meters (registers were free text before, so normalise).
    const readings = meters.flatMap((m) => m.readings);
    const register = (r: string | null) => {
      const k = (r ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (["24h", "24hr", "24hour", "24hours", "general"].includes(k)) return "24h";
      if (k === "nightstorage" || k === "storage") return "night_storage";
      return ["day", "night", "wattless", "gas"].includes(k) ? k : null;
    };
    const latest = (reg: string, fuel?: "gas") => readings.find((r) => register(r.register) === reg || (fuel && !r.register && meters.find((m) => m.id === r.meterPointId)?.fuel === fuel));
    const reading = (reg: string, fuel?: "gas") => (latest(reg, fuel) ? String(num(latest(reg, fuel)!.value)) : null);
    const readDate = readings[0]?.readingDate;
    // Time at the premises, as whole years plus remaining months.
    const since = site?.occupiedSince ? isoDay(site.occupiedSince)! : null;
    const months = since ? Math.max(0, (Number(today().slice(0, 4)) - Number(since.slice(0, 4))) * 12 + (Number(today().slice(5, 7)) - Number(since.slice(5, 7))) - (Number(today().slice(8, 10)) < Number(since.slice(8, 10)) ? 1 : 0)) : null;
    const aq = num(gas?.annualQuantityKwh as Prisma.Decimal | null) ?? (gas ? num(site?.annualConsumptionKwh as Prisma.Decimal | null) : null);
    const newSupplierName = contract?.selectedSupplier?.name ?? opp.selectedSupplier?.name ?? null;
    const broker = await this.brokerProfile();

    return {
      "customer.legalName": c?.legalName ?? opp.companyName,
      "customer.tradingName": c?.tradingName ?? null,
      "customer.companyRegNumber": c?.companyRegNumber ?? null,
      "customer.vatNumber": c?.vatNumber ?? null,
      "customer.businessType": c?.businessType ?? null,
      "customer.phone": c?.phone ?? opp.phone,
      "customer.email": c?.email ?? opp.email,
      "contact.fullName": fullName,
      "contact.firstName": contact?.firstName ?? null,
      "contact.lastName": contact?.lastName ?? null,
      "contact.jobTitle": contact?.jobTitle ?? opp.contactRole,
      "contact.phone": contact?.mobile ?? contact?.phone ?? opp.phone,
      "contact.email": contact?.email ?? opp.email,
      "billing.full": full(billing),
      "billing.line1": billing?.line1 ?? null,
      "billing.line2": billing?.line2 ?? null,
      "billing.city": billing?.city ?? null,
      "billing.county": billing?.county ?? null,
      "billing.postcode": billing?.postcode ?? null,
      "site.full": full(site),
      "site.line1": site?.line1 ?? null,
      "site.line2": site?.line2 ?? null,
      "site.city": site?.city ?? null,
      "site.county": site?.county ?? null,
      "site.postcode": site?.postcode ?? null,
      "site.mprn": elec?.mprn ?? null,
      "site.gprn": gas?.gprn ?? null,
      "site.meterNumber": (elec ?? gas)?.meterNumber ?? null,
      "site.mccCode": elec?.mccCode ?? null,
      "site.annualConsumptionKwh": site?.annualConsumptionKwh ? String(num(site.annualConsumptionKwh)) : null,
      "landlord.name": sites.find((s) => s.landlordName)?.landlordName ?? null,
      "landlord.contact": sites.find((s) => s.landlordContact)?.landlordContact ?? null,
      "tenancy.occupancyDate": opp.workflowCase?.occupancyDate ? fmtDate(isoDay(opp.workflowCase.occupancyDate)!) : null,
      "outgoing.legalName": opp.workflowCase?.outgoingCustomer?.legalName ?? null,
      "outgoing.accountRef": opp.workflowCase?.outgoingAccountRef ?? null,
      "contract.existingSupplier": contract?.existingSupplierName ?? null,
      "contract.existingSupplierAccount": contract?.existingSupplierAccount ?? null,
      "contract.newSupplier": contract?.selectedSupplier?.name ?? opp.selectedSupplier?.name ?? null,
      "contract.proposedStartDate": contract?.proposedActivationDate ? fmtDate(isoDay(contract.proposedActivationDate)!) : null,
      "contract.termMonths": contract?.termMonths ? String(contract.termMonths) : null,
      "contract.pricingPlan": contract?.pricingPlan ?? null,
      "contract.dayRate": rate(contract?.dayRate),
      "contract.nightRate": rate(contract?.nightRate),
      "contract.peakRate": rate(contract?.peakRate),
      "contract.gasRate": rate(contract?.gasRate),
      "contract.standingCharge": rate(contract?.standingCharge),
      "contract.endDate": contract?.proposedActivationDate && contract.termMonths ? fmtDate(addDays(addMonths(isoDay(contract.proposedActivationDate)!, contract.termMonths), -1)) : null,
      "bank.accountName": bank ? this.crypto.decrypt(bank.accountNameEnc) : null,
      "bank.iban": bank ? this.crypto.decrypt(bank.ibanEnc) : null,
      "bank.bic": bank?.bicEnc ? this.crypto.decrypt(bank.bicEnc) : null,
      "broker.name": opp.owner?.name ?? null,
      "opportunity.number": `UO-${String(opp.number).padStart(6, "0")}`,
      today: fmtDate(today()),
      "is.electricity": opp.serviceType === "electricity" || opp.serviceType === "dual_fuel",
      "is.gas": opp.serviceType === "gas" || opp.serviceType === "dual_fuel",
      "is.changeOfSupplier": opp.supplyChanges.includes("change_of_supplier"),
      "is.changeOfLegalEntity": opp.supplyChanges.includes("change_of_legal_entity"),
      "is.reenergise": opp.supplyChanges.includes("reenergise_meter"),
      "is.vatRegistered": c?.vatRegistered === "yes",
      // The legal entity on the customer record; older records without one fall back to the old guess.
      "is.limitedCompany": c?.legalEntity ? c.legalEntity === "limited_company" || c.legalEntity === "plc" : /limited|ltd|plc|dac|clg/i.test(c?.businessType ?? "") || /\b(ltd|limited|dac|plc|clg)\b/i.test(c?.legalName ?? ""),
      "is.soleTrader": c?.legalEntity ? c.legalEntity === "sole_trader" : /sole/i.test(c?.businessType ?? ""),
      "is.renewal": opp.saleType === "renewal",
      "is.newBusiness": opp.saleType !== "renewal",
      "is.existingCustomerOfSupplier": !!newSupplierName && !!contract?.existingSupplierName && contract.existingSupplierName.trim().toLowerCase() === newSupplierName.trim().toLowerCase(),

      "customer.legalEntity": c?.legalEntity ?? null,
      "customer.legalEntityName": c?.legalEntity ? LEGAL_ENTITY_LABELS[c.legalEntity] : null,
      "customer.dateEstablished": c?.incorporationDate ? fmtDate(isoDay(c.incorporationDate)!) : null,
      "customer.employees": c?.employees != null ? String(c.employees) : null,
      "customer.vatExemptNumber": c?.vatExemptNumber ?? null,
      "customer.charityNumber": c?.charityNumber ?? null,
      "customer.vatExempt": c?.vatExempt ?? null,
      "customer.carbonTaxExempt": c?.carbonTaxExempt ?? null,
      "customer.priorityCustomer": c?.priorityCustomer ?? null,
      "customer.paperlessBilling": c?.paperlessBilling ?? null,
      "marketing.email": c?.marketingEmail ?? null,
      "marketing.post": c?.marketingPost ?? null,
      "marketing.phone": c?.marketingPhone ?? null,
      "marketing.sms": c?.marketingSms ?? null,
      "home.full": full(home),
      "home.line1": home?.line1 ?? null,
      "home.line2": home?.line2 ?? null,
      "home.city": home?.city ?? null,
      "home.county": home?.county ?? null,
      "home.postcode": home?.postcode ?? null,
      "contact.title": contact?.title ?? null,
      "contact.mobile": contact?.mobile ?? null,
      "contact.landline": contact?.phone ?? null,
      "site.name": site?.label ?? null,
      "site.occupancy": site?.occupancyType ?? null,
      "site.ownsPremises": site?.occupancyType ? site.occupancyType === "owner_occupied" : null,
      "site.yearsAtPremises": months === null ? null : String(Math.floor(months / 12)),
      "site.monthsAtPremises": months === null ? null : String(months % 12),
      "site.leaseTerms": site?.leaseTerms ?? null,
      "meter.mic": elec ? qty(elec.mic) : null,
      "meter.dgCode": elec?.dgCode ?? null,
      "meter.voltage": elec?.voltage ?? null,
      "meter.profileClass": elec?.profileClass ?? null,
      "meter.serial2": elec?.meterSerial2 ?? null,
      "meter.spc": gas ? qty(gas.supplyPointCapacityKwh) : null,
      "meter.aq": aq === null ? null : String(aq),
      // Flogas and Gas Networks Ireland draw the line between small and medium business users at 73,000 kWh a year.
      "meter.gasSector": aq === null ? null : aq >= 73_000 ? "medium" : "small",
      "reading.24h": reading("24h"),
      "reading.day": reading("day"),
      "reading.night": reading("night"),
      "reading.nightStorage": reading("night_storage"),
      "reading.wattless": reading("wattless"),
      "reading.gas": reading("gas", "gas"),
      "reading.date": readDate ? fmtDate(isoDay(readDate)!) : null,
      "contract.priceType": contract?.priceType ?? null,
      "contract.isFixed": contract?.priceType ? contract.priceType !== "variable" : null,
      "contract.termText": contract?.termMonths ? `${contract.termMonths} months` : null,
      "contract.rate24hCent": contract && num(contract.nightRate) === null ? cent(contract.dayRate) : null,
      "contract.rateDayCent": contract && num(contract.nightRate) !== null ? cent(contract.dayRate) : null,
      "contract.standingChargeCent": cent(contract?.standingCharge),
      "site.street": site ? [site.line1, site.line2].filter(Boolean).join(", ") : null,
      "site.locality": site ? [site.city, site.county, site.postcode].filter(Boolean).join(", ") || null : null,
      "billing.street": billing ? [billing.line1, billing.line2].filter(Boolean).join(", ") : null,
      "billing.locality": billing ? [billing.city, billing.county, billing.postcode].filter(Boolean).join(", ") || null : null,
      "contract.tariff": contract ? (num(contract.nightRate) !== null ? "night_saver" : "24h") : null,
      "contract.nightStorageRate": rate(contract?.nightStorageRate),
      "contract.summerDayRate": rate(contract?.summerDayRate),
      "contract.winterDayRate": rate(contract?.winterDayRate),
      "contract.dayRateCent": cent(contract?.dayRate),
      "contract.nightRateCent": cent(contract?.nightRate),
      "contract.gasRateCent": cent(contract?.gasRate),
      "contract.nightStorageRateCent": cent(contract?.nightStorageRate),
      "contract.summerDayRateCent": cent(contract?.summerDayRate),
      "contract.winterDayRateCent": cent(contract?.winterDayRate),
      "opportunity.saleType": opp.saleType,
      "broker.agencyId": contract?.selectedSupplier?.agencyId ?? opp.selectedSupplier?.agencyId ?? null,
      "broker.company": broker.companyName,
    };
  }

  async brokerProfile(): Promise<{ companyName: string }> {
    const saved = (await this.prisma.setting.findUnique({ where: { key: "broker.profile" } }))?.value as { companyName?: string } | undefined;
    return { companyName: saved?.companyName ?? "Utility Optimizer Limited" };
  }

  private static fieldValue(f: FormField, crm: Record<FormSource, FillValue>): FillValue {
    if (f.kind === "signature" || f.kind === "signed_date") return null;
    const empty = f.kind === "check" ? false : null;
    if (f.onlyIf && !sourceMatches(crm[f.onlyIf.source], f.onlyIf.equals)) return empty;
    if (!f.source) return empty;
    const v = crm[f.source];
    if (f.match !== undefined && !sourceMatches(v, f.match)) return empty;
    if (f.kind === "check") return f.match !== undefined ? true : v === true;
    return typeof v === "string" ? v : v === true ? "Yes" : null;
  }

  /**
   * What the form would contain: each field with its CRM value and, for a returning customer, the
   * value on their last approved copy of the same form. Restricted values are hidden without bank.read.
   */
  async prefill(actor: Actor, opportunityId: string, templateId: string) {
    const opp = await this.access.writable(actor, opportunityId);
    const t = await this.template(templateId);
    if (t.workflow) throw new RuleViolation(["This supplier form is filled from its own application tab on the opportunity."]);
    const fields = formFieldSchema.array().parse(t.fields);
    const crm = await this.crmValues(opportunityId);
    const seeBank = can(actor, "bank.read");
    const previous = await this.previousForm(opp, t.id);
    const restrictedShown = fields.some((f) => isRestrictedSource(f.source) && seeBank && (crm[f.source!] || previous?.values[f.id]));
    if (restrictedShown) await this.audit.sensitiveAccess(actor, "opportunity", opportunityId, "bank details for a supplier form");
    return {
      template: { id: t.id, name: t.name, version: t.version, documentType: t.documentType, supplier: t.supplier },
      previousForm: previous ? { id: previous.id, opportunityId: previous.opportunityId, opportunityNumber: previous.opportunityNumber, createdAt: previous.createdAt } : null,
      fields: fields.map((f) => {
        const restricted = isRestrictedSource(f.source);
        const value = FormsService.fieldValue(f, crm);
        const before = previous && f.id in previous.values ? (previous.values[f.id] ?? null) : undefined;
        return {
          ...f,
          restricted,
          value: restricted && !seeBank ? null : value,
          hasCrmValue: value !== null && value !== "" && value !== false,
          ...(before !== undefined ? { previousValue: restricted && !seeBank ? null : before, changedSincePrevious: !sameValue(f, before, value) } : {}),
        };
      }),
    };
  }

  /**
   * The customer's last approved copy of this form on another of their deals (a renewal's
   * previous contract, usually), with its values, for a field-by-field comparison.
   */
  private async previousForm(opp: { id: string; customerId: string | null; previousOpportunityId: string | null }, templateId: string) {
    const scope: Prisma.OpportunityWhereInput[] = [];
    if (opp.customerId) scope.push({ customerId: opp.customerId });
    if (opp.previousOpportunityId) scope.push({ id: opp.previousOpportunityId });
    if (!scope.length) return null;
    const form = await this.prisma.generatedForm.findFirst({
      where: { templateId, status: "approved", opportunityId: { not: opp.id }, opportunity: { OR: scope } },
      orderBy: { createdAt: "desc" },
      include: { opportunity: { select: { number: true } } },
    });
    if (!form) return null;
    return { id: form.id, opportunityId: form.opportunityId, opportunityNumber: form.opportunity.number, createdAt: form.createdAt, values: this.crypto.decryptJson<Values>(form.valuesEnc) ?? {} };
  }

  async list(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    const forms = await this.prisma.generatedForm.findMany({
      where: { opportunityId },
      include: { template: { select: { name: true, documentType: true } }, signatures: { orderBy: { uploadedAt: "asc" }, include: { signingLink: { select: { createdById: true } } } } },
      orderBy: { createdAt: "desc" },
    });
    const users = await this.userNames([...forms.flatMap((f) => [f.createdById, f.reviewedById, f.signedCopyUploadedById]), ...forms.flatMap((f) => f.signatures.map((s) => s.uploadedById))]);
    return forms.map((f) => ({
      id: f.id,
      name: f.template.name,
      documentType: f.template.documentType,
      templateId: f.templateId,
      templateVersion: f.templateVersion,
      status: f.status,
      qcPassed: f.qcPassed,
      qcIssues: f.qcIssues as string[],
      changedFields: (f.changedFields as string[]).map((id) => (f.fields as FormField[]).find((x) => x.id === id)?.label ?? id),
      ibanChangeConfirmed: f.ibanChangeConfirmed,
      changedSincePrevious: f.changedSincePrevious as string[],
      previousFormId: f.previousFormId,
      changeReason: f.changeReason,
      documentItemId: f.documentItemId,
      versionId: f.versionId,
      signedVersionId: f.signedVersionId,
      /** The signed copy is a scan of the form signed on paper; its uploader can't review it. */
      signedCopyUpload: f.signedCopyUploadedAt ? { uploadedById: f.signedCopyUploadedById, uploadedBy: users.get(f.signedCopyUploadedById ?? "") ?? null, uploadedAt: f.signedCopyUploadedAt } : null,
      monoVersionId: f.monoVersionId,
      requiredSigners: requiredSigners(f.fields as FormField[]),
      signatures: f.signatures.map((s) => ({
        id: s.id,
        role: s.role,
        signerName: s.signerName,
        signerCapacity: s.signerCapacity,
        authorisation: s.authorisation,
        note: s.note,
        uploadedAt: s.uploadedAt,
        uploadedBy: users.get(s.uploadedById ?? "") ?? null,
        uploadedById: s.uploadedById,
        /** Who sent the signing link, for online signatures (they can't review it either). */
        linkSentById: s.signingLink?.createdById ?? null,
      })),
      createdAt: f.createdAt,
      createdBy: users.get(f.createdById ?? "") ?? null,
      reviewedAt: f.reviewedAt,
      reviewedBy: users.get(f.reviewedById ?? "") ?? null,
      reviewNote: f.reviewNote,
    }));
  }

  private async userNames(ids: (string | null)[]) {
    const clean = [...new Set(ids.filter((x): x is string => !!x))];
    const users = clean.length ? await this.prisma.user.findMany({ where: { id: { in: clean } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  async generate(actor: Actor, opportunityId: string, input: z.infer<typeof generateFormSchema>) {
    const opp = await this.access.writable(actor, opportunityId);
    if (opp.outcome !== "open") throw new RuleViolation(["Forms can only be generated for open opportunities."]);
    const t = await this.template(input.templateId);
    if (!t.active) throw new RuleViolation(["This template has been retired."]);
    if (t.workflow) throw new RuleViolation(["This supplier form is filled from its own application tab on the opportunity."]);
    await this.checkWorkflowBeforeGenerating(opp);
    const fields = formFieldSchema.array().parse(t.fields);
    const crm = await this.crmValues(opportunityId);
    const seeBank = can(actor, "bank.read");

    const values: Values = {};
    const changed: string[] = [];
    let ibanChanged = false;
    const issues: string[] = [];
    for (const f of fields) {
      const fromCrm = FormsService.fieldValue(f, crm);
      if (!(f.id in input.values)) {
        values[f.id] = fromCrm;
        continue;
      }
      const given = input.values[f.id];
      if (f.kind === "signature" || f.kind === "signed_date") continue;
      if (f.kind === "check" ? typeof given !== "boolean" : typeof given !== "string") {
        issues.push(`"${f.label}" needs ${f.kind === "check" ? "a tick or no tick" : "text"}.`);
        continue;
      }
      // Without bank.read the CRM's bank value can't be compared, so an empty override keeps it.
      if (isRestrictedSource(f.source) && !seeBank && given === "") {
        values[f.id] = fromCrm;
        continue;
      }
      values[f.id] = typeof given === "string" ? given.trim() : given;
      const same = f.source === "bank.iban" ? normIban(given) === normIban(fromCrm) : (fromCrm ?? (f.kind === "check" ? false : "")) === values[f.id];
      if (!same) {
        changed.push(f.id);
        if (f.source === "bank.iban" && fromCrm) ibanChanged = true;
      }
    }
    if (ibanChanged && !input.confirmIbanChange) issues.push("The IBAN on this form differs from the one on file. Confirm the change with the customer, then tick to confirm it.");
    if (issues.length) throw new RuleViolation(issues);
    // A returning customer's form is compared with their last approved copy, so every change stays visible.
    const previous = await this.previousForm(opp, t.id);
    const sincePrevious = previous ? fields.filter((f) => f.kind !== "signature" && f.kind !== "signed_date" && f.id in previous.values && !sameValue(f, previous.values[f.id], values[f.id])).map((f) => f.label) : [];

    const template = await this.storage.get(t.storageKey);
    const title = `${t.name} – UO-${String(opp.number).padStart(6, "0")}`;
    const filled = await fillPdf({ template, fields, values, title });
    const form = await this.storeGenerated(actor, opp, t, {
      fields,
      values,
      filled,
      title,
      extra: { changedFields: changed, ibanChangeConfirmed: ibanChanged, previousFormId: previous?.id ?? null, changedSincePrevious: sincePrevious, changeReason: input.changeReason ?? null },
      onCreated: async (tx, created) => {
        const changedLabels = changed.map((id) => fields.find((f) => f.id === id)!.label);
        await this.audit.record(
          actor,
          {
            action: "form.generate",
            entityType: "generated_form",
            entityId: created.id,
            summary: `Generated ${t.name} v${t.version}`,
            data: { templateId: t.id, templateVersion: t.version, changedFields: changedLabels, ibanChanged, qcPassed: filled.issues.length === 0, previousFormId: previous?.id ?? null, changedSincePrevious: sincePrevious },
          },
          {
            opportunityId,
            customerId: opp.customerId,
            kind: "document",
            body:
              `Generated "${t.name}" from the CRM${changedLabels.length ? `; changed by hand: ${changedLabels.join(", ")}` : ""}${ibanChanged ? " (IBAN change confirmed)" : ""}.` +
              (previous ? (sincePrevious.length ? ` Changed since the previous form (UO-${String(previous.opportunityNumber).padStart(6, "0")}): ${sincePrevious.join(", ")}${input.changeReason ? ` (${input.changeReason})` : ""}.` : " Unchanged since the previous form.") : "") +
              (filled.issues.length ? ` Quality check failed: ${filled.issues.length} problem${filled.issues.length === 1 ? "" : "s"}.` : " Quality check passed."),
          },
          tx,
        );
      },
    });
    return { id: form.id, qcPassed: filled.issues.length === 0, qcIssues: filled.issues };
  }

  /**
   * Stores a filled PDF as a new document version and a new generated form, superseding earlier
   * forms from the same template. `onCreated` runs in the same transaction (audit, links).
   */
  async storeGenerated(
    actor: Actor,
    opp: { id: string; customerId: string | null },
    t: { id: string; version: number; documentType: string },
    input: {
      fields: FormField[];
      values: Values;
      filled: { bytes: Uint8Array; issues: string[] };
      title: string;
      /** Whether the PDF holds restricted values (bank details); worked out from field sources when omitted. */
      sensitive?: boolean;
      extra?: Partial<Pick<Prisma.GeneratedFormUncheckedCreateInput, "changedFields" | "ibanChangeConfirmed" | "previousFormId" | "changedSincePrevious" | "changeReason">>;
      onCreated?: (tx: Prisma.TransactionClient, form: { id: string; versionId: string; documentItemId: string }) => Promise<void>;
    },
  ) {
    const { fields, values, filled } = input;
    const restricted = input.sensitive ?? fields.some((f) => isRestrictedSource(f.source) && values[f.id]);
    const itemId = await this.itemFor(opp.id, opp.customerId, t.documentType, restricted);
    const version = await this.documents.upload(actor, itemId, { originalname: `${slug(input.title)}.pdf`, mimetype: "application/pdf", buffer: Buffer.from(filled.bytes), size: filled.bytes.length });
    return this.prisma.$transaction(async (tx) => {
      await tx.generatedForm.updateMany({ where: { opportunityId: opp.id, templateId: t.id, status: { not: "superseded" } }, data: { status: "superseded" } });
      const created = await tx.generatedForm.create({
        data: {
          opportunityId: opp.id,
          templateId: t.id,
          templateVersion: t.version,
          fields: fields as unknown as Prisma.InputJsonValue,
          valuesEnc: this.crypto.encryptJson(values),
          ...input.extra,
          documentItemId: itemId,
          versionId: version.id,
          status: "generated",
          qcPassed: filled.issues.length === 0,
          qcIssues: filled.issues,
          createdById: actorRef(actor),
        },
      });
      await input.onCreated?.(tx, created);
      return created;
    });
  }

  /**
   * Workflow rules that apply before any supplier document is filled: a change of entity fills
   * only the incoming customer's details (never the outgoing account holder's), and a renewal's
   * terms must have been verified by Admin.
   */
  private async checkWorkflowBeforeGenerating(opp: { id: string; serviceType: string; saleType: SaleType; supplyChanges: SupplyChange[]; customerId: string | null }) {
    const kind = caseKind({ serviceType: opp.serviceType as ServiceType, saleType: opp.saleType, supplyChanges: opp.supplyChanges });
    if (kind !== "change_of_entity" && kind !== "renewal") return;
    const w = (await loadGateFacts(this.prisma, opp.id, this.crypto)).workflow!;
    const issues: string[] = [];
    if (kind === "change_of_entity") {
      if (!opp.customerId) issues.push("Create or link the incoming customer before filling forms, so their own details are used.");
      if (w.incomingIsOutgoing) issues.push("This deal is linked to the outgoing account holder. Link the incoming customer before filling forms.");
      if (w.sharedIban) issues.push("The incoming customer's IBAN is the same as the outgoing customer's. Record the incoming customer's own bank account first.");
    }
    if (kind === "renewal" && !w.terms.verified) issues.push("Verify the renewal terms before generating documents.");
    if (issues.length) throw new RuleViolation(issues);
  }

  /** The checklist item a template's output is stored under (created if the checklist doesn't have one). */
  private async itemFor(opportunityId: string, customerId: string | null, documentType: string, sensitive: boolean) {
    const existing = await this.prisma.documentItem.findFirst({ where: { opportunityId, documentType }, orderBy: { createdAt: "asc" } });
    if (existing) {
      if (sensitive && !existing.sensitive) await this.prisma.documentItem.update({ where: { id: existing.id }, data: { sensitive: true } });
      return existing.id;
    }
    const isSensitive = sensitive || !!(DOCUMENT_TYPES as Record<string, { sensitive: boolean }>)[documentType]?.sensitive;
    return (await this.prisma.documentItem.create({ data: { opportunityId, customerId, documentType, required: true, sensitive: isSensitive } })).id;
  }

  private async loadForm(actor: Actor, formId: string) {
    const form = await this.prisma.generatedForm.findUnique({ where: { id: formId }, include: { template: true, signatures: { orderBy: { uploadedAt: "asc" } } } });
    if (!form) throw new NotFound("Form");
    return { form, opp: await this.access.writable(actor, form.opportunityId) };
  }

  /**
   * Adds an uploaded signature, authorised by the signer for this form only. When every
   * required signer has one, the signed copy is generated, checked and sent for review.
   */
  async addSignature(actor: Actor, formId: string, meta: z.infer<typeof formSignatureSchema>, file: UploadedFile) {
    const { form, opp } = await this.loadForm(actor, formId);
    this.assertSignable(form, meta.role);
    const issues = signatureImageIssues(file.buffer, file.mimetype);
    if (meta.authorisation === "broker_own_signature" && meta.role !== "broker") issues.push("Only the broker's signature can be authorised as the broker's own.");
    if (issues.length) throw new RuleViolation(issues);
    await this.storeSignature(actor, form, opp, { role: meta.role, signerName: meta.signerName, signerCapacity: meta.signerCapacity ?? null, authorisation: meta.authorisation, note: meta.note ?? null, png: file.buffer });
    return this.completeIfSigned(actor, formId);
  }

  /** The form can take a signature for this role: generated (or awaiting review), passed QC, and has that box. */
  assertSignable(form: { status: string; qcPassed: boolean; fields: Prisma.JsonValue }, role: FormSignerRole) {
    if (form.status !== "generated" && form.status !== "awaiting_review") throw new RuleViolation([`This form is ${form.status.replace("_", " ")}; generate a new one to sign it again.`]);
    if (!form.qcPassed) throw new RuleViolation(["This form failed its quality check. Generate it again before signing."]);
    if (!requiredSigners(form.fields as FormField[]).includes(role)) throw new RuleViolation([`This form has no ${FORM_SIGNER_ROLE_LABELS[role].toLowerCase()} signature box.`]);
  }

  /** Stores one signature image and how it was authorised (append-only), with its audit and timeline entry. */
  async storeSignature(
    actor: Actor,
    form: { id: string; opportunityId: string; template: { name: string } },
    opp: { id: string; customerId: string | null },
    input: { role: FormSignerRole; signerName: string; signerCapacity: string | null; authorisation: SignatureAuthorisation; note: string | null; png: Buffer; online?: OnlineSignatureEvidence },
  ) {
    const storageKey = `form-signatures/${form.opportunityId}/${form.id}/${randomUUID()}.png`;
    await this.storage.put(storageKey, input.png, "image/png");
    const sig = await this.prisma.formSignature.create({
      data: {
        formId: form.id,
        role: input.role,
        signerName: input.signerName,
        signerCapacity: input.signerCapacity,
        authorisation: input.authorisation,
        note: input.note,
        storageKey,
        sha256: CryptoService.sha256(input.png),
        uploadedById: actorRef(actor),
        ...(input.online ?? {}),
      },
    });
    const how = input.online ? "signed online" : "uploaded";
    await this.audit.record(
      actor,
      {
        action: input.online ? "form.signature_online" : "form.signature_upload",
        entityType: "generated_form",
        entityId: form.id,
        summary: `${FORM_SIGNER_ROLE_LABELS[input.role]} signature ${how} for ${form.template.name}`,
        data: { signatureId: sig.id, authorisation: input.authorisation, signingLinkId: input.online?.signingLinkId },
      },
      {
        opportunityId: opp.id,
        customerId: opp.customerId,
        kind: "signature",
        body: `${FORM_SIGNER_ROLE_LABELS[input.role]} signature for "${form.template.name}" ${how}: ${input.signerName}${input.signerCapacity ? ` (${input.signerCapacity})` : ""}. ${SIGNATURE_AUTHORISATION_LABELS[input.authorisation]}.`,
      },
    );
    return sig;
  }

  /**
   * When every required signer has a signature (the latest per role counts), builds the signed
   * copy, checks it and sends it for review. Online signatures add an evidence page at the end.
   */
  async completeIfSigned(actor: Actor, formId: string) {
    const form = await this.prisma.generatedForm.findUniqueOrThrow({ where: { id: formId }, include: { template: true, opportunity: true, signatures: { orderBy: { uploadedAt: "asc" } } } });
    const opp = form.opportunity;
    const fields = form.fields as FormField[];
    const needed = requiredSigners(fields);
    const latest = new Map<FormSignerRole, (typeof form.signatures)[number]>();
    for (const s of form.signatures) latest.set(s.role, s);
    if (!needed.every((r) => latest.has(r))) return { signed: false, missing: needed.filter((r) => !latest.has(r)) };

    const signatures: Partial<Record<FormSignerRole, Uint8Array>> = {};
    const signedDates: Partial<Record<FormSignerRole, string>> = {};
    const signingRecord: { heading: string; lines: string[] }[] = [];
    for (const [role, s] of latest) {
      signatures[role] = await this.storage.get(s.storageKey);
      signedDates[role] = fmtDate(today(s.uploadedAt));
      if (s.signingLinkId) {
        signingRecord.push({
          heading: `${FORM_SIGNER_ROLE_LABELS[role]}: ${s.signerName}`,
          lines: [
            `Signed online on ${dublinTime(s.uploadedAt)} (Europe/Dublin).`,
            `Signing link sent to: ${s.signerEmail}`,
            `IP address: ${s.signerIp ?? "not recorded"}`,
            `Browser: ${s.signerUserAgent ?? "not recorded"}`,
            `Document shown (SHA-256 of the unsigned PDF): ${s.documentSha256}`,
            `Signature image (SHA-256): ${s.sha256}`,
            `Agreed: ${s.consentText}`,
          ],
        });
      }
    }
    const values = this.crypto.decryptJson<Values>(form.valuesEnc) ?? {};
    const template = await this.storage.get(form.template.storageKey);
    const title = `${form.template.name} – UO-${String(opp.number).padStart(6, "0")} (signed)`;
    let filled: Awaited<ReturnType<typeof fillPdf>>;
    try {
      const args = { template, fields, values, signatures, signedDates, requireSignatures: true, signingRecord, title };
      // A form that fills the PDF's own fields is signed the same way, then flattened so its values can't change.
      filled = fields.some((f) => f.pdfField) ? await fillAcroForm({ ...args, flatten: true, allowUnmapped: true }) : await fillPdf(args);
    } catch {
      throw new RuleViolation(["The signature image couldn't be read. Upload it again as a PNG."]);
    }
    const version = await this.documents.upload(actor, form.documentItemId, { originalname: `${slug(title)}.pdf`, mimetype: "application/pdf", buffer: Buffer.from(filled.bytes), size: filled.bytes.length });
    const qcPassed = filled.issues.length === 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.generatedForm.update({ where: { id: formId }, data: { signedVersionId: version.id, signedCopyUploadedById: null, signedCopyUploadedAt: null, status: qcPassed ? "awaiting_review" : "generated", qcPassed, qcIssues: filled.issues } });
      await this.audit.timeline(
        actor,
        { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: qcPassed ? `"${form.template.name}" signed copy created and sent for review.` : `"${form.template.name}" signed copy failed its quality check.` },
        tx,
      );
    });
    return { signed: true, qcPassed, qcIssues: filled.issues };
  }

  /**
   * For a form the customer signed on paper: stores the scanned signed PDF as the form's signed copy
   * and sends it for review, where someone other than the uploader checks it against the form.
   */
  async uploadSignedCopy(actor: Actor, formId: string, file: UploadedFile) {
    const { form, opp } = await this.loadForm(actor, formId);
    if (form.status !== "generated" && form.status !== "awaiting_review") throw new RuleViolation([`This form is ${FORM_STATUS_WORD[form.status]}; generate a new one first.`]);
    if (!form.qcPassed) throw new RuleViolation(["This form failed its quality check. Generate it again before it's signed."]);
    if (!requiredSigners(form.fields as FormField[]).length) throw new RuleViolation(["This form has no signature boxes, so there's no signed copy to upload."]);
    if (file.mimetype !== "application/pdf" || !file.originalname.toLowerCase().endsWith(".pdf")) throw new RuleViolation(["Upload the signed form as a PDF."]);
    const version = await this.documents.upload(actor, form.documentItemId, file);
    await this.prisma.$transaction(async (tx) => {
      await tx.generatedForm.update({ where: { id: formId }, data: { signedVersionId: version.id, signedCopyUploadedById: actorRef(actor), signedCopyUploadedAt: new Date(), status: "awaiting_review" } });
      await this.audit.record(
        actor,
        { action: "form.signed_copy_upload", entityType: "generated_form", entityId: formId, summary: `Uploaded the customer-signed ${form.template.name}`, data: { versionId: version.id } },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: `Signed copy of "${form.template.name}" uploaded (signed on paper) and sent for review.` },
        tx,
      );
    });
    return { versionId: version.id };
  }

  /** A second person checks the signed copy. Approving it counts as the customer's signature for submission. */
  async review(actor: Actor, formId: string, input: z.infer<typeof formReviewSchema>) {
    if (!can(actor, "document.review")) throw new Forbidden("Only reviewers can approve signed forms.");
    const { form, opp } = await this.loadForm(actor, formId);
    if (form.status !== "awaiting_review") throw new RuleViolation(["Only signed forms awaiting review can be reviewed."]);
    if (form.signatures.some((s) => s.uploadedById === actor.id)) throw new RuleViolation(["Someone other than the person who uploaded the signatures must review this form."]);
    if (form.signedCopyUploadedById === actor.id) throw new RuleViolation(["Someone other than the person who uploaded the signed copy must review this form."]);
    const linkIds = form.signatures.flatMap((s) => (s.signingLinkId ? [s.signingLinkId] : []));
    if (linkIds.length && (await this.prisma.signingLink.count({ where: { id: { in: linkIds }, createdById: actor.id } }))) {
      throw new RuleViolation(["Someone other than the person who sent the signing link must review this form."]);
    }
    if (input.decision === "rejected" && !input.note) throw new RuleViolation(["Say why the form is rejected."]);
    await this.prisma.$transaction(async (tx) => {
      await tx.generatedForm.update({ where: { id: formId }, data: { status: input.decision, reviewedById: actorRef(actor), reviewedAt: new Date(), reviewNote: input.note ?? null } });
      await tx.documentItem.update({ where: { id: form.documentItemId }, data: { approval: input.decision, reviewerId: actorRef(actor), reviewedAt: new Date(), reviewNotes: input.note ?? null } });
      await this.audit.record(
        actor,
        { action: `form.${input.decision}`, entityType: "generated_form", entityId: formId, summary: `${input.decision === "approved" ? "Approved" : "Rejected"} signed ${form.template.name}` },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: `Signed "${form.template.name}" ${input.decision}${input.note ? `: ${input.note}` : "."}` },
        tx,
      );
    });
  }

  /**
   * Creates the black and white copy some external parties need, straight from the signed PDF
   * (or the unsigned one for forms without signatures). It is stored as a new document version.
   */
  async monoCopy(actor: Actor, formId: string) {
    const { form, opp } = await this.loadForm(actor, formId);
    if (form.status === "superseded" || form.status === "rejected") throw new RuleViolation([`This form is ${FORM_STATUS_WORD[form.status]}; generate a new one first.`]);
    if (!form.qcPassed) throw new RuleViolation(["This form failed its quality check. Generate it again first."]);
    const needsSignatures = requiredSigners(form.fields as FormField[]).length > 0;
    if (needsSignatures && !form.signedVersionId) throw new RuleViolation(["Add the signatures first: the black and white copy is made from the signed form."]);
    const sourceId = form.signedVersionId ?? form.versionId;
    const source = await this.prisma.documentVersion.findUniqueOrThrow({ where: { id: sourceId } });
    const title = `${form.template.name} – UO-${String(opp.number).padStart(6, "0")}`;
    const copy = await greyscaleCopy(await this.storage.get(source.storageKey), title);
    if (copy.issues.length) throw new RuleViolation(copy.issues);
    // Its own optional checklist item, so the reviewed form's approval isn't reset by a new version.
    const existing = form.monoVersionId ? await this.prisma.documentVersion.findUnique({ where: { id: form.monoVersionId } }) : null;
    if (existing?.sha256 === CryptoService.sha256(Buffer.from(copy.bytes))) return { versionId: existing.id };
    const original = await this.prisma.documentItem.findUniqueOrThrow({ where: { id: form.documentItemId } });
    const itemId =
      existing?.itemId ??
      (await this.prisma.documentItem.create({ data: { opportunityId: opp.id, customerId: opp.customerId, documentType: original.documentType, required: false, sensitive: original.sensitive } })).id;
    const version = await this.documents.upload(actor, itemId, { originalname: `${slug(title)}-black-and-white.pdf`, mimetype: "application/pdf", buffer: Buffer.from(copy.bytes), size: copy.bytes.length });
    await this.prisma.$transaction(async (tx) => {
      await tx.generatedForm.update({ where: { id: formId }, data: { monoVersionId: version.id } });
      await this.audit.record(
        actor,
        { action: "form.mono_copy", entityType: "generated_form", entityId: formId, summary: `Black and white copy of ${form.template.name}`, data: { sourceVersionId: sourceId, versionId: version.id } },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "document", body: `Black and white copy of "${form.template.name}" created from the ${form.signedVersionId ? "signed" : "generated"} PDF and checked.` },
        tx,
      );
    });
    return { versionId: version.id };
  }

  // --- Change of supplier -------------------------------------------------------------

  /** The latest version of the previous supplier's bill (the energy bill checklist item). */
  private async latestBill(opportunityId: string) {
    return this.prisma.documentVersion.findFirst({ where: { item: { opportunityId, documentType: "energy_bill" }, removedAt: null }, orderBy: [{ uploadedAt: "desc" }] });
  }

  async billChecks(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    const [checks, bill] = await Promise.all([this.prisma.billCheck.findMany({ where: { opportunityId }, orderBy: { verifiedAt: "desc" } }), this.latestBill(opportunityId)]);
    const users = await this.userNames(checks.map((c) => c.verifiedById));
    return {
      latestBill: bill ? { versionId: bill.id, version: bill.version, filename: bill.filename, uploadedAt: bill.uploadedAt } : null,
      checks: checks.map((c) => ({ ...c, billDate: isoDay(c.billDate), verifiedBy: users.get(c.verifiedById ?? "") ?? null, current: c.documentVersionId === bill?.id })),
    };
  }

  async checkBill(actor: Actor, opportunityId: string, input: z.infer<typeof billCheckSchema>) {
    const opp = await this.access.writable(actor, opportunityId);
    const bill = await this.latestBill(opportunityId);
    if (!bill) throw new RuleViolation(["Upload the previous supplier's bill under Documents first."]);
    const passed = billCheckPassed(input);
    const check = await this.prisma.billCheck.create({
      data: {
        opportunityId,
        documentVersionId: bill.id,
        previousSupplier: input.previousSupplier,
        billDate: dateOnly(input.billDate) ?? null,
        readable: input.readable,
        customerNameMatches: input.customerNameMatches,
        supplyPointMatches: input.supplyPointMatches,
        supplierMatches: input.supplierMatches,
        passed,
        notes: input.notes ?? null,
        verifiedById: actorRef(actor),
      },
    });
    const failed = [!input.readable && "not readable", !input.customerNameMatches && "customer name differs", !input.supplyPointMatches && "MPRN/GPRN or address differs", !input.supplierMatches && "supplier differs"].filter(Boolean);
    await this.audit.record(
      actor,
      { action: "bill_check.record", entityType: "opportunity", entityId: opportunityId, summary: `Previous supplier bill ${passed ? "passed" : "failed"} its check`, data: { billCheckId: check.id, documentVersionId: bill.id } },
      { opportunityId, customerId: opp.customerId, kind: "document", body: passed ? `Previous supplier's bill (${input.previousSupplier}, version ${bill.version}) checked: readable and matches.` : `Previous supplier's bill (version ${bill.version}) failed its check: ${failed.join(", ")}.` },
    );
    return { id: check.id, passed };
  }

  /** Other open opportunities switching the same MPRN/GPRN. Deals the user can't see are only counted. */
  async switchConflicts(actor: Actor, opportunityId: string) {
    const opp = await this.access.readable(actor, opportunityId);
    // The deal's own sites, the sites its contracts renew and the supply point its case matched.
    const meters = await this.prisma.meterPoint.findMany({
      where: { site: { OR: [{ opportunityId }, { contracts: { some: { opportunityId } } }, { cases: { some: { opportunityId } } }] } },
      select: { mprn: true, gprn: true },
    });
    const ids = meters.flatMap((m) => [m.mprn, m.gprn]).filter((x): x is string => !!x && /^\d{7,11}$/.test(x));
    if (!ids.length) return { supplyChanges: opp.supplyChanges.map((c) => SUPPLY_CHANGE_LABELS[c]), conflicts: [], hiddenCount: 0 };
    const where: Prisma.OpportunityWhereInput = {
      id: { not: opportunityId },
      outcome: "open",
      OR: [
        { sites: { some: { meterPoints: { some: { OR: [{ mprn: { in: ids } }, { gprn: { in: ids } }] } } } } },
        { contracts: { some: { site: { meterPoints: { some: { OR: [{ mprn: { in: ids } }, { gprn: { in: ids } }] } } } } } },
        { workflowCase: { site: { meterPoints: { some: { OR: [{ mprn: { in: ids } }, { gprn: { in: ids } }] } } } } },
      ],
    };
    const [visible, total] = await Promise.all([
      this.prisma.opportunity.findMany({ where: { AND: [where, this.access.visibleWhere(actor)] }, select: { id: true, number: true, name: true, stage: { select: { name: true } } }, take: 20 }),
      this.prisma.opportunity.count({ where }),
    ]);
    return { supplyChanges: opp.supplyChanges.map((c) => SUPPLY_CHANGE_LABELS[c]), conflicts: visible, hiddenCount: total - visible.length };
  }
}

export function requiredSigners(fields: FormField[]): FormSignerRole[] {
  return [...new Set(fields.filter((f) => f.kind === "signature" && f.signer).map((f) => f.signer!))];
}

/** Equal for form purposes: IBANs ignore spacing and case, empty text equals no value, unticked equals no tick. */
function sameValue(f: FormField, a: FillValue, b: FillValue) {
  if (f.source === "bank.iban") return normIban(a) === normIban(b);
  if (f.kind === "check") return (a === true) === (b === true);
  return (typeof a === "string" ? a.trim() : "") === (typeof b === "string" ? b.trim() : "");
}

function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

const FORM_STATUS_WORD: Record<string, string> = { superseded: "superseded", rejected: "rejected" };

const slug = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 120);
