# API

- Interactive documentation: **`/api/docs`** on a running API (Swagger UI); JSON at `/api/docs-json`.
- Static copy: [`openapi.json`](openapi.json). Regenerate with `npm run openapi -w @uo/api` (no database needed).
- All routes are under `/api`. In the browser, the web app proxies `/api/*` to the API, so everything is same-origin.

## Authentication

```http
POST /api/auth/login
Origin: https://crm.utilityoptimizer.com
Content-Type: application/json

{"email":"…","password":"…","totp":"123456"}
```

The response sets two cookies: `uo_session` (HTTP-only, the session) and `uo_csrf` (readable), and returns `{ user, csrfToken }`. When two-factor authentication is on and no `totp` was sent, it returns `{ mfaRequired: true }` with status 200; send the request again with the code.

Every `POST`/`PUT`/`PATCH`/`DELETE` must send:

- the `uo_session` cookie,
- `X-CSRF-Token: <csrfToken>`,
- an `Origin` header matching `WEB_ORIGIN` (browsers do this automatically).

**Single sign-on**: `GET /api/auth/providers` lists the configured providers. The browser navigates to `GET /api/auth/sso/{microsoft|google}/start?next=/path`, the provider returns to `…/callback`, and the API sets the same session cookies and redirects to `next`, or to `/login?error=<code>` on failure. Users with CRM two-factor are sent to `/login?mfa=sso`, and the page then calls `POST /api/auth/sso/mfa {"code":"123456"}`.

`GET /api/auth/me` returns the current user, roles and capabilities, so the UI can show only the actions the user may take.

## Errors

Every error has the same shape:

```json
{ "statusCode": 422, "message": "Please fix the following.", "issues": ["Enter an MPRN for every electricity meter.", "Internal approval must be granted before submission."] }
```

| Status | Meaning |
|---|---|
| 400 | Invalid input (Zod). `issues` lists `field: message`. |
| 401 | Not signed in |
| 403 | Signed in but not allowed (permissions, CSRF, origin) |
| 404 | Not found, or belongs to someone you can't see |
| 409 | Conflict (e.g. already merged) |
| 422 | A business rule isn't met (stage gates, history protection). `issues` are complete sentences for the user. |
| 429 | Rate limit |
| 500 | Unexpected; the message includes a reference to find in the logs |

## Conventions

- IDs are UUIDs; opportunities also have a human number shown as `UO-000123`.
- Calendar dates are `YYYY-MM-DD`; timestamps are ISO 8601 UTC. Money and rates are numbers: euro for money; energy rates in €/kWh (the UI shows cent).
- Lists take `page` and `pageSize` and return `{ items, total, page, pageSize }`.
- `GET /api/opportunities?view=…` saved views: `my_open`, `all`, `all_won`, `energy`, `worldpay`, `renewals_due`, `awaiting_customer`, `awaiting_supplier`, `awaiting_worldpay`, `compliance_queries`, `missing_documents`, `unsigned`, `unassigned`, `lost`. Combine with `q`, `serviceType`, `stage`, `ownerId`, `supplierId`.
- `GET /api/opportunities/{id}/gates/{stage}` previews what blocks a stage without trying to move.

## Main resources

| Area | Endpoints |
|---|---|
| Opportunities | `GET/POST /opportunities`, `GET/PATCH /opportunities/{id}`, `POST …/stage`, `…/assign`, `…/approval`, `…/lost`, `…/reopen`, `…/activate`, `…/customer`, `…/customer/create`, `GET/POST …/timeline`, `GET /opportunities/board`, `POST /opportunities/import` (CSV) |
| Customers | `GET/POST /customers` (`?confirmNew=true` to create despite duplicates), `POST /customers/duplicates`, `GET/PATCH /customers/{id}`, `POST …/contacts`, `POST …/merge`, `POST …/bank-accounts`, `GET /bank-accounts/{id}` (restricted, logged) |
| Energy | `GET /opportunities/{id}/energy`, `POST …/sites`, `PATCH /sites/{id}`, `POST /sites/{id}/meters`, `PATCH /meters/{id}`, `POST /meters/{id}/readings`, `POST …/contracts`, `PATCH /contracts/{id}`, `POST …/quotes`, `POST /quotes/{id}/select` |
| Worldpay | `GET /opportunities/{id}/merchant`, `POST …/merchant-applications`, `PATCH /merchant-applications/{id}`, `…/accept`, `…/approve`, `…/pricing`, `…/principals`, `PUT …/risk`, `POST …/compliance-review` |
| Documents | `GET/POST /opportunities/{id}/documents`, `…/standard`, `…/request`, `POST /documents/{id}/versions` (multipart `file`), `GET /document-versions/{id}/url`, `POST /documents/{id}/review` |
| Signatures | `GET/POST /opportunities/{id}/signatures`, `POST /signatures/{id}/remind`, `…/cancel`, `…/signers/{signerId}/signed`, `GET/POST /signature-templates` |
| Tasks & notifications | `GET/POST /activities`, `PATCH /activities/{id}`, `…/complete`, `…/cancel`, `GET /notifications`, `POST /notifications/read` |
| Business cards | `POST /business-cards` (multipart), `GET /business-cards/{id}`, `…/duplicates`, `…/confirm`, `…/discard`, `…/retry` |
| Messaging | `POST /opportunities/{id}/emails`, `…/whatsapp`, `…/submission-pack` (each takes an `idempotencyKey`) |
| Reports | `GET /reports/dashboard` (`from`, `to`, `ownerId`, `serviceType`, `supplierId`, `outcome`), `GET /reports/commissions.csv`, `GET /search?q=` |
| Admin | `/admin/users`, `/admin/suppliers`, `/admin/stages`, `/admin/settings/worldpay`, `/admin/retention`, `/admin/audit-log`, `/admin/integration-jobs` |
| Health | `GET /health` (public) |

## Inbound integrations

Both endpoints authenticate with an HMAC signature instead of a session:

```
x-uo-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
```

Requests more than 5 minutes old are rejected (replay protection).

**Website / API leads**: `POST /api/public/leads`, secret `LEAD_WEBHOOK_SECRET`:

```json
{ "externalId": "form-8841", "serviceType": "electricity", "companyName": "Quay Bakery", "contactName": "Ann Lee", "email": "ann@quay.ie", "phone": "+353 87 123 4567", "message": "Please call after 2pm", "source": "website" }
```

The same `externalId` is never imported twice. Leads arrive unassigned and are shared out by the lead-assignment job.

**E-signature events**: `POST /api/webhooks/signatures`, secret `SIGNATURE_WEBHOOK_SECRET`:

```json
{ "eventId": "evt_123", "providerRequestId": "env_abc", "type": "signer_signed | signer_declined | completed | declined | expired", "signerEmail": "ann@quay.ie", "signedDocumentBase64": "…" }
```

Each `eventId` is processed once; failures are kept as dead letters.

Example signer (Node):

```js
const t = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
headers["x-uo-signature"] = `t=${t},v1=${sig}`;
```
