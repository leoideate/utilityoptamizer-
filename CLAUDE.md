# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Utility Optimizer CRM: a standalone CRM (not Odoo) for an Irish energy and Worldpay broker. It's an npm-workspaces monorepo:

- `packages/shared` (`@uo/shared`): pure domain code shared by both apps. It holds the enums, the 18-stage pipeline (`stages.ts`), the permission matrix (`permissions.ts`), stage-gate rules (`rules.ts`), MPRN/GPRN checks and Zod request schemas. It compiles to CommonJS in `dist/`; **rebuild it (`npm run build -w @uo/shared`) after any change**, because the API and web consume the build (Jest maps to `src` directly).
- `apps/api` (`@uo/api`): NestJS 11 + Prisma 6 + PostgreSQL + BullMQ/Redis + S3. The same code runs as the HTTP API (`dist/main.js`) and the background worker (`dist/worker.js`).
- `apps/web` (`@uo/web`): Next.js 15 App Router client. It calls only `/api/*`, which `next.config.ts` rewrites to the API (`API_ORIGIN`, default `http://127.0.0.1:4000`; fixed at build time).

## Commands

```bash
docker compose up -d                       # Postgres on 127.0.0.1:5433 (not 5432), Redis 6379, SeaweedFS S3 8333, Mailpit 8025
npm run build -w @uo/shared                # required before running/type-checking the apps
npm run db:migrate && npm run db:seed      # prisma migrate deploy + idempotent seed (demo users unless NODE_ENV=production)
npm run dev:api                            # nest start --watch on :4000 (Swagger at /api/docs)
npm run dev:web                            # next dev on :3000
npm run lint                               # eslint (flat config at root)
npm run typecheck
npm test                                   # shared + API unit + API integration (integration needs docker compose)
npm run test:e2e                           # Playwright + axe; needs API + web running and the dev seed loaded
```

Single tests:

```bash
cd packages/shared && npx jest -t "stage gates"
cd apps/api && npx jest --selectProjects unit -t "TOTP"
cd apps/api && npx jest --runInBand test/integration/opportunities.test.ts -t "activation"
cd apps/web && npx playwright test -g "duplicate customers"
```

