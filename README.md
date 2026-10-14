# Utility Optimizer CRM

A CRM for Utility Optimizer Limited covering electricity, gas, dual-fuel and Worldpay merchant-services sales, from first call through documents, signatures, approval, submission and activation, to automatic renewals.

- **Customers and opportunities are separate, permanent records.** Linking a customer never hides a deal; won deals stay under **Live / Won** with their salesperson.
- **The pipeline checks itself.** The 18 stages enforce what each step needs (MPRN/GPRN, documents, signature, approval, Worldpay principals and risk) and tell users exactly what's missing, while keeping lead capture to two fields.
- **Restricted data is encrypted and logged.** Dates of birth, address history, bank details, compliance notes and identity documents are visible only to the right roles, and every view is audited.
- **Automations do the chasing**: lead assignment, first contact, missing information and documents, signatures, supplier and Worldpay follow-ups, activation checks, document expiry, and renewals 120 days before contracts end.

## Stack

| | |
|---|---|
| Web | Next.js 15, React 19, TypeScript, Tailwind CSS 4, Radix primitives, TanStack Query, React Hook Form + Zod |
| API | NestJS 11, REST + OpenAPI, Prisma 6, PostgreSQL 16, BullMQ 5 + Redis 7, S3-compatible storage |
| Shared | `packages/shared`: pipeline, permission matrix, validation rules and request schemas used by both apps |
| Tests | Jest (unit + integration against PostgreSQL), Playwright + axe (end-to-end and accessibility) |

## Quick start (local)

Requirements: Node 22+, Docker Desktop.

```bash
docker compose up -d
cp apps/api/.env.example apps/api/.env
```

In `apps/api/.env`, set `FIELD_ENCRYPTION_KEY` (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) and `APP_SECRET` (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Then:

```bash
npm install
npm run build -w @uo/shared
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:web
```

Open http://localhost:3000 and sign in as `manager@demo.utilityoptimizer.ie` (or `admin@`, `sarah@`, `sean@`, `ops@`, `compliance@`, `finance@`) with password `ChangeMe-Demo-2026!`. API docs: http://localhost:4000/api/docs. Caught email: http://localhost:8025.

## Commands

| Command | What it does |
|---|---|
| `npm run lint` | ESLint across the repo |
| `npm run typecheck` | Builds `@uo/shared`, then type-checks API and web |
| `npm test` | Shared unit tests + API unit and integration tests (needs `docker compose up`) |
| `npm run test:unit` | Tests that need no services |
| `npm run test:e2e` | Playwright end-to-end + axe (needs API and web running and the dev seed) |
| `npm run build` | Production builds of all three packages |
| `npm run openapi -w @uo/api` | Regenerates `docs/openapi.json` |
| `npm run worker -w @uo/api` | Background worker (queues and schedules), after `npm run build -w @uo/api`. In development `RUN_WORKERS_IN_API=true` runs them inside the API instead. |

## Documentation

- [Architecture](docs/architecture.md), with system and data-model diagrams
- [Field dictionary](docs/field-dictionary.md)
- [Security matrix](docs/security-matrix.md)
- [API](docs/api.md) and [OpenAPI](docs/openapi.json)
- [User guide](docs/user-guide.md)
- [Administrator guide](docs/administrator-guide.md)
- [Deployment, backup and recovery](docs/deployment.md)
- [Test report](docs/test-report.md)
- [Known limitations](docs/known-limitations.md)

## Repository layout

```
apps/api        NestJS API and background worker (Prisma schema and migrations in apps/api/prisma)
apps/web        Next.js web app (Playwright tests in apps/web/e2e)
packages/shared Domain rules shared by both apps
docs/           Documentation
infra/          Local service configuration used by docker-compose.yml
scripts/        Doc generators (security matrix, field dictionary)
```
