---
description: Fix a security issue with a failing regression test first, an entry in docs/security-assessment.md, and the pentest suite green.
argument-hint: <the vulnerability and where it is>
---

# /security-fix

Issue: $ARGUMENTS

Keep the details out of commit messages, PR titles and public issues until the fix is merged; describe the outcome ("Require the current password to change it"), not the exploit.

## Steps

1. **Reproduce with a test first**: add a `describe("<short name> (F<n>)", ...)` block to `apps/api/test/integration/hardening.test.ts`, using `createTestApp`, `userAndClient`, `login` and `expectStatus` from `../support/app`. Run it and watch it fail:
   `cd apps/api && npx jest --runInBand test/integration/hardening.test.ts -t "F<n>"`
   `<n>` is the next number after the last `F` row in `docs/security-assessment.md`.
2. **Fix at the right layer**:
   - permissions: `CAPABILITIES` in `packages/shared/src/permissions.ts` plus `@RequireCapability` or `can()`; regenerate `node scripts/gen-security-matrix.js`;
   - row access: `OpportunityAccess` (`readable` 404, `writable` 403, `visibleWhere`, `customerWhere`, `linkableCustomer`); never re-implement the check in a controller;
   - sign-in: `AuthService.issueSession` / `checkTotp`, which both password and SSO paths use;
   - data exposure: restricted columns stay `*Enc` through `CryptoService`, unmask only with the capability and `audit.sensitiveAccess`, and extend `redact()`.
   The web app only hides buttons; the fix must be in the API.
3. **Log refusals and abuse**: refusals already go through the guards' logging; a new kind of attempt (replay, tampering) is audited with `AuditService`, without the secret itself.
4. **Record it** in `docs/security-assessment.md`: a new row in the Findings table (`| F<n> | Severity | Finding | Fix | Regression test |`), with the test name you added in the last column.
5. **Run the security suites**:
   `cd apps/api && npx jest --runInBand test/integration/hardening.test.ts test/integration/pentest.test.ts test/integration/security.test.ts`
   If the fix adds or changes a public route, update `PUBLIC` in `pentest.test.ts` with what protects it.
6. **Verify**: `npm run lint`, `npm run typecheck`, `npm test`.
