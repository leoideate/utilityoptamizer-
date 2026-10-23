import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { type EmailMessage, type Mailbox, type MailProviderId, Prisma } from "@prisma/client";
import type { Role } from "@uo/shared";
import { ENV, type Env } from "../config/env";
import { AuditService } from "../audit/audit.service";
import type { Actor } from "../common/actor";
import { CryptoService } from "../common/crypto.service";
import { NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { type Page, pageArgs } from "../common/values";
import { NotConfigured } from "../integrations/adapters";
import { JOB_QUEUE, type JobQueue, QUEUES } from "../jobs/queue";
import { NotificationsService } from "../notifications/notifications.service";
import { OpportunityAccess } from "../opportunities/access.service";
import { RealtimeService } from "../realtime/realtime";
import { snippetOf } from "./html-text";
import { type EmailLink, matchEmail } from "./matching";
import { MailOAuth, MailReauthRequired, type MailTokens } from "./oauth";
import { MailAuthError, type MailProvider, type OutgoingMail, type ProviderMessage } from "./providers";

export const MAIL_OAUTH = Symbol("MAIL_OAUTH");
export const MAIL_PROVIDERS = Symbol("MAIL_PROVIDERS");
export type MailProviders = Record<MailProviderId, MailProvider>;

export const MAIL_PROVIDER_IDS: MailProviderId[] = ["microsoft", "google"];
export const isMailProvider = (p: string): p is MailProviderId => (MAIL_PROVIDER_IDS as string[]).includes(p);

const FLOW_TTL_SECONDS = 600;
/** One sync job per mailbox per bucket, however often the scheduler fires. */
const SYNC_BUCKET_MS = 120_000;
const isUnique = (e: unknown) => (e as { code?: string }).code === "P2002";
const normSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, "").trim().toLowerCase();

/** Why connecting a mailbox failed; shown on the Account page. */
export type MailboxConnectErrorCode = "mailbox_unavailable" | "mailbox_cancelled" | "mailbox_expired" | "mailbox_wrong_address" | "mailbox_failed";
export class MailboxConnectError extends Error {
  constructor(
    public readonly code: MailboxConnectErrorCode,
    detail: string,
  ) {
    super(detail);
  }
}

/** The sender's mailbox can't send until it's reconnected: retrying won't help. */
export class MailboxUnavailable extends NotConfigured {
  constructor() {
    super("mailbox");
    this.message = "Your mailbox needs reconnecting on the Account page before it can send email.";
  }
}

interface ConnectFlow {
  userId: string;
  provider: MailProviderId;
  state: string;
  verifier: string;
  exp: number;
}

type MailboxWithOwner = Mailbox & { user: { id: string; name: string; email: string; roles: { role: Role }[] } };

/**
 * Each person's own Microsoft 365 or Google mailbox, connected with OAuth and synced into the CRM
 * (inbox and sent). Mail matched to a customer or deal appears on its timeline for anyone who can
 * see that deal; everything else stays visible to the mailbox owner only. Sending through the
 * mailbox puts the email in the person's own Sent folder and keeps replies in the same thread.
 */
@Injectable()
export class MailboxesService {
  private readonly log = new Logger(MailboxesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly access: OpportunityAccess,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(MAIL_OAUTH) private readonly oauth: MailOAuth,
    @Inject(MAIL_PROVIDERS) private readonly providers: MailProviders,
    @Inject(ENV) private readonly env: Env,
  ) {}

  available() {
    return { microsoft: this.oauth.configured("microsoft"), google: this.oauth.configured("google") };
  }

  // --- Connecting ------------------------------------------------------------------------

