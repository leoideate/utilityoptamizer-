# Security assessment: penetration and stress testing

**Date:** 15 October 2026 · **Scope:** Utility Optimizer CRM (`apps/api`, `apps/web`), branch `feature/utility-optimizer-crm` · **Environment:** local development stack (Windows 10, 4 cores, Docker Desktop: Postgres 16, Redis 7, SeaweedFS S3)

## Summary

The application was reviewed line by line for security weaknesses, attacked with an automated penetration-test suite, and load tested. **Nine weaknesses were found and fixed**, plus one found during the automated attacks and one performance hotspot found under load. After the fixes:

- every one of the 150 API operations refuses anonymous access (except the 9 that are public by design and protected another way);
- every state-changing operation refuses requests without a valid CSRF token or from a foreign origin;
- a salesperson using another salesperson's record ids across all 95 id-based operations (1,710 attempts) received none of their data and changed none of their records;
- 12 classes of injection, XSS, traversal and oversized payloads caused no server error and no database damage;
- no API response contains password hashes, session tokens, MFA secrets or ciphertext;
- under load (up to 200 concurrent requests) there were **no server errors and no dropped connections**, and the login and chat rate limits held.

**What this does and doesn't show.** These are strong, repeatable controls and they run on every `npm test`, but automated testing by the developer is not proof that no breach is possible. Before go-live, commission an **independent penetration test** (CREST- or OSCP-certified tester, against the production-like environment including the TLS proxy, S3 bucket policy and cloud configuration), and run the organisational controls in the [ISO 27001 gap analysis](iso27001-gap-analysis.md).

## Findings

| # | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| F1 | **High** | A signed-in user could change their own password **without the current password**, via the admin reset endpoint (anyone holding a stolen session could lock the owner out). | New `POST /api/auth/password` requires the current password, refuses re-use, ends the user's other sessions and audits failures. The admin reset endpoint now always needs `admin.users`. The Account page asks for the current password. | `hardening.test.ts` "password changes (F1)" |
| F2 | Medium | **Salespeople could read every customer** (profile, contacts, timeline, list, global search), update them, add contacts/bank accounts, and the duplicate check returned other customers' email, phone, CRO and VAT numbers. Linking a deal to any customer id then exposed that customer fully. | Customer visibility now follows opportunity visibility (`OpportunityAccess.customerWhere`): roles that see all deals see all customers; salespeople see customers they created or that are on a deal they can see. Others return 404. Duplicate warnings still fire but show salespeople only the company name. Only visible customers can be linked to a deal (422 with "Ask a manager"). | `pentest.test.ts` IDOR sweep and linking test; `hardening.test.ts` "customer least privilege (F2)" |
| F3 | Medium | Uploads were buffered in memory up to **100 MB**, with unlimited multipart parts: a few concurrent uploads could exhaust memory. | Upload size follows `MAX_UPLOAD_MB` (default 20) at the parser, with limits on files, fields and parts (documents and chat). | `hardening.test.ts` "rejects files over MAX_UPLOAD_MB with 413" |
| F4 | Medium | Behind the web proxy the API saw every request as coming from the web server, so **all users shared one rate limit** (11 people signing in within a minute locked everyone out) and audit IPs were wrong. | `TRUST_PROXY` setting (Express `trust proxy`), documented with its precondition (a proxy that sets `X-Forwarded-For`). | Configuration; see [deployment](deployment.md) |
| F5 | Medium | The web app sent **no Content-Security-Policy and no HSTS**. | CSP (`default-src 'self'`, no third-party scripts, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri`/`form-action 'self'`), Cross-Origin-Opener-Policy, and HSTS in production builds. | Checked on the running production build (see below) |
| F6 | Medium | Sessions had **no idle timeout** (12 hours regardless of activity). | `SESSION_IDLE_MINUTES` (default 60); idle sessions are deleted on next use. | `hardening.test.ts` "idle sessions (F6)" |
| F7 | Low | Interactive API docs (the whole attack surface) were **public in production**. | Off in production unless `ENABLE_API_DOCS=true`. | `hardening.test.ts` "API documentation (F7)" |
| F8 | Low | A TOTP code could be **replayed** within its 30–90 second window. | Each time step is accepted once per user (atomic conditional update); replays are audited. | `hardening.test.ts` "each authenticator code works once" |
| F9 | Low | Access refusals (401/403/429) were **not logged**, and the rate limit was fixed. | Refusals are logged with user, route and IP; `RATE_LIMIT_PER_MINUTE` is configurable. | `hardening.test.ts` "access denials are logged (F9)" |
| F10 | Low | Found by the injection fuzzing: request bodies over the JSON limit returned **500** instead of 413 (and logged as unhandled errors). | Body-parser errors map to 413 / 400 with a plain message. | `hardening.test.ts` "rejects request bodies over the JSON limit" |
| P1 | Performance | The pipeline board ran two extra queries per stage (54+ queries per load); 4.2 s p95 under load with 5,000 deals. | One grouped query for all column totals; indexes on `opportunities.updated_at` and `customers.created_by_id`. | p95 4.2 s → 2.4 s at 25 concurrent |

Already in place before this review and confirmed by the tests: server-side sessions (SHA-256 token hashes, HTTP-only SameSite cookies), double-submit CSRF plus Origin check, scrypt password hashing, account lockout, PKCE/state/nonce SSO, role and row-level authorisation on every request, AES-256-GCM field encryption for bank details, principal data, compliance notes and MFA secrets, masked restricted data with audited reveals, append-only audit and timeline tables (database triggers), upload content sniffing and virus-scan hook, signed short-lived file links, formula-safe CSV export, log redaction, parameterised database access (Prisma), Zod validation of every input, and generic error messages with a reference id.

## Automated penetration tests

`apps/api/test/integration/pentest.test.ts` (17 tests) reads the **live OpenAPI document** at test time, so any new route is attacked automatically. It runs against the real NestJS app and a real PostgreSQL database.

| Attack | Method | Result |
|---|---|---|
| Unauthenticated access | Every operation (141 non-public) with no session | All 401 |
| Session abuse | Forged cookie; stolen cookie after logout | 401 |
| CSRF | Every state-changing operation (97) without the token, and with a valid token from `https://evil.example`; another user's token | All 403 |
| IDOR / broken object-level authorisation | Salesperson B calls all 95 id-based operations with each of 18 ids belonging to salesperson A (deal, customer, contact, bank account, site, meter, contract, activity, note, document, document version, signature, call, direct-message channel, message, attachment, business-card scan) = 1,710 requests, with valid request bodies so the access check is reached | No response contained A's data; A's records were byte-for-byte unchanged; 80%+ of routes passed validation and reached the access check. A planted bug (customer profile without the visibility check) was caught by this test, proving it works. |
| Data leakage through lists | B's opportunity list, board, customers, search, activities, notifications, chat, dashboard | Nothing of A's |
| Privilege escalation / mass assignment | Salesperson setting `ownerId`, `outcome`, `stageId`; non-admins changing roles, resetting passwords, disabling MFA | Ignored or 403 |
| Injection and XSS | SQL (`' OR '1'='1`, stacked queries, `pg_sleep`), NoSQL operators, template injection, script and attribute XSS, path traversal (Unix and Windows), CRLF header injection, Unicode controls, 10,000-character strings, wrong JSON types, malformed JSON — in query strings of every list route, path ids and every body field of six write routes | No 5xx; database intact; script payloads stored as text and served as `application/json` with `nosniff` and `default-src 'none'` |
| File link tampering | Traversal keys and forged signatures on `/api/files/local` | 4xx |
| Secret exposure | Every GET route called as an administrator/finance/compliance user with every id, response scanned for password hashes, `$argon2`/scrypt, MFA secrets, token hashes, `v1:` ciphertext, encrypted columns, key names | None found |
| Account enumeration | Login with unknown email vs wrong password | Identical status and message |
| Cookie flags | Session cookie | `HttpOnly`, `SameSite=Lax` (`Secure` enforced in production by configuration validation) |

Run: `npm run test:integration -w @uo/api -- pentest hardening`

## Stress test

`apps/api/scripts/stress.ts` (`npm run stress -w @uo/api`) seeds a throwaway database with **5,000 opportunities, 2,000 customers and 6 users**, then holds each scenario at fixed concurrency for 15 seconds against a production build of the API (rate limit raised to 100,000/min for the run; login and chat keep their own limits).

| Scenario | Concurrency | Requests | Req/s | p50 ms | p95 ms | p99 ms | 5xx | Network errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `GET /health` (database + Redis + S3 check) | 50 | 3,603 | 239 | 200 | 286 | 351 | 0 | 0 |
| Opportunity list (salesperson) | 50 | 1,272 | 78 | 563 | 1,158 | 1,513 | 0 | 0 |
| Pipeline board | 25 | 198 | 12 | 2,049 | 2,373 | 2,500 | 0 | 0 |
| Opportunity detail | 50 | 949 | 61 | 785 | 986 | 1,131 | 0 | 0 |
| Customer list (scoped) | 50 | 897 | 57 | 828 | 1,098 | 1,184 | 0 | 0 |
| Global search | 50 | 1,148 | 74 | 666 | 803 | 867 | 0 | 0 |
| Dashboard (manager) | 20 | 220 | 14 | 1,408 | 1,712 | 1,763 | 0 | 0 |
| Create opportunity | 20 | 1,011 | 67 | 289 | 378 | 408 | 0 | 0 |
| Post chat message | 20 | 10,289 | 685 | 24 | 43 | 72 | 0 | 0 (60 accepted, rest 429: the 60/min chat limit per client works) |
| Spike: 200 users listing deals | 200 | 1,433 | 87 | 2,289 | 2,536 | 2,655 | 0 | 0 |
| Login brute force (wrong password) | 10 | 11,213 | 747 | 11 | 20 | 35 | 0 | 0 (10 refused as wrong password, then 429 for the rest) |

**Reading the numbers.** The API stayed correct and available at every load level: latency grows with concurrency (requests queue for the database connection pool) but nothing fails. On this 4-core Windows laptop with Postgres inside Docker Desktop, one API instance serves roughly 60–80 list or detail requests per second. A broker office with 50 active users generates a few requests per second, so there is a large margin. For production:

- run 2+ API instances (stateless; sessions live in Postgres, events in Redis) on Linux next to a managed Postgres;
- set the Prisma pool explicitly in `DATABASE_URL` (`?connection_limit=20`) and size Postgres `max_connections` for all instances;
- the board and dashboard are the heaviest screens; if the deal count grows past ~50,000, cache dashboard aggregates for a minute.

## Production checks on the web app

The production web build (`npm run build -w @uo/web`, served by `npm run start`) returns on every page: `Content-Security-Policy` (as above), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera for card scanning only), `Cross-Origin-Opener-Policy: same-origin` and `Strict-Transport-Security`. The Playwright suite (including real-time chat, document upload and call logging) runs under this policy without CSP violations.

