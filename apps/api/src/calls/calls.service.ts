import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CallLog, CallStatus } from "@prisma/client";
import { can, toE164, today } from "@uo/shared";
import type { callOutcomeSchema, startCallSchema } from "@uo/shared";
import type { z } from "zod";
import { ActivitiesService } from "../activities/activities.service";
import { ENV, type Env } from "../config/env";
import { AuditService } from "../audit/audit.service";
import { type Actor, SYSTEM } from "../common/actor";
import { OPEN_DEAL, pickDeal } from "../common/linking";
import { Forbidden, NotFound, RuleViolation } from "../common/errors";
import type { Db } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";
import { phoneKey } from "../common/values";
import { JOB_QUEUE, type JobQueue, QUEUES } from "../jobs/queue";
import { OpportunityAccess } from "../opportunities/access.service";
import { RealtimeService } from "../realtime/realtime";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { VIRUS_SCANNER, type VirusScanner } from "../storage/virus-scan";
import { type CallLogRecord, FINAL_STATUSES, TELEPHONY_PROVIDER, type TelephonyProvider, isCallLogSource } from "./telephony";

export const POLL_INTERVAL_MS = 4_000;
/** Stop following a call after this long (it's then left as last seen). */
export const MAX_FOLLOW_MS = 4 * 3_600_000;
/** Call-log sync re-reads this much before the last cursor (records can appear late). */
const CALL_LOG_OVERLAP_MS = 15 * 60_000;
const CALL_LOG_CURSOR = "ringcentral.callLog.cursor";
/** A click-to-call and its call-log record start within this of each other. */
const RINGOUT_MATCH_MS = 3 * 60_000;

const OUTCOME_LABELS: Record<z.infer<typeof callOutcomeSchema>["outcome"], string> = {
  answered: "Answered",
  no_answer: "No answer",
  busy: "Busy",
  voicemail: "Left voicemail",
  wrong_number: "Wrong number",
  call_back_requested: "Asked us to call back",
};
const OUTCOME_STATUS: Record<z.infer<typeof callOutcomeSchema>["outcome"], CallStatus> = {
  answered: "completed",
  no_answer: "no_answer",
  busy: "busy",
  voicemail: "no_answer",
  wrong_number: "completed",
  call_back_requested: "completed",
};

export interface DialableNumber {
  number: string;
  label: string;
  contactId: string | null;
}

const fmtDuration = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);

/**
 * Click-to-call to customers. Only numbers held on the opportunity, its customer or contacts can
 * be dialled (so the CRM can't be used as an open dialler). Every finished call is written to the
 * opportunity timeline exactly once and counts as contact with the customer.
 */
@Injectable()
export class CallsService {
  private readonly log = new Logger(CallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly activities: ActivitiesService,
    private readonly realtime: RealtimeService,
    @Inject(TELEPHONY_PROVIDER) private readonly provider: TelephonyProvider,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    @Inject(ENV) private readonly env: Env,
  ) {}

  info(actorPhone: string | null) {
    return { provider: this.provider.name, bridged: this.provider.bridged, myPhone: actorPhone };
  }

  async myPhone(actor: Actor) {
    return (await this.prisma.user.findUnique({ where: { id: actor.id }, select: { callbackPhone: true } }))?.callbackPhone ?? null;
  }

  async setMyPhone(actor: Actor, phone: string | null) {
    const normalised = phone ? toE164(phone) : null;
    if (phone && !normalised) throw new RuleViolation(["Enter a valid phone number, e.g. 087 123 4567 or +353 1 234 5678."]);
    await this.prisma.user.update({ where: { id: actor.id }, data: { callbackPhone: normalised } });
    return { phone: normalised };
  }

