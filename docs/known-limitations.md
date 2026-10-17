# Known limitations

These are deliberate gaps or follow-up work. Nothing here pretends to work when it doesn't: unconfigured features are hidden or show a clear "not set up" message.

## Not implemented yet

| Area | Status | What's there instead |
|---|---|---|
| DocuSign / Dropbox Sign adapters | Not built | `SignatureProvider` interface, a working **manual** provider (signed in person or by scan, with full audit trail), and a generic HMAC-verified, idempotent webhook endpoint a vendor adapter can post to. |
| Bill data extraction | Not built | Bills are stored, versioned and reviewed; meter details and rates are typed in. |
| Supplier / Worldpay APIs | Not built | Submission is recorded by Operations; **Send submission pack** emails the approved documents (signed links) to the supplier's or Worldpay's submissions address. `SubmissionChannel` is the extension point for vendor APIs. |
| Accounting integration | CSV only | `GET /api/reports/commissions.csv` (formula-safe) for import into the accounting system. |
| Inbound email and WhatsApp | Manual logging | Staff log inbound messages on the timeline (which drives the unanswered-message reminders). Outbound email (SMTP) and WhatsApp (Meta Cloud API) are sent from the CRM. |
| Inbound calls and call recording | Not built | Outbound click-to-call only (RingCentral RingOut, or manual). Inbound calls and RingCentral call-log sync aren't imported; recording is off (it needs consent notices). |
| Staff audio/video calls | Not built | Internal chat only. |
| Notifications by email or push | In-app only | Bell notifications, plus reminders for tasks with a reminder time. |
| API keys for machine clients | Not built | Session-based API for users; HMAC-signed endpoints for website leads and e-signature events. |
| Custom pipeline stages | Rename only | The 18 stages and their rules are fixed in code; names can be changed in Administration. |
| Workflow consent channels and acknowledgements | Manual | The briefs leave open which channels give valid consent per supplier, whether acknowledgements arrive by email or portal, and the retention period per evidence type. Consent is an authorised signature upload (or an e-signature request); responses are recorded by Operations; evidence follows the general retention policy. |
| Bill data extraction for renewals | Manual | A renewal for a customer new to us uses the bill check and the case checklist; values are typed, not read from the bill. |
| Commission rules | Manual | Expected commission comes from the chosen quotes and is confirmed at activation; Finance can add or adjust entries. No rate tables per supplier. |

- **Supplier forms**: the black and white copy is greyscale (each colour shown as its brightness) rather than a thresholded scan; text and signatures stay sharp. Forms fill from the deal's first supply site and first live contract, so multi-site applications need the extra sites typed. Text uses Helvetica, which covers Irish and Western European characters (fadas, €) but not others; the quality check names any character it can't print. Signature capture is an authorised upload reviewed by a colleague, not a qualified e-signature; use the Signatures tab with an e-signature provider where a supplier requires one.

## Operational notes

- **Content-Security-Policy** allows inline scripts (`'unsafe-inline'`), which Next.js needs for hydration without per-request nonces. No third-party script origins are allowed.
- **Customer data subject requests** (GDPR access/erasure) are handled by an administrator from the customer record and the retention job; there's no self-service export.

- **Single sign-on** signs in existing users only, and doesn't sync users or roles from Entra ID or Google (no SCIM). Microsoft SSO is single-tenant by design. An administrator can make a user SSO-only (password sign-in off) one user at a time; there's no per-domain switch.
- **RingCentral call length** is measured by the CRM from "connected" to "ended" (RingOut doesn't report duration), so it's shown as approximate. Salespeople can enter the exact length with their notes.
- **Chat** messages are kept indefinitely (no chat retention setting yet) and have no threads, reactions, per-person read receipts or search. Live updates use Server-Sent Events; proxies must not buffer `/api/realtime/stream`.
- **OCR** needs a provider behind the generic HTTP adapter (Azure, Google, AWS…). With the default `manual` setting, users type the details beside the photo. The local text parser is tuned for Irish and UK cards and may mis-assign unusual layouts; the review screen is there to catch that.
- **Virus scanning** is a ClamAV (clamd) adapter. Without it, uploads are accepted and clearly marked "not virus-scanned".
- **Encryption key rotation** re-encrypts values as they're edited. There's no bulk re-encryption job yet; keep the previous key configured until none of its values remain (see the administrator guide).
- **Local S3**: MinIO no longer publishes free public images, so the development stack uses SeaweedFS. Production should use AWS S3 or another managed S3-compatible service.
- **Dependency pins**: NestJS 11, Prisma 6, BullMQ 5 and Next.js 15 are intentionally pinned to their mature majors (NestJS 12, Prisma 7/8 and Next 16 exist). `npm audit` still reports advisories in **development-only tooling** (Jest's `braces`/`micromatch`, for which no fixed version exists yet); runtime dependencies are clean after the `overrides` in the root `package.json`.

## Testing gaps

- End-to-end tests run against the seeded local stack, not an isolated database per run, so they create extra demo records each time.
- Rate limiting is switched off in the automated test environment; the login limit and account lockout are covered by a dedicated test, and the throttles were exercised under load by the stress script, but not in `npm test`.
- Penetration and load testing were done by the developer ([security-assessment.md](security-assessment.md)), not independently. Commission an independent test before go-live. Accessibility is checked with axe (WCAG 2.1 AA, serious and critical issues) on the main pages, not with a manual screen-reader audit.
- Recurring job *schedules* (cron registration in BullMQ) are exercised by starting the worker, not by automated tests; the job *handlers* are tested directly.
