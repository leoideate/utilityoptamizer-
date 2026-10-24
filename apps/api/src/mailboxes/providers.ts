import { randomUUID } from "node:crypto";
import { htmlToText, tidy } from "./html-text";

/** One message as the provider reports it, already reduced to what the CRM stores. */
export interface ProviderMessage {
  id: string;
  threadId: string | null;
  internetMessageId: string | null;
  direction: "inbound" | "outbound";
  from: { address: string; name: string | null };
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  sentAt: Date;
  unread: boolean;
  hasAttachments: boolean;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** HTML version of the same message (e.g. with the sender's email signature). The text stays as the plain-text part. */
  html?: string;
  replyTo?: string;
  /** Reply in this message's thread (the provider ids of the original). */
  inReplyTo?: { providerMessageId: string; threadId: string | null; internetMessageId: string | null };
}

export interface MailChanges {
  messages: ProviderMessage[];
  /** Cursor to store and pass back next time. */
  state: unknown;
}

/** A user's mailbox at Microsoft 365 or Google, used with that user's access token. */
export interface MailProvider {
  profile(token: string): Promise<{ address: string }>;
  /** New and changed messages since `state` (or since `since` on the first run). */
  changes(token: string, state: unknown, since: Date): Promise<MailChanges>;
  send(token: string, mail: OutgoingMail): Promise<{ providerMessageId: string | null; threadId: string | null }>;
  markRead(token: string, providerMessageId: string): Promise<void>;
}

/** The access token was rejected (expired early or revoked): refresh and try once more. */
export class MailAuthError extends Error {}

const TIMEOUT_MS = 20_000;
/** Pages fetched per sync run per folder; the cursor resumes where it stopped. */
const MAX_PAGES = 20;
const lower = (a: string | null | undefined) => (a ?? "").trim().toLowerCase();

async function call<T>(url: string, token: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401) throw new MailAuthError(`${new URL(url).host} rejected the access token`);
  const text = await res.text();
  const body = (text ? JSON.parse(text) : null) as T;
  if (!res.ok && res.status !== 404) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  return { status: res.status, body };
}

// --- Microsoft Graph ------------------------------------------------------------------------

interface GraphAddress {
  emailAddress?: { address?: string; name?: string };
}
interface GraphMessage {
  id: string;
  "@removed"?: unknown;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  sentDateTime?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
}
interface GraphPage {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

const GRAPH_FOLDERS = { inbox: "inbound", sentitems: "outbound" } as const;
const GRAPH_SELECT = "id,conversationId,internetMessageId,subject,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,isRead,isDraft,hasAttachments";

export class GraphMailProvider implements MailProvider {
  constructor(private readonly base: string) {}

  async profile(token: string) {
    const { body } = await call<{ mail?: string; userPrincipalName?: string }>(`${this.base}/me?$select=mail,userPrincipalName`, token);
    return { address: lower(body.mail ?? body.userPrincipalName) };
  }