  private seal(value: ConnectFlow): string {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${this.crypto.sign(`mailbox|${body}`)}`;
  }

  private unseal(cookie: string | undefined): ConnectFlow | null {
    if (!cookie) return null;
    const [body, sig] = cookie.split(".");
    if (!body || !sig || !/^[0-9a-f]+$/.test(sig) || !this.crypto.verify(`mailbox|${body}`, sig)) return null;
    const v = JSON.parse(Buffer.from(body, "base64url").toString()) as ConnectFlow;
    return v.exp > Math.floor(Date.now() / 1000) ? v : null;
  }

  /** The provider's consent URL, and the signed flow cookie (state and PKCE verifier) for the callback. */
  async startConnect(actor: Actor, provider: string) {
    if (!isMailProvider(provider) || !this.oauth.configured(provider)) throw new MailboxConnectError("mailbox_unavailable", `${provider} mailboxes aren't configured`);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { email: true } });
    const flow: ConnectFlow = { userId: actor.id, provider, state: CryptoService.token(24), verifier: CryptoService.token(48), exp: Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS };
    const challenge = createHash("sha256").update(flow.verifier).digest("base64url");
    const url = await this.oauth.authorizeUrl(provider, { state: flow.state, challenge, loginHint: user.email });
    return { url, cookie: this.seal(flow), maxAgeMs: FLOW_TTL_SECONDS * 1000 };
  }

  /** The provider redirects back here. The mailbox must be the person's own CRM email address. */
  async completeConnect(actor: Actor, provider: string, q: { code?: string; state?: string; error?: string }, cookie: string | undefined) {
    if (!isMailProvider(provider)) throw new MailboxConnectError("mailbox_unavailable", `Unknown mail provider ${provider}`);
    const flow = this.unseal(cookie);
    if (!flow || flow.provider !== provider || flow.userId !== actor.id || !q.state || flow.state !== q.state) throw new MailboxConnectError("mailbox_expired", "Connect flow missing, expired or for someone else");
    if (q.error || !q.code) throw new MailboxConnectError("mailbox_cancelled", q.error ?? "No code returned");

    let tokens: MailTokens;
    let address: string;
    try {
      tokens = await this.oauth.exchange(provider, q.code, flow.verifier);
      address = (await this.providers[provider].profile(tokens.accessToken)).address;
    } catch (e) {
      this.log.warn({ provider, err: (e as Error).message }, "Mailbox connect failed");
      throw new MailboxConnectError("mailbox_failed", (e as Error).message);
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { email: true } });
    if (address !== user.email.toLowerCase()) {
      await this.audit.log(actor, { action: "mailbox.connect_refused", entityType: "user", entityId: actor.id, summary: `Tried to connect a ${provider} mailbox that isn't their CRM address` });
      throw new MailboxConnectError("mailbox_wrong_address", "Mailbox address doesn't match the CRM user");
    }

