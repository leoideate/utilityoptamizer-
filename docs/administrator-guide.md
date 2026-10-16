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

## Calling customers with RingCentral

The **Call** button on an opportunity uses RingCentral **RingOut**. RingCentral rings the salesperson's own phone first (desk phone, the RingCentral app or a mobile), and when they answer it dials the customer, showing your company number. No softphone or browser plug-in is needed.

1. In the RingCentral Developer Console, create a **REST API app** with authentication **JWT auth flow** and the app permission **RingOut**.
2. As the RingCentral user the CRM should place calls as (typically an admin or a dedicated "CRM" user), create a **JWT credential** and authorise it for the app.
3. Set `TELEPHONY_PROVIDER=ringcentral`, `RINGCENTRAL_CLIENT_ID`, `RINGCENTRAL_CLIENT_SECRET` and `RINGCENTRAL_JWT`. Optionally set `RINGCENTRAL_CALLER_ID` (a number on that RingCentral user that customers should see) and `RINGCENTRAL_PLAY_PROMPT=true` (the salesperson presses 1 before the customer is dialled, so calls never connect to their voicemail). For the RingCentral sandbox, set `RINGCENTRAL_SERVER_URL=https://platform.devtest.ringcentral.com`.
4. Restart the API and worker. Each salesperson enters their own phone number under **Account → Security, 2FA & phone**.

Only numbers saved on the opportunity, its customer or its contacts can be dialled, so the CRM can't be used as an open dialler. The worker follows each call every few seconds. When it ends, the call is written to the opportunity timeline once (outcome and approximate duration), and an answered call counts as contact with the customer. Recording is not enabled.

Without RingCentral (`TELEPHONY_PROVIDER=manual`, the default), **Call** opens the device's dialler (`tel:` link) and then asks the user for the outcome, length and notes.

## Internal chat

Chat needs no configuration. Anyone can send direct messages and join public channels; managers and administrators create, archive and add people to channels (`chat.manage_channels`). Each opportunity has a **Team chat** tab, visible to everyone who can see that opportunity; if a deal is reassigned, the previous salesperson loses access to its discussion as well. Messages can be edited or deleted by their author; the earlier text is kept and administrators can view it (each view is audit-logged). Files shared in chat are limited to PDF, images, Word and Excel, stored in the private bucket and virus-scanned. Live updates use one Server-Sent Events connection per browser tab; if a proxy in front of the CRM buffers responses, disable buffering for `/api/realtime/stream` (screens fall back to polling every 10–30 seconds).

## Users and roles (Administration → Users & roles)

| Role | Typical person |
|---|---|
| Administrator | System owner: users, settings, integrations, audit log, retention |
| Manager | Sales manager: sees everything, assigns, approves, reopens completed deals, reports |
| Salesperson | Manages their own (and unassigned) leads and opportunities |
| Operations | Reviews documents, submits applications, tracks activation |
| Compliance | Reviews Worldpay principals and risk; approves or raises queries; sees restricted data |
| Finance | Commissions and restricted bank details |

A user can hold several roles. The full permission table is in [security-matrix.md](security-matrix.md) and under **Administration → Security matrix**. Deactivating a user keeps all their opportunities and history; reassign their open deals from **Opportunities → filter by salesperson → Reassign**. Changing roles or resetting a password signs the user out everywhere. **Reset 2FA** removes a lost authenticator. People change their own password under **Account** (it asks for the current one and signs out their other devices); only administrators can reset someone else's. Sessions end after `SESSION_IDLE_MINUTES` without activity (default 60) and after `SESSION_TTL_HOURS` in any case.

Salespeople see the customers they created and those on deals they can see. If a salesperson enters details that match a customer they can't see, the duplicate warning shows only the company name; a manager links that customer to the deal.

## Suppliers and pipeline (Administration → Suppliers & pipeline)

- Add or deactivate suppliers. Set each supplier's **submissions email** to enable **Send submission pack**.
- Stage names can be changed; their order and rules can't (rules reference stable keys). **Check stages** re-runs the idempotent stage migration: it matches existing stages by key, then by name (e.g. a legacy "Proposition" becomes Proposal Sent), creates only what's missing and never duplicates. A legacy "Lost" stage is left untouched and reported, because Lost is an outcome.

## Supplier forms (Supplier forms in the menu)

Administrators, managers and operations can add each supplier's PDF once and reuse it for every deal.

1. **Add form**: upload the PDF, choose the supplier and how the filled copy is filed on the deal's checklist (application form, rate card, direct debit mandate, commercial agreement, letter of authority or supplier contract).
2. **Place the fields.** Fillable PDFs (such as the Bord Gáis electricity form) bring their own boxes, including rows of single-character boxes for the MPRN. On flat PDFs (most rate cards and CAFs), choose *Text*, *Tick box*, *Signature* or *Date signed* and click where the box starts; drag to move, drag the corner to resize, or use the arrow keys.
3. **Link each box** to CRM data under *Fill from* (customer, contact, billing and supply address, MPRN/GPRN, contract and rates, bank details, broker), or leave it to be typed. Set *Character boxes* for MPRN/GPRN rows on flat PDFs. Signature and date-signed boxes belong to the client or the broker.
4. **Save.** Changing the boxes creates a new template version; forms already filled keep the version they used. Untick *In use* to retire a template.

On a deal, the **Forms** tab fills the supplier's form from the CRM. Anything typed or changed is recorded against the form, and an IBAN that differs from the one on file must be confirmed. The generated PDF has no fillable fields left (so nothing can drop out when it's opened in Adobe), and the CRM reopens it to check every value and signature is present; a failed check blocks signing and submission.

**Signatures** are uploaded as a photo or scan; the browser removes the paper background. The uploader records who signed, in what capacity and how they authorised it *for that form*, and the signed copy then needs **review by someone else** with document review rights. An approved form counts as the customer's signature for submission. Stored signatures are never reused automatically.

**Change of supplier**: when a deal is marked *Change of supplier*, the Forms tab shows the previous supplier's bill (uploaded as the “Recent energy bill”) and a **Check bill** step: readable, customer name, MPRN/GPRN and supplier must all match. Submission is blocked until the latest bill passes; a newer upload needs a new check. Other open deals for the same MPRN/GPRN are flagged.

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
