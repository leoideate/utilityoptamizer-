import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { FORM_SIGNER_ROLE_LABELS, type FormField, SIGNING_CONSENT_TEXT, SIGNING_CONSENT_VERSION, SIGNING_LINK_DAYS, type SigningLinkStatus } from "@uo/shared";
import type { publicSignSchema, signingLinkSchema } from "@uo/shared";
import type { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { type Actor, SYSTEM, actorRef } from "../common/actor";
import { CryptoService } from "../common/crypto.service";
import { NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { ENV, type Env } from "../config/env";
import { IntegrationsService } from "../integrations/integrations.service";
import { OpportunityAccess } from "../opportunities/access.service";
import { RealtimeService } from "../realtime/realtime";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { FormsService, signatureImageIssues } from "./forms.service";

const hashToken = (token: string) => CryptoService.sha256(token);
const linkExpiry = (from: Date) => new Date(from.getTime() + SIGNING_LINK_DAYS * 24 * 3600 * 1000);
const fmtDay = (d: Date) => new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", dateStyle: "long" }).format(d);

type LinkRow = { signedAt: Date | null; revokedAt: Date | null; expiresAt: Date; openedAt: Date | null };
export function signingLinkStatus(l: LinkRow, now = new Date()): SigningLinkStatus {
  if (l.signedAt) return "signed";
  if (l.revokedAt) return "revoked";
  if (l.expiresAt < now) return "expired";
  return l.openedAt ? "opened" : "sent";
}

/**
 * Online signing: staff send a signer an emailed link to one generated form; the signer reviews
 * the PDF and draws their signature on a public page. Links are unguessable (32 random bytes),
 * stored only as a hash, expire after SIGNING_LINK_DAYS and work once. The signature joins the
 * normal form pipeline (signed copy, quality check, second-person review).
 */
@Injectable()
export class SigningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly integrations: IntegrationsService,
    private readonly realtime: RealtimeService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // --- Staff ------------------------------------------------------------------------

  async list(actor: Actor, formId: string) {
    const form = await this.prisma.generatedForm.findUnique({ where: { id: formId } });
    if (!form) throw new NotFound("Form");
    await this.access.readable(actor, form.opportunityId);
    const links = await this.prisma.signingLink.findMany({ where: { formId }, orderBy: { createdAt: "desc" } });
    return links.map((l) => ({
      id: l.id,
      role: l.role,
      signerName: l.signerName,
      signerEmail: l.signerEmail,
      status: signingLinkStatus(l),
      expiresAt: l.expiresAt,
      lastSentAt: l.lastSentAt,
      openedAt: l.openedAt,
      signedAt: l.signedAt,
    }));
  }

  /** Creates a link for one signer (replacing any open link for the same role) and emails it. The URL is returned once. */
  async createLink(actor: Actor, formId: string, input: z.infer<typeof signingLinkSchema>) {
    const { form, opp } = await this.writableForm(actor, formId);
    this.forms.assertSignable(form, input.role);
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const link = await this.prisma.$transaction(async (tx) => {
      await tx.signingLink.updateMany({ where: { formId, role: input.role, signedAt: null, revokedAt: null }, data: { revokedAt: now } });
      const created = await tx.signingLink.create({
        data: { formId, role: input.role, signerName: input.signerName, signerEmail: input.email, tokenHash: hashToken(token), expiresAt: linkExpiry(now), createdById: actorRef(actor) },
      });
      await this.audit.record(
        actor,
        { action: "form.signing_link", entityType: "generated_form", entityId: formId, summary: `Signing link sent for ${form.template.name}`, data: { signingLinkId: created.id, role: input.role } },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: `Signing link for "${form.template.name}" ${this.integrations.emailConfigured ? "emailed" : "created"} for ${input.signerName} (${FORM_SIGNER_ROLE_LABELS[input.role].toLowerCase()}).` },
        tx,
      );
      return created;
    });
    const emailed = await this.emailLink(actor, link.id, form.template.name, opp.id, token, `${link.id}:1`);
    return { id: link.id, url: this.url(token), emailed, expiresAt: link.expiresAt };
  }

  /** Issues a fresh token for an open link (the old URL stops working), restarts its expiry and emails it again. */
  async resend(actor: Actor, linkId: string) {
    const link = await this.prisma.signingLink.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFound("Signing link");
    const { form, opp } = await this.writableForm(actor, link.formId);
    if (link.signedAt || link.revokedAt) throw new RuleViolation(["Only open signing links can be sent again."]);
    this.forms.assertSignable(form, link.role);
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const updated = await this.prisma.signingLink.update({ where: { id: linkId }, data: { tokenHash: hashToken(token), expiresAt: linkExpiry(now), lastSentAt: now } });
    await this.audit.timeline(actor, { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: `Signing link for "${form.template.name}" sent again to ${link.signerName}.` });
    const emailed = await this.emailLink(actor, linkId, form.template.name, opp.id, token, `${linkId}:${now.getTime()}`);
    return { id: linkId, url: this.url(token), emailed, expiresAt: updated.expiresAt };
  }

  async revoke(actor: Actor, linkId: string) {
    const link = await this.prisma.signingLink.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFound("Signing link");
    const { form, opp } = await this.writableForm(actor, link.formId);
    if (link.signedAt) throw new RuleViolation(["This link has already been used to sign."]);
    if (link.revokedAt) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.signingLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
      await this.audit.record(
        actor,
        { action: "form.signing_link_revoke", entityType: "generated_form", entityId: form.id, summary: "Signing link cancelled", data: { signingLinkId: linkId } },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "signature", body: `Signing link for "${form.template.name}" sent to ${link.signerName} cancelled.` },
        tx,
      );
    });
  }

  // --- Public (the signer, no CRM account) ----------------------------------------

  /** What the signing page shows. The first view is noted on the deal's timeline. */
  async publicView(token: string) {
    const { link, form } = await this.openLink(token);
    if (!link.openedAt) {
      const opened = await this.prisma.signingLink.updateMany({ where: { id: link.id, openedAt: null }, data: { openedAt: new Date() } });
      if (opened.count) await this.audit.timeline(SYSTEM, { opportunityId: form.opportunityId, customerId: form.opportunity.customerId, kind: "signature", body: `${link.signerName} opened the signing link for "${form.template.name}".` });
    }
    const broker = await this.forms.brokerProfile();
    const boxes = (form.fields as FormField[]).filter((f) => f.kind === "signature" && f.signer === link.role).map((f) => ({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h }));
    return { formName: form.template.name, brokerName: broker.companyName, signerName: link.signerName, role: link.role, expiresAt: link.expiresAt, boxes, consentText: SIGNING_CONSENT_TEXT };
  }

  /** The unsigned PDF the signer is asked to sign. */
  async publicDocument(token: string): Promise<Buffer> {
    const { form } = await this.openLink(token);
    const version = await this.prisma.documentVersion.findUniqueOrThrow({ where: { id: form.versionId } });
    return this.storage.get(version.storageKey);
  }

  async publicSign(token: string, input: z.infer<typeof publicSignSchema>, ip: string | null, userAgent: string | null) {
    const { link, form } = await this.openLink(token);
    const png = Buffer.from(input.signaturePng.slice(input.signaturePng.indexOf(",") + 1), "base64");
    if (signatureImageIssues(png).length) throw new RuleViolation(["Your signature couldn't be read. Clear it and sign again."]);
    const version = await this.prisma.documentVersion.findUniqueOrThrow({ where: { id: form.versionId } });

    // Claim the link first, so two submissions can't both sign.
    const claimed = await this.prisma.signingLink.updateMany({ where: { id: link.id, signedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { signedAt: new Date() } });
    if (!claimed.count) throw new NotFound("Signing link");

    const opp = form.opportunity;
    const online = {
      signingLinkId: link.id,
      signerEmail: link.signerEmail,
      signerIp: ip?.slice(0, 100) ?? null,
      signerUserAgent: userAgent?.slice(0, 500) ?? null,
      consentText: `${SIGNING_CONSENT_VERSION}: ${SIGNING_CONSENT_TEXT}`,
      documentSha256: version.sha256,
    };
    await this.forms.storeSignature(SYSTEM, form, opp, { role: link.role, signerName: input.typedName, signerCapacity: null, authorisation: "signed_online", note: null, png, online }).catch(async (e: unknown) => {
      // Nothing was stored, so the signer can try again with the same link.
      await this.prisma.signingLink.update({ where: { id: link.id }, data: { signedAt: null } });
      throw e;
    });
    const result = await this.forms.completeIfSigned(SYSTEM, form.id);

    const notify = [opp.ownerId, link.createdById].filter((x): x is string => !!x);
    await this.realtime.publish([...new Set(notify)], { type: "form.signed", data: { opportunityId: opp.id, formId: form.id, role: link.role, preview: `${input.typedName} signed "${form.template.name}"` } });
    if (this.integrations.emailConfigured) {
      const broker = await this.forms.brokerProfile();
      await this.integrations.enqueue(
        SYSTEM,
        "email.send",
        {
          to: link.signerEmail,
          subject: `Signed: ${form.template.name}`,
          text: `Hello ${input.typedName},\n\nThank you. We've received your signature for "${form.template.name}". ${broker.companyName} will be in touch if anything else is needed.\n\n${broker.companyName}`,
        },
        `signing-done:${link.id}`,
        opp.id,
      );
    }
    return { signed: true, complete: result.signed };
  }

  // --- Helpers ----------------------------------------------------------------------

  private url(token: string) {
    return `${new URL(this.env.WEB_ORIGIN).origin}/sign/${token}`;
  }

  private async writableForm(actor: Actor, formId: string) {
    const form = await this.prisma.generatedForm.findUnique({ where: { id: formId }, include: { template: true } });
    if (!form) throw new NotFound("Form");
    return { form, opp: await this.access.writable(actor, form.opportunityId) };
  }

  /** Finds an open link by its token. Unknown, expired, cancelled, used or superseded links all look the same. */
  private async openLink(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFound("Signing link");
    const link = await this.prisma.signingLink.findUnique({ where: { tokenHash: hashToken(token) }, include: { form: { include: { template: true, opportunity: true } } } });
    const status = link ? signingLinkStatus(link) : null;
    if (!link || (status !== "sent" && status !== "opened")) throw new NotFound("Signing link");
    const form = link.form;
    if ((form.status !== "generated" && form.status !== "awaiting_review") || !form.qcPassed) throw new NotFound("Signing link");
    return { link, form };
  }

  /** Emails the link when SMTP is set up; otherwise staff copy it from the CRM. Returns whether an email was queued. */
  private async emailLink(actor: Actor, linkId: string, formName: string, opportunityId: string, token: string, key: string) {
    if (!this.integrations.emailConfigured) return false;
    const link = await this.prisma.signingLink.findUniqueOrThrow({ where: { id: linkId } });
    const broker = await this.forms.brokerProfile();
    await this.integrations.enqueue(
      actor,
      "email.send",
      {
        to: link.signerEmail,
        subject: `Please sign: ${formName}`,
        ...(await this.integrations.withSenderSignature(actor, [
          `Hello ${link.signerName},`,
          "",
          `${broker.companyName} has prepared "${formName}" for you to sign.`,
          "Open this link to read the document and sign it online:",
          "",
          this.url(token),
          "",
          `The link works once and expires on ${fmtDay(link.expiresAt)}. If you weren't expecting this email, you can ignore it.`,
        ].join("\n"), broker.companyName)),
      },
      `signing:${key}`,
      opportunityId,
    );
    return true;
  }
}