    const existing = await this.prisma.mailbox.findUnique({ where: { userId_provider: { userId: actor.id, provider } } });
    const data = { address, tokensEnc: this.crypto.encryptJson(tokens), status: "active" as const, lastError: null };
    const mailbox = existing
      ? await this.prisma.mailbox.update({ where: { id: existing.id }, data: { ...data, ...(existing.address !== address ? { syncState: Prisma.DbNull } : {}) } })
      : await this.prisma.mailbox.create({ data: { ...data, userId: actor.id, provider } });
    await this.audit.log(actor, { action: "mailbox.connected", entityType: "mailbox", entityId: mailbox.id, summary: `Connected ${provider === "microsoft" ? "Outlook" : "Gmail"} mailbox` });
    await this.queue.add(QUEUES.mail, "mailbox.sync", { mailboxId: mailbox.id }, { jobId: `mailbox.sync:${mailbox.id}:connect:${Date.now()}`, attempts: 1 });
    return mailbox.id;
  }

  async mine(actor: Actor) {
    return this.prisma.mailbox.findMany({
      where: { userId: actor.id, status: { not: "disconnected" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, provider: true, address: true, status: true, lastSyncedAt: true, lastError: true, createdAt: true },
    });
  }

  /** Stops syncing and forgets the tokens. Mail already synced stays (it may be on deal timelines). */
  async disconnect(actor: Actor, id: string) {
    const mb = await this.prisma.mailbox.findFirst({ where: { id, userId: actor.id } });
    if (!mb) throw new NotFound("Mailbox not found.");
    await this.prisma.mailbox.update({ where: { id }, data: { status: "disconnected", tokensEnc: null, syncState: Prisma.DbNull, lastError: null } });
    await this.audit.log(actor, { action: "mailbox.disconnected", entityType: "mailbox", entityId: id, summary: `Disconnected ${mb.provider} mailbox` });
  }

  async requestSync(actor: Actor, id: string) {
    const mb = await this.prisma.mailbox.findFirst({ where: { id, userId: actor.id, status: "active" } });
    if (!mb) throw new NotFound("Mailbox not found.");
    await this.queue.add(QUEUES.mail, "mailbox.sync", { mailboxId: id }, { jobId: `mailbox.sync:${id}:${Math.floor(Date.now() / SYNC_BUCKET_MS)}`, attempts: 1 });
  }

  /** The active mailbox someone sends from (the first they connected). */
  sendingMailbox(userId: string) {
    return this.prisma.mailbox.findFirst({ where: { userId, status: "active" }, orderBy: { createdAt: "asc" }, select: { id: true, provider: true, address: true } });
  }

  // --- Tokens ----------------------------------------------------------------------------

  private async accessToken(mb: Mailbox, force = false): Promise<string> {
    const t = this.crypto.decryptJson<MailTokens>(mb.tokensEnc);
    if (!t) {
      await this.needsReauth(mb);
      throw new MailReauthRequired("No tokens stored");
    }
    if (!force && t.expiresAt - 60_000 > Date.now()) return t.accessToken;
    try {
      const fresh = await this.oauth.refresh(mb.provider, t.refreshToken);
      const tokensEnc = this.crypto.encryptJson(fresh);
      await this.prisma.mailbox.update({ where: { id: mb.id }, data: { tokensEnc } });
      mb.tokensEnc = tokensEnc;
      return fresh.accessToken;
    } catch (e) {
      if (e instanceof MailReauthRequired) await this.needsReauth(mb);
      throw e;
    }
  }

  /** Calls the provider; if it rejects the token, refreshes once and retries. */
  private async withToken<T>(mb: Mailbox, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.accessToken(mb));
    } catch (e) {
      if (!(e instanceof MailAuthError)) throw e;
      return fn(await this.accessToken(mb, true));
    }
  }

  private async needsReauth(mb: Mailbox) {
    const { count } = await this.prisma.mailbox.updateMany({ where: { id: mb.id, status: "active" }, data: { status: "reauth_required", lastError: "The connection expired or was revoked." } });
    if (count) {
      await this.notifications.notify(mb.userId, { title: "Reconnect your mailbox", body: `The CRM can no longer reach ${mb.address}. Connect it again on your Account page.`, link: "/account" });
      this.log.warn({ mailboxId: mb.id, provider: mb.provider }, "Mailbox needs reconnecting");
    }
  }

  // --- Sync --------------------------------------------------------------------------------

  /** Scheduled: queue a sync for every active mailbox (deduplicated per two-minute bucket). */
  async enqueueSyncAll(now = new Date()) {
    const bucket = Math.floor(now.getTime() / SYNC_BUCKET_MS);
    const boxes = await this.prisma.mailbox.findMany({ where: { status: "active" }, select: { id: true } });
    for (const b of boxes) await this.queue.add(QUEUES.mail, "mailbox.sync", { mailboxId: b.id }, { jobId: `mailbox.sync:${b.id}:${bucket}`, attempts: 1 });
    return boxes.length;
  }

  /** Pulls new and changed messages since the stored cursor. Safe to run repeatedly. */
  async sync(mailboxId: string) {
    const mb = await this.prisma.mailbox.findUnique({ where: { id: mailboxId }, include: { user: { select: { id: true, name: true, email: true, roles: { select: { role: true } } } } } });
    if (!mb || mb.status !== "active") return { skipped: true };
    const since = new Date(Date.now() - this.env.MAIL_BACKFILL_DAYS * 86_400_000);
    try {
      const changes = await this.withToken(mb, (token) => this.providers[mb.provider].changes(token, mb.syncState, since));
      let added = 0;
      for (const m of changes.messages) if (await this.store(mb, m)) added++;
      await this.prisma.mailbox.update({ where: { id: mb.id }, data: { syncState: changes.state as Prisma.InputJsonValue, lastSyncedAt: new Date(), lastError: null } });
      return { added };
    } catch (e) {
      if (e instanceof MailReauthRequired) return { reauth: true };
      const message = (e as Error).message.slice(0, 500);
      await this.prisma.mailbox.update({ where: { id: mb.id }, data: { lastError: message } });
      this.log.warn({ mailboxId: mb.id, provider: mb.provider, err: message }, "Mailbox sync failed");
      return { error: message };
    }
  }

  /** Stores one message (once), links it, writes its timeline entry and tells the owner. Returns true if new. */
  private async store(mb: MailboxWithOwner, m: ProviderMessage): Promise<boolean> {
    const key = { mailboxId_providerMessageId: { mailboxId: mb.id, providerMessageId: m.id } };
    const existing = await this.prisma.emailMessage.findUnique({ where: key, select: { id: true, unread: true } });
    if (existing) {
      // Read in Outlook or Gmail: reflect it here (never the other way round on sync).
      if (existing.unread && !m.unread) await this.prisma.emailMessage.update({ where: { id: existing.id }, data: { unread: false } });
      return false;
    }

    const own = mb.address.toLowerCase();
    const counterparts = [m.from.address, ...m.to, ...m.cc].filter((a) => a && a !== own);
    const claim = m.direction === "outbound" ? await this.claimCrmSend(mb.id, m) : null;
    const link: EmailLink = claim ?? (await matchEmail(this.prisma, { mailboxId: mb.id, ownerId: mb.userId, threadId: m.threadId, counterparts }));

    let row: EmailMessage;
    try {
      row = await this.prisma.emailMessage.create({
        data: {
          mailboxId: mb.id,
          providerMessageId: m.id,
          threadId: m.threadId,
          internetMessageId: m.internetMessageId,
          direction: m.direction,
          fromAddress: m.from.address,
          fromName: m.from.name,
          toAddresses: m.to,
          ccAddresses: m.cc,
          subject: m.subject.slice(0, 998),
          snippet: snippetOf(m.bodyText),
          bodyEnc: this.crypto.encrypt(m.bodyText.slice(0, 200_000)),
          sentAt: m.sentAt,
          unread: m.unread,
          hasAttachments: m.hasAttachments,
          customerId: link.customerId,
          opportunityId: link.opportunityId,
          // Sent from the CRM: its timeline entry was written when it was sent.
          timelineLoggedAt: claim ? new Date() : null,
        },
      });
    } catch (e) {
      if (isUnique(e)) return false; // a concurrent sync stored it
      throw e;
    }

    if (claim) {
      await this.prisma.integrationJob.update({ where: { id: claim.jobId }, data: { result: { ...claim.result, emailMessageId: row.id } as Prisma.InputJsonValue } });
    } else {
      const owner: Actor = { id: mb.user.id, name: mb.user.name, roles: mb.user.roles.map((r) => r.role) };
      await this.logTimeline(row, owner);
    }

    if (m.direction === "inbound") {
      const dealOwner = row.opportunityId ? (await this.prisma.opportunity.findUnique({ where: { id: row.opportunityId }, select: { ownerId: true } }))?.ownerId : null;
      await this.realtime.publish([mb.userId, dealOwner], { type: "email.received", data: { id: row.id, from: m.from.name ?? m.from.address, subject: row.subject.slice(0, 120), opportunityId: row.opportunityId } });
    }
    return true;
  }

  /**
   * A message the CRM itself sent through this mailbox, coming back from the Sent folder: link it to
   * the deal it was sent from instead of matching it again (and don't log it twice).
   */
  private async claimCrmSend(mailboxId: string, m: ProviderMessage) {
    const jobs = await this.prisma.integrationJob.findMany({
      where: { kind: "email.send", status: { in: ["succeeded", "running"] }, createdAt: { gte: new Date(Date.now() - 3 * 86_400_000) }, payload: { path: ["mailboxId"], equals: mailboxId } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const recipients = new Set(m.to);
    for (const job of jobs) {
      const result = (job.result ?? {}) as { providerMessageId?: string | null; emailMessageId?: string };
      if (result.emailMessageId) continue;
      const p = job.payload as { to?: string; subject?: string; customerId?: string | null };
      const sameMessage = result.providerMessageId === m.id;
      const looksSame = normSubject(p.subject ?? "") === normSubject(m.subject) && (p.to ?? "").split(",").every((t) => recipients.has(t.trim().toLowerCase()));
      if (!sameMessage && !looksSame) continue;
      const customerId = p.customerId ?? (job.opportunityId ? ((await this.prisma.opportunity.findUnique({ where: { id: job.opportunityId }, select: { customerId: true } }))?.customerId ?? null) : null);
      return { jobId: job.id, result, opportunityId: job.opportunityId, customerId };
    }
    return null;
  }

  /** Writes the email to the customer/deal timeline exactly once. */
  private async logTimeline(row: EmailMessage, owner: Actor) {
    if (!row.opportunityId && !row.customerId) return;
    const claimed = await this.prisma.emailMessage.updateMany({ where: { id: row.id, timelineLoggedAt: null }, data: { timelineLoggedAt: new Date() } });
    if (!claimed.count) return;
    const head = row.direction === "inbound" ? `From ${row.fromName ? `${row.fromName} <${row.fromAddress}>` : row.fromAddress}` : `To ${row.toAddresses.join(", ")}`;
    await this.audit.timeline(owner, {
      opportunityId: row.opportunityId ?? undefined,
      customerId: row.customerId ?? undefined,
      kind: "email",
      direction: row.direction as "inbound" | "outbound",
      body: `${head}: ${row.subject || "(no subject)"}${row.snippet ? `\n\n${row.snippet}` : ""}`,
      occurredAt: row.sentAt,
      data: { emailMessageId: row.id },
    });
    if (row.direction === "outbound" && row.opportunityId) {
      const opp = await this.prisma.opportunity.findUnique({ where: { id: row.opportunityId }, select: { firstContactAt: true, lastContactAt: true } });
      if (opp && (!opp.lastContactAt || opp.lastContactAt < row.sentAt)) {
        await this.prisma.opportunity.update({ where: { id: row.opportunityId }, data: { lastContactAt: row.sentAt, firstContactAt: opp.firstContactAt ?? row.sentAt } });
      }
    }
  }

  // --- Reading ---------------------------------------------------------------------------

  /** The caller's own inbox or sent mail, newest first. */
  async list(actor: Actor, q: { folder: "inbox" | "sent"; page: number; pageSize: number; unread?: boolean }): Promise<Page<unknown>> {
    const where: Prisma.EmailMessageWhereInput = { mailbox: { userId: actor.id }, direction: q.folder === "inbox" ? "inbound" : "outbound", ...(q.unread ? { unread: true } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.emailMessage.findMany({
        where,
        orderBy: { sentAt: "desc" },
        ...pageArgs(q.page, q.pageSize),
        select: { id: true, fromAddress: true, fromName: true, toAddresses: true, subject: true, snippet: true, sentAt: true, unread: true, hasAttachments: true, opportunityId: true, customerId: true },
      }),
      this.prisma.emailMessage.count({ where }),
    ]);
    const links = await this.linkNames(rows);
    return { items: rows.map((r) => ({ ...r, ...links(r) })), total, page: q.page, pageSize: q.pageSize };
  }

  unreadCount(actor: Actor) {
    return this.prisma.emailMessage.count({ where: { mailbox: { userId: actor.id }, direction: "inbound", unread: true } });
  }

  /** The mailbox owner, or anyone who can see the deal (or customer) it's linked to; others get 404. */
  async get(actor: Actor, id: string) {
    const m = await this.prisma.emailMessage.findUnique({ where: { id }, include: { mailbox: { select: { userId: true, address: true, provider: true, status: true, user: { select: { name: true } } } } } });
    if (!m) throw new NotFound("Email not found.");
    const owner = m.mailbox.userId === actor.id;
    if (!owner && !(await this.canSeeLinked(actor, m))) throw new NotFound("Email not found.");
    if (owner && m.unread) {
      await this.prisma.emailMessage.update({ where: { id }, data: { unread: false } });
      await this.queue.add(QUEUES.mail, "mailbox.markRead", { emailMessageId: id }, { jobId: `mailbox.markRead:${id}`, attempts: 3 });
    }
    const links = await this.linkNames([m]);
    const { bodyEnc, mailbox, ...rest } = m;
    return {
      ...rest,
      unread: owner ? false : m.unread,
      ...links(m),
      body: this.crypto.decrypt(bodyEnc) ?? "",
      mailbox: { address: mailbox.address, provider: mailbox.provider, ownerName: mailbox.user.name },
      isOwner: owner,
      canReply: owner && mailbox.status === "active",
    };
  }

  private async canSeeLinked(actor: Actor, m: { opportunityId: string | null; customerId: string | null }) {
    if (m.opportunityId) {
      try {
        await this.access.readable(actor, m.opportunityId);
        return true;
      } catch {
        return false;
      }
    }
    if (m.customerId) return (await this.prisma.customer.count({ where: { AND: [{ id: m.customerId }, this.access.customerWhere(actor)] } })) > 0;
    return false;
  }

  private async linkNames(rows: { opportunityId: string | null; customerId: string | null }[]) {
    const oppIds = [...new Set(rows.map((r) => r.opportunityId).filter((x): x is string => !!x))];
    const custIds = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))];
    const [opps, custs] = await Promise.all([
      oppIds.length ? this.prisma.opportunity.findMany({ where: { id: { in: oppIds } }, select: { id: true, name: true } }) : [],
      custIds.length ? this.prisma.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, legalName: true } }) : [],
    ]);
    const oppName = new Map(opps.map((o) => [o.id, o.name]));
    const custName = new Map(custs.map((c) => [c.id, c.legalName]));
    return (r: { opportunityId: string | null; customerId: string | null }) => ({
      opportunityName: r.opportunityId ? (oppName.get(r.opportunityId) ?? null) : null,
      customerName: r.customerId ? (custName.get(r.customerId) ?? null) : null,
    });
  }

  /** For replying: the caller's own message in an active mailbox. */
  async forReply(actor: Actor, id: string) {
    const m = await this.prisma.emailMessage.findUnique({ where: { id }, include: { mailbox: true } });
    if (!m || m.mailbox.userId !== actor.id) throw new NotFound("Email not found.");
    if (m.mailbox.status !== "active") throw new RuleViolation(["Reconnect your mailbox on the Account page to reply."]);
    return m;
  }

  // --- Provider writes (jobs) ------------------------------------------------------------------

  /** Sends through the mailbox (called by the integrations worker, with its retries). */
  async send(mailboxId: string, mail: Omit<OutgoingMail, "from" | "inReplyTo"> & { replyToEmailId?: string }) {
    const mb = await this.prisma.mailbox.findUnique({ where: { id: mailboxId } });
    if (!mb || mb.status !== "active") throw new MailboxUnavailable();
    let inReplyTo: OutgoingMail["inReplyTo"];
    if (mail.replyToEmailId) {
      const orig = await this.prisma.emailMessage.findUnique({ where: { id: mail.replyToEmailId } });
      if (orig && orig.mailboxId === mb.id) inReplyTo = { providerMessageId: orig.providerMessageId, threadId: orig.threadId, internetMessageId: orig.internetMessageId };
    }
    try {
      return await this.withToken(mb, (token) => this.providers[mb.provider].send(token, { from: mb.address, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, inReplyTo }));
    } catch (e) {
      if (e instanceof MailReauthRequired) throw new MailboxUnavailable();
      throw e;
    }
  }

  /**
   * System email (signing links and the like) through the connected mailbox with this address,
   * whoever connected it, optionally from one of its send-as aliases. Null when it isn't connected.
   */
  async sendSystem(address: string, from: string | undefined, mail: Omit<OutgoingMail, "from" | "to" | "inReplyTo"> & { to: string }) {
    const mb = await this.prisma.mailbox.findFirst({ where: { address: { equals: address, mode: "insensitive" }, status: "active" } });
    if (!mb) return null;
    try {
      const sent = await this.withToken(mb, (token) => this.providers[mb.provider].send(token, { ...mail, from: from ?? mb.address, to: [mail.to] }));
      return { messageId: sent.providerMessageId ?? "" };
    } catch (e) {
      if (e instanceof MailReauthRequired) throw new MailboxUnavailable();
      throw e;
    }
  }

  async markReadAtProvider(emailMessageId: string) {
    const m = await this.prisma.emailMessage.findUnique({ where: { id: emailMessageId }, include: { mailbox: true } });
    if (!m || m.mailbox.status !== "active") return;
    await this.withToken(m.mailbox, (token) => this.providers[m.mailbox.provider].markRead(token, m.providerMessageId)).catch((e) => {
      if (e instanceof MailReauthRequired) return;
      throw e;
    });
  }
}
