# The CRM's AI assistant: functions, guardrails and rules

This is the technical companion to the client document *"The AI assistant: what it does, and how it keeps company information safe"*. It explains what the AI features do, the rules they follow, and **where each rule is enforced in code**, plus the tests that check it.

The model is Claude by Anthropic, called through `@anthropic-ai/sdk`. It defaults to `claude-haiku-5-5`: set `AI_ASSISTANT_MODEL` for the assistant and `AI_MODEL` for bill and card reading.

## Features

| Feature | What it does | Code |
|---|---|---|
| Ask the CRM | Chat panel (top bar ✨). It answers from read-only lookups and the team guide, and links to screens. | `apps/api/src/assistant/`, `apps/web/src/components/assistant/assistant-panel.tsx` |
| Prepared actions | Tasks (create, complete, reschedule), follow-ups, new leads, deal contact fields, stage moves, timeline notes and calls, customer emails. Each becomes a card; nothing changes until Confirm. | `apps/api/src/assistant/actions.ts`, `packages/shared/src/assistant-actions.ts` |
| Read bill | Extracts address, MPRN/GPRN, meter number, supplier, account, rates and readings from an `energy_bill` version. It returns suggestions only. | `apps/api/src/ai/` |
| Business card scan | The same reader fills the scan review form. | `apps/api/src/ocr/providers.ts` (`AiOcrProvider`) |
| Fill from bill (PR #29) | Maps a bill reading onto the Flogas or Bord Gáis form, and saves the ticked fields through the form's own `PUT`. | `packages/shared/src/bill-fill.ts`, `components/opportunity/supplier-application/fill-from-bill.tsx` |
| Morning summary | **Not AI.** It is built from fixed rules, and nothing is sent to Anthropic. | `packages/shared/src/attention.ts`, `apps/api/src/attention/` |

## Guardrails, and where they're enforced

### 1. The AI has the access of the person asking
- **Lookups:** the model can only call the tools in `TOOL_INPUTS` (`assistant/tools.ts`). Each one calls an existing service with the asker's `Actor`:
  - `OpportunityAccess.readable` / `visibleWhere`;
  - `OpportunitiesService.workspace` / `list` / `gatePreview`;
  - `DocumentsService.checklist`;
  - `ActivitiesService.list`;
  - `EnergyService.workspace`.
- **Hidden deals:** a deal the user can't see raises `NotFound`. That reaches the model as "Opportunity not found.", the same as a deal that doesn't exist.
- **Prepared actions** resolve the deal with `OpportunityAccess.writable` when they're prepared, and run through the normal services with the user's `Actor` at Confirm (`AssistantActions.execute`). So capabilities, stage gates (`stageGateIssues`), the timeline and the audit log all apply. Live / Won is only reached through `activate`, which is not offered.

### 2. Restricted data never reaches the model
- **Tool output:** each tool maps its service's result to a fixed set of fields (`AssistantTools.call` / `getDeal`). Nothing reads `*Enc` columns, principals, bank accounts or risk notes.
- **Size cap:** tool output is cut at 4 KB (`MAX_RESULT`).
- **Bills:** the bill-reading schema (`packages/shared/src/bill-reading.ts`) has no bank fields, and the instructions forbid extracting IBANs, BICs, card numbers or direct-debit references.
- **Forms:** `flogasFillSave` / `bordGaisFillSave` never set `bank` or `debtorAddress`.
- **Supplier forms:** for the assistant, `FlogasElectricityService.outstanding` / `BordGaisElectricityService.outstanding` return issue messages only. They don't go through `view()`, which can reveal bank details.

### 3. No sharing between users
- **Conversations** are owned by `userId`. `AssistantService.conversation` returns 404 to anyone else, and so do feedback and actions (`AssistantActions.own`).
- **History:** each request carries only that conversation's last 20 messages (`HISTORY`).
- **Shared prefix:** the cached system block (`cache_control: ephemeral`) is `assistantInstructions()`. That is the rules, the stage list and the team guide's text, which is the same for everyone and holds no customer data.

### 4. No secrets in the model
- **Instructions:** `instructions.ts` holds the rules plus `crm-guide.html` as text. There are no keys, settings or customer data in it.
- **API key:** `ANTHROPIC_API_KEY` is used only server-side, in `modules.ts` factories. It is never returned by any route; `/auth/me` returns only booleans (`features.aiReading`, `features.assistant`).

### 5. Nothing changes without a person
- **Proposals:** `propose_*` tools only call `AssistantActions.prepare`, which validates and describes. Proposals are stored with `status: pending`.
- **Confirm** (`AssistantActions.confirm`):
  - claims the row atomically (`pending → confirming`), so it can run only once;
  - refuses proposals older than `ASSISTANT_ACTION_TTL_HOURS` (24);
  - records a failure on the card.
- **Emails** use the action id as the idempotency key, so the same suggestion can never send twice. The card shows the recipient and subject, with the full text under "Read the email".
- **Limits:** at most 5 proposals per answer. Proposal rows can't be edited after they're offered (database triggers).

### 6. Prompt injection
- **The rule:** the instructions say tool-result text is data, not instructions, and never a reason to prepare a change.
- **The structural defence:** the protections in sections 1 and 5 don't depend on the model obeying. An injected instruction can't widen access, and can only produce a card a person must confirm.

### 7. Limits
- **Questions:** `AI_ASSISTANT_DAILY_LIMIT` (default 100 per person per day, giving 429 after that), plus `@Throttle` at 20 per minute on `POST /assistant/messages`.
- **Lookups:** at most 6 tool calls per question (`MAX_TOOL_CALLS`). `find_deals` returns at most 25.
- **Bill reading:** 20 per minute per user.

### 8. Audit and retention
- **Audit:** `assistant.message` per question (tools used and token counts, no text), `assistant.action` per confirmed change (kind and ids, no note or email text), and `document.ai_read` per bill read (model and version, no values).
- **Feedback:** thumbs-down answers are listed for `assistant.review` (managers and administrators) under Administration → Assistant feedback.
- **Retention:** conversations, messages, feedback and actions are append-only (triggers) and are purged after 90 days by `RetentionService` with `uo.allow_purge`.

### 9. Off switches
- **The key:** with no `ANTHROPIC_API_KEY`, every AI feature is off. The assistant routes 404 (`AssistantEnabledGuard`), Read bill says it isn't set up, and card scans fall back to manual.
- **The assistant only:** `AI_ASSISTANT_ENABLED=false` turns off the assistant but keeps bill reading.
- **Per role:** remove `assistant.use` from a role in `packages/shared/src/permissions.ts`, then regenerate `docs/security-matrix.md`.

## Data sent to Anthropic
- **Ask the CRM:** the question, the conversation so far, the instructions and guide, and the trimmed tool results.
- **Read bill and card scans:** the uploaded file only.

Anthropic is a data processor for this. Check its current commercial terms and data processing addendum for retention and training. The client document says this too.

## Tests that check the rules
- **`apps/api/test/integration/assistant.test.ts`:**
  - looks up the deal on screen with the asker's access;
  - can't see other people's deals, and says so to the model the same way as a missing one;
  - runs every tool on real data without errors or restricted fields;
  - keeps conversations and feedback to their owner, and lets managers review unhelpful answers;
  - returns an apology on a refusal;
  - stops at the daily limit.
- **`apps/api/test/integration/assistant-actions.test.ts`:**
  - changes nothing until the user confirms, then makes the change once, as the user;
  - moves stages only through the stage gates, never to Live / Won;
  - won't prepare changes to deals the user can't see or change;
  - refuses suggestions older than a day;
  - keeps a proposal as it was offered, with the database refusing edits;
  - stops at five changes per answer.
- **`apps/api/test/integration/bill-reading.test.ts`:**
  - returns suggestions, saves nothing, and audits the read without the values;
  - only reads energy bills, and only for people who can edit the deal.
- **`apps/api/test/integration/pentest.test.ts`** attacks every route:
  - anonymous;
  - without CSRF;
  - as a second salesperson using the first one's ids.
- **`packages/shared/test/bill-fill.test.ts`** (PR #29): no bank fields are ever filled.

## Options the client can ask for
- **Email recipients:** limit `send_email` to addresses already on the deal (a check in `AssistantActions.prepare`).
- **Separate switches:** turn off emails, or all prepared actions, while keeping questions. A new env flag would filter `ASSISTANT_ACTION_KINDS` in `toolDefinitions`.
- **Roles:** restrict `assistant.use` to some roles.
- **Reporting:** a monthly usage and feedback report built from the audit log.
