import { createHash, timingSafeEqual } from "node:crypto";
import { Controller, Get, Headers, HttpCode, Inject, Injectable, Logger, Post, Query, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Prisma } from "@prisma/client";
import { toE164 } from "@uo/shared";
import type { Request, Response } from "express";
import { z } from "zod";
import { ENV, type Env } from "../config/env";
import type { Actor } from "../common/actor";
import { CurrentUser, Public, SkipCsrf } from "../common/decorators";
import { Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { OPEN_DEAL } from "../common/linking";
import { phoneKey } from "../common/values";
import { ZodPipe } from "../common/zod.pipe";
import { OpportunityAccess } from "../opportunities/access.service";
import { RealtimeService } from "../realtime/realtime";
import { TELEPHONY_PROVIDER, type TelephonyProvider, isEventSource } from "./telephony";

const SUBSCRIPTION_SETTING = "ringcentral.subscription";
/** Renew when the subscription has less than this left (RingCentral webhooks last up to 7 days). */
const RENEW_WITHIN_MS = 2 * 86_400_000;

interface TelephonyEvent {
  uuid?: string;
  body?: {
    telephonySessionId?: string;
    sequence?: number;
    parties?: { extensionId?: string; direction?: string; status?: { code?: string }; from?: { phoneNumber?: string } }[];
  };
}

/** What the person whose phone is ringing needs to know: ringing, answered, or gone. */
const STATES: Record<string, "ringing" | "answered" | "ended"> = { Setup: "ringing", Proceeding: "ringing", Answered: "answered", Disconnected: "ended", Gone: "ended", Voicemail: "ended" };

const sameToken = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

/**
 * Incoming-call pop-ups. RingCentral pushes account telephony-session events to a webhook; the CRM
 * tells the person whose extension is ringing (by live update: session id, state and caller number
 * only), and their browser looks the caller up through the normal permission-checked API.
 */
@Injectable()
export class RingCentralEventsService {
  private readonly log = new Logger(RingCentralEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly realtime: RealtimeService,
    @Inject(TELEPHONY_PROVIDER) private readonly provider: TelephonyProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get enabled() {
    return isEventSource(this.provider) && !!this.env.RINGCENTRAL_WEBHOOK_TOKEN;
  }

  webhookAddress() {
    return this.env.RINGCENTRAL_WEBHOOK_URL ?? `${this.env.WEB_ORIGIN.replace(/\/$/, "")}/api/webhooks/ringcentral`;
  }

  /** Scheduled: keeps one webhook subscription alive (creates it, or renews it before it lapses). */
  async ensureSubscription(now = new Date()) {
    if (!this.enabled || !isEventSource(this.provider)) return { skipped: "not configured" };
    const address = this.webhookAddress();
    if (!address.startsWith("https://")) return { skipped: "RingCentral only delivers to a public https address" };
    const saved = (await this.prisma.setting.findUnique({ where: { key: SUBSCRIPTION_SETTING } }))?.value as { id?: string } | undefined;
    let sub = saved?.id ? await this.provider.subscription(saved.id) : null;
    if (sub && sub.status === "Active" && sub.expiresAt.getTime() - now.getTime() > RENEW_WITHIN_MS) return { id: sub.id, action: "kept" };
    let action: "renewed" | "created";
    if (sub && sub.status === "Active") {
      sub = { ...(await this.provider.renewSubscription(sub.id)), status: "Active" };
      action = "renewed";
    } else {
      sub = { ...(await this.provider.subscribe(address, this.env.RINGCENTRAL_WEBHOOK_TOKEN!)), status: "Active" };
      action = "created";
    }
    const value = { id: sub.id, expiresAt: sub.expiresAt.toISOString() };
    await this.prisma.setting.upsert({ where: { key: SUBSCRIPTION_SETTING }, create: { key: SUBSCRIPTION_SETTING, value }, update: { value } });
    this.log.log({ subscriptionId: sub.id, action }, "RingCentral webhook subscription");
    return { id: sub.id, action };
  }

  /** One webhook delivery: verified by token, stored once per event, then pushed to the right people. */
  async handle(raw: string, verificationToken: string | undefined) {
    if (!this.enabled || !verificationToken || !sameToken(verificationToken, this.env.RINGCENTRAL_WEBHOOK_TOKEN!)) throw new Forbidden("Invalid webhook token.");
    let ev: TelephonyEvent;
    try {
      ev = JSON.parse(raw) as TelephonyEvent;
    } catch {
      throw new RuleViolation(["Malformed event."]);
    }
    const sessionId = ev.body?.telephonySessionId;
    if (!sessionId) return { status: "ignored" };
    const eventId = ev.uuid ?? `${sessionId}:${ev.body?.sequence ?? 0}`;
    try {
      await this.prisma.webhookEvent.create({ data: { provider: "ringcentral", eventId, payload: { sessionId, sequence: ev.body?.sequence ?? null } as Prisma.InputJsonValue } });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return { status: "duplicate" };
      throw e;
    }

    let notified = 0;
    for (const party of ev.body?.parties ?? []) {
      const state = STATES[party.status?.code ?? ""];
      if (party.direction !== "Inbound" || !party.extensionId || !state) continue;
      const user = await this.prisma.user.findUnique({ where: { ringcentralExtensionId: String(party.extensionId) }, select: { id: true, active: true } });
      if (!user?.active) continue;
      const from = party.from?.phoneNumber ? (toE164(party.from.phoneNumber) ?? party.from.phoneNumber) : null;
      await this.realtime.publish([user.id], { type: "call.incoming", data: { sessionId, state, from } });
      notified++;
    }
    await this.prisma.webhookEvent.update({ where: { provider_eventId: { provider: "ringcentral", eventId } }, data: { status: "succeeded", processedAt: new Date() } });
    return { status: "processed", notified };
  }

  /** Who's calling: the customers and open deals with this number that the person may see. */
  async caller(actor: Actor, number: string) {
    const key = phoneKey(number);
    if (!key) throw new NotFound("Caller");
    const customers = await this.prisma.customer.findMany({
      where: { AND: [{ mergedIntoId: null, OR: [{ phoneKey: key }, { contacts: { some: { OR: [{ phoneKey: key }, { mobileKey: key }] } } }] }, this.access.customerWhere(actor)] },
      select: { id: true, legalName: true, contacts: { where: { OR: [{ phoneKey: key }, { mobileKey: key }] }, select: { firstName: true, lastName: true }, take: 1 } },
      take: 5,
    });
    const deals = await this.prisma.opportunity.findMany({
      where: { AND: [OPEN_DEAL, this.access.visibleWhere(actor), { OR: [...(customers.length ? [{ customerId: { in: customers.map((c) => c.id) } }] : []), { customerId: null, phoneKey: key }] }] },
      select: { id: true, name: true, stage: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });
    return {
      number: toE164(number) ?? number,
      customers: customers.map((c) => ({ id: c.id, name: c.legalName, contact: c.contacts[0] ? [c.contacts[0].firstName, c.contacts[0].lastName].filter(Boolean).join(" ") : null })),
      deals: deals.map((d) => ({ id: d.id, name: d.name, stage: d.stage.name })),
    };
  }
}

@ApiTags("calls")
@Controller()
export class RingCentralEventsController {
  constructor(private readonly events: RingCentralEventsService) {}

  /**
   * RingCentral call events. Authenticated by the subscription's verification token, not by session.
   * On creating the subscription RingCentral first sends a Validation-Token, which must be echoed.
   */
  @Public()
  @SkipCsrf()
  @SkipThrottle()
  @Post("webhooks/ringcentral")
  @HttpCode(200)
  webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Res({ passthrough: true }) res: Response,
    @Headers("validation-token") validationToken?: string,
    @Headers("verification-token") verificationToken?: string,
  ) {
    if (validationToken) {
      if (!this.events.enabled || !/^[\w-]{1,200}$/.test(validationToken)) throw new Forbidden("Webhooks aren't enabled.");
      res.setHeader("Validation-Token", validationToken);
      return {};
    }
    return this.events.handle(req.rawBody?.toString("utf8") ?? "", verificationToken);
  }

  @Get("telephony/caller")
  caller(@CurrentUser() a: Actor, @Query(new ZodPipe(z.object({ number: z.string().trim().min(3).max(40) }))) q: { number: string }) {
    return this.events.caller(a, q.number);
  }
}
