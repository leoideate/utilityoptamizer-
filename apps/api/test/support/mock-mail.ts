import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockMail {
  id: string;
  seq: number;
  folder: "inbox" | "sent";
  threadId: string;
  internetMessageId: string;
  from: { address: string; name?: string };
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  html: boolean;
  sentAt: Date;
  isRead: boolean;
  inReplyTo?: string;
  /** The HTML part of a multipart message sent through Gmail. */
  sentHtml?: string;
}

/**
 * A mail provider for tests: OpenID discovery, OAuth (authorization code + PKCE, refresh tokens)
 * and either Microsoft Graph or Gmail API endpoints over an in-memory mailbox per address.
 */
export class MockMailProvider {
  url = "";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly mail: MockMail[] = [];
  tokenRequests: URLSearchParams[] = [];
  private server!: Server;
  private seq = 100;
  private readonly codes = new Map<string, { challenge: string; address: string }>();
  private readonly accessTokens = new Map<string, string>();
  private readonly refreshTokens = new Map<string, string>();
  private readonly revoked = new Set<string>();

  constructor(readonly kind: "microsoft" | "google") {
    this.clientId = `${kind}-mail-client`;
    this.clientSecret = `${this.clientId}-secret`;
  }

  get issuer() {
    return `${this.url}/oidc`;
  }
  /** MAIL_GRAPH_URL or MAIL_GMAIL_URL. */
  get apiBase() {
    return this.kind === "microsoft" ? `${this.url}/graph` : `${this.url}/gm`;
  }

