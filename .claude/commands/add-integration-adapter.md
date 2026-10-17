---
description: Add a vendor integration behind an adapter chosen by env (interface + token, real and disabled implementations, NotConfigured, idempotent jobs, test mock).
argument-hint: <vendor and what it does>
---

# /add-integration-adapter

Integration: $ARGUMENTS

Follow the existing adapters: `EmailSender` / `WhatsAppSender` / `SubmissionChannel` in `apps/api/src/integrations/adapters.ts`, `OcrProvider` in `apps/api/src/ocr/providers.ts`, `TelephonyProvider` in `apps/api/src/calls/`.

## Steps

1. **Interface and token**: `export interface <Thing>` and `export const <THING> = Symbol("<THING>")`, next to the feature that uses it.
2. **Implementations**:
   - the real one, taking its settings in the constructor;
   - a disabled or manual one whose methods `throw new NotConfigured("<What>")` (from `integrations/adapters.ts`). Never return fake success: an unconfigured adapter must fail so the job is dead-lettered and an admin sees it.
3. **Env** in `apps/api/src/config/env.ts`: a `<VENDOR>_PROVIDER` enum whose default is the disabled option, plus its settings, and a `superRefine` issue when the provider is selected but a required setting is blank (see `OCR_PROVIDER`, `WHATSAPP_PROVIDER`). Add every key, commented, to `apps/api/.env.example`. Secrets are never logged or returned by the API.
4. **Wiring** in `apps/api/src/modules.ts`: `{ provide: <THING>, inject: [ENV], useFactory: (env: Env) => (env.<VENDOR>_PROVIDER === "<real>" ? new Real(...) : new Disabled()) }`.
5. **Calls go through jobs**, never inline in a request:
   - outbound sends: add an `IntegrationKind` and a case in `IntegrationsService.run`, and enqueue with `IntegrationsService.enqueue(actor, kind, payload, "<kind>:<stable key>", opportunityId)`; `integration_jobs.idempotency_key` makes retries safe;
   - other background work: `JOB_QUEUE` (`apps/api/src/jobs/queue.ts`) with a stable `jobId` (`:` becomes `-` for BullMQ), and a handler in `apps/api/src/automations/` wired in `apps/api/src/jobs/workers.ts`. Never import `bullmq` elsewhere.
   - Incoming webhooks: `@Public()` + `@SkipCsrf()`, verify an HMAC over the raw body, dedupe on `(provider, event_id)`, and add the route to `PUBLIC` in `pentest.test.ts`.
6. **Payloads**: no restricted values in job payloads, audit `data` or timeline bodies unless the vendor needs them; then encrypt at rest and `redact()` covers the keys.
7. **Tests**: an in-process mock in `apps/api/test/support/` (like `mock-ringcentral.ts`, `mock-oidc.ts`); integration tests override the token and use `RecordingJobQueue` (`queue.jobs`) to assert what was enqueued. Cover: the success path, `NotConfigured` when disabled, retry with the same idempotency key creating no duplicate, and webhook signature rejection.
8. **Docs**: describe the setup in `docs/administrator-guide.md`; `npm run openapi -w @uo/api` if routes changed.
9. **Verify**: `npm run lint`, `npm run typecheck`, `npm test`.
