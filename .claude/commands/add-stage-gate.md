---
description: Add or change a stage-gate requirement (rules.ts, GateFacts, loadGateFacts, shared unit tests, API integration test).
argument-hint: <which stage, and what must be true before entering it>
---

# /add-stage-gate

Requirement: $ARGUMENTS

`stageGateIssues(facts, target)` in `packages/shared/src/rules.ts` is the only place stage requirements live. Gates are cumulative (`at(gate)` is true for that stage and every later one) and the early stages have none.

## Steps

1. **Facts**: if the rule needs data `GateFacts` (`packages/shared/src/rules.ts`) doesn't carry yet, add the smallest field that answers it. Restricted data becomes a presence flag or a boolean (`hasDob`, the IBAN comparison via `IbanComparer`), never the value.
2. **Load the facts**: fill the new field in `loadGateFacts` (`apps/api/src/opportunities/facts.ts`). Keep it to one query per relation; don't decrypt unless the rule really needs a comparison (pass `CryptoService` as `IbanComparer`).
3. **The rule**: add it inside the right `if (at("<stage>"))` block of `stageGateIssues`, as `issues.push("<one user-facing sentence telling them what to do>")`. Merchant (`f.serviceType === "merchant_services"`) and energy deals usually differ; workflow-dependent rules read `f.workflow`. If it's also a checklist item or missing information, update `caseChecklist` / `missingInformation` too.
4. **Rebuild**: `npm run build -w @uo/shared`.
5. **Shared unit tests** in `packages/shared/test/rules.test.ts` (use the `facts()` / `readyEnergy()` helpers there):
   - blocked at the gate stage with the exact sentence;
   - also blocked at a later stage (cumulative);
   - not reported at the stage before;
   - passes when the fact is satisfied.
   Run `cd packages/shared && npx jest -t "<describe name>"`.
6. **API integration test** in `apps/api/test/integration/opportunities.test.ts` (or `workflows.test.ts` for workflow facts): moving the deal to the stage returns 422 with the sentence in `issues`, and succeeds once the data exists. This proves `loadGateFacts` fills the field.
7. **Check nothing else broke**: `live_won` is only reached through `OpportunitiesService.activate`, which uses the same gate; the web pipeline shows `issues` as returned. Run `npm test`.
