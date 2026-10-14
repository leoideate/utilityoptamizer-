import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { can, today } from "@uo/shared";
import type { signatureRequestSchema } from "@uo/shared";
import type { z } from "zod";
import { ENV, type Env } from "../config/env";
import { ActivitiesService } from "../activities/activities.service";
import { AuditService } from "../audit/audit.service";
import { type Actor, SYSTEM, actorRef } from "../common/actor";
import { Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { DocumentsService, type UploadedFile } from "../documents/documents.service";
import { OpportunityAccess } from "../opportunities/access.service";
import { SIGNATURE_PROVIDER, type SignatureEvent, type SignatureProvider, verifyWebhook } from "./provider";

@Injectable()
export class SignaturesService {
  private readonly log = new Logger(SignaturesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly activities: ActivitiesService,
    private readonly documents: DocumentsService,
    @Inject(SIGNATURE_PROVIDER) private readonly provider: SignatureProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    return this.prisma.signatureRequest.findMany({ where: { opportunityId }, include: { signers: true, template: true }, orderBy: { createdAt: "desc" } });
  }

  templates() {
    return this.prisma.signatureTemplate.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  }

  async createTemplate(actor: Actor, input: { name: string; serviceType?: "electricity" | "gas" | "dual_fuel" | "merchant_services" | null; providerTemplateId?: string | null }) {
    if (!can(actor, "admin.integrations")) throw new Forbidden();
    return this.prisma.signatureTemplate.create({ data: { name: input.name, serviceType: input.serviceType ?? null, providerTemplateId: input.providerTemplateId ?? null, provider: this.provider.name } });
  }

  async request(actor: Actor, opportunityId: string, input: z.infer<typeof signatureRequestSchema>) {
    const opp = await this.access.writable(actor, opportunityId);
    const template = input.templateId ? await this.prisma.signatureTemplate.findUnique({ where: { id: input.templateId } }) : null;
    if (input.templateId && !template) throw new NotFound("Signature template");
    const req = await this.prisma.signatureRequest.create({
      data: {
        opportunityId,
        templateId: template?.id ?? null,
        documentItemId: input.documentItemId ?? null,
        title: input.title,
        provider: this.provider.name,
        status: "draft",
        createdById: actorRef(actor),
        signers: { create: input.signers },
      },
      include: { signers: true },
    });
    const { providerRequestId } = await this.provider.send({
      requestId: req.id,
      title: req.title,
      providerTemplateId: template?.providerTemplateId,
      signers: req.signers.map((s) => ({ id: s.id, role: s.role, name: s.name, email: s.email })),
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.signatureRequest.update({ where: { id: req.id }, data: { providerRequestId, status: "sent", requestedAt: new Date() } });
      await this.audit.record(
        actor,
        { action: "signature.request", entityType: "signature_request", entityId: req.id, summary: `Signature requested: ${req.title}` },
        { opportunityId, customerId: opp.customerId, kind: "signature", body: `Signature requested: ${req.title} (${req.signers.map((s) => `${s.name}, ${s.role}`).join("; ")}).` },
        tx,
      );
      await this.activities.ensureAutomated(tx, { opportunityId, customerId: opp.customerId, type: "obtain_signature", summary: `Obtain signature: ${req.title}`, dueDate: today(), ownerId: opp.ownerId, automationKey: `signature:${req.id}` });
    });
    return { id: req.id };
  }

  private async load(actor: Actor, id: string) {
    const req = await this.prisma.signatureRequest.findUnique({ where: { id }, include: { signers: true } });
    if (!req) throw new NotFound("Signature request");
    const opp = await this.access.writable(actor, req.opportunityId);
    return { req, opp };
  }

  async remind(actor: Actor, id: string) {
    const { req, opp } = await this.load(actor, id);
    if (!["sent", "partially_signed"].includes(req.status)) throw new RuleViolation(["Only open signature requests can be reminded."]);
    await this.provider.remind(req.providerRequestId!);
    await this.prisma.signatureRequest.update({ where: { id }, data: { lastReminderAt: new Date() } });
    await this.audit.timeline(actor, { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: `Signature reminder sent: ${req.title}.` });
  }

  async cancel(actor: Actor, id: string) {
    const { req, opp } = await this.load(actor, id);
    if (req.status === "completed") throw new RuleViolation(["A completed signature can't be cancelled."]);
    await this.provider.cancel(req.providerRequestId!);
    await this.prisma.$transaction(async (tx) => {
      await tx.signatureRequest.update({ where: { id }, data: { status: "cancelled" } });
      await this.activities.completeAutomated(tx, opp.id, `signature:${id}`);
      await this.audit.record(
        actor,
        { action: "signature.cancel", entityType: "signature_request", entityId: id, summary: "Signature request cancelled" },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: `Signature request cancelled: ${req.title}.` },
        tx,
      );
    });
  }

  /**
   * Manual provider: staff record that a signer has signed. The signed copy (if given) is
   * stored as a new version of the linked checklist document.
   */
  async recordSigned(actor: Actor, id: string, signerId: string, signedFile?: UploadedFile) {
    const { req } = await this.load(actor, id);
    if (req.provider !== "manual") throw new RuleViolation(["This request is managed by the e-signature provider."]);
    const signer = req.signers.find((s) => s.id === signerId);
    if (!signer) throw new NotFound("Signer");
    let signedVersionId: string | undefined;
    if (signedFile) {
      const itemId = req.documentItemId ?? (await this.documentItemFor(req.opportunityId, req.title));
      signedVersionId = (await this.documents.upload(actor, itemId, signedFile)).id;
    }
    await this.applyEvent(actor, req.id, { type: "signer_signed", signerEmail: signer.email }, signedVersionId);
  }

  private async documentItemFor(opportunityId: string, title: string): Promise<string> {
    const opp = await this.prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
    const type = opp.serviceType === "merchant_services" ? "worldpay_application" : "supplier_contract";
    const existing = await this.prisma.documentItem.findFirst({ where: { opportunityId, documentType: type } });
    if (existing) return existing.id;
    const item = await this.prisma.documentItem.create({ data: { opportunityId, customerId: opp.customerId, documentType: type, required: true, reviewNotes: `Created for signature: ${title}` } });
    return item.id;
  }

  /** Applies a signing event (from staff or a provider webhook) and completes the request when everyone has signed. */
  private async applyEvent(actor: Actor, requestId: string, ev: { type: SignatureEvent["type"]; signerEmail?: string }, signedVersionId?: string) {
    await this.prisma.$transaction(async (tx) => {
      const req = await tx.signatureRequest.findUniqueOrThrow({ where: { id: requestId }, include: { signers: true, opportunity: true } });
      if (["completed", "cancelled", "declined", "expired"].includes(req.status)) return;
      const now = new Date();
      const signer = ev.signerEmail ? req.signers.find((s) => s.email.toLowerCase() === ev.signerEmail!.toLowerCase()) : undefined;
      if ((ev.type === "signer_signed" || ev.type === "signer_declined") && !signer) throw new NotFound("Signer");
      if (ev.type === "signer_signed") await tx.signer.update({ where: { id: signer!.id }, data: { status: "signed", signedAt: now } });
      if (ev.type === "signer_declined") await tx.signer.update({ where: { id: signer!.id }, data: { status: "declined" } });

      const signers = await tx.signer.findMany({ where: { requestId } });
      let status = req.status;
      if (ev.type === "completed" || signers.every((s) => s.status === "signed")) status = "completed";
      else if (ev.type === "declined" || ev.type === "signer_declined") status = "declined";
      else if (ev.type === "expired") status = "expired";
      else if (signers.some((s) => s.status === "signed")) status = "partially_signed";

      await tx.signatureRequest.update({
        where: { id: requestId },
        data: { status, completedAt: status === "completed" ? now : undefined, signedVersionId: signedVersionId ?? undefined },
      });
      const opp = req.opportunity;
      const who = signer ? `${signer.name} (${signer.role})` : "";
      const text: Record<string, string> = {
        signer_signed: `${who} signed "${req.title}".`,
        signer_declined: `${who} declined to sign "${req.title}".`,
        completed: `"${req.title}" fully signed.`,
        declined: `"${req.title}" was declined.`,
        expired: `"${req.title}" expired before it was signed.`,
      };
      await this.audit.record(
        actor,
        { action: `signature.${ev.type}`, entityType: "signature_request", entityId: requestId, summary: text[ev.type] },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: text[ev.type] },
        tx,
      );
      if (status === "completed") {
        if (ev.type !== "completed") await this.audit.timeline(actor, { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: `"${req.title}" fully signed.` }, tx);
        await this.activities.completeAutomated(tx, opp.id, `signature:${requestId}`);
        await this.activities.completeAutomated(tx, opp.id, "signature_reminder");
        await tx.energyContract.updateMany({ where: { opportunityId: opp.id, status: { in: ["draft", "quoted", "selected"] } }, data: { status: "signed" } });
      }
    });
  }

  /**
   * Inbound provider webhook: HMAC-verified, processed once per event id (idempotent).
   * Failures are recorded on the WebhookEvent row (dead-letter) for an administrator to inspect.
   */
  async handleWebhook(rawBody: string, signatureHeader: string | undefined): Promise<{ status: "processed" | "duplicate" }> {
    if (!this.env.SIGNATURE_WEBHOOK_SECRET || !verifyWebhook(this.env.SIGNATURE_WEBHOOK_SECRET, rawBody, signatureHeader)) {
      throw new Forbidden("Invalid webhook signature.");
    }
    const ev = JSON.parse(rawBody) as SignatureEvent;
    if (!ev.eventId || !ev.providerRequestId || !ev.type) throw new RuleViolation(["Malformed signature event."]);
    try {
      await this.prisma.webhookEvent.create({ data: { provider: this.provider.name, eventId: ev.eventId, payload: { ...ev, signedDocumentBase64: undefined } as Prisma.InputJsonValue } });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return { status: "duplicate" };
      throw e;
    }
    try {
      const req = await this.prisma.signatureRequest.findUnique({ where: { providerRequestId: ev.providerRequestId } });
      if (!req) throw new NotFound("Signature request");
      let versionId: string | undefined;
      if (ev.type === "completed" && ev.signedDocumentBase64) {
        const itemId = req.documentItemId ?? (await this.documentItemFor(req.opportunityId, req.title));
        versionId = (
          await this.documents.upload(SYSTEM, itemId, { originalname: `${req.title}-signed.pdf`, mimetype: "application/pdf", buffer: Buffer.from(ev.signedDocumentBase64, "base64"), size: Buffer.byteLength(ev.signedDocumentBase64, "base64") })
        ).id;
      }
      await this.applyEvent(SYSTEM, req.id, ev, versionId);
      await this.prisma.webhookEvent.update({ where: { provider_eventId: { provider: this.provider.name, eventId: ev.eventId } }, data: { status: "succeeded", processedAt: new Date() } });
      return { status: "processed" };
    } catch (e) {
      this.log.error({ err: e, eventId: ev.eventId }, "Signature webhook failed");
      await this.prisma.webhookEvent.update({ where: { provider_eventId: { provider: this.provider.name, eventId: ev.eventId } }, data: { status: "dead", error: (e as Error).message.slice(0, 500) } });
      throw e;
    }
  }
}
