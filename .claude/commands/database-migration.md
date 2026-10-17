---
description: Change the Prisma schema and add a migration the way this repo does it (schema, migration folder, integrity SQL, regenerated docs).
argument-hint: <what the schema change is for>
---

# /database-migration

Schema change: $ARGUMENTS

## Steps

1. **Edit the schema** in `apps/api/prisma/schema.prisma`.
   - Calendar dates are `@db.Date` (UTC midnight); convert with `dateOnly`/`isoDay` from `apps/api/src/common/values.ts`.
   - Restricted values (DOB, nationality, address, IBAN, compliance notes) get a column ending in `Enc` and go through `CryptoService`. If rules need to know a value exists, add a plain presence flag (like `hasDob`) so they don't decrypt.
2. **Add a migration folder** under `apps/api/prisma/migrations/`, named `YYYYMMDDHHMMSS_short_name` and later than the newest one there.
   - With the DB running (`docker compose up -d`, Postgres on 127.0.0.1:5433): `cd apps/api && npx prisma migrate dev --name short_name`.
   - Offline, diff the committed schema against your edited one (`--from-migrations` needs a shadow database, so it doesn't work offline):
     `git show HEAD:apps/api/prisma/schema.prisma > /tmp/schema.before.prisma`, then
     `npx prisma migrate diff --from-schema-datamodel /tmp/schema.before.prisma --to-schema-datamodel prisma/schema.prisma --script`, and save the result as `migration.sql` in the new folder.
     This only works if the committed schema matches the existing migrations.
3. **Constraints Prisma can't express** (CHECKs, partial unique indexes, triggers) go in their own SQL in the new migration; follow the patterns in `20261014000100_integrity/migration.sql`.
   - History stays append-only: new evidence or history tables need the same no-UPDATE/no-DELETE triggers as `audit_logs`, `timeline_entries`, `form_signatures`, `bill_checks` and the workflow evidence tables.
   - Idempotent automations rely on unique keys (`automationKey` partial index, `renewal_source_key`, `integration_jobs.idempotency_key`, webhook `(provider, event_id)`); keep or extend those.
4. **Regenerate the client**: `npm run db:generate -w @uo/api`. If shared enums or schemas changed, `npm run build -w @uo/shared`.
5. **Update services**: every mutation records itself through `AuditService` inside the same `tx`, with no restricted values in timeline bodies or audit `data`.
6. **Regenerate the docs**: `node scripts/gen-field-dictionary.js`, plus `node scripts/gen-security-matrix.js` if permissions changed.
7. **Verify**:
   - `npm run db:migrate && npm run db:seed` (the seed must stay idempotent).
   - `npm run typecheck` and `npm run lint`.
   - `cd apps/api && npx jest --runInBand --selectProjects integration` (needs docker compose; the test DB is `uo_crm_test`).
   - If you added a trigger, add a test that the forbidden UPDATE/DELETE fails.

Never edit or delete an existing migration folder; add a new one.
