# CI troubleshooting

CI is one GitHub Actions workflow, [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). It runs on every pull request against `feature/utility-optimizer-crm` and on every push to it. A newer push to the same branch cancels the run in progress, so a "cancelled" job usually just means it was superseded.

## Jobs

| Job | What it runs | What it needs |
|---|---|---|
| **Lint, typecheck, unit tests** (`checks`) | `npm ci`, `prisma generate`, `npm run build -w @uo/shared`, `npm run lint`, `npm run typecheck`, `npm run test:unit` | Nothing external |
| **API integration tests** (`integration`) | The same setup, then `prisma migrate deploy` against the test database and `npm run test:integration -w @uo/api` (includes `pentest.test.ts` and `hardening.test.ts`) | A Postgres 16 service container on port 5433 with database `uo_crm_test` (`TEST_DATABASE_URL`). No Redis or S3: the tests use local-disk storage, `RecordingJobQueue` and `LocalRealtimeBus` (`apps/api/test/support/app.ts`). |
| **SBOM and dependency audit** (`security`) | `npm ci --ignore-scripts`, `npm sbom --sbom-format cyclonedx`, `npm audit --omit=dev` | Access to the npm registry |

The Playwright + axe end-to-end suite (`npm run test:e2e`) doesn't run in CI yet; run it locally as described in `CLAUDE.md`.

### Security evidence

The `security` job attaches two artifacts to every run (Actions run page → **Artifacts**):

- `sbom-cyclonedx`: `sbom.cdx.json`, a CycloneDX SBOM of the root package and all workspaces, including development dependencies.
- `npm-audit`: `npm-audit.json`, the full `npm audit --json` report for production dependencies (every severity).

The job **fails on a high or critical advisory in a production dependency**. Development-only advisories (today: `braces`, pulled in by Jest and ESLint) don't fail it; they are tracked in [the security assessment](security-assessment.md#residual-risks-and-recommendations) because they aren't in the production images.

## Reproduce a job locally

```bash
docker compose up -d
npm ci
npm run db:generate -w @uo/api
npm run build -w @uo/shared
npm run lint && npm run typecheck && npm run test:unit
npm run test:integration -w @uo/api
```

`docker compose` creates `uo_crm_test` on first start (`infra/postgres/init`) and `apps/api/.env` supplies `TEST_DATABASE_URL`. Apply migrations to the test database once, and again after pulling a new migration:

```bash
DATABASE_URL=postgresql://uo:uo_local_dev@127.0.0.1:5433/uo_crm_test npm run db:migrate -w @uo/api
```

## Common failures

### `@uo/shared` not rebuilt

**Symptoms:** typecheck or lint reports `Module '"@uo/shared"' has no exported member …`, a new stage, capability or schema is "missing", or the API fails to start with `Cannot find module '@uo/shared'`. Jest tests can pass at the same time because Jest maps `@uo/shared` to `src`, while the TypeScript build and the apps read `packages/shared/dist`.

**Fix:** `npm run build -w @uo/shared`. CI always builds it before lint, typecheck and tests, so if this happens in CI, check that a newly added step or job also runs the build, and that the shared change compiles (`npm run build -w @uo/shared` fails on type errors in `packages/shared/src`).

### Prisma client or migrations out of date

**Symptoms:**

- Typecheck errors such as `Property 'xyz' does not exist on type 'PrismaClient'` or a model field missing from a type: the client wasn't regenerated. Run `npm run db:generate -w @uo/api`.
- Integration tests fail with Prisma `P2021` (table does not exist) or `P2022` (column does not exist): `schema.prisma` changed without a migration, or the test database hasn't had the latest migration applied. Add the migration under `apps/api/prisma/migrations/` (see "Schema changes" in `CLAUDE.md`) and apply it.
- The **Apply migrations to the test database** step fails (`P3018`, `P3009`): the migration SQL itself is wrong. CI starts from an empty database every run, so the migration must apply cleanly from scratch; reproduce with a fresh test database (`docker compose down -v && docker compose up -d`, which also deletes your local data).

### Integration database unreachable

**Symptoms:** `Set TEST_DATABASE_URL (see apps/api/.env.example).`, `P1001: Can't reach database server at 127.0.0.1:5433`, or `database "uo_crm_test" does not exist`.

**Fix:** Locally, run `docker compose up -d` and wait for Postgres to be healthy (`docker compose ps`); the port is **5433**, not 5432. If the volume predates `infra/postgres/init`, create the database yourself or recreate the volume. In CI, open the job's **Initialize containers** step: the Postgres service must report healthy before the steps start, and `TEST_DATABASE_URL` in `ci.yml` must match the service's port, user and database.

### An integration test gets a 500

The test app runs with logging off, so a 500 shows only the generic error body. Re-run with server errors logged:

```bash
cd apps/api && TEST_LOG_ERRORS=1 npx jest --runInBand test/integration/opportunities.test.ts -t "activation"
```

In CI, add `TEST_LOG_ERRORS: "1"` to the `integration` job's `env` on a branch while you investigate.

### Pentest fails after adding a route

`pentest.test.ts` reads the live OpenAPI document, so every new route is attacked automatically.

- **A new authenticated route** fails the IDOR, CSRF or secret-exposure sweeps if it skips `OpportunityAccess`, `@RequireCapability` or the CSRF guard. Fix the route, not the test.
- **A new public route** (`@Public()`) fails "refuses every non-public route without a session" because it doesn't answer 401. If it is meant to be public, add `"<method> <path>"` to the `PUBLIC` set at the top of `apps/api/test/integration/pentest.test.ts`, with a comment saying how the route protects itself (signature, rate limit, unguessable token), and add a regression to `hardening.test.ts`.

### Security job fails

- **`npm audit` finds a high or critical advisory:** run `npm audit --omit=dev` locally, then `npm ls <package>` to see what pulls it in. Update the direct dependency, or pin a fixed version with `overrides` in the root `package.json` (several are pinned there already). Commit the updated `package-lock.json`.
- **`npm audit` can't reach the registry** (`EAI_AGAIN`, `ETIMEDOUT`, 5xx from `registry.npmjs.org`): re-run the job.
- **`npm sbom` reports `ESBOMPROBLEMS`:** `npm sbom` refuses to run when `npm ls` would report a problem. `missing: …` means the installed tree doesn't match `package-lock.json`: run `npm install` locally and commit the lockfile (`npm ci` in the other jobs fails for the same reason). `invalid: <pkg>@x, <range> required by …` for a peer dependency is what `--legacy-peer-deps` in the workflow already skips (an optional peer of `@hookform/resolvers`); if a regular dependency is invalid, fix the version in `package.json` or `overrides`. Reproduce with `npm ls --all`.

### `npm ci` fails

`npm ci can only install packages when your package.json and package-lock.json … are in sync`: a dependency was added or changed without updating the lockfile. Run `npm install` and commit `package-lock.json`.
