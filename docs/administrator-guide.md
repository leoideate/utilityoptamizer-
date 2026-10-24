# Administrator guide

## First administrator

```bash
SEED_ADMIN_EMAIL=you@utilityoptimizer.com SEED_ADMIN_PASSWORD='a-long-unique-passphrase' NODE_ENV=production npm run db:seed
```

Inside a production container (for example the Render shell of the API service) the TypeScript tooling isn't installed, so use the compiled seed instead:

```bash
SEED_ADMIN_EMAIL=you@utilityoptimizer.com SEED_ADMIN_PASSWORD='a-long-unique-passphrase' npm run db:seed:prod
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

SSO-only accounts: once someone signs in with SSO, untick **Allow password sign-in** on their user (**Users & roles** → Edit). Their CRM password then stops working (sign-in attempts get the usual "incorrect" message and are audit-logged as `auth.password_login_refused`), they can't change it, and any open sessions end so they sign back in with SSO. Leaving a company account in Entra ID or Google then removes their CRM access too. The CRM won't turn it off for your own account, when no SSO provider is configured, or when the user's email domain isn't in `SSO_ALLOWED_DOMAINS`, so nobody is left without a way in. Tick the box again to restore password sign-in (reset their password if they don't know it).

## Email (each person's Outlook or Gmail)

People connect their own work mailbox under **My account → My mailbox**. The CRM then syncs their inbox and sent mail every two minutes (the first sync fetches the last `MAIL_BACKFILL_DAYS`, default 30), shows it under **Email**, and sends from their own address so replies stay in their Outlook or Gmail thread. Only a mailbox whose address equals the person's CRM email can be connected.

Emails with a customer are added to the matching deal's timeline (and the deal owner is notified live): a reply in a thread already linked keeps that deal; otherwise the other party's address is matched to customers, their contacts and leads. If a customer has several open deals, the one owned by the mailbox owner is used, or else the email is linked to the customer only. Anyone who can see the deal can open the email; mail that matches no customer (and mail between staff) stays visible to its owner only. Synced email is never deleted, even if the mailbox is disconnected. Email HTML is converted to plain text; attachments stay in Outlook or Gmail.

Setup uses the same app registrations as single sign-on, plus mail permissions:

- **Microsoft 365**: in the Entra app, add the redirect URI `https://<your CRM>/api/mailboxes/microsoft/callback` and the delegated Microsoft Graph permissions `Mail.ReadWrite`, `Mail.Send`, `User.Read` and `offline_access`, then **Grant admin consent**.
- **Google Workspace**: in the OAuth client, add the redirect URI `https://<your CRM>/api/mailboxes/google/callback`, enable the **Gmail API**, and add the scopes `gmail.modify` and `gmail.send` to the consent screen. Keep the app **Internal** to your Workspace; an external app needs Google's security assessment for these scopes.

If someone changes their password or revokes access, their mailbox shows **Needs reconnecting** and they get a notification; sending from the CRM then asks them to reconnect.

### Email signatures

Email sent from the CRM (deal emails, replies and signing links) ends with the sender's signature, as HTML with a plain-text copy, through Outlook, Gmail or SMTP.

- **Company template:** **Administration → Company email signature** sets the company name, address, phone, website, general email and optional small print, plus the logo. It starts with the letterhead logo and the Greenhills Road details. Uploading a different logo (PNG or JPEG, up to 1 MB) replaces it for everyone using the company logo; **Use the letterhead logo** goes back.
- **Each person:** **My account → Email signature** starts from the template with their name. People can change anything: job title, phone, mobile, email, extra lines, colour, picture size, whether to show the company details, and the picture (company logo, their own uploaded picture, or none). The preview is exactly what recipients see. Turning the signature off sends plain text.
- Pictures are served from `/api/public/email-images/<id>` so recipients' mail apps can show them. They're public by an unguessable id and are only ever signature pictures, never documents. Many mail apps hide pictures until the reader allows them; the text still shows.
- The deal timeline records the message without the signature.

## Calling customers with RingCentral

The **Call** button on an opportunity uses RingCentral **RingOut**. RingCentral rings the salesperson's own phone first (desk phone, the RingCentral app or a mobile), and when they answer it dials the customer, showing your company number. No softphone or browser plug-in is needed.

