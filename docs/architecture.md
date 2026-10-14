# Architecture

## System overview

```mermaid
flowchart LR
  browser["Browser<br/>(staff, desktop & mobile)"] -->|HTTPS| web["apps/web<br/>Next.js 15"]
  web -->|"/api/* rewrite<br/>(same origin, cookies)"| api["apps/api<br/>NestJS 11 REST + OpenAPI"]
  api --> pg[("PostgreSQL 16<br/>Prisma")]
  api --> redis[("Redis<br/>BullMQ queues")]
  api --> s3[("S3-compatible<br/>private bucket")]
  worker["apps/api worker<br/>(same image, dist/worker.js)"] --> pg
  worker --> redis
  worker --> s3
  worker -->|SMTP| mail["Email"]
  worker -->|Graph API| wa["WhatsApp Cloud API"]
  api --> ocr["OCR provider<br/>(HTTP adapter)"]
  esign["E-signature provider"] -->|"HMAC-signed webhook"| api
  shared["packages/shared<br/>enums · pipeline · permissions · rules · Zod schemas"] -.-> web
  shared -.-> api
```

| Part | Responsibility |
|---|---|
| `packages/shared` | The domain's single source of truth: enumerations, the 18-stage pipeline, the permission matrix, stage-gate rules, MPRN/GPRN checks and request schemas. Pure TypeScript, no I/O, unit-tested. Both apps import it, so a form and the server validate identically. |
| `apps/api` | NestJS REST API. Owns authentication, authorisation, persistence, encryption, audit, file storage, integrations and background jobs. Every permission is enforced here. |
| `apps/api` worker | Same code and image, started with `node dist/worker.js`: runs BullMQ workers and the cron-style schedules (automations, reminders, virus scans, outbound integrations, retention). |
| `apps/web` | Next.js (App Router) client UI. Talks only to `/api/*`, which Next proxies to the API, so the session cookie stays first-party. TanStack Query for server state, React Hook Form + Zod for forms, Tailwind + Radix primitives for accessible components. |

## Key design decisions

- **Customers and opportunities are separate, permanent records.** Linking or creating a customer changes only `opportunities.customer_id`. A database trigger rejects deleting an opportunity or setting `active = false`, so no code path (or SQL console slip) can hide a deal. "Lost" is an `outcome`, not a stage. Won deals stay in `Live / Won`, keep their salesperson, and can only be reopened by a manager.
- **Stage gates live in one pure function** (`stageGateIssues` in `packages/shared/src/rules.ts`). Gates are cumulative and the first seven stages have none, so leads can be captured with just a name and service. The API loads a `GateFacts` snapshot (restricted values reduced to presence flags) and refuses moves with a list of user-friendly reasons. The UI shows the same list as a checklist.
- **History is never overwritten.** Live and ended contracts and live Worldpay applications are read-only. Renewals create new draft records with `previous_contract_id` / `previous_application_id`. Documents keep every upload as a numbered version.
- **Append-only audit.** `audit_logs` and `timeline_entries` are protected by triggers that block `UPDATE`/`DELETE` (only the retention job may purge old audit rows, via a transaction-local flag). Corrections are new timeline entries pointing at the original.
- **Idempotent automations.** Reminders use an `automation_key` with a partial unique index (one *open* reminder per kind per opportunity). Renewals use a unique `renewal_source_key`. Outbound jobs use a unique `idempotency_key`; inbound webhooks a unique `(provider, event_id)`. Jobs can therefore be retried or run concurrently safely.
- **Adapters for every vendor.** OCR (`OcrProvider`), e-signature (`SignatureProvider`), object storage (`ObjectStorage`), virus scanning (`VirusScanner`), email, WhatsApp and submissions (`SubmissionChannel`) are interfaces with configuration-selected implementations, so no vendor is hard-wired.

## Request lifecycle

1. `ThrottlerGuard`: rate limit per IP.
2. `SessionGuard`: resolves the `uo_session` cookie (SHA-256 lookup) into `req.user`, or 401 unless the route is `@Public()`.
3. `CsrfGuard`: for state-changing methods, checks the Origin header and that `X-CSRF-Token` matches the session's token.
4. `CapabilityGuard`: `@RequireCapability(...)` against the shared matrix.
5. `ZodPipe`: validates the body/query with the shared schema.
6. Service: row-level checks (`OpportunityAccess`), business rules, then a transaction that writes the change plus its audit and timeline entries.
7. `HttpErrorFilter`: one error shape, `{ statusCode, message, issues? }`. 422 = business rule, 400 = invalid input, 403/404/409 as usual; unexpected errors return a reference id and are logged.

## Background jobs

