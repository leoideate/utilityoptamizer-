import { Inject, Injectable, Logger } from "@nestjs/common";
import { addMonths, today } from "@uo/shared";
import { AuditService } from "../audit/audit.service";
import { SYSTEM } from "../common/actor";
import { PrismaService } from "../common/prisma.service";
import { dateOnly } from "../common/values";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { AdminService } from "./admin.service";

/**
 * Applies the configured retention policy (Admin → Retention):
 * - sensitive documents and principal personal data on lost deals / long-ended contracts are erased;
 * - unconfirmed business-card scans are deleted;
 * - call recordings are deleted after their retention period (the call stays on the timeline);
 * - CRM assistant conversations are deleted after 90 days;
 * - audit-log rows older than the retention period are purged (the only permitted deletion,
 *   done with the uo.allow_purge flag the append-only trigger checks).
 * Opportunities, customers and the timeline are never deleted.
 */
const ASSISTANT_DAYS = 90;

@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminService,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async run(asOf = today()) {
    const p = await this.admin.retention();
    const lostBefore = new Date(`${addMonths(asOf, -p.lostSensitiveDataMonths)}T00:00:00Z`);
    const endedBefore = dateOnly(addMonths(asOf, -p.endedSensitiveDataMonths));
    const expiredOpps = await this.prisma.opportunity.findMany({
      where: {
        OR: [
          { outcome: "lost", lostAt: { lt: lostBefore } },
          // renewalDate is the earliest contract end; deals with no end date are never purged.
          { outcome: "won", renewals: { none: {} }, renewalDate: { lt: endedBefore } },
        ],
      },
      select: { id: true },
    });
    const ids = expiredOpps.map((o) => o.id);
    let files = 0;
    let principals = 0;
    if (ids.length) {
      const versions = await this.prisma.documentVersion.findMany({ where: { item: { opportunityId: { in: ids }, sensitive: true } } });
      for (const v of versions) {
        await this.storage.delete(v.storageKey);
        files++;
      }
      await this.prisma.documentVersion.deleteMany({ where: { id: { in: versions.map((v) => v.id) } } });
      const res = await this.prisma.principal.updateMany({
        where: { application: { opportunityId: { in: ids } }, OR: [{ hasDob: true }, { hasNationality: true }] },
        data: { dobEnc: null, nationalityEnc: null, hasDob: false, hasNationality: false },
      });
      principals = res.count;
      await this.prisma.principalAddress.deleteMany({ where: { principal: { application: { opportunityId: { in: ids } } } } });
      await this.prisma.merchantRisk.updateMany({ where: { application: { opportunityId: { in: ids } } }, data: { restrictedNotesEnc: null } });
    }

    const oldScans = await this.prisma.businessCardScan.findMany({ where: { status: { not: "confirmed" }, createdAt: { lt: new Date(Date.now() - p.ocrScanDays * 86_400_000) } } });
    for (const s of oldScans) await this.storage.delete(s.storageKey);
    await this.prisma.businessCardScan.deleteMany({ where: { id: { in: oldScans.map((s) => s.id) } } });

    // Call recordings: the file goes, the call (and its timeline entry) stays.
    const recordingsBefore = new Date(`${addMonths(asOf, -p.recordingMonths)}T00:00:00Z`);
    const oldRecordings = await this.prisma.callLog.findMany({ where: { recordingKey: { not: null }, startedAt: { lt: recordingsBefore } }, select: { id: true, recordingKey: true } });
    for (const r of oldRecordings) {
      await this.storage.delete(r.recordingKey!);
      await this.prisma.callLog.update({ where: { id: r.id }, data: { recordingKey: null, recordingDeletedAt: new Date() } });
    }

    const auditBefore = new Date(`${addMonths(asOf, -12 * p.auditLogYears)}T00:00:00Z`);
    const purged = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('uo.allow_purge', 'on', true)`;
      return tx.auditLog.deleteMany({ where: { createdAt: { lt: auditBefore } } });
    });

    // Assistant conversations are kept for 90 days (their feedback and messages go with them).
    const conversationsBefore = new Date(Date.now() - ASSISTANT_DAYS * 86_400_000);
    const conversations = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('uo.allow_purge', 'on', true)`;
      const old = { conversation: { createdAt: { lt: conversationsBefore } } };
      await tx.assistantFeedback.deleteMany({ where: { message: old } });
      await tx.assistantMessage.deleteMany({ where: old });
      return tx.assistantConversation.deleteMany({ where: { createdAt: { lt: conversationsBefore } } });
    });

    const summary = { opportunities: ids.length, sensitiveFiles: files, principals, scans: oldScans.length, recordings: oldRecordings.length, auditRows: purged.count, assistantConversations: conversations.count };
    await this.audit.log(SYSTEM, { action: "retention.run", entityType: "system", summary: "Retention policy applied", data: summary });
    this.log.log({ summary }, "Retention run complete");
    return summary;
  }
}
