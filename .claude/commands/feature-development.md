---
description: Build a feature across shared, API and web the way this repo does it (shared rules first, API enforcement, audit, tests, responsive UI).
argument-hint: <feature to build>
---

# /feature-development

Feature: $ARGUMENTS

Read `CLAUDE.md` first; its architecture rules apply to every step.

## Steps

1. **Shared domain (`packages/shared/src`)**: enums, Zod request schemas, stage gates (`rules.ts` / `stageGateIssues` is the only place stage requirements live), workflow steps (`workflows.ts`) and capabilities (`permissions.ts` `CAPABILITIES`). Then `npm run build -w @uo/shared`; the API and web use the build.
2. **Schema**: if the feature needs tables or columns, follow `/database-migration`.
3. **API (`apps/api/src/<module>/`)**: controller + service in a NestJS module.
   - Routes: `@RequireCapability(...)`, bodies and queries validated with `new ZodPipe(sharedSchema)`. Public routes need `@Public()` and an entry in `PUBLIC` in `test/integration/pentest.test.ts`.
   - Anything under an opportunity calls `OpportunityAccess.readable`/`writable` first; lists use `visibleWhere`, customers `customerWhere`/`linkableCustomer`.
   - Business rule failures throw `RuleViolation(issues[])` with user-facing sentences; otherwise `Forbidden`/`NotFound`/`Conflict`.
   - Each mutation records itself with `AuditService.record/log/timeline` inside the same transaction, and pushes live updates through `RealtimeService.publish` with ids and short previews only.
   - Background work goes through the `JOB_QUEUE` abstraction with an idempotency key (`ActivitiesService.ensureAutomated` for tasks); vendor calls go through the adapters in `modules.ts`, which fail with `NotConfigured` rather than faking success.
   - Constructor-injected classes are value imports, not `import type`.
4. **Web (`apps/web/src`)**: call only `/api/*` through `lib/api.ts`, use TanStack Query, and hide buttons with capabilities from `/auth/me` (the API still enforces them). Page files export only the page component.
   - Responsive rules: no page-level horizontal scroll; tables sit in `overflow-x-auto` with `tabIndex={0}`; phone lists become cards below `md`; `min-w-0` on grid/flex children with tables; text ≥ 12px; touch targets ≥ 24px; hover-only controls stay visible without hover.
5. **Tests**:
   - Shared rules: unit tests in `packages/shared` (`npx jest -t "..."`).
   - API: integration tests in `apps/api/test/integration/` against the real `AppModule`, including a second salesperson trying the first one's ids (404 on read, 403 on write).
   - UI flows: Playwright specs in `apps/web/e2e/`; check `responsive.spec.ts` still passes.
6. **Docs**: `node scripts/gen-security-matrix.js` after permission changes, `node scripts/gen-field-dictionary.js` after schema changes, and `npm run openapi -w @uo/api` if routes changed.
7. **Verify**: `npm run lint`, `npm run typecheck`, `npm test`, and `npm run test:e2e` with the API and web running on the dev seed.

Don't change an opportunity's stage, outcome, owner or active flag as a side effect, and never merge duplicate customers automatically.