  /** Delta queries on Inbox and Sent Items; the delta (or next) link per folder is the cursor. */
  async changes(token: string, state: unknown, since: Date): Promise<MailChanges> {
    const links = { ...((state as Record<string, string> | null) ?? {}) };
    const messages: ProviderMessage[] = [];
    for (const [folder, direction] of Object.entries(GRAPH_FOLDERS)) {
      let url: string | undefined = links[folder] ?? `${this.base}/me/mailFolders/${folder}/messages/delta?$select=${GRAPH_SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const { body }: { body: GraphPage } = await call<GraphPage>(url, token, { headers: { Prefer: 'outlook.body-content-type="text", odata.maxpagesize=50' } });
        for (const m of body.value ?? []) if (!m["@removed"] && !m.isDraft) messages.push(this.toMessage(m, direction));
        if (body["@odata.deltaLink"]) {
          links[folder] = body["@odata.deltaLink"];
          url = undefined;
        } else {
          url = body["@odata.nextLink"];
          if (url) links[folder] = url; // resume here next run if we stop early
        }
      }
    }
    return { messages, state: links };
  }

  private toMessage(m: GraphMessage, direction: "inbound" | "outbound"): ProviderMessage {
    const content = m.body?.content ?? "";
    return {
      id: m.id,
      threadId: m.conversationId ?? null,
      internetMessageId: m.internetMessageId ?? null,
      direction,
      from: { address: lower(m.from?.emailAddress?.address), name: m.from?.emailAddress?.name ?? null },
      to: (m.toRecipients ?? []).map((r) => lower(r.emailAddress?.address)).filter(Boolean),
      cc: (m.ccRecipients ?? []).map((r) => lower(r.emailAddress?.address)).filter(Boolean),
      subject: m.subject ?? "",
      bodyText: m.body?.contentType?.toLowerCase() === "html" ? htmlToText(content) : tidy(content),
      sentAt: new Date(m.sentDateTime ?? m.receivedDateTime ?? Date.now()),
      unread: direction === "inbound" && m.isRead === false,
      hasAttachments: !!m.hasAttachments,
    };
  }

  /** Graph keeps a copy in Sent Items; it arrives with the next sync (no id is returned). */
  async send(token: string, mail: OutgoingMail) {
    const body = mail.html ? { contentType: "HTML", content: mail.html } : { contentType: "Text", content: mail.text };
    if (mail.inReplyTo) {
      const reply = mail.html ? { message: { body } } : { comment: mail.text };
      await call(`${this.base}/me/messages/${encodeURIComponent(mail.inReplyTo.providerMessageId)}/reply`, token, { method: "POST", body: JSON.stringify(reply) });
    } else {
      const recipients = mail.to.map((address) => ({ emailAddress: { address } }));
      await call(`${this.base}/me/sendMail`, token, { method: "POST", body: JSON.stringify({ message: { subject: mail.subject, body, toRecipients: recipients }, saveToSentItems: true }) });
    }
    return { providerMessageId: null, threadId: mail.inReplyTo?.threadId ?? null };
  }

  async markRead(token: string, id: string) {
    await call(`${this.base}/me/messages/${encodeURIComponent(id)}`, token, { method: "PATCH", body: JSON.stringify({ isRead: true }) });
  }
}

// --- Gmail ---------------------------------------------------------------------------------

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

const SKIP_LABELS = ["DRAFT", "SPAM", "TRASH"];

/** Splits an address header ("Name <a@b>, c@d") into lowercase addresses. */
export function parseAddresses(header: string | undefined): { address: string; name: string | null }[] {
  if (!header) return [];
  const out: { address: string; name: string | null }[] = [];
  for (const raw of header.match(/(?:"[^"]*"|[^,])+/g) ?? []) {
    const angle = raw.match(/<([^>]+)>/);
    const address = lower(angle ? angle[1] : raw);
    if (!address.includes("@")) continue;
    const name = angle ? raw.slice(0, raw.indexOf("<")).trim().replace(/^"|"$/g, "") || null : null;
    out.push({ address, name });
  }
  return out;
}

/** RFC 2047 for non-ASCII subjects; strips CR/LF so a subject can't inject headers. */
function encodeHeader(v: string) {
  const clean = v.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean).toString("base64")}?=`;
}

export function buildRfc822(mail: OutgoingMail): string {
  const headers = [
    `From: ${mail.from}`,
    `To: ${mail.to.map((t) => t.replace(/[\r\n,<>]/g, "")).join(", ")}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (mail.replyTo) headers.push(`Reply-To: ${mail.replyTo.replace(/[\r\n,]/g, "")}`);
  if (mail.inReplyTo?.internetMessageId) {
    const ref = mail.inReplyTo.internetMessageId.replace(/[\r\n]/g, "");
    headers.push(`In-Reply-To: ${ref}`, `References: ${ref}`);
  }
  const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/(.{76})/g, "$1\r\n");
  if (!mail.html) {
    headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
    return `${headers.join("\r\n")}\r\n\r\n${b64(mail.text)}`;
  }
  // Plain text first, HTML last: mail apps show the last part they can display.
  const boundary = `uo-${randomUUID()}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type: string, content: string) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(content)}`;
  return `${headers.join("\r\n")}\r\n\r\n${part("text/plain", mail.text)}\r\n${part("text/html", mail.html)}\r\n--${boundary}--`;
}

export class GmailMailProvider implements MailProvider {
  constructor(
    private readonly base: string,
    private readonly backfillDays: number,
  ) {}

  private url(path: string) {
    return `${this.base}/gmail/v1/users/me/${path}`;
  }

  async profile(token: string) {
    const { body } = await call<{ emailAddress?: string; historyId?: string }>(this.url("profile"), token);
    return { address: lower(body.emailAddress) };
  }

  /** First run: recent messages; then history since the stored historyId (falls back to a recent re-list if it's too old). */
  async changes(token: string, state: unknown): Promise<MailChanges> {
    const { historyId: startHistoryId } = (state as { historyId?: string } | null) ?? {};
    const { body: profile } = await call<{ historyId?: string }>(this.url("profile"), token);
    const ids = new Set<string>();

    let listed = false;
    if (startHistoryId) {
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", ...(pageToken ? { pageToken } : {}) });
        const res = await call<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; nextPageToken?: string }>(this.url(`history?${q}`), token);
        if (res.status === 404) break; // history expired: re-list below
        listed = true;
        for (const h of res.body.history ?? []) for (const a of h.messagesAdded ?? []) ids.add(a.message.id);
        pageToken = res.body.nextPageToken;
        if (!pageToken) break;
      }
    }
    if (!listed) {
      let pageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const q = new URLSearchParams({ q: `newer_than:${this.backfillDays}d -in:drafts -in:spam -in:trash`, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
        const { body } = await call<{ messages?: { id: string }[]; nextPageToken?: string }>(this.url(`messages?${q}`), token);
        for (const m of body.messages ?? []) ids.add(m.id);
        pageToken = body.nextPageToken;
        if (!pageToken) break;
      }
    }

    const messages: ProviderMessage[] = [];
    for (const id of ids) {
      const res = await call<GmailMessage>(this.url(`messages/${encodeURIComponent(id)}?format=full`), token);
      if (res.status === 404) continue; // deleted since
      const m = this.toMessage(res.body);
      if (m) messages.push(m);
    }
    return { messages, state: { historyId: profile.historyId ?? startHistoryId } };
  }

  private toMessage(g: GmailMessage): ProviderMessage | null {
    const labels = g.labelIds ?? [];
    if (labels.some((l) => SKIP_LABELS.includes(l))) return null;
    const headers = new Map((g.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
    const from = parseAddresses(headers.get("from"))[0] ?? { address: "", name: null };
    let plain: string | null = null;
    let html: string | null = null;
    let attachments = false;
    const walk = (p: GmailPart | undefined) => {
      if (!p) return;
      if (p.filename && p.body?.attachmentId) attachments = true;
      else if (p.mimeType === "text/plain" && p.body?.data && plain === null) plain = Buffer.from(p.body.data, "base64url").toString("utf8");
      else if (p.mimeType === "text/html" && p.body?.data && html === null) html = Buffer.from(p.body.data, "base64url").toString("utf8");
      for (const c of p.parts ?? []) walk(c);
    };
    walk(g.payload);
    const direction = labels.includes("SENT") ? "outbound" : "inbound";
    return {
      id: g.id,
      threadId: g.threadId ?? null,
      internetMessageId: headers.get("message-id") ?? null,
      direction,
      from,
      to: parseAddresses(headers.get("to")).map((a) => a.address),
      cc: parseAddresses(headers.get("cc")).map((a) => a.address),
      subject: headers.get("subject") ?? "",
      bodyText: plain !== null ? tidy(plain) : html !== null ? htmlToText(html) : "",
      sentAt: new Date(Number(g.internalDate) || Date.now()),
      unread: direction === "inbound" && labels.includes("UNREAD"),
      hasAttachments: attachments,
    };
  }

  async send(token: string, mail: OutgoingMail) {
    const raw = Buffer.from(buildRfc822(mail)).toString("base64url");
    const { body } = await call<{ id?: string; threadId?: string }>(this.url("messages/send"), token, { method: "POST", body: JSON.stringify({ raw, ...(mail.inReplyTo?.threadId ? { threadId: mail.inReplyTo.threadId } : {}) }) });
    return { providerMessageId: body.id ?? null, threadId: body.threadId ?? null };
  }

  async markRead(token: string, id: string) {
    await call(this.url(`messages/${encodeURIComponent(id)}/modify`), token, { method: "POST", body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) });
  }
}