| Queue | Job | Schedule | What it does |
|---|---|---|---|
| automations | `daily` | 07:00 Europe/Dublin | Missing-information and missing-document reminders, signature reminders, supplier/Worldpay follow-ups, activation-due checks, document expiry, renewal creation |
| automations | `leads` | every 15 min, 07:00–20:59 | New-lead assignment (least-loaded salesperson), first-contact and unanswered-message reminders |
| automations | `hourly` | :05 each hour | Activity reminders → notifications; expired session purge |
| automations | `retention` | Sundays 02:30 | Applies the retention policy |
| documents | `scan` | on upload | Virus scan; infected files are deleted and the item reset |
| integrations | `email.send`, `whatsapp.send`, `submission.send` | on demand | Exponential backoff (6 attempts from 30 s). After the last attempt the job is marked `dead` and administrators are notified. |

## Data model

```mermaid
erDiagram
  USER ||--o{ USER_ROLE : has
  USER ||--o{ SESSION : has
  SALES_TEAM ||--o{ USER : groups
  CUSTOMER ||--o{ CUSTOMER_CONTACT : has
  CUSTOMER ||--o{ CUSTOMER_ADDRESS : has
  CUSTOMER ||--o{ BANK_ACCOUNT : "has (encrypted)"
  CUSTOMER ||--o{ OPPORTUNITY : "buys through"
  CUSTOMER ||--o{ SUPPLY_SITE : owns
  USER ||--o{ OPPORTUNITY : "owns (salesperson)"
  STAGE ||--o{ OPPORTUNITY : "current stage"
  OPPORTUNITY ||--o{ STAGE_HISTORY : "visits"
  OPPORTUNITY |o--o{ OPPORTUNITY : "renewed by (previous_opportunity_id)"
  SUPPLIER ||--o{ OPPORTUNITY : "selected"
  OPPORTUNITY ||--o{ SUPPLY_SITE : "energy"
  SUPPLY_SITE ||--o{ METER_POINT : has
  METER_POINT ||--o{ METER_READING : has
  OPPORTUNITY ||--o{ ENERGY_CONTRACT : "energy"
  ENERGY_CONTRACT |o--o| ENERGY_CONTRACT : "renews (previous_contract_id)"
  SUPPLY_SITE ||--o{ ENERGY_CONTRACT : supplies
  OPPORTUNITY ||--o{ COMPARISON_QUOTE : "price comparison"
  OPPORTUNITY ||--o{ MERCHANT_APPLICATION : "Worldpay"
  MERCHANT_APPLICATION ||--o{ MERCHANT_PRICING : has
  MERCHANT_APPLICATION ||--o{ PRINCIPAL : "has (restricted)"
  PRINCIPAL ||--o{ PRINCIPAL_ADDRESS : "3-yr history (encrypted)"
  MERCHANT_APPLICATION ||--o| MERCHANT_RISK : "underwriting"
  OPPORTUNITY ||--o{ DOCUMENT_ITEM : checklist
  DOCUMENT_ITEM ||--o{ DOCUMENT_VERSION : "uploads (never overwritten)"
  OPPORTUNITY ||--o{ SIGNATURE_REQUEST : has
  SIGNATURE_REQUEST ||--o{ SIGNER : has
  SIGNATURE_TEMPLATE ||--o{ SIGNATURE_REQUEST : uses
  OPPORTUNITY ||--o{ ACTIVITY : tasks
  OPPORTUNITY ||--o{ TIMELINE_ENTRY : "timeline (append-only)"
  OPPORTUNITY ||--o{ COMMISSION : earns
  USER ||--o{ NOTIFICATION : receives
  AUDIT_LOG }o--|| USER : "actor (append-only)"
  BUSINESS_CARD_SCAN }o--o| OPPORTUNITY : "creates"
  INTEGRATION_JOB }o--o| OPPORTUNITY : "about"
```

Full column definitions: [field-dictionary.md](field-dictionary.md). Schema: `apps/api/prisma/schema.prisma`. Constraints Prisma can't express (append-only triggers, the opportunity-permanence trigger, the partial unique index and percentage checks) are in `apps/api/prisma/migrations/20261014000100_integrity/migration.sql`.

## Code map

```
packages/shared/src/      enums.ts · stages.ts · permissions.ts · rules.ts · identifiers.ts · dates.ts · schemas.ts
apps/api/src/
  auth/                   sessions, CSRF/session/capability guards, TOTP, scrypt
  common/                 Prisma, field encryption, errors + filter, redaction, value helpers
  config/                 Zod-validated environment
  opportunities/          access (row-level), stages (idempotent sync), gate facts, service + controller
  customers/ energy/ merchant/ documents/ signatures/ activities/ ocr/ integrations/ reports/ admin/
  automations/            renewals + scheduled automations
  jobs/                   queue abstraction, BullMQ workers and schedules
  storage/                S3 / local storage, signed links, virus scanning
apps/web/src/
  app/(app)/              authenticated pages (dashboard, pipeline, opportunities, customers, tasks, scan, admin, account)
  components/             shell, UI primitives, opportunity workspace tabs
  lib/                    API client (CSRF), session, formatting
```
