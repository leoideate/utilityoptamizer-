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
  SUPPLY_CHANGE_LABELS,
  billCheckPassed,
  can,
  formFieldSchema,
  isRestrictedSource,
  today,
} from "@uo/shared";
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
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { type FillValue, fillPdf, inspectTemplate } from "./pdf";

type Values = Record<string, FillValue>;
const normIban = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() : "");
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

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
      where: { active: true, ...(supplierId ? { OR: [{ supplierId }, { supplierId: null }] } : {}) },
      select: { id: true, name: true, documentType: true, version: true, supplierId: true, supplier: { select: { id: true, name: true } }, updatedAt: true },
      orderBy: [{ name: "asc" }],
    });
  }

  allTemplates(actor: Actor) {
    if (!can(actor, "form.template_manage")) throw new Forbidden();
    return this.prisma.formTemplate.findMany({
      select: { id: true, name: true, documentType: true, version: true, active: true, filename: true, supplier: { select: { id: true, name: true } }, updatedAt: true, _count: { select: { forms: true } } },
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
    const storageKey = `form-templates/${randomUUID()}.pdf`;
    await this.storage.put(storageKey, file.buffer, "application/pdf");
    const t = await this.prisma.formTemplate.create({
      data: {
        name: meta.name,
        supplierId: meta.supplierId ?? null,
        documentType: meta.documentType,
        storageKey,
        filename: file.originalname.slice(0, 200),
        sha256: CryptoService.sha256(file.buffer),
        pages: inspected.pages as unknown as Prisma.InputJsonValue,
        fields: inspected.fields as unknown as Prisma.InputJsonValue,
        createdById: actorRef(actor),
      },
    });
    await this.audit.log(actor, { action: "form_template.create", entityType: "form_template", entityId: t.id, summary: `Added form template ${t.name} (${inspected.fields.length} fields found)` });
    return { id: t.id, fieldsFound: inspected.fields.length };
  }

  async updateTemplate(actor: Actor, id: string, input: z.infer<typeof formTemplateUpdateSchema>) {
    if (!can(actor, "form.template_manage")) throw new Forbidden();
    const t = await this.template(id);
    const issues: string[] = [];
    const pages = t.pages as unknown as { width: number; height: number }[];
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
        selectedSupplier: { select: { name: true } },
        customer: { include: { contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }, addresses: true, bankAccounts: { orderBy: { createdAt: "desc" }, take: 1 } } },
        sites: { include: { meterPoints: true }, orderBy: { createdAt: "asc" } },
        contracts: { include: { selectedSupplier: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
      },
    });
    const c = opp.customer;
    const contact = c?.contacts[0];
    const billing = c?.addresses.find((a) => a.kind === "billing") ?? c?.addresses.find((a) => a.kind === "registered") ?? c?.addresses.find((a) => a.kind === "trading") ?? c?.addresses[0];
    const site = opp.sites[0];
    const meters = opp.sites.flatMap((s) => s.meterPoints);
    const elec = meters.find((m) => m.fuel === "electricity");
    const gas = meters.find((m) => m.fuel === "gas");
    const contract = opp.contracts.find((k) => k.status !== "cancelled") ?? opp.contracts[0];
    const bank = c?.bankAccounts[0];
    const full = (a?: { line1: string; line2: string | null; city: string | null; county: string | null; postcode: string | null } | null) =>
      a ? [a.line1, a.line2, a.city, a.county, a.postcode].filter(Boolean).join(", ") : null;
    const rate = (v: unknown) => (num(v as Prisma.Decimal | null) === null ? null : String(num(v as Prisma.Decimal | null)));
    const fullName = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") : opp.contactName;

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
      "bank.accountName": bank ? this.crypto.decrypt(bank.accountNameEnc) : null,
      "bank.iban": bank ? this.crypto.decrypt(bank.ibanEnc) : null,
      "bank.bic": bank?.bicEnc ? this.crypto.decrypt(bank.bicEnc) : null,
      "broker.name": opp.owner?.name ?? null,
      "broker.company": "Utility Optimizer Limited",
      "opportunity.number": `UO-${String(opp.number).padStart(6, "0")}`,
      today: fmtDate(today()),
      "is.electricity": opp.serviceType === "electricity" || opp.serviceType === "dual_fuel",
      "is.gas": opp.serviceType === "gas" || opp.serviceType === "dual_fuel",
      "is.changeOfSupplier": opp.supplyChanges.includes("change_of_supplier"),
      "is.changeOfLegalEntity": opp.supplyChanges.includes("change_of_legal_entity"),
      "is.reenergise": opp.supplyChanges.includes("reenergise_meter"),
      "is.vatRegistered": c?.vatRegistered === "yes",
      "is.limitedCompany": /limited|ltd|plc|dac|clg/i.test(c?.businessType ?? "") || /\b(ltd|limited|dac|plc|clg)\b/i.test(c?.legalName ?? ""),
      "is.soleTrader": /sole/i.test(c?.businessType ?? ""),
    };
  }

  private static fieldValue(f: FormField, crm: Record<FormSource, FillValue>): FillValue {
    if (f.kind === "signature" || f.kind === "signed_date") return null;
    if (!f.source) return f.kind === "check" ? false : null;
    const v = crm[f.source];
    return f.kind === "check" ? v === true : typeof v === "string" ? v : v === true ? "Yes" : null;
  }

  /** What the form would contain: each field with its CRM value. Restricted values are hidden without bank.read. */
  async prefill(actor: Actor, opportunityId: string, templateId: string) {
    await this.access.writable(actor, opportunityId);
    const t = await this.template(templateId);
    const fields = formFieldSchema.array().parse(t.fields);
    const crm = await this.crmValues(opportunityId);
    const seeBank = can(actor, "bank.read");
    const restrictedShown = fields.some((f) => isRestrictedSource(f.source) && seeBank && crm[f.source!]);
    if (restrictedShown) await this.audit.sensitiveAccess(actor, "opportunity", opportunityId, "bank details for a supplier form");
    return {
      template: { id: t.id, name: t.name, version: t.version, documentType: t.documentType, supplier: t.supplier },
      fields: fields.map((f) => {
        const restricted = isRestrictedSource(f.source);
        const value = FormsService.fieldValue(f, crm);
        return { ...f, restricted, value: restricted && !seeBank ? null : value, hasCrmValue: value !== null && value !== "" && value !== false };
      }),
    };
  }

  async list(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    const forms = await this.prisma.generatedForm.findMany({
      where: { opportunityId },
      include: { template: { select: { name: true, documentType: true } }, signatures: { orderBy: { uploadedAt: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    const users = await this.userNames([...forms.flatMap((f) => [f.createdById, f.reviewedById]), ...forms.flatMap((f) => f.signatures.map((s) => s.uploadedById))]);
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
      documentItemId: f.documentItemId,
      versionId: f.versionId,
      signedVersionId: f.signedVersionId,
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

    const template = await this.storage.get(t.storageKey);
    const title = `${t.name} – UO-${String(opp.number).padStart(6, "0")}`;
    const filled = await fillPdf({ template, fields, values, title });
    const restricted = fields.some((f) => isRestrictedSource(f.source) && values[f.id]);

    const itemId = await this.itemFor(opp.id, opp.customerId, t.documentType, restricted);
    const version = await this.documents.upload(actor, itemId, { originalname: `${slug(title)}.pdf`, mimetype: "application/pdf", buffer: Buffer.from(filled.bytes), size: filled.bytes.length });

    const form = await this.prisma.$transaction(async (tx) => {
      await tx.generatedForm.updateMany({ where: { opportunityId, templateId: t.id, status: { not: "superseded" } }, data: { status: "superseded" } });
      const created = await tx.generatedForm.create({
        data: {
          opportunityId,
          templateId: t.id,
          templateVersion: t.version,
          fields: fields as unknown as Prisma.InputJsonValue,
          valuesEnc: this.crypto.encryptJson(values),
          changedFields: changed,
          ibanChangeConfirmed: ibanChanged,
          documentItemId: itemId,
          versionId: version.id,
          status: "generated",
          qcPassed: filled.issues.length === 0,
          qcIssues: filled.issues,
          createdById: actorRef(actor),
        },
      });
      const changedLabels = changed.map((id) => fields.find((f) => f.id === id)!.label);
      await this.audit.record(
        actor,
        {
          action: "form.generate",
          entityType: "generated_form",
          entityId: created.id,
          summary: `Generated ${t.name} v${t.version}`,
          data: { templateId: t.id, templateVersion: t.version, changedFields: changedLabels, ibanChanged, qcPassed: filled.issues.length === 0 },
        },
        {
          opportunityId,
          customerId: opp.customerId,
          kind: "document",
          body:
            `Generated "${t.name}" from the CRM${changedLabels.length ? `; changed by hand: ${changedLabels.join(", ")}` : ""}${ibanChanged ? " (IBAN change confirmed)" : ""}.` +
            (filled.issues.length ? ` Quality check failed: ${filled.issues.length} problem${filled.issues.length === 1 ? "" : "s"}.` : " Quality check passed."),
        },
        tx,
      );
      return created;
    });
    return { id: form.id, qcPassed: filled.issues.length === 0, qcIssues: filled.issues };
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
    if (form.status !== "generated" && form.status !== "awaiting_review") throw new RuleViolation([`This form is ${form.status.replace("_", " ")}; generate a new one to sign it again.`]);
    if (!form.qcPassed) throw new RuleViolation(["This form failed its quality check. Generate it again before signing."]);
    const fields = form.fields as FormField[];
    const needed = requiredSigners(fields);
    if (!needed.includes(meta.role)) throw new RuleViolation([`This form has no ${FORM_SIGNER_ROLE_LABELS[meta.role].toLowerCase()} signature box.`]);
    const issues: string[] = [];
    if (file.mimetype !== "image/png" || !sniffMatches("image/png", file.buffer)) issues.push("Upload the signature as a PNG image.");
    if (file.size > MAX_SIGNATURE_BYTES) issues.push("Signature images must be 2 MB or smaller.");
    if (meta.authorisation === "broker_own_signature" && meta.role !== "broker") issues.push("Only the broker's signature can be authorised as the broker's own.");
    if (issues.length) throw new RuleViolation(issues);

    const storageKey = `form-signatures/${form.opportunityId}/${form.id}/${randomUUID()}.png`;
    await this.storage.put(storageKey, file.buffer, "image/png");
    const sig = await this.prisma.formSignature.create({
      data: {
        formId,
        role: meta.role,
        signerName: meta.signerName,
        signerCapacity: meta.signerCapacity ?? null,
        authorisation: meta.authorisation,
        note: meta.note ?? null,
        storageKey,
        sha256: CryptoService.sha256(file.buffer),
        uploadedById: actorRef(actor),
      },
    });
    await this.audit.record(
      actor,
      { action: "form.signature_upload", entityType: "generated_form", entityId: formId, summary: `${FORM_SIGNER_ROLE_LABELS[meta.role]} signature uploaded for ${form.template.name}`, data: { signatureId: sig.id, authorisation: meta.authorisation } },
      {
        opportunityId: opp.id,
        customerId: opp.customerId,
        kind: "signature",
        body: `${FORM_SIGNER_ROLE_LABELS[meta.role]} signature for "${form.template.name}" uploaded: ${meta.signerName}${meta.signerCapacity ? ` (${meta.signerCapacity})` : ""}. ${SIGNATURE_AUTHORISATION_LABELS[meta.authorisation]}.`,
      },
    );

    // The latest upload per role is the one used.
    const all = [...form.signatures, sig];
    const latest = new Map<FormSignerRole, (typeof all)[number]>();
    for (const s of all) latest.set(s.role, s);
    if (!needed.every((r) => latest.has(r))) return { signed: false, missing: needed.filter((r) => !latest.has(r)) };

    const signatures: Partial<Record<FormSignerRole, Uint8Array>> = {};
    const signedDates: Partial<Record<FormSignerRole, string>> = {};
    for (const [role, s] of latest) {
      signatures[role] = await this.storage.get(s.storageKey);
      signedDates[role] = fmtDate(today(s.uploadedAt));
    }
    const values = this.crypto.decryptJson<Values>(form.valuesEnc) ?? {};
    const template = await this.storage.get(form.template.storageKey);
    const title = `${form.template.name} – UO-${String(opp.number).padStart(6, "0")} (signed)`;
    let filled: Awaited<ReturnType<typeof fillPdf>>;
    try {
      filled = await fillPdf({ template, fields, values, signatures, signedDates, requireSignatures: true, title });
    } catch {
      throw new RuleViolation(["The signature image couldn't be read. Upload it again as a PNG."]);
    }
    const version = await this.documents.upload(actor, form.documentItemId, { originalname: `${slug(title)}.pdf`, mimetype: "application/pdf", buffer: Buffer.from(filled.bytes), size: filled.bytes.length });
    const qcPassed = filled.issues.length === 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.generatedForm.update({ where: { id: formId }, data: { signedVersionId: version.id, status: qcPassed ? "awaiting_review" : "generated", qcPassed, qcIssues: filled.issues } });
      await this.audit.timeline(
        actor,
        { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: qcPassed ? `"${form.template.name}" signed copy created and sent for review.` : `"${form.template.name}" signed copy failed its quality check.` },
        tx,
      );
    });
    return { signed: true, qcPassed, qcIssues: filled.issues };
  }

  /** A second person checks the signed copy. Approving it counts as the customer's signature for submission. */
  async review(actor: Actor, formId: string, input: z.infer<typeof formReviewSchema>) {
    if (!can(actor, "document.review")) throw new Forbidden("Only reviewers can approve signed forms.");
    const { form, opp } = await this.loadForm(actor, formId);
    if (form.status !== "awaiting_review") throw new RuleViolation(["Only signed forms awaiting review can be reviewed."]);
    if (form.signatures.some((s) => s.uploadedById === actor.id)) throw new RuleViolation(["Someone other than the person who uploaded the signatures must review this form."]);
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

  // --- Change of supplier -------------------------------------------------------------

  /** The latest version of the previous supplier's bill (the energy bill checklist item). */
  private async latestBill(opportunityId: string) {
    return this.prisma.documentVersion.findFirst({ where: { item: { opportunityId, documentType: "energy_bill" } }, orderBy: [{ uploadedAt: "desc" }] });
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
    const meters = await this.prisma.meterPoint.findMany({ where: { site: { opportunityId } }, select: { mprn: true, gprn: true } });
    const ids = meters.flatMap((m) => [m.mprn, m.gprn]).filter((x): x is string => !!x && /^\d{7,11}$/.test(x));
    if (!ids.length) return { supplyChanges: opp.supplyChanges.map((c) => SUPPLY_CHANGE_LABELS[c]), conflicts: [], hiddenCount: 0 };
    const where: Prisma.OpportunityWhereInput = {
      id: { not: opportunityId },
      outcome: "open",
      sites: { some: { meterPoints: { some: { OR: [{ mprn: { in: ids } }, { gprn: { in: ids } }] } } } },
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

function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

const slug = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 120);