  async numbers(actor: Actor, opportunityId: string): Promise<DialableNumber[]> {
    const opp = await this.access.readable(actor, opportunityId);
    const out: DialableNumber[] = [];
    const add = (raw: string | null | undefined, label: string, contactId: string | null = null) => {
      const n = toE164(raw);
      if (n && !out.some((o) => o.number === n)) out.push({ number: n, label, contactId });
    };
    if (opp.customerId) {
      const c = await this.prisma.customer.findUnique({ where: { id: opp.customerId }, include: { contacts: { orderBy: { isPrimary: "desc" } } } });
      for (const ct of c?.contacts ?? []) {
        const name = [ct.firstName, ct.lastName].filter(Boolean).join(" ");
        add(ct.mobile, `${name} (mobile)`, ct.id);
        add(ct.phone, `${name} (phone)`, ct.id);
      }
      add(c?.phone, `${c?.legalName ?? "Customer"} (main)`);
    }
    add(opp.phone, opp.contactName ? `${opp.contactName} (from lead)` : "Phone from lead");
    return out;
  }

  async list(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    const calls = await this.prisma.callLog.findMany({ where: { opportunityId }, orderBy: { startedAt: "desc" }, take: 100 });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(calls.map((c) => c.userId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
    return calls.map((c) => ({ ...c, userName: users.find((u) => u.id === c.userId)?.name ?? "" }));
  }

  async start(actor: Actor, opportunityId: string, input: z.infer<typeof startCallSchema>) {
    const opp = await this.access.writable(actor, opportunityId);
    const target = toE164(input.number);
    const allowed = await this.numbers(actor, opportunityId);
    const match = allowed.find((n) => n.number === target);
    if (!target || !match) throw new RuleViolation(["Choose one of the numbers saved for this customer."]);

    let agentNumber: string | null = null;
    if (this.provider.bridged) {
      agentNumber = await this.myPhone(actor);
      if (!agentNumber) throw new RuleViolation(["Add your own phone number first (Account → Security & phone), so we know which phone to ring."]);
    }
    const call = await this.prisma.callLog.create({
      data: {
        opportunityId,
        customerId: opp.customerId,
        contactId: input.contactId ?? match.contactId,
        userId: actor.id,
        toNumber: target,
        agentNumber,
        provider: this.provider.name,
      },
    });
    if (!this.provider.bridged) return { call, mode: "manual" as const, telUri: `tel:${target}` };

    try {
      const { providerCallId } = await this.provider.start({ agentNumber: agentNumber!, customerNumber: target });
      const updated = await this.prisma.callLog.update({ where: { id: call.id }, data: { providerCallId, status: "ringing_agent" } });
      await this.queue.add(QUEUES.integrations, "call.poll", { callId: call.id }, { delayMs: POLL_INTERVAL_MS, jobId: `call.poll:${call.id}:0`, attempts: 1 });
      await this.realtime.publish([actor.id], { type: "call.updated", data: { callId: call.id, opportunityId, status: updated.status } });
      return { call: updated, mode: "bridged" as const };
    } catch (e) {
      this.log.warn({ callId: call.id, err: (e as Error).message }, "Call could not be started");
      await this.prisma.callLog.update({ where: { id: call.id }, data: { status: "failed", endedAt: new Date(), outcome: "Couldn't start the call" } });
      throw new RuleViolation(["The phone system couldn't start the call. Try again, or dial from your phone."]);
    }
  }

  private async owned(actor: Actor, id: string) {
    const call = await this.prisma.callLog.findUnique({ where: { id } });
    if (!call) throw new NotFound("Call");
    if (call.userId !== actor.id && !can(actor, "opportunity.write_all")) throw new Forbidden("This is someone else's call.");
    if (call.opportunityId) await this.access.readable(actor, call.opportunityId);
    return call;
  }

  async get(actor: Actor, id: string) {
    return this.owned(actor, id);
  }

  async cancel(actor: Actor, id: string) {
    const call = await this.owned(actor, id);
    if (FINAL_STATUSES.includes(call.status)) return call;
    if (call.providerCallId) await this.provider.cancel(call.providerCallId).catch(() => undefined);
    const updated = await this.prisma.callLog.update({ where: { id }, data: { status: "canceled", endedAt: new Date() } });
    await this.finalise(updated);
    return updated;
  }

  /** Background job: follow a bridged call until it ends, then log it. */
  async poll(callId: string, attempt = 0) {
    const call = await this.prisma.callLog.findUnique({ where: { id: callId } });
    if (!call || !call.providerCallId || FINAL_STATUSES.includes(call.status)) return;
    let state;
    try {
      state = await this.provider.status(call.providerCallId);
    } catch (e) {
      this.log.warn({ callId, err: (e as Error).message }, "Call status check failed");
      state = { status: call.status };
    }
    const now = new Date();
    let status = state.status;
    // A finished session that was never answered didn't connect.
    if (status === "completed" && !call.answeredAt) status = call.status === "ringing_agent" ? "canceled" : "no_answer";
    const data: Partial<CallLog> = { status };
    if (status === "in_progress" && !call.answeredAt) data.answeredAt = now;
    if (FINAL_STATUSES.includes(status)) {
      data.endedAt = now;
      if (call.answeredAt && status === "completed") data.durationSec = Math.max(1, Math.round((now.getTime() - call.answeredAt.getTime()) / 1000));
      if (state.detail && !call.outcome) data.outcome = state.detail;
    }
    const updated = await this.prisma.callLog.update({ where: { id: callId }, data });
    if (updated.status !== call.status) {
      await this.realtime.publish([call.userId], { type: "call.updated", data: { callId, opportunityId: call.opportunityId, status: updated.status } });
    }
    if (FINAL_STATUSES.includes(updated.status)) return this.finalise(updated);
    if (now.getTime() - call.startedAt.getTime() < MAX_FOLLOW_MS) {
      await this.queue.add(QUEUES.integrations, "call.poll", { callId, attempt: attempt + 1 }, { delayMs: POLL_INTERVAL_MS, jobId: `call.poll:${callId}:${attempt + 1}`, attempts: 1 });
    }
  }

  /** The salesperson records what happened (manual calls), or adds notes to a dialled call. */
  async recordOutcome(actor: Actor, id: string, input: z.infer<typeof callOutcomeSchema>) {
    const call = await this.owned(actor, id);
    const label = OUTCOME_LABELS[input.outcome];
    const durationSec = input.durationMinutes != null ? input.durationMinutes * 60 : undefined;
    const manual = call.provider === "manual";
    const updated = await this.prisma.callLog.update({
      where: { id },
      data: {
        outcome: label,
        notes: input.notes ?? null,
        ...(durationSec !== undefined ? { durationSec } : {}),
        ...(manual ? { status: OUTCOME_STATUS[input.outcome], endedAt: call.endedAt ?? new Date(), answeredAt: input.outcome === "answered" ? (call.answeredAt ?? call.startedAt) : null } : {}),
      },
    });
    if (!updated.loggedAt && (manual || FINAL_STATUSES.includes(updated.status))) {
      await this.finalise(updated);
    } else if (call.opportunityId) {
      // Already on the timeline: add the notes as a follow-up entry (timeline entries are never edited).
      await this.audit.timeline(actor, { opportunityId: call.opportunityId, customerId: call.customerId, kind: "call", direction: "outbound", body: `Call outcome: ${label}.${input.notes ? `\n${input.notes}` : ""}`, data: { callId: id } });
    }
    return this.prisma.callLog.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Writes the call to the deal or customer timeline exactly once, records contact with the customer,
   * and turns a missed inbound call into a "call back" task.
   */
  private async finalise(call: CallLog, db: Db = this.prisma) {
    const claimed = await db.callLog.updateMany({ where: { id: call.id, loggedAt: null }, data: { loggedAt: new Date() } });
    if (!claimed.count || (!call.opportunityId && !call.customerId)) return;
    const user = call.userId ? await db.user.findUnique({ where: { id: call.userId }, select: { name: true } }) : null;
    const actor: Actor = call.userId && user ? { id: call.userId, name: user.name, roles: [] } : SYSTEM;
    const inbound = call.direction === "inbound";
    const connected = call.status === "completed";
    const missed = inbound && !connected;
    // RingOut doesn't report a duration; the call log does (for calls imported or matched to it).
    const approx = call.provider === "ringcentral" && !call.rcRecordId;
    const parts = [
      inbound ? `${missed ? "Missed call" : "Inbound call"} from ${call.toNumber}` : `Outbound call to ${call.toNumber}`,
      missed ? call.outcome : (call.outcome ?? (connected ? "Connected" : call.status.replace("_", " "))),
      call.durationSec ? `${fmtDuration(call.durationSec)}${approx ? " (approx.)" : ""}` : null,
    ].filter((p) => p && p !== "Missed");
    await this.audit.timeline(
      actor,
      {
        opportunityId: call.opportunityId ?? undefined,
        customerId: call.customerId,
        kind: "call",
        direction: inbound ? "inbound" : "outbound",
        body: `${parts.join(" · ")}.${call.notes ? `\n${call.notes}` : ""}`,
        occurredAt: call.startedAt,
        data: { callId: call.id, provider: call.provider, status: call.status },
      },
      db,
    );
    let dealOwner: string | null = null;
    if (call.opportunityId) {
      const opp = await db.opportunity.findUnique({ where: { id: call.opportunityId }, select: { firstContactAt: true, ownerId: true, customerId: true } });
      dealOwner = opp?.ownerId ?? null;
      if (connected) {
        await db.opportunity.update({ where: { id: call.opportunityId }, data: { lastContactAt: call.startedAt, firstContactAt: opp?.firstContactAt ?? call.startedAt } });
        await this.activities.completeAutomated(db, call.opportunityId, "first_contact");
        await this.activities.completeAutomated(db, call.opportunityId, "first_contact_overdue");
      }
      if (missed) {
        await this.activities.ensureAutomated(db, {
          opportunityId: call.opportunityId,
          customerId: opp?.customerId ?? call.customerId,
          type: "call",
          summary: `Call back ${call.toNumber}`,
          note: `Missed call at ${call.startedAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin", dateStyle: "medium", timeStyle: "short" })}.`,
          dueDate: today(),
          priority: "high",
          ownerId: dealOwner ?? call.userId,
          automationKey: `missed_call:${call.id}`,
        });
      }
    }
    await this.realtime.publish([call.userId, dealOwner], { type: "call.updated", data: { callId: call.id, opportunityId: call.opportunityId, status: call.status, logged: true } });
  }

  // --- Call-log sync -------------------------------------------------------------------------

  /** The customer and open deal a phone number belongs to (same rules as email). */
  private async matchNumber(number: string, staffId: string | null): Promise<{ customerId: string | null; opportunityId: string | null; contactId: string | null }> {
    const key = phoneKey(number);
    if (!key) return { customerId: null, opportunityId: null, contactId: null };
    const customers = await this.prisma.customer.findMany({
      where: { mergedIntoId: null, OR: [{ phoneKey: key }, { contacts: { some: { OR: [{ phoneKey: key }, { mobileKey: key }] } } }] },
      select: { id: true, contacts: { where: { OR: [{ phoneKey: key }, { mobileKey: key }] }, select: { id: true }, take: 1 } },
      take: 20,
    });
    const ids = customers.map((c) => c.id);
    const deals = await this.prisma.opportunity.findMany({
      where: { ...OPEN_DEAL, OR: [...(ids.length ? [{ customerId: { in: ids } }] : []), { customerId: null, phoneKey: key }] },
      select: { id: true, customerId: true, ownerId: true },
      take: 50,
    });
    const deal = pickDeal(deals, staffId);
    const customerId = deal ? deal.customerId : ids.length === 1 ? ids[0] : null;
    const contactId = customers.find((c) => c.id === customerId)?.contacts[0]?.id ?? null;
    return { customerId, opportunityId: deal?.id ?? null, contactId };
  }

  /** Links RingCentral extensions to CRM users by email (the address on both must match). */
  private async mapExtensions(source: { extensions(): Promise<{ id: string; email: string | null }[]> }) {
    const extensions = await source.extensions();
    const users = await this.prisma.user.findMany({ where: { active: true }, select: { id: true, email: true, ringcentralExtensionId: true } });
    const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
    const map = new Map<string, string>();
    for (const ext of extensions) {
      const u = ext.email ? byEmail.get(ext.email) : undefined;
      if (!u) continue;
      map.set(ext.id, u.id);
      if (u.ringcentralExtensionId !== ext.id) {
        await this.prisma.user.updateMany({ where: { ringcentralExtensionId: ext.id, id: { not: u.id } }, data: { ringcentralExtensionId: null } });
        await this.prisma.user.update({ where: { id: u.id }, data: { ringcentralExtensionId: ext.id } });
      }
    }
    for (const u of users) if (u.ringcentralExtensionId && !map.has(u.ringcentralExtensionId)) map.set(u.ringcentralExtensionId, u.id);
    return map;
  }

  /**
   * Scheduled: imports every call on the RingCentral account since the last run (inbound, missed,
   * and calls made from desk phones or the RingCentral app), links each to the customer and deal by
   * number, and logs it once. Click-to-calls the CRM started are matched to their record, not duplicated.
   */
  async syncCallLog(now = new Date()) {
    if (!isCallLogSource(this.provider)) return { skipped: true };
    const extUser = await this.mapExtensions(this.provider);

    // Deals created before phone keys existed (or by the seed) get one, so leads can be matched by number.
    const missingKeys = await this.prisma.opportunity.findMany({ where: { phoneKey: null, phone: { not: null } }, select: { id: true, phone: true }, take: 500 });
    for (const o of missingKeys) {
      const key = phoneKey(o.phone);
      if (key) await this.prisma.opportunity.update({ where: { id: o.id }, data: { phoneKey: key } });
    }

    const cursor = await this.prisma.setting.findUnique({ where: { key: CALL_LOG_CURSOR } });
    const from = typeof cursor?.value === "string" ? new Date(new Date(cursor.value).getTime() - CALL_LOG_OVERLAP_MS) : new Date(now.getTime() - 86_400_000);
    const records = await this.provider.callLog(from, now);
    let imported = 0;
    let matched = 0;
    for (const r of records) {
      const result = await this.importRecord(r, r.extensionId ? (extUser.get(r.extensionId) ?? null) : null);
      if (result === "imported") imported++;
      if (result === "matched") matched++;
    }
    await this.prisma.setting.upsert({ where: { key: CALL_LOG_CURSOR }, create: { key: CALL_LOG_CURSOR, value: now.toISOString() }, update: { value: now.toISOString() } });
    return { records: records.length, imported, matched };
  }

  private async importRecord(r: CallLogRecord, userId: string | null): Promise<"imported" | "matched" | "known"> {
    if (await this.prisma.callLog.findUnique({ where: { rcRecordId: r.id }, select: { id: true } })) return "known";
    const counterpart = r.counterpart ? (toE164(r.counterpart) ?? r.counterpart) : "Unknown number";
    const endedAt = new Date(r.startedAt.getTime() + r.durationSec * 1000);

    // A click-to-call from the CRM: attach the record (exact duration) instead of logging it again.
    if (r.direction === "outbound" && userId) {
      const key = phoneKey(counterpart);
      const candidates = await this.prisma.callLog.findMany({
        where: { provider: "ringcentral", rcRecordId: null, userId, direction: "outbound", startedAt: { gte: new Date(r.startedAt.getTime() - RINGOUT_MATCH_MS), lte: new Date(r.startedAt.getTime() + RINGOUT_MATCH_MS) } },
        orderBy: { startedAt: "asc" },
      });
      // Redials to the same number are common: take the click-to-call nearest in time.
      const same = candidates
        .filter((c) => phoneKey(c.toNumber) === key)
        .sort((a, b) => Math.abs(a.startedAt.getTime() - r.startedAt.getTime()) - Math.abs(b.startedAt.getTime() - r.startedAt.getTime()))[0];
      if (same) {
        await this.prisma.callLog.update({ where: { id: same.id }, data: { rcRecordId: r.id, rcSessionId: r.sessionId, ...(r.durationSec ? { durationSec: r.durationSec } : {}), ...this.recordingFields(r) } });
        await this.queueRecording(same.id, r);
        return "matched";
      }
    }

    const link = await this.matchNumber(counterpart, userId);
    let call: CallLog;
    try {
      call = await this.prisma.callLog.create({
        data: {
          ...link,
          userId,
          direction: r.direction,
          toNumber: counterpart,
          agentNumber: r.ourNumber ? (toE164(r.ourNumber) ?? r.ourNumber) : null,
          provider: "ringcentral",
          rcRecordId: r.id,
          rcSessionId: r.sessionId,
          status: r.status,
          startedAt: r.startedAt,
          answeredAt: r.status === "completed" ? r.startedAt : null,
          endedAt,
          durationSec: r.durationSec || null,
          outcome: r.outcome,
          ...this.recordingFields(r),
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return "known";
      throw e;
    }
    await this.finalise(call);
    await this.queueRecording(call.id, r);
    return "imported";
  }

  // --- Recordings -------------------------------------------------------------------------------

  private recordingFields(r: CallLogRecord) {
    return this.env.RINGCENTRAL_RECORDINGS && r.recording ? { rcRecordingId: r.recording.id, recordingScan: "pending" as const } : {};
  }

  private async queueRecording(callId: string, r: CallLogRecord) {
    if (!this.env.RINGCENTRAL_RECORDINGS || !r.recording) return;
    await this.queue.add(QUEUES.integrations, "call.recording", { callId, contentUri: r.recording.contentUri }, { jobId: `call.recording:${callId}` });
  }

  /** Job: copies a recording into our storage and virus-scans it (retried by the queue on failure). */
  async fetchRecording(callId: string, contentUri: string) {
    const call = await this.prisma.callLog.findUnique({ where: { id: callId } });
    if (!call || call.recordingKey || call.recordingDeletedAt || !isCallLogSource(this.provider)) return;
    const { body, contentType } = await this.provider.recording(contentUri);
    const ext = contentType === "audio/wav" || contentType === "audio/x-wav" ? "wav" : "mp3";
    const key = `recordings/${callId}.${ext}`;
    await this.storage.put(key, body, contentType);
    const scan = await this.scanner.scan(body);
    if (scan === "infected") {
      await this.storage.delete(key);
      await this.prisma.callLog.update({ where: { id: callId }, data: { recordingScan: "infected" } });
      this.log.warn({ callId }, "Call recording failed the virus scan and was discarded");
      return;
    }
    if (scan === "error") throw new Error(`Virus scan failed for the recording of call ${callId}`);
    await this.prisma.callLog.update({ where: { id: callId }, data: { recordingKey: key, recordingMime: contentType, recordingSize: body.length, recordingScan: scan } });
  }

  /**
   * A short-lived link to play a call recording: for the person on the call, or anyone who can see
   * its deal or customer. Every play is recorded as access to sensitive data.
   */
  async recordingUrl(actor: Actor, id: string) {
    const call = await this.prisma.callLog.findUnique({ where: { id } });
    if (!call) throw new NotFound("Call");
    let allowed = call.userId === actor.id;
    if (!allowed && call.opportunityId) allowed = await this.access.readable(actor, call.opportunityId).then(() => true, () => false);
    if (!allowed && call.customerId) allowed = (await this.prisma.customer.count({ where: { AND: [{ id: call.customerId }, this.access.customerWhere(actor)] } })) > 0;
    if (!allowed) throw new NotFound("Call");
    if (!call.recordingKey) throw new RuleViolation([call.recordingDeletedAt ? "This recording was deleted under the retention policy." : call.rcRecordingId ? "The recording is still being fetched. Try again in a minute." : "This call wasn't recorded."]);
    await this.audit.sensitiveAccess(actor, "call", id, "Call recording");
    const filename = `call-${call.startedAt.toISOString().slice(0, 10)}.${call.recordingKey.split(".").pop()}`;
    return { url: await this.storage.signedUrl(call.recordingKey, filename, this.env.DOWNLOAD_URL_TTL_SECONDS), mimeType: call.recordingMime, expiresInSeconds: this.env.DOWNLOAD_URL_TTL_SECONDS };
  }
}