  async start() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          this.handle(req, res, raw);
        } catch (e) {
          this.json(res, 500, { error: (e as Error).message });
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  /** The person approves at the provider; returns the code and state for the callback. */
  issueCode(authorizeUrl: string, address: string) {
    const u = new URL(authorizeUrl);
    const code = `code-${Math.random().toString(36).slice(2)}`;
    this.codes.set(code, { challenge: u.searchParams.get("code_challenge")!, address: address.toLowerCase() });
    return { code, state: u.searchParams.get("state")! };
  }

  /** Every issued access token stops working (the client must refresh). */
  expireAccessTokens() {
    this.accessTokens.clear();
  }

  /** The person revokes consent: refresh tokens are refused with invalid_grant. */
  revokeAll() {
    for (const rt of this.refreshTokens.keys()) this.revoked.add(rt);
    this.accessTokens.clear();
  }

  deliver(m: { to: string; from: string; fromName?: string; subject: string; body: string; html?: boolean; cc?: string[]; folder?: "inbox" | "sent"; threadId?: string; isRead?: boolean; sentAt?: Date }) {
    const id = `${this.kind === "microsoft" ? "ms" : "gm"}${++this.seq}`;
    const msg: MockMail = {
      id,
      seq: this.seq,
      folder: m.folder ?? "inbox",
      threadId: m.threadId ?? `t-${id}`,
      internetMessageId: `<${id}@mock.test>`,
      from: { address: m.from.toLowerCase(), name: m.fromName },
      to: [m.to.toLowerCase()],
      cc: m.cc ?? [],
      subject: m.subject,
      body: m.body,
      html: !!m.html,
      sentAt: m.sentAt ?? new Date(),
      isRead: m.isRead ?? false,
    };
    this.mail.push(msg);
    return msg;
  }

  private owner(req: IncomingMessage): string | null {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    return this.accessTokens.get(token) ?? null;
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  private mine(address: string) {
    return this.mail.filter((m) => (m.folder === "sent" ? m.from.address === address : m.to.includes(address) || m.cc.includes(address)));
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string) {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;

    // --- OpenID discovery and OAuth -------------------------------------------------
    if (path === "/oidc/.well-known/openid-configuration") {
      return this.json(res, 200, { issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks` });
    }
    if (path === "/oidc/token" && req.method === "POST") {
      const p = new URLSearchParams(raw);
      this.tokenRequests.push(p);
      if (p.get("client_id") !== this.clientId || p.get("client_secret") !== this.clientSecret) return this.json(res, 401, { error: "invalid_client" });
      let address: string | undefined;
      if (p.get("grant_type") === "authorization_code") {
        const pending = this.codes.get(p.get("code") ?? "");
        if (!pending) return this.json(res, 400, { error: "invalid_grant" });
        if (createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") !== pending.challenge) return this.json(res, 400, { error: "invalid_grant", error_description: "PKCE" });
        this.codes.delete(p.get("code")!);
        address = pending.address;
      } else if (p.get("grant_type") === "refresh_token") {
        const rt = p.get("refresh_token") ?? "";
        if (this.revoked.has(rt) || !this.refreshTokens.has(rt)) return this.json(res, 400, { error: "invalid_grant" });
        address = this.refreshTokens.get(rt);
      } else {
        return this.json(res, 400, { error: "unsupported_grant_type" });
      }
      const access = `at-${Math.random().toString(36).slice(2)}`;
      this.accessTokens.set(access, address!);
      const out: Record<string, unknown> = { access_token: access, token_type: "Bearer", expires_in: 3600 };
      if (p.get("grant_type") === "authorization_code") {
        const refresh = `rt-${Math.random().toString(36).slice(2)}`;
        this.refreshTokens.set(refresh, address!);
        out.refresh_token = refresh;
      }
      return this.json(res, 200, out);
    }

    const me = this.owner(req);
    if (!me) return this.json(res, 401, { error: "invalid_token" });
    return this.kind === "microsoft" ? this.graph(req, res, url, raw, me) : this.gmail(req, res, url, raw, me);
  }

  // --- Microsoft Graph ---------------------------------------------------------------------

  private graphMessage(m: MockMail) {
    const addr = (a: string, name?: string) => ({ emailAddress: { address: a, ...(name ? { name } : {}) } });
    return {
      id: m.id,
      conversationId: m.threadId,
      internetMessageId: m.internetMessageId,
      subject: m.subject,
      body: { contentType: m.html ? "html" : "text", content: m.body },
      from: addr(m.from.address, m.from.name),
      toRecipients: m.to.map((a) => addr(a)),
      ccRecipients: m.cc.map((a) => addr(a)),
      sentDateTime: m.sentAt.toISOString(),
      receivedDateTime: m.sentAt.toISOString(),
      isRead: m.isRead,
      isDraft: false,
      hasAttachments: false,
    };
  }

  private graph(req: IncomingMessage, res: ServerResponse, url: URL, raw: string, me: string) {
    const p = url.pathname.replace(/^\/graph/, "");
    if (p === "/me") return this.json(res, 200, { mail: me, userPrincipalName: me });
    const delta = p.match(/^\/me\/mailFolders\/(inbox|sentitems)\/messages\/delta$/);
    if (delta) {
      const folder = delta[1] === "inbox" ? "inbox" : "sent";
      const after = Number(url.searchParams.get("token") ?? 0);
      const items = this.mine(me).filter((m) => m.folder === folder && m.seq > after);
      return this.json(res, 200, { value: items.map((m) => this.graphMessage(m)), "@odata.deltaLink": `${this.apiBase}/me/mailFolders/${delta[1]}/messages/delta?token=${this.seq}` });
    }
    if (p === "/me/sendMail" && req.method === "POST") {
      const b = JSON.parse(raw) as { message: { subject: string; body: { content: string }; toRecipients: { emailAddress: { address: string } }[] } };
      const m = this.deliver({ from: me, to: b.message.toRecipients[0].emailAddress.address, subject: b.message.subject, body: b.message.body.content, folder: "sent", isRead: true });
      m.to = b.message.toRecipients.map((r) => r.emailAddress.address.toLowerCase());
      return this.json(res, 202, undefined);
    }
    const reply = p.match(/^\/me\/messages\/([^/]+)\/reply$/);
    if (reply && req.method === "POST") {
      const orig = this.mail.find((m) => m.id === decodeURIComponent(reply[1]));
      if (!orig) return this.json(res, 404, {});
      // A reply carries either a plain comment or a message body (HTML, e.g. with a signature).
      const b = JSON.parse(raw) as { comment?: string; message?: { body: { content: string } } };
      const to = orig.folder === "inbox" ? orig.from.address : orig.to[0];
      const m = this.deliver({ from: me, to, subject: `RE: ${orig.subject}`, body: b.message?.body.content ?? b.comment ?? "", folder: "sent", threadId: orig.threadId, isRead: true });
      m.inReplyTo = orig.internetMessageId;
      return this.json(res, 202, undefined);
    }
    const one = p.match(/^\/me\/messages\/([^/]+)$/);
    if (one && req.method === "PATCH") {
      const m = this.mail.find((x) => x.id === decodeURIComponent(one[1]));
      if (!m) return this.json(res, 404, {});
      if ((JSON.parse(raw) as { isRead?: boolean }).isRead) {
        m.isRead = true;
        m.seq = ++this.seq;
      }
      return this.json(res, 200, this.graphMessage(m));
    }
    return this.json(res, 404, {});
  }

  // --- Gmail ---------------------------------------------------------------------------------

  private gmailMessage(m: MockMail) {
    const enc = (s: string) => Buffer.from(s).toString("base64url");
    const headers = [
      { name: "From", value: m.from.name ? `"${m.from.name}" <${m.from.address}>` : m.from.address },
      { name: "To", value: m.to.join(", ") },
      ...(m.cc.length ? [{ name: "Cc", value: m.cc.join(", ") }] : []),
      { name: "Subject", value: m.subject },
      { name: "Message-ID", value: m.internetMessageId },
    ];
    const labelIds = [m.folder === "sent" ? "SENT" : "INBOX", ...(m.isRead ? [] : ["UNREAD"])];
    return {
      id: m.id,
      threadId: m.threadId,
      labelIds,
      internalDate: String(m.sentAt.getTime()),
      payload: { mimeType: "multipart/alternative", headers, parts: [{ mimeType: m.html ? "text/html" : "text/plain", body: { data: enc(m.body) } }] },
    };
  }

  private gmail(req: IncomingMessage, res: ServerResponse, url: URL, raw: string, me: string) {
    const p = url.pathname.replace(/^\/gm\/gmail\/v1\/users\/me/, "");
    if (p === "/profile") return this.json(res, 200, { emailAddress: me, historyId: String(this.seq) });
    if (p === "/messages" && req.method === "GET") return this.json(res, 200, { messages: this.mine(me).map((m) => ({ id: m.id, threadId: m.threadId })) });
    if (p === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      const added = this.mine(me).filter((m) => m.seq > start);
      return this.json(res, 200, { history: added.map((m) => ({ messagesAdded: [{ message: { id: m.id } }] })), historyId: String(this.seq) });
    }
    if (p === "/messages/send" && req.method === "POST") {
      const b = JSON.parse(raw) as { raw: string; threadId?: string };
      const text = Buffer.from(b.raw, "base64url").toString("utf8");
      const [head, ...rest] = text.split("\r\n\r\n");
      const h = new Map(head.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      const decode = (s: string) => Buffer.from(s.replace(/\r\n/g, ""), "base64").toString("utf8");
      // multipart/alternative: the text/plain part is the body; the HTML part is kept beside it.
      const boundary = h.get("content-type")?.match(/boundary="([^"]+)"/)?.[1];
      const parts = boundary ? rest.join("\r\n\r\n").split(`--${boundary}`).filter((x) => x.includes("Content-Type:")) : [];
      const part = (type: string) => {
        const found = parts.find((x) => x.includes(`Content-Type: ${type}`));
        return found ? decode(found.split("\r\n\r\n")[1]) : undefined;
      };
      const body = boundary ? (part("text/plain") ?? "") : decode(rest.join("\r\n\r\n"));
      const m = this.deliver({ from: me, to: h.get("to")!.split(",")[0].trim(), subject: h.get("subject")!, body, folder: "sent", threadId: b.threadId, isRead: true });
      m.sentHtml = part("text/html");
      m.to = h.get("to")!.split(",").map((s) => s.trim().toLowerCase());
      m.inReplyTo = h.get("in-reply-to");
      return this.json(res, 200, { id: m.id, threadId: m.threadId });
    }
    const modify = p.match(/^\/messages\/([^/]+)\/modify$/);
    if (modify && req.method === "POST") {
      const m = this.mail.find((x) => x.id === modify[1]);
      if (!m) return this.json(res, 404, {});
      if ((JSON.parse(raw) as { removeLabelIds?: string[] }).removeLabelIds?.includes("UNREAD")) m.isRead = true;
      return this.json(res, 200, { id: m.id });
    }
    const one = p.match(/^\/messages\/([^/]+)$/);
    if (one) {
      const m = this.mail.find((x) => x.id === one[1]);
      return m ? this.json(res, 200, this.gmailMessage(m)) : this.json(res, 404, {});
    }
    return this.json(res, 404, {});
  }
}
