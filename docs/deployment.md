# Deployment, backup and recovery

## What runs

| Process | Image / command | Scale |
|---|---|---|
| API | `apps/api/Dockerfile` → `node dist/main.js` (port 4000) | 1+ instances behind the web app |
| Worker | same image → `node dist/worker.js` | 1 instance (schedules are de-duplicated by BullMQ, so 2 is also safe) |
| Migrations | same image → `npx prisma migrate deploy` | once per release, before the API starts |
| Web | `apps/web/Dockerfile` (build arg `API_ORIGIN`, e.g. `http://api:4000`) → `node apps/web/server.js` (port 3000) | 1+ instances |
| PostgreSQL 16 | managed service recommended (Azure Database for PostgreSQL, AWS RDS, …) | with point-in-time recovery |
| Redis 7 | managed service recommended; `maxmemory-policy noeviction` | persistence on |
| Object storage | AWS S3 / Azure Blob via S3 gateway / any S3-compatible service | private bucket, versioning on |

Put HTTPS (TLS) in front of the web app, e.g. a load balancer or reverse proxy. Only the web app needs to be public: the API is reached through the web app's `/api` proxy. The proxy must **set or append** `X-Forwarded-For` (AWS ALB, Azure Front Door/App Gateway, nginx `proxy_add_x_forwarded_for` all do), and the API needs `TRUST_PROXY` so rate limits and audit entries see each user's real address. Don't expose the web container directly to the internet with `TRUST_PROXY` set: a client could then choose its own address.

The production web build sends a Content-Security-Policy, HSTS (`max-age=31536000; includeSubDomains`), `X-Frame-Options: DENY`, `nosniff` and a strict referrer policy. Document previews load from your bucket, so build the web image with `STORAGE_ORIGIN` set to the bucket's origin (e.g. `https://uo-documents.s3.eu-west-1.amazonaws.com`).

## Environment

Copy `apps/api/.env.example` into your secret store and set at least:

```
NODE_ENV=production
WEB_ORIGIN=https://crm.utilityoptimizer.com
DATABASE_URL=postgresql://…?sslmode=require
REDIS_URL=rediss://…
FIELD_ENCRYPTION_KEY=<32 random bytes, base64>
APP_SECRET=<64 random hex chars>
COOKIE_SECURE=true
TRUST_PROXY=loopback,linklocal,uniquelocal
STORAGE_DRIVER=s3  S3_REGION=…  S3_BUCKET=…  S3_ACCESS_KEY_ID=…  S3_SECRET_ACCESS_KEY=…
SMTP_URL=…  MAIL_FROM=…
RUN_WORKERS_IN_API=false
```

The API refuses to start if anything is missing or malformed, and prints which variable is wrong. **Back up `FIELD_ENCRYPTION_KEY` separately from the database**: without it, encrypted fields can't be recovered.

## Release steps

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d api worker web
curl -fsS https://crm.utilityoptimizer.com/api/health
```

`docker-compose.prod.yml` reads `.env.production` (never commit it) and expects managed Postgres, Redis and S3. Migrations are forward-only and additive; the API syncs pipeline stages on start (idempotent). Create the first administrator as described in the [administrator guide](administrator-guide.md).

`GET /api/health` returns 200 when the database, Redis and storage respond, and 503 otherwise. Use it for load-balancer health checks and uptime monitoring. Logs are JSON (pino) on stdout with a request id (`x-request-id`); ship them to your log platform.

## Backup

| What | How | Retention (suggested) |
|---|---|---|
| PostgreSQL | Managed point-in-time recovery, plus a nightly logical dump: `pg_dump --format=custom --no-owner "$DATABASE_URL" > uo-$(date +%F).dump` copied to separate storage | PITR 7–35 days; nightly dumps 30 days; monthly 12 months |
| Object storage | Bucket versioning plus cross-region or second-account replication | match database retention |
| Encryption key and secrets | Secrets manager with its own backup / soft delete | indefinitely |
| Redis | Not needed: queues are rebuilt from `integration_jobs` and the schedules re-register on worker start | none |

Test a restore at least quarterly.

## Recovery

1. **Database**: restore to a point in time (managed service), or `pg_restore --clean --no-owner -d "$DATABASE_URL" uo-YYYY-MM-DD.dump`. Then run `npx prisma migrate deploy` (a no-op if up to date).
2. **Files**: restore the bucket (or the needed object versions). Document versions reference objects by `storage_key`.
3. **Secrets**: the same `FIELD_ENCRYPTION_KEY` (and `FIELD_ENCRYPTION_KEY_PREVIOUS` if mid-rotation) must be restored with the database.
4. Start the worker: schedules re-register automatically. Retry any dead or failed jobs from **Administration → Integrations**.
5. Check `/api/health` and sign in.

## Local development

```bash
docker compose up -d
cp apps/api/.env.example apps/api/.env    # then generate FIELD_ENCRYPTION_KEY and APP_SECRET
npm install
npm run build -w @uo/shared
npm run db:migrate && npm run db:seed
npm run dev:api        # http://localhost:4000/api/docs
npm run dev:web        # http://localhost:3000
```

Local services: Postgres on 127.0.0.1:**5433** (5432 is often taken), Redis 6379, S3 (SeaweedFS) 8333, Mailpit (catches email) http://localhost:8025. Demo users: `admin|manager|sarah|sean|ops|compliance|finance@demo.utilityoptimizer.ie`, password `ChangeMe-Demo-2026!` (override with `SEED_DEMO_PASSWORD`).