API integration tests boot the real `AppModule` against `TEST_DATABASE_URL` (the `uo_crm_test` database is created by `infra/postgres/init`). They truncate all tables per file, use local-disk storage and a `RecordingJobQueue` instead of Redis, and run with `--runInBand`. Set `TEST_LOG_ERRORS=1` to see server errors behind a 500. Config comes from `apps/api/.env` (Node's built-in `.env` loading, no dotenv); blank values count as unset.

Schema changes: edit `apps/api/prisma/schema.prisma` and add a migration folder under `prisma/migrations/` (`npx prisma migrate dev` needs a running DB; `prisma migrate diff --from-... --script` works offline). Constraints Prisma can't express live in `20261014000100_integrity/migration.sql`. Then regenerate the docs with `node scripts/gen-field-dictionary.js` (and `node scripts/gen-security-matrix.js` after permission changes).

## Architecture rules that span files

- **Permissions are enforced in the API, from one table.** `CAPABILITIES` in `packages/shared/src/permissions.ts` is the matrix. Route-level checks use `@RequireCapability`; row-level opportunity access goes through `OpportunityAccess` (`apps/api/src/opportunities/access.service.ts`: `readable` returns 404 for other people's deals, `writable` 403; `visibleWhere` for lists). Every service touching an opportunity's children (energy, merchant, documents, signatures, activities) calls `access.readable/writable` first. The web app only uses capabilities (from `/auth/me`) to hide buttons.
- **Global guard order** (`app.module.ts`): Throttler → `SessionGuard` (cookie `uo_session`, `@Public()` to skip) → `CsrfGuard` (Origin check plus `X-CSRF-Token` header vs. the session's token; `@SkipCsrf()` only for HMAC-signed webhooks) → `CapabilityGuard`. The web client (`apps/web/src/lib/api.ts`) reads `uo_csrf` and sends the header.
- **Stage gates**: `stageGateIssues(facts, target)` in `packages/shared/src/rules.ts` is the only place stage requirements are defined. They're cumulative and the early stages have none. The API builds facts with `loadGateFacts` (`opportunities/facts.ts`), which reduces restricted data to presence flags. Moving to `live_won` only happens via `OpportunitiesService.activate`; won deals can't change stage and can't be unassigned; "lost" is `outcome`, not a stage.
- **Never delete or overwrite history.** DB triggers make `audit_logs` and `timeline_entries` append-only and forbid deleting or deactivating `opportunities`. Live and ended `energy_contracts` and live `merchant_applications` are read-only in services. Renewals create new rows linked by `previous_*_id`. Uploads are new `document_versions`. Corrections to the timeline are new entries with `correctsId`.
- **Every mutation records itself**: `AuditService.record/log/timeline`, passed the transaction (`tx`) so it commits atomically. Never put restricted values (DOB, nationality, address, IBAN, compliance notes) in timeline bodies or audit `data`; `redact()` strips known keys as a backstop.
- **Sign-in paths share `AuthService.issueSession` / `checkTotp`.** Password login and SSO (`auth/sso.service.ts`: OIDC code + PKCE, flow state in an HMAC-signed `uo_sso` cookie, ID token verified with node:crypto against the provider JWKS) must both go through them. SSO never creates users. Tests use `test/support/mock-oidc.ts`.
- **Encryption**: restricted columns end in `Enc` and go through `CryptoService` (AES-256-GCM, `v1:<keyId>:…`, previous key accepted for rotation). Principals also store `hasDob`/`hasNationality` so rules don't decrypt. Reads unmask only with the capability, and call `audit.sensitiveAccess`.
- **Automations must be idempotent.** Use `ActivitiesService.ensureAutomated` with an `automationKey` (a partial unique index allows one *open* row per opportunity and key) and `completeAutomated` to close it. Renewals rely on the unique `renewal_source_key`; outbound integrations on `integration_jobs.idempotency_key`; webhooks on `(provider, event_id)`. Background handlers live in `automations/` and are wired to BullMQ in `jobs/workers.ts`; enqueue through the `JOB_QUEUE` abstraction, never `bullmq` directly.
- **Vendor integrations are adapters chosen by env** (`modules.ts`): `ObjectStorage` (S3/local with signed links), `VirusScanner`, `OcrProvider`, `SignatureProvider`, email/WhatsApp senders, `SubmissionChannel`. Unconfigured adapters fail with `NotConfigured` (the job is dead-lettered), never with fake success.
- **Errors**: throw `RuleViolation(issues[])` for business rules (422, `issues` are user-facing sentences), plus `Forbidden`/`NotFound`/`Conflict`; `HttpErrorFilter` maps them. Bodies and queries are validated with `new ZodPipe(sharedSchema)`. Prisma Decimals are turned into numbers by a global interceptor in `bootstrap.ts`.
- **Dates**: calendar dates are `YYYY-MM-DD` strings in shared/web, and `@db.Date` (UTC midnight) in Prisma; convert with `dateOnly`/`isoDay` (`common/values.ts`). Business "today" is Europe/Dublin (`today()` in shared).
- **NestJS DI needs value imports**: ESLint's `consistent-type-imports` is off for `apps/api` because constructor-injected classes must not be `import type`.
- **Next.js page files** may only export the page component; put shared constants in `src/lib` or `src/components`.

## Product rules to preserve

Opportunities are permanent; creating or linking a customer must not change an opportunity's stage, outcome, owner or active flag. Duplicate customers are flagged (email, phone, CRO, VAT, name and postcode) and never merged automatically (merge is `customer.merge`, managers only). Irish formats: MPRN is 11 digits starting "10", GPRN is 7 digits; exceptions need `formatExceptionReason`. Phone matching normalises +353/+44 and the trunk 0 (`phoneKey`).