1. In the RingCentral Developer Console, create a **REST API app** with authentication **JWT auth flow** and the app permissions **RingOut**, **Read Call Log** and **Read Accounts** (the last two for the call log below).
2. As the RingCentral user the CRM should place calls as (typically an admin or a dedicated "CRM" user), create a **JWT credential** and authorise it for the app.
3. Set `TELEPHONY_PROVIDER=ringcentral`, `RINGCENTRAL_CLIENT_ID`, `RINGCENTRAL_CLIENT_SECRET` and `RINGCENTRAL_JWT`. Optionally set `RINGCENTRAL_CALLER_ID` (a number on that RingCentral user that customers should see) and `RINGCENTRAL_PLAY_PROMPT=true` (the salesperson presses 1 before the customer is dialled, so calls never connect to their voicemail). For the RingCentral sandbox, set `RINGCENTRAL_SERVER_URL=https://platform.devtest.ringcentral.com`.
4. Restart the API and worker. Each salesperson enters their own phone number under **My account → My phone for calls**.

Only numbers saved on the opportunity, its customer or its contacts can be dialled, so the CRM can't be used as an open dialler. The worker follows each call every few seconds. When it ends, the call is written to the opportunity timeline once (outcome and approximate duration), and an answered call counts as contact with the customer. Recording is not enabled.

**Call log.** Every five minutes the worker also imports the company's RingCentral call log, so calls nobody started from the CRM show up too: inbound calls, missed calls, and calls made from desk phones or the RingCentral app. The JWT user needs to be a RingCentral **administrator** (the company call log is account-wide). RingCentral users are matched to CRM users by email address, so each person's RingCentral login email must be the same as their CRM email. Each call is matched by the customer's number to customers, their contacts and leads, using the same rules as email (one open deal, or the deal owned by the person on the call, or the customer only), and logged on the timeline once. A missed call from a customer creates a high-priority "Call back" task for the deal's owner. Click-to-calls are matched to their call-log record (which gives their exact length) rather than logged twice. Calls from numbers that match no customer are kept but don't appear on any timeline.

**Recordings.** If your RingCentral account records calls, set `RINGCENTRAL_RECORDINGS=true` (and give the app the **Read Call Recording** permission) to bring the recordings into the CRM. Only turn this on once callers hear a recording notice: recording calls needs their consent. Each recording is copied into the CRM's own storage and virus-scanned, and a **Play recording** link appears on the call in the timeline. Only the person on the call and people who can see its deal (or customer) can play it, and every play is recorded in the audit log as access to sensitive data. Recordings are deleted after **Delete call recordings after (months)** in the retention policy (default 12); the call itself stays on the timeline.

**Incoming-call pop-ups.** When a customer calls someone's RingCentral extension, the CRM can show them who it is (the customer, the contact and their open deals) while the phone rings, with a button to open the deal. Set `RINGCENTRAL_WEBHOOK_TOKEN` to 16–64 random characters and give the app the **Webhook Subscriptions** permission. The worker then subscribes RingCentral to the company's call events, delivered to `{WEB_ORIGIN}/api/webhooks/ringcentral` (set `RINGCENTRAL_WEBHOOK_URL` if RingCentral must use a different address), and renews the subscription every few hours. That address must be reachable from the internet over HTTPS. Each event must carry the token, and the pop-up only shows customers and deals the person could see anyway. Extensions are matched to people by email, as for the call log.

Without RingCentral (`TELEPHONY_PROVIDER=manual`, the default), **Call** opens the device's dialler (`tel:` link) and then asks the user for the outcome, length and notes.

## Internal chat

Chat is **turned off** unless the API is started with `CHAT_ENABLED=true`. While it is off, the Chat menu item and the opportunity **Team chat** tab are hidden and every `/api/chat/*` route answers 404; existing messages and files are kept, and come back when it is switched on again. When on, chat needs no other configuration. Anyone can send direct messages and join public channels; managers and administrators create, archive and add people to channels (`chat.manage_channels`). Each opportunity has a **Team chat** tab, visible to everyone who can see that opportunity; if a deal is reassigned, the previous salesperson loses access to its discussion as well. Messages can be edited or deleted by their author; the earlier text is kept and administrators can view it (each view is audit-logged). Files shared in chat are limited to PDF, images, Word and Excel, stored in the private bucket and virus-scanned. Live updates use one Server-Sent Events connection per browser tab; if a proxy in front of the CRM buffers responses, disable buffering for `/api/realtime/stream` (screens fall back to polling every 10–30 seconds).

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

## One interface for sales and the back office

There is one interface for every role. The menu and Home show what a user's role allows (for example **Scan business card** needs permission to create opportunities, **Supplier forms** needs template management, and the **Work queue** on Home shows to those who can submit deals). A deal is handed to the back office when it reaches **Supplier selected** (a task goes to the Operations user with the fewest open tasks). Hiding a screen is only a convenience: every permission is still enforced by the server from the security matrix.

