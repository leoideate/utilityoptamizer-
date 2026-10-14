import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { type OcrConfirmInput, can } from "@uo/shared";
import { ENV, type Env } from "../config/env";
import { AuditService } from "../audit/audit.service";
import { type Actor, actorRef } from "../common/actor";
import { Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { phoneKey } from "../common/values";
import { CustomersService } from "../customers/customers.service";
import { type UploadedFile, sniffMatches } from "../documents/documents.service";
import { OpportunitiesService } from "../opportunities/opportunities.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { type CardFields, parseCardText } from "./card-parser";
import { OCR_PROVIDER, type OcrProvider } from "./providers";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];

/**
 * Scan Business Card: upload → OCR → review → (duplicate check) → confirm.
 * Nothing is created until the user confirms the reviewed details.
 */
@Injectable()
export class OcrService {
  private readonly log = new Logger(OcrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly opportunities: OpportunitiesService,
    @Inject(OCR_PROVIDER) private readonly provider: OcrProvider,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async own(actor: Actor, id: string) {
    const scan = await this.prisma.businessCardScan.findUnique({ where: { id } });
    if (!scan) throw new NotFound("Scan");
    if (scan.createdById !== actor.id && !can(actor, "opportunity.read_all")) throw new NotFound("Scan");
    return scan;
  }

  async upload(actor: Actor, file: UploadedFile) {
    if (!can(actor, "opportunity.create")) throw new Forbidden();
    if (!IMAGE_TYPES.includes(file.mimetype) || !sniffMatches(file.mimetype, file.buffer)) throw new RuleViolation(["Upload a photo of the card (JPG, PNG, WEBP or HEIC)."]);
    if (file.size > this.env.MAX_UPLOAD_MB * 1024 * 1024) throw new RuleViolation([`Images must be ${this.env.MAX_UPLOAD_MB} MB or smaller.`]);
    const storageKey = `business-cards/${randomUUID()}`;
    await this.storage.put(storageKey, file.buffer, file.mimetype);
    const scan = await this.prisma.businessCardScan.create({
      data: { storageKey, filename: file.originalname.slice(0, 200), mimeType: file.mimetype, provider: this.provider.name, createdById: actorRef(actor) },
    });
    await this.audit.log(actor, { action: "ocr.upload", entityType: "business_card_scan", entityId: scan.id, summary: "Business card uploaded" });
    return this.process(actor, scan.id);
  }

  /** Runs OCR (or, for the manual provider, just opens the review step). */
  async process(actor: Actor, id: string) {
    const scan = await this.own(actor, id);
    if (!this.provider.automatic) {
      return this.prisma.businessCardScan.update({ where: { id }, data: { status: "processed", parsed: Prisma.JsonNull, confidence: null } });
    }
    await this.prisma.businessCardScan.update({ where: { id }, data: { status: "processing" } });
    try {
      const result = await this.provider.recognise(await this.storage.get(scan.storageKey), scan.mimeType);
      const parsed: CardFields = { ...parseCardText(result.text), ...Object.fromEntries(Object.entries(result.fields ?? {}).filter(([, v]) => v)) };
      return await this.prisma.businessCardScan.update({
        where: { id },
        data: { status: "processed", rawText: result.text, parsed: parsed as unknown as Prisma.InputJsonValue, confidence: result.confidence, error: null },
      });
    } catch (e) {
      this.log.warn({ scanId: id, err: (e as Error).message }, "OCR failed");
      return this.prisma.businessCardScan.update({ where: { id }, data: { status: "failed", error: "Text couldn't be read automatically. Enter the details by hand." } });
    }
  }

  async get(actor: Actor, id: string) {
    const scan = await this.own(actor, id);
    const imageUrl = await this.storage.signedUrl(scan.storageKey, scan.filename, this.env.DOWNLOAD_URL_TTL_SECONDS);
    const parsed = (scan.parsed ?? {}) as Partial<CardFields>;
    const duplicates = await this.customers.findDuplicates({
      email: parsed.email ?? null,
      phone: parsed.mobile ?? parsed.phone ?? null,
      legalName: parsed.company ?? null,
    });
    return { ...scan, imageUrl, duplicates, automatic: this.provider.automatic };
  }

  async duplicates(actor: Actor, id: string, fields: Partial<CardFields>) {
    await this.own(actor, id);
    const byMobile = await this.customers.findDuplicates({ email: fields.email ?? null, phone: fields.mobile ?? null, legalName: fields.company ?? null });
    const byPhone = fields.phone ? await this.customers.findDuplicates({ phone: fields.phone }) : [];
    const seen = new Set<string>();
    return [...byMobile, ...byPhone].filter((d) => !seen.has(d.customer.id) && seen.add(d.customer.id));
  }

  /**
   * Creates (or links) the customer and contact from the reviewed details and opens an
   * opportunity, linking the card image to both.
   */
  async confirm(actor: Actor, id: string, input: OcrConfirmInput) {
    const scan = await this.own(actor, id);
    if (scan.status === "confirmed") throw new RuleViolation(["This card has already been added."]);
    if (scan.status === "discarded") throw new RuleViolation(["This scan was discarded."]);
    const person = [input.firstName, input.lastName].filter(Boolean).join(" ");
    if (!input.existingCustomerId && !input.company && !person) throw new RuleViolation(["Enter at least a name or a company."]);

    let customerId = input.existingCustomerId ?? null;
    if (customerId) {
      const existing = await this.prisma.customer.findUnique({ where: { id: customerId } });
      if (!existing) throw new NotFound("Customer");
    } else {
      // The user has reviewed the duplicates on screen; creating a new customer is their explicit choice.
      const created = await this.customers.create(
        actor,
        { legalName: input.company || person, website: input.website ?? null, phone: input.phone ?? null, email: input.company ? null : input.email ?? null, addresses: input.address ? [{ kind: "trading", line1: input.address, country: "IE" }] : undefined },
        true,
      );
      customerId = created.id!;
    }
    if (person || input.email || input.mobile) {
      const already = input.email ? await this.prisma.customerContact.findFirst({ where: { customerId, email: { equals: input.email, mode: "insensitive" } } }) : null;
      if (!already) {
        await this.prisma.customerContact.create({
          data: {
            customerId,
            firstName: input.firstName || person || "Contact",
            lastName: input.lastName ?? null,
            jobTitle: input.jobTitle ?? null,
            email: input.email ?? null,
            phone: input.phone ?? null,
            mobile: input.mobile ?? null,
            phoneKey: phoneKey(input.phone),
            mobileKey: phoneKey(input.mobile),
          },
        });
      }
    }
    const { id: opportunityId } = await this.opportunities.create(actor, {
      name: input.opportunityName || `${input.company || person} – ${input.serviceType === "merchant_services" ? "Worldpay" : "Energy"}`,
      serviceType: input.serviceType,
      saleType: "new_sale",
      customerId,
      contactName: person || null,
      companyName: input.company ?? null,
      email: input.email ?? null,
      phone: input.mobile ?? input.phone ?? null,
      leadSource: "business_card",
    });
    await this.prisma.businessCardScan.update({ where: { id }, data: { status: "confirmed", customerId, opportunityId } });
    await this.audit.record(
      actor,
      { action: "ocr.confirm", entityType: "business_card_scan", entityId: id, summary: "Business card confirmed" },
      { opportunityId, customerId, kind: "system", body: "Created from a scanned business card.", data: { scanId: id } },
    );
    return { customerId, opportunityId };
  }

  async discard(actor: Actor, id: string) {
    await this.own(actor, id);
    await this.prisma.businessCardScan.update({ where: { id }, data: { status: "discarded" } });
  }
}
