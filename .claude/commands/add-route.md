---
description: Add an API route the way this repo does it (capability, Zod validation, row-level access, audit in the transaction, pentest coverage, OpenAPI).
argument-hint: <method and path, and what it does>
---

# /add-route

Route: $ARGUMENTS

## Steps

1. **Request schema**: put the body schema in `packages/shared/src` (named export, reused by the web form) and `npm run build -w @uo/shared`. Small query schemas can stay in the controller (see `listQuery` in `apps/api/src/activities/activities.controller.ts`).
2. **Capability**: use an existing key from `CAPABILITIES` in `packages/shared/src/permissions.ts`. Only add a new one if no existing key fits; then rebuild shared and run `node scripts/gen-security-matrix.js`.
3. **Controller** (`apps/api/src/<feature>/<feature>.controller.ts`):
   - `@RequireCapability("...")` from `../common/decorators` when the whole route needs one; finer checks (`can(actor, ...)` from `@uo/shared`) go in the service and throw `Forbidden` with a sentence.
   - Ids through `new ParseUUIDPipe({ version: "4" })`; bodies and queries through `new ZodPipe(schema)`; the user from `@CurrentUser() a: Actor`.
   - `@Public()` only for sign-in, health and HMAC/shared-secret endpoints. A public route must be added to `PUBLIC` in `apps/api/test/integration/pentest.test.ts` with a comment saying what protects it. `@SkipCsrf()` only for HMAC-signed webhooks.
4. **Service**:
   - Anything under an opportunity: `await this.access.readable(actor, id)` (404 for other people's deals) or `writable` (403) first. Lists filter with `visibleWhere`; customers with `customerWhere` / `linkableCustomer`.
   - Business rules: `throw new RuleViolation([...sentences])` (422); otherwise `NotFound` / `Forbidden` / `Conflict` from `../common/errors`. No `try/catch` that rethrows `new Error`.
   - Mutations run in `this.prisma.$transaction(async (tx) => ...)` and call `AuditService.record/log/timeline` with that `tx`. No restricted values (DOB, nationality, address, IBAN, compliance notes) in timeline bodies or audit `data`.
   - Live updates: `RealtimeService.publish(userIds, event)` with ids and short previews only.
   - Never change an opportunity's stage, outcome, owner or active flag as a side effect; never delete history.
5. **Register** the controller and service in the feature's module (`apps/api/src/modules.ts` or `<feature>.module.ts`). Constructor-injected classes are value imports, not `import type`.
6. **Web**: call it through `apps/web/src/lib/api.ts` with TanStack Query; hide the button with `useCan()` from `@/lib/session` (a UI hint only).
7. **Tests** in `apps/api/test/integration/<feature>.test.ts`, using `createTestApp`, `userAndClient` and `expectStatus` from `../support/app` and fixtures from `../support/fixtures`:
   - the happy path, and the audit or timeline row it writes;
   - a role without the capability gets 403;
   - for opportunity data, a second salesperson using the first one's ids gets 404 on read and 403 on write;
   - each `RuleViolation` sentence.
   `pentest.test.ts` attacks the new route automatically (anonymous, no CSRF, injection payloads, secret patterns).
8. **Docs**: `npm run openapi -w @uo/api` (rewrites `docs/openapi.json`, no database needed).
9. **Verify**: `npm run lint`, `npm run typecheck`, then `cd apps/api && npx jest --runInBand test/integration/<feature>.test.ts test/integration/pentest.test.ts`.
