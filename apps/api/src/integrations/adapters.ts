import nodemailer, { type Transporter } from "nodemailer";

/** An adapter that isn't configured fails with this; the job is dead-lettered with a clear reason. */
export class NotConfigured extends Error {
  constructor(what: string) {
    super(`${what} is not configured. An administrator needs to set it up.`);
    this.name = "NotConfigured";
  }
}

// --- Email -------------------------------------------------------------------

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

export interface EmailSender {
  readonly configured: boolean;
  send(msg: EmailMessage): Promise<{ messageId: string }>;
}
export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter | null;
  constructor(
    url: string | undefined,
    private readonly from: string,
  ) {
    this.transport = url ? nodemailer.createTransport(url) : null;
  }
  get configured() {
    return !!this.transport;
  }
  async send(msg: EmailMessage) {
    if (!this.transport) throw new NotConfigured("Email (SMTP_URL)");
    const info = await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text, replyTo: msg.replyTo });
    return { messageId: String(info.messageId) };
  }
}

// --- WhatsApp ---------------------------------------------------------------

export interface WhatsAppSender {
  readonly configured: boolean;
  send(toE164: string, text: string): Promise<{ messageId: string }>;
}
export const WHATSAPP_SENDER = Symbol("WHATSAPP_SENDER");

export class DisabledWhatsApp implements WhatsAppSender {
  readonly configured = false;
  async send(): Promise<{ messageId: string }> {
    throw new NotConfigured("WhatsApp");
  }
}

/** WhatsApp Business Cloud API (Meta). Free-form text only works inside the 24-hour customer window. */
export class MetaCloudWhatsApp implements WhatsAppSender {
  readonly configured = true;
  constructor(
    private readonly phoneNumberId: string,
    private readonly token: string,
  ) {}
  async send(toE164: string, text: string) {
    const res = await fetch(`https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: toE164.replace(/[^\d]/g, ""), type: "text", text: { body: text } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`WhatsApp API returned HTTP ${res.status}`);
    const body = (await res.json()) as { messages?: { id: string }[] };
    return { messageId: body.messages?.[0]?.id ?? "unknown" };
  }
}

// --- Submissions --------------------------------------------------------------

export interface SubmissionPack {
  opportunityNumber: number;
  customerName: string;
  serviceType: string;
  summary: string;
  /** Short-lived links to the approved documents. */
  documents: { label: string; url: string }[];
}

/** Sends an application to a supplier or Worldpay. Vendors with an API can implement this directly. */
export interface SubmissionChannel {
  submit(destination: string, pack: SubmissionPack): Promise<{ reference: string }>;
}
export const SUBMISSION_CHANNEL = Symbol("SUBMISSION_CHANNEL");

/** Emails the submission pack to the supplier's (or Worldpay's) submissions address. */
export class EmailSubmissionChannel implements SubmissionChannel {
  constructor(private readonly email: EmailSender) {}
  async submit(destination: string, pack: SubmissionPack) {
    const text = [
      `Application UO-${String(pack.opportunityNumber).padStart(6, "0")}`,
      `Customer: ${pack.customerName}`,
      `Service: ${pack.serviceType}`,
      "",
      pack.summary,
      "",
      "Documents (links expire):",
      ...pack.documents.map((d) => `- ${d.label}: ${d.url}`),
    ].join("\n");
    const r = await this.email.send({ to: destination, subject: `New application UO-${String(pack.opportunityNumber).padStart(6, "0")} – ${pack.customerName}`, text });
    return { reference: r.messageId };
  }
}
