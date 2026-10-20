import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type CompanySignature, DEFAULT_SIGNATURE_STYLE, type EmailSignature, type SignatureImageChoice, can, renderSignature, withSignature } from "@uo/shared";
import { AuditService } from "../audit/audit.service";
import { type Actor, actorRef } from "../common/actor";
import { CryptoService } from "../common/crypto.service";
import { Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { ENV, type Env } from "../config/env";
import { sniffMatches } from "../documents/documents.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";

const COMPANY_KEY = "email.signature_company";
const MAX_IMAGE_BYTES = 1024 * 1024;
/** The letterhead logo, used until an administrator uploads another one. */
export const DEFAULT_LOGO_ID = "default-logo";
const DEFAULT_LOGO_FILE = path.resolve(__dirname, "../../assets/email-logo.png");

/** From the company letterhead. */
const DEFAULT_COMPANY: Omit<CompanySignature, "companyName"> = {
  address: "First Floor, Greenhills Road\nDublin 12, Ireland, D12NP98",
  phone: "085 8566667",
  website: null,
  email: null,
  disclaimer: null,
};

type CompanySetting = CompanySignature & { logoImageId: string | null };
type Row = { enabled: boolean; fullName: string; jobTitle: string | null; phone: string | null; mobile: string | null; email: string | null; extra: string | null; image: string; imageWidth: number; accentColor: string; showCompany: boolean; ownImageId: string | null };

/**
 * Email signatures. The company template (logo and company details) is set by an administrator;
 * each person's signature starts from it and can be changed freely, including their own picture.
 * The signature is added to email people send from the CRM, as HTML with a plain-text copy.
 */
@Injectable()
export class EmailSignaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // --- Company template ----------------------------------------------------------

  async company(): Promise<CompanySetting> {
    const saved = (await this.prisma.setting.findUnique({ where: { key: COMPANY_KEY } }))?.value as Partial<CompanySetting> | undefined;
    const broker = (await this.prisma.setting.findUnique({ where: { key: "broker.profile" } }))?.value as { companyName?: string } | undefined;
    return { companyName: broker?.companyName ?? "Utility Optimizer Limited", ...DEFAULT_COMPANY, logoImageId: null, ...(saved ?? {}) };
  }

  async saveCompany(actor: Actor, input: CompanySignature) {
    if (!can(actor, "admin.integrations")) throw new Forbidden();
    const current = await this.company();
    await this.saveCompanySetting(actor, { ...input, website: input.website || null, email: input.email || null, logoImageId: current.logoImageId });
  }

  async setCompanyLogo(actor: Actor, file: { buffer: Buffer } | null) {
    if (!can(actor, "admin.integrations")) throw new Forbidden();
    const current = await this.company();
    const logoImageId = file ? await this.storeImage(actor, file.buffer) : null;
    await this.saveCompanySetting(actor, { ...current, logoImageId });
    return { logoUrl: this.imageUrl(logoImageId ?? DEFAULT_LOGO_ID) };
  }

  private async saveCompanySetting(actor: Actor, value: CompanySetting) {
    await this.prisma.setting.upsert({ where: { key: COMPANY_KEY }, create: { key: COMPANY_KEY, value }, update: { value } });
    await this.audit.log(actor, { action: "setting.update", entityType: "setting", entityId: COMPANY_KEY, summary: "Changed the company email signature" });
  }

  // --- A person's signature ------------------------------------------------------

  /** The person's signature (or the company default for them), the company template and a rendered preview. */
  async mine(actor: Actor) {
    const { signature, ownImageId } = await this.signatureFor(actor.id);
    const company = await this.company();
    const images = this.imagesFor(company, ownImageId);
    return { signature, company, logoUrl: images.company, ownImageUrl: images.own, preview: renderSignature(signature, company, images) };
  }

  async saveMine(actor: Actor, input: EmailSignature) {
    const current = await this.prisma.emailSignature.findUnique({ where: { userId: actor.id } });
    if (input.image === "own" && !current?.ownImageId) throw new RuleViolation(["Upload your picture first, or choose the company logo."]);
    const data = { ...input, jobTitle: input.jobTitle || null, phone: input.phone || null, mobile: input.mobile || null, email: input.email || null, extra: input.extra || null };
    await this.prisma.emailSignature.upsert({ where: { userId: actor.id }, create: { userId: actor.id, ...data }, update: data });
    await this.audit.log(actor, { action: "email_signature.update", entityType: "user", entityId: actor.id, summary: "Changed their email signature" });
    return this.mine(actor);
  }

  /** Uploads the person's own picture (PNG or JPEG, up to 1 MB) and switches their signature to it. */
  async setMyImage(actor: Actor, file: { buffer: Buffer }) {
    const imageId = await this.storeImage(actor, file.buffer);
    const { signature } = await this.signatureFor(actor.id);
    const data = { ...signature, image: "own" as const, ownImageId: imageId };
    await this.prisma.emailSignature.upsert({ where: { userId: actor.id }, create: { userId: actor.id, ...data }, update: data });
    await this.audit.log(actor, { action: "email_signature.image", entityType: "user", entityId: actor.id, summary: "Uploaded a picture for their email signature" });
    return this.mine(actor);
  }

  /** The rendered signature to add to an email this person sends, or null if they turned it off. */
  async renderedFor(userId: string | null): Promise<{ html: string; text: string } | null> {
    if (!userId) return null;
    const { signature, ownImageId } = await this.signatureFor(userId);
    if (!signature.enabled) return null;
    const company = await this.company();
    return renderSignature(signature, company, this.imagesFor(company, ownImageId));
  }

  /** The message body with the sender's signature, as text and HTML. */
  async compose(userId: string | null, body: string) {
    return withSignature(body, await this.renderedFor(userId));
  }

  // --- Images --------------------------------------------------------------------

  /** A signature picture, for recipients' mail apps (public, by unguessable id). */
  async image(id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    if (id === DEFAULT_LOGO_ID) return { bytes: await readFile(DEFAULT_LOGO_FILE), mimeType: "image/png" };
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFound("Image");
    const img = await this.prisma.emailImage.findUnique({ where: { id } });
    if (!img) throw new NotFound("Image");
    return { bytes: await this.storage.get(img.storageKey), mimeType: img.mimeType };
  }

  private async storeImage(actor: Actor, buffer: Buffer): Promise<string> {
    const mimeType = sniffMatches("image/png", buffer) ? "image/png" : sniffMatches("image/jpeg", buffer) ? "image/jpeg" : null;
    const issues: string[] = [];
    if (!mimeType) issues.push("Upload a PNG or JPEG picture.");
    if (buffer.length > MAX_IMAGE_BYTES) issues.push("Pictures must be 1 MB or smaller.");
    if (issues.length) throw new RuleViolation(issues);
    const id = randomUUID();
    const storageKey = `email-images/${id}${mimeType === "image/png" ? ".png" : ".jpg"}`;
    await this.storage.put(storageKey, buffer, mimeType!);
    await this.prisma.emailImage.create({ data: { id, storageKey, mimeType: mimeType!, sha256: CryptoService.sha256(buffer), uploadedById: actorRef(actor) } });
    return id;
  }

  private imageUrl(id: string) {
    return `${new URL(this.env.WEB_ORIGIN).origin}/api/public/email-images/${id}`;
  }

  private imagesFor(company: CompanySetting, ownImageId: string | null) {
    return { company: this.imageUrl(company.logoImageId ?? DEFAULT_LOGO_ID), own: ownImageId ? this.imageUrl(ownImageId) : null };
  }

  private async signatureFor(userId: string): Promise<{ signature: EmailSignature; ownImageId: string | null }> {
    const row = (await this.prisma.emailSignature.findUnique({ where: { userId } })) as Row | null;
    if (row) {
      const { ownImageId, ...rest } = row;
      return { signature: { ...rest, image: rest.image as SignatureImageChoice }, ownImageId };
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return { signature: { enabled: true, fullName: user?.name ?? "", jobTitle: null, phone: null, mobile: user?.callbackPhone ?? null, email: user?.email ?? null, extra: null, ...DEFAULT_SIGNATURE_STYLE }, ownImageId: null };
  }
}
