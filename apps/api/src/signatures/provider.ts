import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface SignatureEnvelope {
  requestId: string;
  title: string;
  signers: { id: string; role: "customer" | "broker" | "account_holder_2"; name: string; email: string }[];
  providerTemplateId?: string | null;
}

export type SignatureEventType = "signer_signed" | "signer_declined" | "completed" | "declined" | "expired";

export interface SignatureEvent {
  eventId: string;
  providerRequestId: string;
  type: SignatureEventType;
  signerEmail?: string;
  occurredAt?: string;
  /** Signed PDF, base64, when the provider includes it with "completed". */
  signedDocumentBase64?: string;
}

/**
 * Integration point for e-signature vendors (DocuSign, Dropbox Sign, ...). A vendor adapter
 * implements send/remind/cancel against its API and translates its webhooks into SignatureEvents.
 */
export interface SignatureProvider {
  readonly name: string;
  send(envelope: SignatureEnvelope): Promise<{ providerRequestId: string }>;
  remind(providerRequestId: string): Promise<void>;
  cancel(providerRequestId: string): Promise<void>;
}

export const SIGNATURE_PROVIDER = Symbol("SIGNATURE_PROVIDER");

/**
 * Signatures collected outside an e-signature platform (signed in person, or a scanned copy).
 * Staff record each signature and upload the signed document; the audit trail is identical.
 */
export class ManualSignatureProvider implements SignatureProvider {
  readonly name = "manual";
  async send() {
    return { providerRequestId: `manual:${randomUUID()}` };
  }
  async remind() {
    /* Reminders are tasks for staff; nothing to send. */
  }
  async cancel() {
    /* Nothing external to cancel. */
  }
}

/** Header carrying "t=<unix seconds>,v1=<hex hmac>" over `${t}.${rawBody}`. */
export const WEBHOOK_SIGNATURE_HEADER = "x-uo-signature";
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function signWebhook(secret: string, rawBody: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

/** Verifies the HMAC and rejects stale timestamps (replay protection). */
export function verifyWebhook(secret: string, rawBody: string, header: string | undefined, now = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now - t) > WEBHOOK_TOLERANCE_SECONDS || !parts.v1) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "hex");
  const given = Buffer.from(parts.v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
