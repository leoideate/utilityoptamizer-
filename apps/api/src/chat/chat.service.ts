import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ChatChannel, Role } from "@prisma/client";
import { can, canReadOpportunity } from "@uo/shared";
import type { chatChannelSchema, chatMessageSchema } from "@uo/shared";
import type { z } from "zod";
import { ENV, type Env } from "../config/env";
import { AuditService } from "../audit/audit.service";
import { type Actor, SYSTEM } from "../common/actor";
import { CryptoService } from "../common/crypto.service";
import { Conflict, Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { type UploadedFile, sniffMatches } from "../documents/documents.service";
import { JOB_QUEUE, type JobQueue, QUEUES } from "../jobs/queue";
import { NotificationsService } from "../notifications/notifications.service";
import { OpportunityAccess } from "../opportunities/access.service";
import { RealtimeService } from "../realtime/realtime";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { VIRUS_SCANNER, type VirusScanner } from "../storage/virus-scan";

/** Files that can be shared in chat. Office files are ZIP containers. */
const CHAT_TYPES: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/heic": [".heic"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
};
const MAX_FILES = 5;
const PAGE = 50;

function contentMatches(mime: string, buf: Buffer) {
  if (mime.startsWith("application/vnd.openxmlformats")) return buf.subarray(0, 4).toString("hex") === "504b0304";
  return sniffMatches(mime, buf);
}

type ActorWithRoles = { id: string; roles: Role[] };

