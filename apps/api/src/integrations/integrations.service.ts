import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { DOCUMENT_TYPES, SERVICE_TYPE_LABELS, can } from "@uo/shared";
import { ENV, type Env } from "../config/env";
import { AuditService } from "../audit/audit.service";
import { type Actor, SYSTEM, actorRef } from "../common/actor";
import { Forbidden, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { JOB_QUEUE, type JobQueue, QUEUES } from "../jobs/queue";
import { NotificationsService } from "../notifications/notifications.service";
import { OpportunityAccess } from "../opportunities/access.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { EMAIL_SENDER, type EmailSender, NotConfigured, SUBMISSION_CHANNEL, type SubmissionChannel, WHATSAPP_SENDER, type WhatsAppSender } from "./adapters";

export type IntegrationKind = "email.send" | "whatsapp.send" | "submission.send";

/**
 * Outbound integration work. Each request becomes an IntegrationJob row (idempotency key is
 * unique) and a BullMQ job with exponential-backoff retries. After the last attempt the row is
 * marked `dead` (dead-letter) and administrators are notified; it can be retried from Admin.
 */
@Injectable()
export class IntegrationsService {
  private readonly log = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(WHATSAPP_SENDER) private readonly whatsapp: WhatsAppSender,
    @Inject(SUBMISSION_CHANNEL) private readonly submissions: SubmissionChannel,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  status() {
    return {
      email: this.email.configured,
      whatsapp: this.whatsapp.configured,
      storage: this.env.STORAGE_DRIVER,
      ocr: this.env.OCR_PROVIDER,
      signatures: this.env.SIGNATURE_PROVIDER,
      virusScan: this.env.VIRUS_SCAN_DRIVER,
    };
  }

  /** Idempotent: the same key returns the existing job instead of sending twice. */
  async enqueue(actor: Actor, kind: IntegrationKind, payload: Record<string, unknown>, idempotencyKey: string, opportunityId?: string) {
    const existing = await this.prisma.integrationJob.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
    const job = await this.prisma.integrationJob.create({
      data: { kind, payload: payload as Prisma.InputJsonValue, idempotencyKey, opportunityId: opportunityId ?? null, createdById: actorRef(actor) },
    });
    await this.queue.add(QUEUES.integrations, kind, { integrationJobId: job.id }, { jobId: job.id });
    return job;
  }

  // --- User actions ----------------------------------------------------------

  async sendEmail(actor: Actor, opportunityId: string, input: { to: string; subject: string; body: string; idempotencyKey: string }) {
    const opp = await this.access.writable(actor, opportunityId);
    if (!this.email.configured) throw new RuleViolation(["Email sending isn't set up yet. Ask an administrator."]);
    const job = await this.enqueue(actor, "email.send", { to: input.to, subject: input.subject, text: input.body, replyTo: undefined }, `email:${input.idempotencyKey}`, opportunityId);
    await this.audit.timeline(actor, { opportunityId, customerId: opp.customerId, kind: "email", direction: "outbound", body: `To ${input.to}: ${input.subject}\n\n${input.body}`, data: { integrationJobId: job.id } });
    await this.prisma.opportunity.update({ where: { id: opportunityId }, data: { lastContactAt: new Date(), firstContactAt: opp.firstContactAt ?? new Date() } });
    return { jobId: job.id };
  }

  async sendWhatsApp(actor: Actor, opportunityId: string, input: { to: string; body: string; idempotencyKey: string }) {
    const opp = await this.access.writable(actor, opportunityId);
    if (!this.whatsapp.configured) throw new RuleViolation(["WhatsApp isn't set up yet. Ask an administrator."]);
    const job = await this.enqueue(actor, "whatsapp.send", { to: input.to, text: input.body }, `whatsapp:${input.idempotencyKey}`, opportunityId);
    await this.audit.timeline(actor, { opportunityId, customerId: opp.customerId, kind: "whatsapp", direction: "outbound", body: input.body, data: { to: input.to, integrationJobId: job.id } });
    await this.prisma.opportunity.update({ where: { id: opportunityId }, data: { lastContactAt: new Date(), firstContactAt: opp.firstContactAt ?? new Date() } });
    return { jobId: job.id };
  }

  /** Emails the submission pack to the selected supplier's (or Worldpay's) submissions address. */
  async sendSubmissionPack(actor: Actor, opportunityId: string) {
    if (!can(actor, "opportunity.submit")) throw new Forbidden();
    const opp = await this.access.readable(actor, opportunityId);
    if (opp.stageKey !== "submitted" && opp.stageKey !== "compliance_query") throw new RuleViolation(["Move the opportunity to Submitted first (that checks every requirement)."]);
    let destination: string | null = null;
    if (opp.serviceType === "merchant_services") {
      const s = await this.prisma.setting.findUnique({ where: { key: "worldpay.submissionEmail" } });
      destination = typeof s?.value === "string" ? s.value : null;
    } else if (opp.selectedSupplierId) {
      destination = (await this.prisma.supplier.findUnique({ where: { id: opp.selectedSupplierId } }))?.submissionEmail ?? null;
    }
    if (!destination) throw new RuleViolation(["No submissions email address is set for this supplier. An administrator can add one."]);
    return this.enqueue(actor, "submission.send", { opportunityId, destination }, `submission:${opportunityId}:${opp.stageEnteredAt.getTime()}`, opportunityId);
  }

  // --- Worker ------------------------------------------------------------------

  /** Runs one attempt. Throws to let BullMQ retry; marks the row dead after the final attempt. */
  async execute(integrationJobId: string, attempt: number, maxAttempts: number) {
    const job = await this.prisma.integrationJob.findUnique({ where: { id: integrationJobId } });
    if (!job || job.status === "succeeded" || job.status === "dead") return;
    await this.prisma.integrationJob.update({ where: { id: job.id }, data: { status: "running", attempts: { increment: 1 } } });
    try {
      const result = await this.run(job.kind as IntegrationKind, job.payload as Record<string, string>);
      await this.prisma.integrationJob.update({ where: { id: job.id }, data: { status: "succeeded", result: result as Prisma.InputJsonValue, lastError: null } });
      if (job.kind === "submission.send" && job.opportunityId) {
        await this.audit.timeline(SYSTEM, { opportunityId: job.opportunityId, kind: "submission", body: `Submission pack emailed (${(result as { reference: string }).reference}).` });
      }
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      const final = e instanceof NotConfigured || attempt >= maxAttempts;
      await this.prisma.integrationJob.update({ where: { id: job.id }, data: { status: final ? "dead" : "failed", lastError: message } });
      this.log.warn({ integrationJobId: job.id, kind: job.kind, attempt, final }, "Integration attempt failed");
      if (final) {
        const admins = await this.prisma.user.findMany({ where: { active: true, roles: { some: { role: "administrator" } } }, select: { id: true } });
        for (const a of admins) await this.notifications.notify(a.id, { title: `Integration failed: ${job.kind}`, body: message, link: "/admin/integrations" });
        if (job.createdById) await this.notifications.notify(job.createdById, { title: `Couldn't complete: ${job.kind.replace(".", " ")}`, body: message, link: job.opportunityId ? `/opportunities/${job.opportunityId}` : undefined });
        return; // don't rethrow: dead-lettered
      }
      throw e;
    }
  }

  private async run(kind: IntegrationKind, p: Record<string, string>): Promise<unknown> {
    switch (kind) {
      case "email.send":
        return this.email.send({ to: p.to, subject: p.subject, text: p.text });
      case "whatsapp.send":
        return this.whatsapp.send(p.to, p.text);
      case "submission.send": {
        const opp = await this.prisma.opportunity.findUniqueOrThrow({
          where: { id: p.opportunityId },
          include: { customer: true, documents: { where: { approval: "approved" }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } } },
        });
        const documents = [];
        for (const d of opp.documents) {
          const v = d.versions[0];
          if (!v || v.scanStatus === "infected") continue;
          const label = (DOCUMENT_TYPES as Record<string, { label: string }>)[d.documentType]?.label ?? d.documentType;
          // Links last 7 days for the recipient; storage enforces the expiry.
          documents.push({ label, url: await this.storage.signedUrl(v.storageKey, v.filename, Math.min(7 * 24 * 3600, 604800)) });
        }
        return this.submissions.submit(p.destination, {
          opportunityNumber: opp.number,
          customerName: opp.customer?.legalName ?? opp.companyName ?? opp.name,
          serviceType: SERVICE_TYPE_LABELS[opp.serviceType],
          summary: `Submitted by Utility Optimizer Limited.`,
          documents,
        });
      }
    }
  }

  /** Admin: list jobs (dead-letter queue first) and retry. */
  list(status?: "failed" | "dead" | "pending" | "succeeded") {
    return this.prisma.integrationJob.findMany({ where: status ? { status } : {}, orderBy: { updatedAt: "desc" }, take: 200 });
  }

  async retry(actor: Actor, id: string) {
    if (!can(actor, "admin.integrations")) throw new Forbidden();
    const job = await this.prisma.integrationJob.update({ where: { id }, data: { status: "pending", lastError: null, attempts: 0 } });
    await this.queue.add(QUEUES.integrations, job.kind, { integrationJobId: job.id }, { jobId: `${job.id}:retry:${Date.now()}` });
    await this.audit.log(actor, { action: "integration.retry", entityType: "integration_job", entityId: id, summary: `Retried ${job.kind}` });
  }
}