## Suppliers and pipeline (Administration → Suppliers & pipeline)

- Add or deactivate suppliers. Set each supplier's **submissions email** to enable **Send submission pack**.
- **Workflow rules** per energy supplier: whether a renewal needs the **full renewal form** or the **rate card only** (e.g. Flogas), whether submissions need **black and white copies** of the signed forms, and whether a change of entity needs the **outgoing account holder's consent** (uploaded as that document). The submission checklist follows these settings.
- **Workflow reminders**: how many days before chasing an unanswered submission, the points before a contract ends at which an open renewal gets a deadline task (default 90, 60, 30 and 14 days), and how many days an overdue workflow task (renewal, chase, correction) waits before it's escalated to a manager. Unassigned workflow tasks are escalated straight away.
- Stage names can be changed; their order and rules can't (rules reference stable keys). **Check stages** re-runs the idempotent stage migration: it matches existing stages by key, then by name (e.g. a legacy "Proposition" becomes Proposal Sent), creates only what's missing and never duplicates. A legacy "Lost" stage is left untouched and reported, because Lost is an outcome.

## Supplier forms (Supplier forms in the menu)

Administrators, managers and operations can add each supplier's PDF once and reuse it for every deal.

1. **Add form**: upload the PDF, choose the supplier and how the filled copy is filed on the deal's checklist (application form, rate card, direct debit mandate, commercial agreement, letter of authority or supplier contract).
2. **Place the fields.** Fillable PDFs (such as the Bord Gáis electricity form) bring their own boxes, including rows of single-character boxes for the MPRN. On flat PDFs (most rate cards and CAFs), choose *Text*, *Tick box*, *Signature* or *Date signed* and click where the box starts; drag to move, drag the corner to resize, or use the arrow keys.
3. **Link each box** to CRM data under *Fill from* (customer, contact, billing and supply address, MPRN/GPRN, contract and rates, bank details, broker), or leave it to be typed. Set *Character boxes* for MPRN/GPRN rows on flat PDFs. Signature and date-signed boxes belong to the client or the broker.
4. **Save.** Changing the boxes creates a new template version; forms already filled keep the version they used. Untick *In use* to retire a template.

**Forms that come set up.** Five supplier forms are recognised when you upload them, and arrive with every box placed and linked: the Flogas gas Small & Medium Agreement (TC003), the Flogas Commercial Electricity Agreement with its direct debit mandate, the Bord Gáis electricity and gas Customer Agreement Forms, and the Energia Customer Registration Form (Supply Contract May22). Recognition is by the exact file (its SHA-256), so a supplier's new edition is treated as a new form; open the old template beside it to copy the boxes. To load them all at once on a new installation, put the PDFs in a folder on the server and run `npm run forms:presets -w @uo/api -- <folder>` (already-loaded forms are skipped). The PDFs aren't kept in the repository: they belong to the suppliers.

Before the first form is generated, set the **broker company name** (Administration → Integrations → Supplier forms) and **our agency ID** with each supplier (Administration → Suppliers); both print on the forms.

**Box options in the editor**: *Tick when the value is* ticks a box only for one value (for example *Term: 24* for the 24-month box, *Legal entity: sole_trader*, or *Marketing by email: false* for a "do not contact me by email" box). *Only fill when* writes a value only when another one matches (Bord Gáis's rate grid writes the rates in the row for the contract's price type). *Cover what's underneath* draws a white box first, for scanned forms that already show writing. *Block capitals* upper-cases the value.

**What the back office fills in** for these forms, besides the existing deal details: on the customer, the legal entity, date established, number of employees, VAT and carbon-tax exemptions, charity number, priority (life-support) customer, marketing preferences, paperless billing, and a home address for sole traders and partnerships; each contact's title; on the supply site, when the customer moved in (giving years and months at the premises) and the lease terms; on each meter, MIC, DG code, voltage, profile class and a second meter serial (electricity) or the supply point capacity and annual quantity (gas, which also decides the Flogas small/medium sector at 73,000 kWh); readings by register (24 hour, day, night, night storage, wattless, gas); and on the contract, the price type (fixed, variable or fully fixed) and any night storage, summer and winter day rates.

On a deal, the **Forms** tab fills the supplier's form from the CRM. Anything typed or changed is recorded against the form, and an IBAN that differs from the one on file must be confirmed. The generated PDF has no fillable fields left (so nothing can drop out when it's opened in Adobe), and the CRM reopens it to check every value and signature is present; a failed check blocks signing and submission.