/**
 * Internal chat: direct messages, team channels and a discussion on each opportunity.
 * - Direct messages and private channels: members only.
 * - Public channels: any staff member can read and join.
 * - Deal discussions: anyone who can see the opportunity (the same rule as the opportunity itself).
 * Chat is internal and separate from the customer timeline. It isn't the place for restricted
 * data (dates of birth, bank details…), which belongs in the access-controlled records.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // --- Access -----------------------------------------------------------------------

  private async canSee(user: ActorWithRoles, ch: ChatChannel, isMember: boolean): Promise<boolean> {
    if (ch.kind === "direct" || (ch.kind === "channel" && ch.isPrivate)) return isMember;
    if (ch.kind === "channel") return true;
    const opp = await this.prisma.opportunity.findUnique({ where: { id: ch.opportunityId! }, select: { ownerId: true } });
    return !!opp && canReadOpportunity(user, { ownerId: opp.ownerId });
  }

  /** Loads a channel the actor may see; optionally joins it (public channels, deal discussions). */
  private async channel(actor: Actor, id: string, opts: { join?: boolean; write?: boolean } = {}) {
    const ch = await this.prisma.chatChannel.findUnique({ where: { id } });
    if (!ch) throw new NotFound("Conversation");
    const member = await this.prisma.chatMember.findUnique({ where: { channelId_userId: { channelId: id, userId: actor.id } } });
    if (!(await this.canSee(actor, ch, !!member))) throw new NotFound("Conversation");
    if (opts.write && ch.archived) throw new RuleViolation(["This channel is archived."]);
    if (opts.join && !member) await this.prisma.chatMember.create({ data: { channelId: id, userId: actor.id } }).catch(() => undefined);
    return ch;
  }

  private async memberIds(channelId: string) {
    return (await this.prisma.chatMember.findMany({ where: { channelId }, select: { userId: true } })).map((m) => m.userId);
  }

  // --- Conversations ------------------------------------------------------------------

  /** The actor's conversations with unread counts, plus public channels they could join. */
  async list(actor: Actor) {
    const memberships = await this.prisma.chatMember.findMany({ where: { userId: actor.id }, include: { channel: true } });
    const unread = await this.prisma.$queryRaw<{ channel_id: string; n: bigint }[]>`
      SELECT m.channel_id, COUNT(msg.id) AS n
      FROM chat_members m
      JOIN chat_messages msg ON msg.channel_id = m.channel_id AND msg.created_at > m.last_read_at
        AND msg.deleted_at IS NULL AND (msg.author_id IS NULL OR msg.author_id <> m.user_id)
      WHERE m.user_id = ${actor.id}::uuid
      GROUP BY m.channel_id`;
    const counts = new Map(unread.map((u) => [u.channel_id, Number(u.n)]));

    const channels: (ChatChannel & { member: boolean; muted: boolean; unread: number })[] = [];
    for (const m of memberships) {
      if (!(await this.canSee(actor, m.channel, true))) continue; // e.g. a deal reassigned away from this salesperson
      channels.push({ ...m.channel, member: true, muted: m.muted, unread: counts.get(m.channelId) ?? 0 });
    }
    const joined = new Set(channels.map((c) => c.id));
    const joinable = await this.prisma.chatChannel.findMany({ where: { kind: "channel", isPrivate: false, archived: false, id: { notIn: [...joined] } }, orderBy: { name: "asc" } });

    // Display titles: the other person for DMs, the opportunity for deal discussions.
    const dmIds = channels.filter((c) => c.kind === "direct").map((c) => c.id);
    const dmMembers = dmIds.length ? await this.prisma.chatMember.findMany({ where: { channelId: { in: dmIds }, userId: { not: actor.id } } }) : [];
    const users = await this.prisma.user.findMany({ where: { id: { in: dmMembers.map((d) => d.userId) } }, select: { id: true, name: true, active: true } });
    const oppIds = channels.map((c) => c.opportunityId).filter((x): x is string => !!x);
    const opps = oppIds.length ? await this.prisma.opportunity.findMany({ where: { id: { in: oppIds } }, select: { id: true, name: true, number: true } }) : [];

    const title = (c: ChatChannel) => {
      if (c.kind === "direct") {
        const other = users.find((u) => u.id === dmMembers.find((d) => d.channelId === c.id)?.userId);
        return other ? `${other.name}${other.active ? "" : " (inactive)"}` : "Just you";
      }
      if (c.kind === "deal") {
        const o = opps.find((x) => x.id === c.opportunityId);
        return o ? `UO-${String(o.number).padStart(6, "0")} ${o.name}` : "Opportunity";
      }
      return `#${c.name}`;
    };
    return {
      channels: channels
        .map((c) => ({ id: c.id, kind: c.kind, name: c.name, title: title(c), description: c.description, isPrivate: c.isPrivate, archived: c.archived, opportunityId: c.opportunityId, unread: c.unread, muted: c.muted, lastMessageAt: c.lastMessageAt }))
        .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0)),
      joinable: joinable.map((c) => ({ id: c.id, kind: c.kind, name: c.name, title: `#${c.name}`, description: c.description })),
      totalUnread: [...counts.entries()].filter(([id]) => joined.has(id) && !channels.find((c) => c.id === id)?.muted).reduce((s, [, n]) => s + n, 0),
    };
  }

  async openDirect(actor: Actor, userId: string) {
    const other = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!other || !other.active) throw new NotFound("User");
    const directKey = [actor.id, userId].sort().join(":");
    const existing = await this.prisma.chatChannel.findUnique({ where: { directKey } });
    if (existing) return existing;
    try {
      return await this.prisma.chatChannel.create({
        data: { kind: "direct", directKey, createdById: actor.id, members: { create: [...new Set([actor.id, userId])].map((u) => ({ userId: u })) } },
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return this.prisma.chatChannel.findUniqueOrThrow({ where: { directKey } });
      throw e;
    }
  }

  async createChannel(actor: Actor, input: z.infer<typeof chatChannelSchema>) {
    if (!can(actor, "chat.manage_channels")) throw new Forbidden("Only a manager can create channels.");
    if (await this.prisma.chatChannel.findFirst({ where: { kind: "channel", name: input.name } })) throw new Conflict(`#${input.name} already exists.`);
    const members = [...new Set([actor.id, ...input.memberIds])];
    const ch = await this.prisma.chatChannel.create({
      data: { kind: "channel", name: input.name, description: input.description ?? null, isPrivate: input.isPrivate, createdById: actor.id, members: { create: members.map((userId) => ({ userId })) } },
    });
    await this.audit.log(actor, { action: "chat.channel_create", entityType: "chat_channel", entityId: ch.id, summary: `Created ${input.isPrivate ? "private " : ""}channel #${input.name}` });
    return ch;
  }

  async addMembers(actor: Actor, channelId: string, userIds: string[]) {
    const ch = await this.channel(actor, channelId, { write: true });
    if (ch.kind !== "channel") throw new RuleViolation(["People can only be added to team channels."]);
    if (!can(actor, "chat.manage_channels")) throw new Forbidden("Only a manager can add people to channels.");
    await this.prisma.chatMember.createMany({ data: userIds.map((userId) => ({ channelId, userId })), skipDuplicates: true });
  }

  async join(actor: Actor, channelId: string) {
    const ch = await this.channel(actor, channelId, { join: true, write: true });
    if (ch.kind === "direct") throw new RuleViolation(["You can't join someone else's conversation."]);
  }

  async leave(actor: Actor, channelId: string) {
    const ch = await this.channel(actor, channelId);
    if (ch.kind === "direct") throw new RuleViolation(["Direct messages can't be left; mute them instead."]);
    await this.prisma.chatMember.deleteMany({ where: { channelId, userId: actor.id } });
  }

  async setMuted(actor: Actor, channelId: string, muted: boolean) {
    await this.channel(actor, channelId, { join: true });
    await this.prisma.chatMember.update({ where: { channelId_userId: { channelId, userId: actor.id } }, data: { muted } });
  }

  async archive(actor: Actor, channelId: string, archived: boolean) {
    const ch = await this.channel(actor, channelId);
    if (ch.kind !== "channel" || !can(actor, "chat.manage_channels")) throw new Forbidden("Only a manager can archive channels.");
    await this.prisma.chatChannel.update({ where: { id: channelId }, data: { archived } });
  }

  /** The internal discussion for an opportunity (created on first use). Opening it joins you to it. */
  async dealChannel(actor: Actor, opportunityId: string) {
    await this.access.readable(actor, opportunityId);
    let ch = await this.prisma.chatChannel.findUnique({ where: { opportunityId } });
    if (!ch) {
      try {
        ch = await this.prisma.chatChannel.create({ data: { kind: "deal", opportunityId, createdById: actor.id } });
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e;
        ch = await this.prisma.chatChannel.findUniqueOrThrow({ where: { opportunityId } });
      }
    }
    await this.prisma.chatMember.create({ data: { channelId: ch.id, userId: actor.id } }).catch(() => undefined);
    return ch;
  }

  /** People who could be @mentioned (they can see the conversation). */
  async mentionable(actor: Actor, channelId: string) {
    const ch = await this.channel(actor, channelId);
    const users = await this.prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, roles: { select: { role: true } } }, orderBy: { name: "asc" } });
    const members = new Set(await this.memberIds(channelId));
    const out: { id: string; name: string }[] = [];
    for (const u of users) {
      if (await this.canSee({ id: u.id, roles: u.roles.map((r) => r.role) }, ch, members.has(u.id))) out.push({ id: u.id, name: u.name });
    }
    return out;
  }

  // --- Messages -----------------------------------------------------------------------

  async messages(actor: Actor, channelId: string, before?: string) {
    const ch = await this.channel(actor, channelId);
    const rows = await this.prisma.chatMessage.findMany({
      where: { channelId, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
      orderBy: { createdAt: "desc" },
      take: PAGE + 1,
      include: { attachments: { select: { id: true, filename: true, mimeType: true, size: true, scanStatus: true } } },
    });
    const authors = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.authorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
    const page = rows.slice(0, PAGE).reverse();
    return {
      channel: { id: ch.id, kind: ch.kind, name: ch.name, archived: ch.archived, opportunityId: ch.opportunityId },
      hasMore: rows.length > PAGE,
      messages: page.map((m) => ({
        id: m.id,
        authorId: m.authorId,
        authorName: authors.find((a) => a.id === m.authorId)?.name ?? "System",
        body: m.deletedAt ? null : m.body,
        mentions: m.mentions,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        deleted: !!m.deletedAt,
        attachments: m.deletedAt ? [] : m.attachments,
      })),
    };
  }

  async post(actor: Actor, channelId: string, input: z.infer<typeof chatMessageSchema>, files: UploadedFile[] = []) {
    const ch = await this.channel(actor, channelId, { join: true, write: true });
    if (!input.body && !files.length) throw new RuleViolation(["Write a message or attach a file."]);
    if (files.length > MAX_FILES) throw new RuleViolation([`Attach up to ${MAX_FILES} files at a time.`]);
    const issues: string[] = [];
    for (const f of files) {
      const ext = f.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
      if (!CHAT_TYPES[f.mimetype]?.includes(ext) || !contentMatches(f.mimetype, f.buffer)) issues.push(`${f.originalname}: share PDFs, images, Word or Excel files only.`);
      if (f.size > this.env.MAX_UPLOAD_MB * 1024 * 1024) issues.push(`${f.originalname}: files must be ${this.env.MAX_UPLOAD_MB} MB or smaller.`);
    }
    if (issues.length) throw new RuleViolation(issues);

    // Only people who can see the conversation can be mentioned.
    const allowed = new Set((await this.mentionable(actor, channelId)).map((u) => u.id));
    const mentions = [...new Set(input.mentions)].filter((id) => allowed.has(id) && id !== actor.id);

    const stored: { key: string; f: UploadedFile }[] = [];
    for (const f of files) {
      const key = `chat/${channelId}/${randomUUID()}${f.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ""}`;
      await this.storage.put(key, f.buffer, f.mimetype);
      stored.push({ key, f });
    }
    const message = await this.prisma.$transaction(async (tx) => {
      const m = await tx.chatMessage.create({
        data: {
          channelId,
          authorId: actor.id,
          body: input.body || null,
          mentions,
          attachments: { create: stored.map(({ key, f }) => ({ storageKey: key, filename: f.originalname.slice(0, 200), mimeType: f.mimetype, size: f.size, sha256: CryptoService.sha256(f.buffer) })) },
        },
        include: { attachments: true },
      });
      await tx.chatChannel.update({ where: { id: channelId }, data: { lastMessageAt: m.createdAt } });
      await tx.chatMember.update({ where: { channelId_userId: { channelId, userId: actor.id } }, data: { lastReadAt: m.createdAt } });
      // Mentioned people join public channels and deal discussions so they see what follows.
      // Their read marker sits just before this message, so it shows as unread for them.
      if (mentions.length && ch.kind !== "direct") {
        const lastReadAt = new Date(m.createdAt.getTime() - 1);
        await tx.chatMember.createMany({ data: mentions.map((userId) => ({ channelId, userId, lastReadAt })), skipDuplicates: true });
      }
      return m;
    });
    for (const a of message.attachments) await this.queue.add(QUEUES.documents, "chat-scan", { attachmentId: a.id }, { jobId: `chat-scan:${a.id}` });

    const where = ch.kind === "deal" ? (await this.list(actor)).channels.find((c) => c.id === channelId)?.title : ch.kind === "channel" ? `#${ch.name}` : "a direct message";
    for (const userId of mentions) {
      await this.notifications.notify(userId, { title: `${actor.name} mentioned you in ${where}`, body: (input.body ?? "").slice(0, 140), link: `/chat?c=${channelId}` });
    }
    const preview = input.body ? input.body.slice(0, 140) : `Shared ${message.attachments.length} file(s)`;
    await this.realtime.publish(await this.memberIds(channelId), { type: "chat.message", data: { channelId, messageId: message.id, authorId: actor.id, authorName: actor.name, preview, mentions } });
    return { id: message.id };
  }

  async edit(actor: Actor, messageId: string, body: string) {
    const m = await this.prisma.chatMessage.findUnique({ where: { id: messageId } });
    if (!m || m.deletedAt) throw new NotFound("Message");
    await this.channel(actor, m.channelId, { write: true });
    if (m.authorId !== actor.id) throw new Forbidden("You can only edit your own messages.");
    if (!body.trim()) throw new RuleViolation(["A message can't be empty; delete it instead."]);
    await this.prisma.$transaction(async (tx) => {
      if (m.body) await tx.chatMessageRevision.create({ data: { messageId, body: m.body } });
      await tx.chatMessage.update({ where: { id: messageId }, data: { body: body.trim(), editedAt: new Date() } });
    });
    await this.realtime.publish(await this.memberIds(m.channelId), { type: "chat.message.updated", data: { channelId: m.channelId, messageId } });
  }

  /** Authors can delete their messages; administrators can remove any. The text is kept as a revision. */
  async remove(actor: Actor, messageId: string) {
    const m = await this.prisma.chatMessage.findUnique({ where: { id: messageId }, include: { attachments: true } });
    if (!m || m.deletedAt) throw new NotFound("Message");
    await this.channel(actor, m.channelId).catch((e) => {
      if (!can(actor, "chat.moderate")) throw e;
    });
    if (m.authorId !== actor.id && !can(actor, "chat.moderate")) throw new Forbidden("You can only delete your own messages.");
    await this.prisma.$transaction(async (tx) => {
      if (m.body) await tx.chatMessageRevision.create({ data: { messageId, body: m.body } });
      await tx.chatMessage.update({ where: { id: messageId }, data: { body: null, deletedAt: new Date() } });
      await tx.chatAttachment.deleteMany({ where: { messageId } });
      await this.audit.log(actor, { action: "chat.delete", entityType: "chat_message", entityId: messageId, summary: m.authorId === actor.id ? "Deleted own chat message" : "Removed a chat message (moderation)" }, tx);
    });
    for (const a of m.attachments) await this.storage.delete(a.storageKey).catch(() => undefined);
    await this.realtime.publish(await this.memberIds(m.channelId), { type: "chat.message.updated", data: { channelId: m.channelId, messageId } });
  }

  async markRead(actor: Actor, channelId: string) {
    await this.channel(actor, channelId);
    await this.prisma.chatMember.updateMany({ where: { channelId, userId: actor.id }, data: { lastReadAt: new Date() } });
    await this.realtime.publish([actor.id], { type: "chat.read", data: { channelId } });
  }

  async attachmentUrl(actor: Actor, attachmentId: string) {
    const a = await this.prisma.chatAttachment.findUnique({ where: { id: attachmentId }, include: { message: true } });
    if (!a) throw new NotFound("File");
    await this.channel(actor, a.message.channelId);
    if (a.scanStatus === "infected") throw new RuleViolation(["This file failed the virus scan."]);
    if (a.scanStatus === "pending" && this.scanner.name !== "none") throw new RuleViolation(["This file is still being scanned. Try again in a moment."]);
    return { url: await this.storage.signedUrl(a.storageKey, a.filename, this.env.DOWNLOAD_URL_TTL_SECONDS), mimeType: a.mimeType };
  }

  /** Job handler: scan a chat attachment; infected files are removed. */
  async scanAttachment(attachmentId: string) {
    const a = await this.prisma.chatAttachment.findUnique({ where: { id: attachmentId } });
    if (!a || a.scanStatus !== "pending") return;
    const result = await this.scanner.scan(await this.storage.get(a.storageKey));
    await this.prisma.chatAttachment.update({ where: { id: attachmentId }, data: { scanStatus: result } });
    if (result === "infected") {
      await this.storage.delete(a.storageKey);
      await this.audit.log(SYSTEM, { action: "chat.file_infected", entityType: "chat_attachment", entityId: attachmentId, summary: `Chat file ${a.filename} failed the virus scan and was removed` });
    }
    if (result === "error") throw new Error(`Virus scan failed for chat attachment ${attachmentId}`);
  }

  /** Admin: earlier versions of an edited or deleted message. */
  async revisions(actor: Actor, messageId: string) {
    if (!can(actor, "chat.moderate")) throw new Forbidden();
    await this.audit.log(actor, { action: "chat.history_view", entityType: "chat_message", entityId: messageId, summary: "Viewed chat message history" });
    return this.prisma.chatMessageRevision.findMany({ where: { messageId }, orderBy: { createdAt: "asc" } });
  }
}

