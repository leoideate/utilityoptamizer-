---
name: utilityoptamizer-conventions
description: Code and commit conventions for the Utility Optimizer CRM monorepo (file naming, imports, errors, tests, commit messages). Use when writing or reviewing code or commits in this repo.
---

# Utility Optimizer CRM conventions

`CLAUDE.md` holds the architecture and product rules; this skill only covers the house style it doesn't spell out.

## Commits

- One imperative sentence in plain English, about 50–80 characters, describing the outcome: "Add change-of-entity and existing-supplier renewal workflows", "Give sales and the back office their own interfaces".
- No conventional-commit prefixes (`feat:`, `fix:`), no ticket ids.

## Files and modules

- File names are kebab-case: `template-editor.tsx`, `auto-label.ts`. API files add a NestJS role suffix: `activities.service.ts`, `activities.controller.ts`, `auth.module.ts`.
- The API is organised by feature module (`apps/api/src/<feature>/`), not by type. Shared domain code lives in `packages/shared/src`.
- Named exports everywhere, except Next.js page files, which export only the default page component.

## Imports

- Web: the `@/` alias for anything under `apps/web/src` (`@/lib/api`, `@/components/...`); shared code from `@uo/shared`.
- API: relative imports within `src`; `@uo/shared` for domain code. Constructor-injected classes are value imports, never `import type`.

## Errors

- Don't wrap things in `try/catch` and rethrow `new Error(...)`. Throw `RuleViolation(issues[])` for business rules (user-facing sentences, 422) or `Forbidden`/`NotFound`/`Conflict`; `HttpErrorFilter` maps them.
- Vendor adapters that aren't configured throw `NotConfigured`; never return fake success.

## Tests

- Jest with globals (no `import ... from 'jest'`); files are `*.test.ts`.
- `packages/shared`: unit tests for rules. `apps/api`: unit tests plus integration tests in `test/integration/` that boot the real `AppModule` against `TEST_DATABASE_URL`, run with `--runInBand`. `apps/web/e2e`: Playwright + axe specs (`*.spec.ts`).
- New routes are attacked automatically by `pentest.test.ts`; add a regression to `hardening.test.ts` for security fixes.
