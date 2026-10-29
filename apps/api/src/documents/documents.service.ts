import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DOCUMENT_TYPES, type SupplyChange, can, checklistFor, isSensitiveDocument, today } from "@uo/shared";
import type { documentItemSchema, documentReviewSchema } from "@uo/shared";
import type { z } from "zod";
import { ENV, type Env } from "../config/env";
import { ActivitiesService } from "../activities/activities.service";
import { AuditService } from "../audit/audit.service";
import { type Actor, SYSTEM, actorRef } from "../common/actor";
import { CryptoService } from "../common/crypto.service";
import { Forbidden, NotFound, RuleViolation } from "../common/errors";
import type { Db } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";
import { dateOnly } from "../common/values";
import { JOB_QUEUE, type JobQueue, QUEUES } from "../jobs/queue";
import { OpportunityAccess, type OppWithStage } from "../opportunities/access.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { VIRUS_SCANNER, type VirusScanner } from "../storage/virus-scan";

export const ALLOWED_TYPES: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/heic": [".heic"],
};

const label = (t: string) => (DOCUMENT_TYPES as Record<string, { label: string }>)[t]?.label ?? t;

/** Checks the file's leading bytes match its declared type (stops renamed executables). */
export function sniffMatches(mime: string, buf: Buffer): boolean {
  const hex = buf.subarray(0, 12).toString("hex");
  switch (mime) {
    case "application/pdf":
      return buf.subarray(0, 5).toString() === "%PDF-";
    case "image/jpeg":
      return hex.startsWith("ffd8ff");
    case "image/png":
      return hex.startsWith("89504e470d0a1a0a");
    case "image/webp":
      return buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP";
    case "image/heic":
      return buf.subarray(4, 8).toString() === "ftyp";
    default:
      return false;
  }
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly activities: ActivitiesService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async checklist(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    const seeSensitive = can(actor, "document.read_sensitive");
    const items = await this.prisma.documentItem.findMany({
      where: { opportunityId },
      include: { versions: { orderBy: { version: "desc" } } },
      orderBy: [{ required: "desc" }, { createdAt: "asc" }],
    });
    return items.map((i) => ({
      ...i,
      label: label(i.documentType),
      restricted: i.sensitive && !seeSensitive,
      // Restricted users see that a file exists, not its name or details.
      versions: i.sensitive && !seeSensitive ? i.versions.map((v) => ({ id: v.id, version: v.version, uploadedAt: v.uploadedAt, scanStatus: v.scanStatus, removedAt: v.removedAt })) : i.versions,
    }));
  }

  /**
   * Adds the standard checklist for the service type plus the documents its supply changes
   * require, skipping types already present and making existing optional ones required.
   */
  async ensureStandardChecklist(db: Db, opp: Pick<OppWithStage, "id" | "serviceType" | "customerId"> & { supplyChanges?: SupplyChange[] }): Promise<number> {
    const kind = opp.serviceType === "merchant_services" ? "merchant" : "energy";
    const wanted = checklistFor(kind, opp.supplyChanges);
    const rows = await db.documentItem.findMany({ where: { opportunityId: opp.id }, select: { id: true, documentType: true, required: true } });
    const existing = new Set(rows.map((d) => d.documentType));
    const nowRequired = rows.filter((r) => !r.required && wanted.some((w) => w.required && w.type === r.documentType)).map((r) => r.id);
    if (nowRequired.length) await db.documentItem.updateMany({ where: { id: { in: nowRequired } }, data: { required: true } });
    const missing = wanted.filter((d) => !existing.has(d.type));
    if (missing.length) {
      await db.documentItem.createMany({
        data: missing.map((d) => ({ opportunityId: opp.id, customerId: opp.customerId, documentType: d.type, required: d.required, sensitive: isSensitiveDocument(d.type) })),
      });
    }
    return missing.length;
  }

  async addStandard(actor: Actor, opportunityId: string) {
    const opp = await this.access.writable(actor, opportunityId);
    const added = await this.ensureStandardChecklist(this.prisma, opp);
    if (added) await this.audit.timeline(actor, { opportunityId, customerId: opp.customerId, kind: "document", body: `Added ${added} standard document${added === 1 ? "" : "s"} to the checklist.` });
    return { added };
  }

  async addItem(actor: Actor, opportunityId: string, input: z.infer<typeof documentItemSchema>) {
    const opp = await this.access.writable(actor, opportunityId);
    const item = await this.prisma.documentItem.create({
      data: {
        opportunityId,
        customerId: opp.customerId,
        documentType: input.documentType,
        required: input.required,
        sensitive: isSensitiveDocument(input.documentType),
        merchantApplicationId: input.merchantApplicationId ?? null,
        energyContractId: input.energyContractId ?? null,
        expiryDate: dateOnly(input.expiryDate) ?? null,
      },
    });
    await this.audit.timeline(actor, { opportunityId, customerId: opp.customerId, kind: "document", body: `Added "${label(item.documentType)}" to the checklist.` });
    return item;
  }

  async setRequired(actor: Actor, itemId: string, required: boolean) {
    const item = await this.item(itemId);
    await this.access.writable(actor, item.opportunityId);
    await this.prisma.documentItem.update({ where: { id: itemId }, data: { required } });
    await this.audit.log(actor, { action: "document.required", entityType: "document_item", entityId: itemId, summary: `${label(item.documentType)}: ${required ? "required" : "optional"}` });
  }

  private async item(itemId: string) {
    const item = await this.prisma.documentItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFound("Document");
    return item;
  }

  /** Marks items as requested from the customer and creates a follow-up task. */
  async request(actor: Actor, opportunityId: string, itemIds: string[]) {
    if (!can(actor, "document.request")) throw new Forbidden();
    const opp = await this.access.readable(actor, opportunityId);
    const items = await this.prisma.documentItem.findMany({ where: { opportunityId, id: { in: itemIds }, received: false } });
    if (!items.length) throw new RuleViolation(["Choose at least one outstanding document."]);
    await this.prisma.$transaction(async (tx) => {
      await tx.documentItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { requestedAt: new Date() } });
      await this.audit.timeline(actor, { opportunityId, customerId: opp.customerId, kind: "document", body: `Requested from customer: ${items.map((i) => label(i.documentType)).join(", ")}.` }, tx);
      await this.activities.ensureAutomated(tx, {
        opportunityId,
        customerId: opp.customerId,
        type: "request_documents",
        summary: `Chase documents: ${items.map((i) => label(i.documentType)).join(", ")}`,
        dueDate: today(),
        ownerId: opp.ownerId ?? actorRef(actor),
        automationKey: "missing_documents",
      });
    });
  }

  /** Every upload is a new version. The file is scanned before anyone can download it. */
  async upload(actor: Actor, itemId: string, file: UploadedFile) {
    const item = await this.item(itemId);
    const opp = await this.access.writable(actor, item.opportunityId);
    const issues: string[] = [];
    const ext = file.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
    if (!ALLOWED_TYPES[file.mimetype]) issues.push("Upload a PDF or an image (JPG, PNG, WEBP, HEIC).");
    else if (!ALLOWED_TYPES[file.mimetype].includes(ext)) issues.push("The file extension doesn't match its type.");
    else if (!sniffMatches(file.mimetype, file.buffer)) issues.push("The file content doesn't match its type.");
    if (file.size > this.env.MAX_UPLOAD_MB * 1024 * 1024) issues.push(`Files must be ${this.env.MAX_UPLOAD_MB} MB or smaller.`);
    if (file.size === 0) issues.push("The file is empty.");
    if (issues.length) throw new RuleViolation(issues);

    const sha256 = CryptoService.sha256(file.buffer);
    const [last, current] = await Promise.all([
      this.prisma.documentVersion.findFirst({ where: { itemId }, orderBy: { version: "desc" } }),
      this.prisma.documentVersion.findFirst({ where: { itemId, removedAt: null }, orderBy: { version: "desc" } }),
    ]);
    if (current?.sha256 === sha256) throw new RuleViolation(["This file is identical to the current version."]);
    // Removed versions keep their numbers, so a new upload always gets the next one.
    const version = (last?.version ?? 0) + 1;
    const storageKey = `documents/${item.opportunityId}/${itemId}/v${version}-${randomUUID()}${ext}`;
    await this.storage.put(storageKey, file.buffer, file.mimetype);

    const v = await this.prisma.$transaction(async (tx) => {
      const created = await tx.documentVersion.create({
        data: { itemId, version, storageKey, filename: file.originalname.slice(0, 200), mimeType: file.mimetype, size: file.size, sha256, uploadedById: actorRef(actor) },
      });
      // A new version needs a fresh review.
      await tx.documentItem.update({ where: { id: itemId }, data: { received: true, receivedAt: new Date(), approval: "pending", reviewerId: null, reviewedAt: null } });
      await this.audit.record(
        actor,
        { action: "document.upload", entityType: "document_item", entityId: itemId, summary: `Uploaded ${label(item.documentType)} v${version}`, data: { sha256, size: file.size } },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "document", body: `Uploaded ${label(item.documentType)} (version ${version}).` },
        tx,
      );
      return created;
    });
    await this.queue.add(QUEUES.documents, "scan", { versionId: v.id }, { jobId: `scan:${v.id}` });
    return { id: v.id, version };
  }

  /** Job handler: virus-scan a version. Infected files are deleted from storage and the item reset. */
  async scan(versionId: string) {
    const v = await this.prisma.documentVersion.findUnique({ where: { id: versionId }, include: { item: true } });
    if (!v || v.scanStatus !== "pending") return;
    const result = await this.scanner.scan(await this.storage.get(v.storageKey));
    await this.prisma.$transaction(async (tx) => {
      await tx.documentVersion.update({ where: { id: versionId }, data: { scanStatus: result } });
      if (result === "infected") {
        const hasOther = await tx.documentVersion.count({ where: { itemId: v.itemId, id: { not: versionId }, removedAt: null, scanStatus: { in: ["clean", "skipped"] } } });
        if (!hasOther) await tx.documentItem.update({ where: { id: v.itemId }, data: { received: false, receivedAt: null, approval: "pending" } });
        await this.audit.record(
          SYSTEM,
          { action: "document.infected", entityType: "document_item", entityId: v.itemId, summary: `Version ${v.version} failed the virus scan and was removed` },
          { opportunityId: v.item.opportunityId, kind: "document", body: `${label(v.item.documentType)} version ${v.version} failed the virus scan and was removed. Ask the customer for a new copy.` },
          tx,
        );
      }
    });
    if (result === "infected") await this.storage.delete(v.storageKey);
    if (result === "error") throw new Error(`Virus scan failed for document version ${versionId}`); // retried by the queue
  }

  /** Short-lived signed link. Sensitive files need document.read_sensitive; every sensitive view is logged. */
  async downloadUrl(actor: Actor, versionId: string) {
    const v = await this.prisma.documentVersion.findUnique({ where: { id: versionId }, include: { item: true } });
    if (!v) throw new NotFound("Document");
    await this.access.readable(actor, v.item.opportunityId);
    if (v.item.sensitive && !can(actor, "document.read_sensitive")) throw new Forbidden("This document is restricted.");
    if (v.scanStatus === "infected") throw new RuleViolation(["This file failed the virus scan."]);
    if (v.scanStatus === "pending" && this.scanner.name !== "none") throw new RuleViolation(["This file is still being scanned. Try again in a moment."]);
    if (v.item.sensitive) await this.audit.sensitiveAccess(actor, "document_item", v.itemId, `${label(v.item.documentType)} v${v.version}`);
    else await this.audit.log(actor, { action: "document.download", entityType: "document_item", entityId: v.itemId, summary: `Opened ${label(v.item.documentType)} v${v.version}` });
    return { url: await this.storage.signedUrl(v.storageKey, v.filename, this.env.DOWNLOAD_URL_TTL_SECONDS), mimeType: v.mimeType, expiresInSeconds: this.env.DOWNLOAD_URL_TTL_SECONDS };
  }

  /**
   * Removes a wrong upload. The version stays in the history (who removed it, when and why) but is no
   * longer the document's file; evidence other records point at (forms, checks, submissions) can't be removed.
   */
  async removeVersion(actor: Actor, versionId: string, reason: string) {
    const v = await this.prisma.documentVersion.findUnique({ where: { id: versionId }, include: { item: true } });
    if (!v) throw new NotFound("Document");
    const opp = await this.access.writable(actor, v.item.opportunityId);
    if (v.item.sensitive && !can(actor, "document.read_sensitive")) throw new Forbidden("This document is restricted.");
    if (opp.outcome !== "open") throw new RuleViolation(["Won and lost deals keep their documents as they are."]);
    if (v.removedAt) throw new RuleViolation(["This file has already been removed."]);
    const [forms, billChecks, leaseChecks, signatures, submissions] = await Promise.all([
      this.prisma.generatedForm.count({ where: { OR: [{ versionId }, { signedVersionId: versionId }, { monoVersionId: versionId }] } }),
      this.prisma.billCheck.count({ where: { documentVersionId: versionId } }),
      this.prisma.leaseCheck.count({ where: { documentVersionId: versionId } }),
      this.prisma.signatureRequest.count({ where: { signedVersionId: versionId } }),
      this.prisma.submission.count({ where: { opportunityId: opp.id, files: { array_contains: [{ documentVersionId: versionId }] } } }),
    ]);
    const usedBy = [forms && "a generated supplier form", billChecks && "a bill check", leaseChecks && "a lease check", signatures && "a signature request", submissions && "a submission to the supplier"].filter(Boolean);
    if (usedBy.length) throw new RuleViolation([`This file is kept as evidence because ${usedBy.join(", ")} uses it. Upload a new version instead.`]);

    await this.prisma.$transaction(async (tx) => {
      await tx.documentVersion.update({ where: { id: versionId }, data: { removedAt: new Date(), removedById: actorRef(actor), removeReason: reason } });
      const current = await tx.documentVersion.findFirst({ where: { itemId: v.itemId, removedAt: null, scanStatus: { not: "infected" } }, orderBy: { version: "desc" } });
      if (!current) {
        await tx.documentItem.update({ where: { id: v.itemId }, data: { received: false, receivedAt: null, approval: "pending", reviewerId: null, reviewedAt: null } });
      } else if (current.version < v.version) {
        // An earlier file is the document again, and needs a fresh review.
        await tx.documentItem.update({ where: { id: v.itemId }, data: { approval: "pending", reviewerId: null, reviewedAt: null } });
      }
      await this.audit.record(
        actor,
        { action: "document.remove_version", entityType: "document_item", entityId: v.itemId, summary: `Removed ${label(v.item.documentType)} v${v.version}`, data: { versionId, sha256: v.sha256 } },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "document", body: `Removed ${label(v.item.documentType)} version ${v.version}${v.item.sensitive ? "." : `: ${reason}`}` },
        tx,
      );
    });
  }

  /** Deletes a checklist row nothing was ever uploaded to (added by mistake). Rows with files are kept. */
  async deleteItem(actor: Actor, itemId: string) {
    const item = await this.item(itemId);
    const opp = await this.access.writable(actor, item.opportunityId);
    if (opp.outcome !== "open") throw new RuleViolation(["Won and lost deals keep their documents as they are."]);
    const [versions, readings, forms, signatures] = await Promise.all([
      this.prisma.documentVersion.count({ where: { itemId } }),
      this.prisma.meterReading.count({ where: { documentItemId: itemId } }),
      this.prisma.generatedForm.count({ where: { documentItemId: itemId } }),
      this.prisma.signatureRequest.count({ where: { documentItemId: itemId } }),
    ]);
    if (versions) throw new RuleViolation(["Files have been uploaded to this document, so it stays on the checklist. Remove the wrong file, or make the document optional."]);
    if (readings || forms || signatures) throw new RuleViolation(["Other records refer to this document, so it stays on the checklist. Make it optional instead."]);
    await this.prisma.$transaction(async (tx) => {
      await tx.documentItem.delete({ where: { id: itemId } });
      await this.audit.record(
        actor,
        { action: "document.delete_item", entityType: "document_item", entityId: itemId, summary: `Deleted ${label(item.documentType)} from the checklist (nothing uploaded)` },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "document", body: `Removed "${label(item.documentType)}" from the checklist.` },
        tx,
      );
    });
  }

  async review(actor: Actor, itemId: string, input: z.infer<typeof documentReviewSchema>) {
    if (!can(actor, "document.review")) throw new Forbidden("Only Operations, Compliance or a manager can review documents.");
    const item = await this.item(itemId);
    const opp = await this.access.readable(actor, item.opportunityId);
    if (!item.received) throw new RuleViolation(["Upload the document before reviewing it."]);
    if (input.approval === "approved") {
      const latest = await this.prisma.documentVersion.findFirst({ where: { itemId, removedAt: null }, orderBy: { version: "desc" } });
      if (!latest || latest.scanStatus === "infected" || (latest.scanStatus === "pending" && this.scanner.name !== "none")) {
        throw new RuleViolation(["The latest file hasn't passed the virus scan yet."]);
      }
    }
    if (input.approval === "rejected" && !input.reviewNotes) throw new RuleViolation(["Say why the document was rejected."]);
    await this.prisma.$transaction(async (tx) => {
      await tx.documentItem.update({
        where: { id: itemId },
        data: {
          approval: input.approval,
          reviewerId: actorRef(actor),
          reviewedAt: new Date(),
          reviewNotes: input.reviewNotes ?? null,
          ...(input.expiryDate !== undefined ? { expiryDate: dateOnly(input.expiryDate) } : {}),
          // A rejected document has to be supplied again.
          ...(input.approval === "rejected" ? { received: false } : {}),
        },
      });
      await this.audit.record(
        actor,
        { action: `document.${input.approval}`, entityType: "document_item", entityId: itemId, summary: `${label(item.documentType)} ${input.approval}` },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "document", body: `${label(item.documentType)} ${input.approval}.${input.approval === "rejected" && !item.sensitive ? ` ${input.reviewNotes}` : ""}` },
        tx,
      );
    });
  }
}