**Signatures** are uploaded as a photo or scan; the browser removes the paper background. The uploader records who signed, in what capacity and how they authorised it *for that form*, and the signed copy then needs **review by someone else** with document review rights. An approved form counts as the customer's signature for submission. Stored signatures are never reused automatically.

**Online signing.** Instead of uploading, choose **Send for signature** next to a signature box. The signer is emailed a private link (`/sign/…`): they read the filled form, type their name, tick the consent, draw their signature with a finger, pen or mouse, and sign. They don't need a CRM account. When every box is signed, the CRM builds the signed copy and adds an *Electronic signature record* page with each signer's name, email, time (Europe/Dublin), IP address, browser, a SHA-256 fingerprint of the exact PDF they saw and the consent they agreed to. The form then goes to review as usual, and neither whoever uploaded a signature nor whoever sent a link can approve it. Links work once, expire after 14 days and are stored only as a hash. Sending a new link for the same box, **Send again** (which issues a new URL) or **Cancel link** stops the old one. Links are emailed through the connected mailbox named in `SYSTEM_MAILBOX` (if set) or SMTP (`SMTP_URL`, `MAIL_FROM`). Without either, the CRM shows the link once so it can be copied and sent by WhatsApp or from your own mailbox.

**Cases (Forms tab and Cases in the menu)**: every energy deal is a case following its workflow brief: change of legal entity, change of supplier, renewal with the existing supplier, or a new supply. Its status (e.g. *Awaiting incoming details*, *Awaiting tenancy evidence*, *Sent*, *Accepted*, *Entity change confirmed*, *Completed*) is worked out from the evidence recorded, so a step can't be skipped. Sending is recorded separately from acceptance: **Record submission** keeps the recipient, channel, date, exact file versions and proof of delivery; **Record response** keeps acceptance (with the external reference), changes required or rejection (with a reason, a correction owner and due date, which become a task) and, for a change of entity, the confirmed effective date. Activation needs the acceptance (and for a change of entity the confirmed date). Submissions, responses, lease checks, terms checks and supply-point occupancy can't be changed or deleted.

**Change of entity**: match the supply point from our records (search by MPRN/GPRN, address, Eircode or customer; several matches are flagged) or add one new to us and record where its details came from. The deal's customer is the incoming customer and must be a separate record; the outgoing account holder's name, IBAN and consent never fill the incoming fields (forms have separate *Previous occupier* fields). A shared IBAN blocks documents. The lease is checked per version: a draft (including one generated here) never passes; a signed copy must match and be signed by both parties before submission. On activation the incoming customer is linked to the supply point from the confirmed date, and the outgoing customer's occupancy is kept.

**Renewal**: renewals created from a previous contract keep the supplier and supply site, and forms show each value next to last time's, with every change listed on the form and timeline. Operations verifies the renewal terms before documents can be generated; changing a rate, term, start date or supplier afterwards needs a new verification. For a customer new to us, the case checklist stands in for a bill when there isn't one.

**Change of supplier**: when a deal is marked *Change of supplier*, the Forms tab shows the previous supplier's bill (uploaded as the “Recent energy bill”) and a **Check bill** step: readable, customer name, MPRN/GPRN and supplier must all match. Submission is blocked until the latest bill passes; a newer upload needs a new check. Other open deals for the same MPRN/GPRN are flagged.

## Integrations

All credentials are environment variables on the API/worker (or your secrets manager). They're never sent to the browser or written to logs. **Administration → Integrations** shows what's configured and the outbound job queue.

| Feature | Variables | Notes |
|---|---|---|
| Email | `SMTP_URL`, `MAIL_FROM` | e.g. `smtps://user:pass@smtp.office365.com:465`. Enables **Send email** and submission packs. |
| Email through a connected mailbox | `SYSTEM_MAILBOX`, `SYSTEM_MAIL_FROM` | The address of a mailbox someone connected on their Account page (Gmail or Outlook), e.g. `aamir@utilityoptimizer.com`. Signing links, confirmations and submission packs are sent through it instead of SMTP; SMTP is the fallback while it isn't connected. `SYSTEM_MAIL_FROM`, e.g. `Utility Optimizer <sales@utilityoptimizer.com>`, sends from a shared address: in Gmail it must be one of that account's **Send mail as** addresses, or Gmail uses the account's own address. |
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
- Workflow reminder intervals are under **Administration → Suppliers & pipeline → Workflow reminders** (see above).
- Thresholds (first contact 24 h, unanswered message 4 h, document chase 3 days, signature reminder 3 days, supplier follow-up 5 days, Worldpay follow-up 2 days, document expiry 30 days, renewal window 120–90 days) are in `apps/api/src/automations/automations.service.ts` and `renewals.service.ts`.
