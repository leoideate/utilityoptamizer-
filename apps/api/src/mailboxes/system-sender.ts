import { type EmailMessage, type EmailSender, NotConfigured } from "../integrations/adapters";
import type { MailboxesService } from "./mailboxes.service";

/**
 * System email through a connected CRM mailbox (SYSTEM_MAILBOX), e.g. Gmail sending as a shared
 * address. While that mailbox isn't connected it falls back to SMTP, and fails like any
 * unconfigured adapter when there's no SMTP either, so the job is dead-lettered with the reason.
 */
export class MailboxEmailSender implements EmailSender {
  readonly configured = true;
  constructor(
    private readonly mailboxes: MailboxesService,
    private readonly address: string,
    private readonly from: string | undefined,
    private readonly fallback: EmailSender,
  ) {}

  async send(msg: EmailMessage) {
    const sent = await this.mailboxes.sendSystem(this.address, this.from, msg);
    if (sent) return sent;
    if (this.fallback.configured) return this.fallback.send(msg);
    throw new NotConfigured(`Email (connect the ${this.address} mailbox in the CRM, or set SMTP_URL)`);
  }
}
