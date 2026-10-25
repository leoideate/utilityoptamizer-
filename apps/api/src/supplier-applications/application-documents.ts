import { Inject, Injectable } from "@nestjs/common";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { type FormField, type FormSignerRole, type SupplierApplicationKind, applicationStatus, can, canWriteOpportunity } from "@uo/shared";
import { AuditService } from "../audit/audit.service";
import { type Actor, actorRef } from "../common/actor";
import { CryptoService } from "../common/crypto.service";
import { NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { FormsService, requiredSigners } from "../forms/forms.service";
import type { FillValue } from "../forms/pdf";
import { SigningService, signingLinkStatus } from "../forms/signing.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";

/** How one supplier's application turns its data into a filled PDF (Flogas draws on the page; Bord Gáis fills the PDF's fields). */
export interface ApplicationFiller {
  /** Fills the template with the data; issues are user-facing sentences and stop the version being stored. */
  fill(template: Buffer, title: string): Promise<{ fields: FormField[]; values: Record<string, FillValue>; bytes: Uint8Array; issues: string[] }>;
}

export interface ApplicationKindInfo {
  kind: SupplierApplicationKind;
  /** Used in audit and timeline text: "Flogas electricity". */
  label: string;
  /** Where the form is filled: "the Flogas form". */
  formName: string;
  /** Shown when no template has been uploaded. */
  missingTemplate: string;
}

export const dataHash = (data: unknown) => CryptoService.sha256(JSON.stringify(data));

/**
 * Versions, signing and history of a supplier application, the same for every supplier: each
 * generated version is an append-only row linked to a GeneratedForm (stored PDF, field snapshot,
 * encrypted values), sent through online signing only while it still matches the CRM.
 */
@Injectable()
export class ApplicationDocuments {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly forms: FormsService,
    private readonly signing: SigningService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** The broker's company name, printed as the agency on supplier forms. */
  brokerProfile() {
    return this.forms.brokerProfile();
  }

  /** The supplier's template an administrator uploaded (newest first), if any. */
  template(kind: SupplierApplicationKind) {
    return this.prisma.formTemplate.findFirst({ where: { workflow: kind, active: true }, orderBy: { createdAt: "desc" } });
  }

  versions(applicationId: string | undefined) {
    if (!applicationId) return Promise.resolve([]);
    return this.prisma.supplierApplicationVersion.findMany({
      where: { applicationId },
      orderBy: { version: "desc" },
      include: { form: { include: { signatures: { orderBy: { uploadedAt: "asc" } }, signingLinks: { orderBy: { createdAt: "desc" } } } } },
    });
  }

  async userNames(ids: (string | null)[]) {
    const clean = [...new Set(ids.filter((x): x is string => !!x))];
    const users = clean.length ? await this.prisma.user.findMany({ where: { id: { in: clean } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  permissions(actor: Actor, opp: { outcome: string; ownerId: string | null }) {
    const write = opp.outcome === "open" && canWriteOpportunity(actor, { ownerId: opp.ownerId });
    return {
      write,
      customerWrite: write && can(actor, "customer.write"),
      bankRead: can(actor, "bank.read"),
      bankWrite: write && can(actor, "bank.write"),
      readSensitive: can(actor, "document.read_sensitive"),
      review: can(actor, "document.review"),
    };
  }

  /** The application's versions as the UI shows them, with where it stands. `hash` is the current data's. */
  async describe(applicationId: string | undefined, hash: string) {
    const versions = await this.versions(applicationId);
    const current = versions.find((v) => v.form.status !== "superseded") ?? null;
    const stale = !!current && current.dataSha256 !== hash;
    const items = await this.prisma.documentItem.findMany({ where: { id: { in: versions.map((v) => v.form.documentItemId) } }, select: { id: true, sensitive: true } });
    const users = await this.userNames(versions.flatMap((v) => [v.createdById, v.form.reviewedById, v.form.signedCopyUploadedById, ...v.form.signatures.map((s) => s.uploadedById)]));
    return {
      status: applicationStatus({ form: current?.form ?? null, stale, links: current ? current.form.signingLinks.map((l) => ({ role: l.role, status: signingLinkStatus(l) })) : [] }),
      stale,
      currentFormId: current?.formId ?? null,
      versions: versions.map((v) => ({
        version: v.version,
        formId: v.formId,
        layoutVersion: v.layoutVersion,
        templateVersion: v.form.templateVersion,
        createdAt: v.createdAt,
        createdBy: users.get(v.createdById ?? "") ?? null,
        status: v.form.status,
        current: v.formId === current?.formId,
        qcPassed: v.form.qcPassed,
        versionId: v.form.versionId,
        signedVersionId: v.form.signedVersionId,
        signedCopyUpload: v.form.signedCopyUploadedAt ? { uploadedById: v.form.signedCopyUploadedById, uploadedBy: users.get(v.form.signedCopyUploadedById ?? "") ?? null, uploadedAt: v.form.signedCopyUploadedAt } : null,
        sensitive: items.find((i) => i.id === v.form.documentItemId)?.sensitive ?? false,
        requiredSigners: requiredSigners(v.form.fields as never),
        reviewedAt: v.form.reviewedAt,
        reviewedBy: users.get(v.form.reviewedById ?? "") ?? null,
        reviewNote: v.form.reviewNote,
        signatures: v.form.signatures.map((s) => ({ id: s.id, role: s.role, signerName: s.signerName, authorisation: s.authorisation, uploadedAt: s.uploadedAt, uploadedById: s.uploadedById, online: !!s.signingLinkId })),
        links: v.form.signingLinks.map((l) => ({
          id: l.id,
          role: l.role,
          signerName: l.signerName,
          signerEmail: l.signerEmail,
          status: signingLinkStatus(l),
          sentAt: l.lastSentAt,
          openedAt: l.openedAt,
          signedAt: l.signedAt,
          declinedAt: l.declinedAt,
          declineReason: l.declineReason,
          expiresAt: l.expiresAt,
          sentById: l.createdById,
        })),
      })),
    };
  }

  /** Who did what to the application, its versions, their signing and downloads, newest first. */
  async history(opportunityId: string, kind: SupplierApplicationKind) {
    const app = await this.prisma.supplierApplication.findUnique({ where: { opportunityId_kind: { opportunityId, kind } } });
    if (!app) return [];
    const versions = await this.prisma.supplierApplicationVersion.findMany({ where: { applicationId: app.id }, select: { formId: true, form: { select: { documentItemId: true } } } });
    const logs = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: "supplier_application", entityId: app.id },
          { entityType: "generated_form", entityId: { in: versions.map((v) => v.formId) } },
          { entityType: "document_item", entityId: { in: versions.map((v) => v.form.documentItemId) } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const users = await this.userNames(logs.map((l) => l.actorId));
    return logs.map((l) => ({ id: l.id, at: l.createdAt, action: l.action, summary: l.summary, actor: l.actorId ? (users.get(l.actorId) ?? "Unknown user") : "Automation" }));
  }

  /**
   * Generates the next version: filled on the supplier's original PDF, quality-checked and stored
   * with a snapshot of its data. Nothing changed since the current unsent version returns it; a
   * version that was already sent or signed is replaced only when confirmed, and is kept.
   */
  async generate(
    actor: Actor,
    info: ApplicationKindInfo,
    input: {
      opp: { id: string; number: number; customerId: string | null };
      appId: string | null;
      data: unknown;
      layoutVersion: string;
      filler: ApplicationFiller;
      /** The filled PDF holds bank details. */
      sensitive: (values: Record<string, FillValue>) => boolean;
      confirmReplace?: boolean;
    },
  ) {
    const t = await this.template(info.kind);
    if (!t) throw new RuleViolation([info.missingTemplate]);
    const app = input.appId
      ? { id: input.appId }
      : await this.prisma.supplierApplication.create({ data: { opportunityId: input.opp.id, kind: info.kind, answers: {}, createdById: actorRef(actor), updatedById: actorRef(actor) } });
    const versions = await this.versions(app.id);
    const current = versions.find((v) => v.form.status !== "superseded");
    const hash = dataHash(input.data);
    if (current) {
      const used = current.form.status !== "generated" || current.form.signatures.length > 0 || current.form.signingLinks.some((l) => !l.revokedAt);
      if (!used && current.dataSha256 === hash && current.form.templateId === t.id && current.layoutVersion === input.layoutVersion) return { formId: current.formId, version: current.version, unchanged: true };
      if (used && !input.confirmReplace) {
        const what = current.form.status === "approved" ? "signed and approved" : current.form.status === "awaiting_review" ? "signed" : "sent for signature";
        throw new RuleViolation([`Version ${current.version} has already been ${what}. Confirm to replace it with a new version; version ${current.version} is kept.`]);
      }
    }
    const version = (versions[0]?.version ?? 0) + 1;
    const title = `${info.label} application v${version} – UO-${String(input.opp.number).padStart(6, "0")}`;
    const filled = await input.filler.fill(await this.storage.get(t.storageKey), title);
    if (filled.issues.length) throw new RuleViolation(filled.issues);

    const form = await this.forms.storeGenerated(actor, input.opp, t, {
      fields: filled.fields,
      values: filled.values,
      filled: { bytes: filled.bytes, issues: [] },
      title,
      sensitive: input.sensitive(filled.values),
      onCreated: async (tx, created) => {
        await tx.supplierApplicationVersion.create({
          data: { applicationId: app.id, version, formId: created.id, layoutVersion: input.layoutVersion, dataEnc: this.crypto.encryptJson(input.data), dataSha256: hash, createdById: actorRef(actor) },
        });
        // Links for the replaced version stop working with it; cancelling them keeps the record clear.
        if (current) await tx.signingLink.updateMany({ where: { formId: current.formId, signedAt: null, revokedAt: null, declinedAt: null }, data: { revokedAt: new Date() } });
        await this.audit.record(
          actor,
          {
            action: "supplier_application.generate",
            entityType: "supplier_application",
            entityId: app.id,
            summary: `Generated ${info.label} application version ${version}`,
            data: { formId: created.id, version, layoutVersion: input.layoutVersion, templateId: t.id, templateVersion: t.version, replacedVersion: current?.version ?? null },
          },
          {
            opportunityId: input.opp.id,
            customerId: input.opp.customerId,
            kind: "document",
            body: `${info.label} application version ${version} generated on ${info.formName} (template version ${t.version}).${current ? ` Version ${current.version} was replaced and is kept; its open signing links were cancelled.` : ""}`,
          },
          tx,
        );
      },
    });
    return { formId: form.id, version, unchanged: false };
  }

  /** Marks a draft preview, so it can't be mistaken for the document to sign. */
  async markDraft(bytes: Uint8Array): Promise<Buffer> {
    const doc = await PDFDocument.load(bytes);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (const page of doc.getPages()) {
      const text = "DRAFT PREVIEW – NOT FOR SIGNATURE";
      const x = (page.getWidth() - font.widthOfTextAtSize(text, 10)) / 2;
      page.drawText(text, { x, y: page.getHeight() - 14, size: 10, font, color: rgb(0.75, 0.1, 0.1) });
    }
    return Buffer.from(await doc.save());
  }

  /** The version to send, checked: it belongs to the deal, is current, and the CRM hasn't changed since. */
  async sendable(opportunityId: string, formId: string, currentHash: string) {
    const v = await this.prisma.supplierApplicationVersion.findUnique({ where: { formId }, include: { form: true, application: true } });
    if (!v || v.application.opportunityId !== opportunityId) throw new NotFound("Application version");
    if (v.form.status === "superseded") throw new RuleViolation([`Version ${v.version} has been replaced. Send the latest version.`]);
    if (v.dataSha256 !== currentHash) throw new RuleViolation([`The application has changed since version ${v.version} was generated. Generate a new version, then send that.`]);
    return v;
  }

  async send(actor: Actor, opportunityId: string, formId: string, currentHash: string, input: { role: FormSignerRole; signerName: string; email: string }) {
    const v = await this.sendable(opportunityId, formId, currentHash);
    if (!requiredSigners(v.form.fields as never).includes(input.role)) throw new RuleViolation(["This version has no signature box for that signer."]);
    return this.signing.createLink(actor, formId, input, { viaApplication: true });
  }

  async resend(actor: Actor, opportunityId: string, linkId: string, currentHash: string) {
    const link = await this.prisma.signingLink.findUnique({ where: { id: linkId }, select: { formId: true } });
    if (!link) throw new NotFound("Signing link");
    await this.sendable(opportunityId, link.formId, currentHash);
    return this.signing.resend(actor, linkId, { viaApplication: true });
  }
}
