import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CallLog, CallStatus } from "@prisma/client";
import { can, toE164 } from "@uo/shared";
import type { callOutcomeSchema, startCallSchema } from "@uo/shared";
import type { z } from "zod";
import { ActivitiesService } from "../activities/activities.service";
import { AuditService } from "../audit/audit.service";
import { type Actor, SYSTEM } from "../common/actor";
import { Forbidden, NotFound, RuleViolation } from "../common/errors";
import type { Db } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";
import { JOB_QUEUE, type JobQueue, QUEUES } from "../jobs/queue";
import { OpportunityAccess } from "../opportunities/access.service";
import { RealtimeService } from "../realtime/realtime";
import { FINAL_STATUSES, TELEPHONY_PROVIDER, type TelephonyProvider } from "./telephony";

export const POLL_INTERVAL_MS = 4_000;
/** Stop following a call after this long (it's then left as last seen). */
export const MAX_FOLLOW_MS = 4 * 3_600_000;

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
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(calls.map((c) => c.userId))] } }, select: { id: true, name: true } });
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

  /** Writes the call to the timeline exactly once and records contact with the customer. */
  private async finalise(call: CallLog, db: Db = this.prisma) {
    const claimed = await db.callLog.updateMany({ where: { id: call.id, loggedAt: null }, data: { loggedAt: new Date() } });
    if (!claimed.count || !call.opportunityId) return;
    const user = await db.user.findUnique({ where: { id: call.userId }, select: { name: true } });
    const actor: Actor = user ? { id: call.userId, name: user.name, roles: [] } : SYSTEM;
    const connected = call.status === "completed";
    const parts = [
      `Outbound call to ${call.toNumber}`,
      call.outcome ?? (connected ? "Connected" : call.status.replace("_", " ")),
      call.durationSec ? `${fmtDuration(call.durationSec)}${call.provider === "ringcentral" ? " (approx.)" : ""}` : null,
    ].filter(Boolean);
    await this.audit.timeline(actor, {
      opportunityId: call.opportunityId,
      customerId: call.customerId,
      kind: "call",
      direction: "outbound",
      body: `${parts.join(" · ")}.${call.notes ? `\n${call.notes}` : ""}`,
      occurredAt: call.startedAt,
      data: { callId: call.id, provider: call.provider, status: call.status },
    }, db);
    if (connected) {
      const opp = await db.opportunity.findUnique({ where: { id: call.opportunityId }, select: { firstContactAt: true } });
      await db.opportunity.update({ where: { id: call.opportunityId }, data: { lastContactAt: call.startedAt, firstContactAt: opp?.firstContactAt ?? call.startedAt } });
      await this.activities.completeAutomated(db, call.opportunityId, "first_contact");
      await this.activities.completeAutomated(db, call.opportunityId, "first_contact_overdue");
    }
    await this.realtime.publish([call.userId], { type: "call.updated", data: { callId: call.id, opportunityId: call.opportunityId, status: call.status, logged: true } });
  }
}
