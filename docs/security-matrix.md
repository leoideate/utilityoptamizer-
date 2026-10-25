# Security matrix

Generated from `packages/shared/src/permissions.ts`, the single source of truth (`node scripts/gen-security-matrix.js`). The API enforces every row on every request (guards plus row-level checks in services). The web app uses the same table only to hide buttons.

| Capability | What it allows | Administrator | Manager | Salesperson | Operations | Compliance | Finance |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `opportunity.read_all` | See every opportunity (All Opportunities). Salespeople see their own and unassigned leads. | ✓ | ✓ |  | ✓ | ✓ | ✓ |
| `opportunity.create` | Create opportunities | ✓ | ✓ | ✓ | ✓ |  |  |
| `opportunity.write_all` | Edit any opportunity (salespeople edit their own and unassigned) | ✓ | ✓ |  | ✓ |  |  |
| `opportunity.assign` | Assign / reassign salespeople | ✓ | ✓ |  |  |  |  |
| `opportunity.approve` | Grant or refuse internal approval | ✓ | ✓ |  |  |  |  |
| `opportunity.reopen_completed` | Reopen a Live / Won opportunity | ✓ | ✓ |  |  |  |  |
| `opportunity.submit` | Move to Submitted and later stages; send submission packs; record Worldpay approval | ✓ | ✓ |  | ✓ |  |  |
| `opportunity.activate` | Record activation (moves to Live / Won) | ✓ | ✓ |  | ✓ |  |  |
| `opportunity.close_batch` |  | ✓ | ✓ |  |  |  |  |
| `opportunity.purge` |  | ✓ |  |  |  |  |  |
| `customer.read` | View customers | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `customer.write` | Create and edit customers and contacts | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `customer.merge` | Merge duplicate customers | ✓ | ✓ |  |  |  |  |
| `principal.read_sensitive` | View principal date of birth, nationality and address history (every view is logged) | ✓ |  |  |  | ✓ |  |
| `principal.write` | Enter or replace principal details | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `risk.read` | View Worldpay underwriting answers (the owning salesperson can too) | ✓ | ✓ |  | ✓ | ✓ |  |
| `risk.review` | Record the compliance decision; read/write restricted compliance notes | ✓ |  |  |  | ✓ |  |
| `bank.read` | Reveal full bank details (every view is logged) | ✓ |  |  |  | ✓ | ✓ |
| `bank.write` | Add bank details | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `document.read_sensitive` | Open identity documents, bank statements and other restricted files (every view is logged) | ✓ |  |  |  | ✓ | ✓ |
| `document.review` | Approve or reject documents | ✓ | ✓ |  | ✓ | ✓ |  |
| `form.template_manage` |  | ✓ | ✓ |  | ✓ |  |  |
| `document.request` | Request documents from the customer | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `commission.read` | View commission figures and export the commissions CSV | ✓ | ✓ |  |  |  | ✓ |
| `commission.write` | Record and update commissions | ✓ |  |  |  |  | ✓ |
| `report.read` | Business-wide dashboard (others see their own figures) | ✓ | ✓ |  | ✓ | ✓ | ✓ |
| `chat.manage_channels` | Create, archive and add people to team channels (anyone can DM and join public channels) | ✓ | ✓ |  |  |  |  |
| `chat.moderate` | Remove other people's chat messages and view edit/delete history (audit-logged) | ✓ |  |  |  |  |  |
| `admin.users` | Manage users, roles, passwords and 2FA resets | ✓ |  |  |  |  |  |
| `admin.pipeline` | Rename pipeline stages, run the stage check, manage suppliers | ✓ |  |  |  |  |  |
| `admin.integrations` | Integration settings, outbound job queue and retries, signature templates | ✓ |  |  |  |  |  |
| `admin.audit` | Read the audit log | ✓ |  |  |  |  |  |
| `admin.retention` | Configure and run data retention | ✓ |  |  |  |  |  |

## Row-level rules

- **Opportunities**: salespeople read and edit the opportunities they own plus unassigned leads (so they can claim them). Anything else returns *404 Not found*, so other people's deals aren't revealed. Roles with `opportunity.read_all` see everything.
- **Won deals** keep their salesperson: unassigning a won opportunity is refused.
- **Activities** can only be edited by their owner, or by roles with `opportunity.write_all`.
- **Customers**: roles with `opportunity.read_all` see every customer. Salespeople see customers they created or that are on an opportunity they can see; others return *404*. Duplicate checks still warn about any matching customer, but show salespeople only its name, and only customers they can see can be linked to a deal (a manager links the rest).
- **Business-card scans** are visible to the uploader and to roles that read all opportunities.

## Restricted data

| Data | How it's stored | Who can read it |
|---|---|---|
| Principal date of birth, nationality | AES-256-GCM encrypted columns; presence flags in clear for validation | `principal.read_sensitive` |
| Principal residential address history | Encrypted JSON per address; dates in clear for the 3-year check | `principal.read_sensitive` |
| Restricted compliance notes | Encrypted; never copied to the timeline | `risk.review` |
| Bank details (account name, IBAN, BIC) | Encrypted; last four IBAN digits in clear | `bank.read` |
| Identity / bank documents | Private bucket, server-side encryption, short-lived signed links | `document.read_sensitive` |
| Worldpay underwriting answers | Plain columns | `risk.read` or the owning salesperson |
| MFA secrets | Encrypted | nobody (server only) |
| Passwords | scrypt hash (N=32768) | nobody |
| Session tokens | SHA-256 hash only | nobody |

Every view of restricted data writes a `sensitive.read` audit entry. Request logs redact cookies, CSRF tokens, passwords and restricted fields (`apps/api/src/common/redact.ts`).

## Authentication controls

- Email and password, or Microsoft / Google single sign-on (OpenID Connect with PKCE; existing active users only, matched by verified email, optional domain allow-list). HTTP-only, SameSite=Lax session cookie (Secure in production); sessions expire after `SESSION_TTL_HOURS` and after `SESSION_IDLE_MINUTES` without activity.
- CSRF: double-submit token (`uo_csrf` cookie echoed in `X-CSRF-Token`) plus an Origin check on every state-changing request.
- Rate limits: `RATE_LIMIT_PER_MINUTE` (default 300) requests/minute per IP; login and password change 10/minute per IP; account locked for 15 minutes after 8 wrong passwords. Refusals (401/403/429) are logged with user, route and IP.
- Optional TOTP two-factor authentication per user (Account → Security); each code is accepted once; administrators can reset it.
- Changing your own password needs the current one and ends your other sessions. Changing a user's roles, deactivating them or resetting their password ends all their sessions.
- Security headers: the API sends `default-src 'none'` CSP, `nosniff` and frame denial (helmet); the web app sends a Content-Security-Policy, HSTS in production, `X-Frame-Options: DENY` and a strict referrer policy. Interactive API docs are off in production unless `ENABLE_API_DOCS=true`.
