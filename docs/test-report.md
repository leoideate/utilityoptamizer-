# Test report

Run on 14 October 2026, Windows 10, Node 22.17, Docker Desktop (Postgres 16, Redis 7, SeaweedFS S3), after a clean `npm install`.

## Results

| Suite | Command | Result |
|---|---|---|
| Lint | `npm run lint` | ✅ 0 problems |
| Type check (shared, API, web) | `npm run typecheck` | ✅ 0 errors |
| Shared unit tests (rules, permissions, identifiers, percentages, dates) | `npm test -w @uo/shared` | ✅ 30 / 30 |
| API unit tests (encryption, scrypt, TOTP RFC 6238 vector, webhook HMAC and replay, OCR card parser, phone matching, address-history coverage, redaction, upload sniffing, env validation, CSV parsing) | `npm run test:unit -w @uo/api` | ✅ 17 / 17 |
| API integration tests (real PostgreSQL, full NestJS app over HTTP) | `npm run test:integration -w @uo/api` | ✅ 61 / 61 (incl. 10 single sign-on tests against a mock OpenID provider, 7 call tests incl. a mock RingCentral platform, 5 chat tests) |
| End-to-end + accessibility (Playwright, Chromium, axe WCAG 2.1 AA, desktop and Pixel 7) | `npm run test:e2e` | ✅ 11 / 11 (incl. real-time chat between two browsers and a logged call) |
| Production builds | `npm run build`; `docker build` of API and web images | ✅ API container started in production mode, `/api/health` = ok (database, Redis, storage), `prisma migrate status` = up to date |
| Migrations | `prisma migrate deploy` on the dev and test databases | ✅ |
| Dependency audit (runtime) | `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| Dependency audit (all) | `npm audit` | ⚠️ 31 high, all from `braces` in Jest and ESLint tooling. No fixed version exists yet; not shipped in production images. |

**Total automated tests: 119, all passing.**

## Essential scenarios → tests

| # | Scenario | Covered by |
|---|---|---|
| 1–4 | Create electricity, gas, dual-fuel and Worldpay opportunities | `opportunities.test.ts` "creates a %s opportunity…"; e2e "salesperson captures an electricity lead…", "Worldpay opportunity…" |
| 5 | Conditional fields | `opportunities.test.ts` "conditional fields"; e2e (MPRN shown, GPRN hidden; Worldpay tab replaces Energy; deposit questions appear) |
| 6 | Stage validation | `rules.test.ts` (16 gate tests); `opportunities.test.ts` "early stages need nothing…"; e2e stage-move dialog |
| 7 | Document requirements | `rules.test.ts`; `opportunities.test.ts` "submission requires … approved documents…" |
| 8 | Internal approval | `opportunities.test.ts` "only managers can grant internal approval" and the submission test |
| 9 | Worldpay risk conditions | `rules.test.ts` deposits/prepayment and principals; `opportunities.test.ts` "Worldpay: deposit/prepayment details and percentages" |
| 10 | Contact creation doesn't remove the opportunity | `opportunities.test.ts` "creating or linking a customer never removes, archives or reassigns…" |
| 11 | Won opportunities remain active | `opportunities.test.ts` "activation makes the deal Live / Won, active, searchable…" (incl. the database trigger refusing archive/delete); e2e "won opportunities stay visible" |
| 12 | Won opportunities remain assigned | same test (unassigning a won deal is refused); "only a manager can reopen a won deal" |
| 13 | Managers see all opportunities | `opportunities.test.ts` "visibility"; e2e "salespeople only see their own pipeline; managers see everyone's" |
| 14 | Salesperson filtering | same; plus 404 on others' deals and self-claiming unassigned leads |
| 15 | Linked renewal | `renewals-and-jobs.test.ts` "creates one linked renewal per deal…"; Worldpay renewal test |
| 16 | Duplicate renewals prevented | same test: sequential and concurrent re-runs create nothing |
| 17 | Historical contracts preserved | same test: original contracts byte-for-byte unchanged; editing a live contract returns 422 |
| 18 | Duplicate-customer detection | `security.test.ts` "shows matches instead of creating…" (email, phone, CRO, VAT, name + postcode; manager-only merge); e2e duplicate flow |
| 19 | Role restrictions | `security.test.ts`: principal masking, compliance-only notes, restricted documents and bank details, admin-only audit log, CSRF/Origin/session; `misc.test.ts` permission matrix |
| 20 | Audit logs | `security.test.ts` "records who changed what…" (append-only triggers, corrections) and "never writes passwords or restricted values into the audit log" |

Also covered: internal chat (one DM per pair, unread counts and read markers, public/private channel access, deal discussions following opportunity permissions and losing access on reassignment, mentions limited to people who can see the conversation, edit/delete history kept append-only, attachments content-checked, scanned and access-controlled, real-time delivery); click-to-call (only saved numbers dialable, own phone required and normalised, RingOut request body, status followed from ringing to connected to finished, timeline written exactly once, unanswered calls not counted as contact, cancelling, permissions, manual mode); single sign-on (PKCE S256 and state/nonce on the authorize URL; Google and Microsoft sign-in; unknown and inactive users refused, never created; unverified email and disallowed domain refused; forged state, tampered signature, wrong audience, issuer or nonce, and expired tokens rejected; cancelled sign-in; open-redirect protection; CRM two-factor still required unless Microsoft asserts MFA), background jobs (idempotent reminders, lead assignment, unanswered messages, virus-scan enqueue), integration dead-lettering and idempotency, signature webhook HMAC, replay and idempotency, website lead intake (signed, de-duplicated), CSV import with per-line errors, idempotent stage migration (legacy names adopted, "Lost" left untouched), account lockout, upload content sniffing.

## Defects found and fixed during testing

- The supply-site address `kind` leaked into the insert (500 error). Fixed.
- Draft contracts didn't follow the opportunity's selected supplier, so renewals recorded the wrong incumbent supplier. Fixed: choosing a supplier updates unsigned contracts.
- Phone duplicate matching missed `+353 1 …` against `01 …`. Fixed with national-number normalisation.
- The legacy "Proposition" stage name wasn't recognised by the stage migration. Alias added.
- Scrollable tables weren't keyboard-focusable (axe `scrollable-region-focusable`). Fixed across the app.
- `.dockerignore`/`.gitignore` excluded the `src/storage` module. Narrowed to the upload folder.
- People added to a deal discussion by an @mention didn't see that message as unread (their read marker matched the message time). Fixed.
- The login rate-limit error was shown to users as "ThrottlerException: Too Many Requests". It now reads "Too many attempts. Please wait a minute and try again."
- The production container crashed when `NODE_ENV=development` selected a dev-only log formatter. Now only used when installed.

## How to reproduce

```bash
docker compose up -d
npm install && npm run build -w @uo/shared
npm run db:migrate && npm run db:seed
npm run lint && npm run typecheck && npm test
npm run build
# start API (npm run start -w @uo/api) and web (npm run start -w @uo/web), then:
npm run test:e2e
```