## Residual risks and recommendations

| Risk | Recommendation | Owner |
|---|---|---|
| Developer testing isn't independent | Independent penetration test before go-live and yearly / after major changes | Management |
| `script-src 'unsafe-inline'` (needed by Next.js inline hydration) weakens CSP against XSS | React escapes all output and no `dangerouslySetInnerHTML` is used; adopt nonce-based CSP when moving to Next.js middleware nonces | Development |
| Client IP is only trustworthy behind a proxy that sets `X-Forwarded-For` | Deploy behind a load balancer; never expose the web container directly with `TRUST_PROXY` set. Per-account lockout limits guessing regardless of IP. | Operations |
| SSO users keep a CRM password unless an administrator turns it off | Turn off **Allow password sign-in** for every user who signs in with SSO (per user; refused for your own account or when SSO can't serve them). Covered by `sso.test.ts` "single sign-on only accounts". | Administrators |
| No automated alerting on suspicious activity | Ship JSON logs to a SIEM; alert on bursts of "Access denied", `auth.mfa_failed`, `auth.password_change_failed`, lockouts and `sensitive.read` | Operations |
| Development-only dependency advisories (`braces` in Jest/ESLint) | Not in production images; update when fixed versions exist | Development |
| Infrastructure (TLS config, bucket policy, IAM, backups, patching) is outside this codebase | Follow [deployment](deployment.md); include in the independent test | Operations |
