# Administrator guide

## First administrator

```bash
SEED_ADMIN_EMAIL=you@utilityoptimizer.com SEED_ADMIN_PASSWORD='a-long-unique-passphrase' NODE_ENV=production npm run db:seed
```

The seed also creates the 18 pipeline stages, the main Irish energy suppliers, Worldpay and two signature templates. It's idempotent. In production (`NODE_ENV=production`) no demo data is created.

## Single sign-on (Microsoft / Google)

Optional. Users still need a CRM account (created under **Users & roles**); SSO only changes how they prove who they are, and it never creates accounts. Email and password sign-in keeps working alongside it.

**Microsoft Entra ID**
1. Entra admin centre → App registrations → New registration. Supported account types: *this organisational directory only*.
2. Redirect URI (Web): `https://<your CRM address>/api/auth/sso/microsoft/callback`.
3. Certificates & secrets → New client secret.
4. Set `SSO_MICROSOFT_TENANT_ID` (Directory/tenant ID), `SSO_MICROSOFT_CLIENT_ID` (Application ID) and `SSO_MICROSOFT_CLIENT_SECRET`.

**Google Workspace**
1. Google Cloud console → APIs & Services → Credentials → Create OAuth client ID (Web application). On the consent screen, choose *Internal* for Workspace.
2. Authorised redirect URI: `https://<your CRM address>/api/auth/sso/google/callback`.
3. Set `SSO_GOOGLE_CLIENT_ID` and `SSO_GOOGLE_CLIENT_SECRET`.

Set `SSO_ALLOWED_DOMAINS` (for example `utilityoptimizer.com`) so only company addresses can use SSO, then restart the API. The login page shows a **Sign in with …** button for each configured provider.

How it works and what's checked: authorization code flow with PKCE (S256), a random `state` and `nonce` held in a 10-minute signed HTTP-only cookie, and an ID token whose RS256 signature is checked against the provider's published keys, along with issuer, audience, expiry and nonce. The user is matched by email: for Google the email must be verified; for Microsoft the token must come from your tenant (only your directory's accounts are accepted), using `email` or the sign-in name. Inactive users and unknown emails are refused, and every failure is audit-logged (`auth.sso_failed`).

Two-factor: a user who has CRM two-factor turned on is asked for their authenticator code after SSO, unless Microsoft reports that MFA was performed during sign-in (`amr` contains `mfa`). If your Entra conditional access already enforces MFA, staff won't be asked twice. Google doesn't report this, so Google users with CRM two-factor always enter their code.

## Users and roles (Administration → Users & roles)

| Role | Typical person |
|---|---|
| Administrator | System owner: users, settings, integrations, audit log, retention |
| Manager | Sales manager: sees everything, assigns, approves, reopens completed deals, reports |
| Salesperson | Manages their own (and unassigned) leads and opportunities |
| Operations | Reviews documents, submits applications, tracks activation |
| Compliance | Reviews Worldpay principals and risk; approves or raises queries; sees restricted data |
| Finance | Commissions and restricted bank details |

A user can hold several roles. The full permission table is in [security-matrix.md](security-matrix.md) and under **Administration → Security matrix**. Deactivating a user keeps all their opportunities and history; reassign their open deals from **Opportunities → filter by salesperson → Reassign**. Changing roles or resetting a password signs the user out everywhere. **Reset 2FA** removes a lost authenticator.

## Suppliers and pipeline (Administration → Suppliers & pipeline)

- Add or deactivate suppliers. Set each supplier's **submissions email** to enable **Send submission pack**.
- Stage names can be changed; their order and rules can't (rules reference stable keys). **Check stages** re-runs the idempotent stage migration: it matches existing stages by key, then by name (e.g. a legacy "Proposition" becomes Proposal Sent), creates only what's missing and never duplicates. A legacy "Lost" stage is left untouched and reported, because Lost is an outcome.

## Integrations

All credentials are environment variables on the API/worker (or your secrets manager). They're never sent to the browser or written to logs. **Administration → Integrations** shows what's configured and the outbound job queue.

| Feature | Variables | Notes |
|---|---|---|
| Email | `SMTP_URL`, `MAIL_FROM` | e.g. `smtps://user:pass@smtp.office365.com:465`. Enables **Send email** and submission packs. |
| WhatsApp | `WHATSAPP_PROVIDER=meta_cloud`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | Meta WhatsApp Business Cloud API. Free text only reaches customers who messaged within 24 h. |
| OCR | `OCR_PROVIDER=http`, `OCR_HTTP_ENDPOINT`, `OCR_HTTP_API_KEY` | POSTs `{image: base64, mimeType}` with `Authorization: Bearer <key>`; expects `{text, confidence?, fields?}`. Point it at a small wrapper for Azure AI Vision, Google Vision or AWS Textract. With `manual` (default), staff type the details beside the image. |
| E-signatures | `SIGNATURE_PROVIDER`, `SIGNATURE_WEBHOOK_SECRET` | `manual` (default) records in-person or scanned signatures. A vendor adapter implements `SignatureProvider` (`apps/api/src/signatures/provider.ts`) and posts events to `POST /api/webhooks/signatures` signed with `x-uo-signature: t=<unix>,v1=<hmac-sha256 of "t.body">`. Events are processed once per `eventId`; failures are kept as dead letters. |
| Virus scanning | `VIRUS_SCAN_DRIVER=clamav`, `CLAMAV_HOST`, `CLAMAV_PORT` | Without it, uploads are marked "not virus-scanned" in the UI. |
| Storage | `STORAGE_DRIVER=s3`, `S3_*` | Any S3-compatible service. Keep the bucket private; downloads use signed links valid for `DOWNLOAD_URL_TTL_SECONDS`. |
| Worldpay submissions | Administration → Integrations → *Worldpay submissions email* | Used by **Send submission pack** on Worldpay deals. |

**Outbound jobs** retry with exponential backoff (6 attempts). Jobs that give up are marked **dead**, administrators get a notification, and **Retry** re-queues them. Jobs that need configuration (e.g. no SMTP) go straight to dead with a clear message.

## Data retention (Administration → Data retention)

Applied every Sunday at 02:30, or on demand with **Apply now**:
- Sensitive documents, principal personal data and restricted compliance notes are erased N months after a deal is lost (default 24), or after a live contract ended with no renewal (default 84).
- Unconfirmed business-card scans are deleted after N days (default 30).
- Audit-log rows older than N years (default 7) are purged.

Opportunities, customers and timelines are never deleted. Each run is itself recorded in the audit log.

## Audit log (Administration → Audit log)

Every sign-in (and failure), change, export and view of restricted data, with the user and IP. It's append-only: the database refuses edits and deletes.

## Encryption key rotation

1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Set `FIELD_ENCRYPTION_KEY=<new>` and `FIELD_ENCRYPTION_KEY_PREVIOUS=<old>`; restart the API and worker. New writes use the new key; old values still decrypt.
3. Values are re-encrypted as records are updated. Keep the previous key until no `v1:<old key id>:` values remain (`SELECT count(*) FROM principals WHERE dob_enc LIKE 'v1:<oldid>:%'`, and likewise for the other `_enc` columns).

## Automation settings

- **Automatically assign new unassigned leads** (Administration → Integrations): on by default; assigns to the active salesperson in the lead's team with the fewest open opportunities.
- Thresholds (first contact 24 h, unanswered message 4 h, document chase 3 days, signature reminder 3 days, supplier follow-up 5 days, Worldpay follow-up 2 days, document expiry 30 days, renewal window 120–90 days) are in `apps/api/src/automations/automations.service.ts` and `renewals.service.ts`.
