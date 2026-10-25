import { Inject, Injectable } from "@nestjs/common";
import { BILL_READING_TYPES } from "@uo/shared";
import { AuditService } from "../audit/audit.service";
import { ENV, type Env } from "../config/env";
import type { Actor } from "../common/actor";
import { NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { OpportunityAccess } from "../opportunities/access.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { DOCUMENT_READER, type DocumentReader, ReadFailed } from "./document-reader";

/**
 * "Read bill": the AI reads an uploaded energy bill and returns suggested values. It saves
 * nothing; the person applies what they accept through the usual energy endpoints.
 */
@Injectable()
export class BillReadingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(DOCUMENT_READER) private readonly reader: DocumentReader,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async read(actor: Actor, versionId: string) {
    const v = await this.prisma.documentVersion.findUnique({ where: { id: versionId }, include: { item: true } });
    if (!v) throw new NotFound("Document");
    // Reading costs money and leads to edits, so it needs write access to the deal.
    await this.access.writable(actor, v.item.opportunityId);
    if (v.item.documentType !== "energy_bill") throw new RuleViolation(["Only energy bills can be read this way."]);
    if (!this.reader.configured) throw new RuleViolation(["Reading bills with AI isn't set up yet. An administrator needs to add the Anthropic API key."]);
    if (v.scanStatus === "infected" || v.scanStatus === "error") throw new RuleViolation(["This file failed the virus scan."]);
    if (v.scanStatus === "pending" && this.env.VIRUS_SCAN_DRIVER !== "none") throw new RuleViolation(["This file is still being scanned. Try again in a moment."]);
    if (!(BILL_READING_TYPES as readonly string[]).includes(v.mimeType)) throw new RuleViolation(["The AI can read PDFs and JPG, PNG or WEBP photos. Upload the bill in one of those formats."]);

    let reading;
    try {
      reading = await this.reader.readBill(await this.storage.get(v.storageKey), v.mimeType);
    } catch (e) {
      if (e instanceof ReadFailed) throw new RuleViolation([e.message]);
      throw e;
    }
    // No extracted values in the audit entry: it only records that the bill was sent to the model.
    await this.audit.log(actor, {
      action: "document.ai_read",
      entityType: "document_item",
      entityId: v.itemId,
      summary: `Read energy bill v${v.version} with AI`,
      data: { versionId, model: this.reader.model, readable: reading.readable },
    });
    return { versionId, documentItemId: v.itemId, model: this.reader.model, reading };
  }
}
