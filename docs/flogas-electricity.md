# Flogas electricity application

The Flogas **Commercial Agreement Form** with its **SEPA Direct Debit Mandate** (two pages,
654 × 901 pt) is filled straight from the CRM. This page describes how it fits the existing
supplier-form pipeline, the data model and the complete CRM-to-PDF mapping.

## When it shows

An opportunity shows the **Flogas form** tab when all of these hold
(`flogasElectricityApplies` in `packages/shared/src/flogas.ts`):

- Product interest includes **Electricity**,
- the selected supplier is **Flogas** (matched by name, ignoring case and spaces), and
- the opportunity is an energy deal.

If the supplier or product changes later, saved answers and every generated version are kept,
but the tab is hidden and the API refuses to generate or send (`RuleViolation`). The opportunity
details card warns before saving such a change when a Flogas document was already generated.

## How it fits the existing architecture

| Need | Reused | Added |
| --- | --- | --- |
| Original PDF, versioned | `FormTemplate` (stored file, SHA-256, `version`) | `FormTemplate.workflow = "flogas_electricity"`, set when the uploaded PDF's SHA-256 matches the layout. Workflow templates are hidden from the generic "Fill a supplier form" card, and their fields can't be edited in the template editor (the layout lives in code). |
| Coordinates | `fillPdf` / `verifyPdf` (pdf-lib overlay, widgets stripped, every value checked after saving) | `apps/api/src/supplier-applications/flogas-electricity/layout.ts`: every box on both pages. `render.ts` maps the application onto those boxes and wraps multi-line addresses. |
| Generated document | `GeneratedForm` (field snapshot, encrypted values, supersedes older copies), `DocumentVersion` (stored file, scanned, short-lived signed links, downloads audited) | `SupplierApplicationVersion`: version number, layout version, the encrypted snapshot of the data it was made from and its hash. Append-only. |
| E-signature | Online signing links (`SigningLink`, `FormSignature`): emailed single-use link, viewed/signed times, IP and user agent, consent text, evidence page, signed copy, second-person review | A third signer role, `account_holder_2`, for a joint bank account; signers can now **decline** (`SigningLink.declinedAt`, reason). |
| Audit | `AuditService.record/log/timeline` | `supplier_application.*` actions; the tab shows the history of the application, its versions, signing and downloads. |

### Single source of truth

The tabs edit the CRM records where the data already lives. Saving a draft writes, in one
transaction, to:

- `customers` (legal name, trading name, legal entity, VAT exemption, priority, business type,
  CRO and VAT numbers, telephone),
- the primary `customer_contacts` row (account contact name, mobile, email),
- the customer's billing `customer_addresses` row,
- the deal's electricity `supply_sites` row (supply address, occupancy, moved-in date, lease
  terms, landlord),
- its electricity `meter_points` (MPRN, MCC) and new `meter_readings` (readings are history, so a
  changed reading is a new row),
- the deal's electricity `energy_contracts` row (expected changeover, commitment period,
  fixed/variable, unit rates) — live or ended contracts stay read-only,
- a new `bank_accounts` row when bank details change (the old row is kept; an IBAN change needs
  confirmation).

Only answers that have no other home are stored on the application itself
(`SupplierApplication.answers`): the requirement ticks, existing-Flogas-customer answer and
account number, sector, "billing same as supply", direct debit yes/no, mandate reference,
second account holder, signatory name and position, agent signature yes/no, meter rows left off
this application, and the office-use Flogas fields. A separate debtor address is restricted and
stored encrypted (`restrictedEnc`).

Until an answer is changed it shows the value derived from the CRM (for example the requirement
ticks come from the opportunity's supply changes and sale type).

## Data model

```
SupplierApplication            one per opportunity and kind ("flogas_electricity"); never deleted
  answers        Json          Flogas-only answers (flogasAnswersSchema)
  restrictedEnc  String?       encrypted JSON: separate debtor address
  versions ─┐
SupplierApplicationVersion     append-only
  version        Int           1, 2, 3 … per application
  formId         → GeneratedForm (unique): the PDF, its field snapshot and encrypted values
  layoutVersion  String        layout.ts version used
  dataEnc        String        encrypted snapshot of the application data
  dataSha256     String        detects CRM edits made after the version was generated
FormTemplate.workflow          "flogas_electricity" for the Flogas template
SigningLink.declinedAt/declineReason
SignerRole + account_holder_2
```

Status (`flogasStatus`, derived, never stored):
**Draft** (no current version, or the data changed since it was generated) →
**Ready for signature** → **Sent** → **Viewed** → **Signed** (all signers; awaiting review) or
**Declined** / **Expired** → **Completed** (signed copy approved by a second person).
A rejected review shows **Rejected**.

## Validation

`flogasElectricityIssues` (shared, so the browser shows the same messages next to each field)
runs on the server before a version is generated, and again before it is sent. Required:

- legal entity name, supply address (first line and town or county), legal entity type,
  business type, CRO or VAT number for a company, account contact name and a valid email;
- whether the customer owns the premises, and the landlord's name and number when they don't;
- an actual requirement, the MPRN (11 digits starting 10, unless the meter has a recorded format
  exception) and a valid MCC length, no repeated MPRNs, at most 12 meter rows, a reading date
  when readings are given;
- the sector, fixed or variable pricing and the unit rates that sector needs (none for LVMD);
- the VAT exemption number when VAT exempt;
- the signatory's name and position;
- with direct debit: the debtor name, the debtor address and an IBAN; a second account holder
  needs a name and email.

Rates are entered in cent per kWh to two decimals (the CRM stores euro to four decimals) and
can't be negative. Text that would not fit its box fails generation with a message naming the
field, and nothing is stored.

## Security

- Opportunity access (`readable`/`writable`), `customer.write` for customer fields,
  `bank.write` to change bank details and `bank.read` to see them (every unmasked view is
  logged). Without `bank.read` the IBAN shows as its last four digits and the draft preview masks
  it.
- A generated PDF that contains bank details is a sensitive document: opening it needs
  `document.read_sensitive`; links are signed and expire after `DOWNLOAD_URL_TTL_SECONDS`.
  Storage keys and paths are never returned.
- Timeline and audit entries name the fields that changed, never their values.
- Signing links are single-use, hashed, expire after 14 days, and are only shown once.

## CRM-to-PDF mapping

Coordinates are PDF points from the page's bottom-left corner, as in `layout.ts`. ✓ marks a
tick box (drawn as an X). "Upper" means printed in block capitals.

### Page 1 — Commercial Agreement Form

| PDF location | Box (x, y, w, h) | CRM / application value |
| --- | --- | --- |
| Legal entity | 112, 719.5, 206, 16.5 | `customers.legal_name` (upper) |
| Trading as | 106, 692.5, 212, 16.5 | `customers.trading_name` (upper) |
| Supply / billing address, lines 1–3 | 152, 669.5, 163, 11 · 64, 649.8, 251, 11 · 64, 630, 251, 11 | supply site address (line 1, line 2, town, county, Eircode), wrapped across the three lines (upper) |
| Billing address (if different), lines 1–4 | 170, 597.8, 145, 11 · 64, 578 / 558.3 / 538.5, 251, 11 | the customer's billing address when "same as supply" is off; blank otherwise (upper) |
| ✓ Legal entity: Company / Sole trader / Other | 162.3 / 239.2 / 289.3, 518.4, 6.8 | `customers.legal_entity`: limited company or PLC → Company; sole trader → Sole trader; partnership, charity/club, other → Other |
| ✓ VAT exempt: Yes / No | 134 / 166.9, 503.7, 6.8 | `customers.vat_exempt` |
| VAT exempt number | 152, 482, 166, 13 | `customers.vat_exempt_number`, only when VAT exempt (upper) |
| ✓ Priority / special needs: Yes / No | 189.5 / 222.3, 467.3, 6.8 | `customers.priority_customer` |
| Business type | 116, 409, 202, 16.5 | `customers.business_type` (upper) |
| Company reg / VAT no | 140, 382, 178, 16.5 | `customers.company_reg_number` and `vat_number`, joined with " / " (upper) |
| Account contact name | 148, 355.5, 170, 16.5 | primary contact's first name and surname (upper) |
| Telephone no | 115, 329, 203, 16.5 | `customers.phone`, else the contact's landline |
| Mobile no | 102, 302, 216, 16.5 | primary contact's mobile |
| Email | 87, 275, 231, 16.5 | primary contact's email, else the customer's |
| ✓ Own the supply premises: Yes / No | 194.7 / 220.8, 241.2, 6.8 | site occupancy: owner-occupied → Yes; rented or landlord supply → No |
| Duration at premises: year / month | 159.2, 229.6, 20.8, 9 · 206.2, 229.6, 20.7, 9 | whole years and remaining months since `supply_sites.occupied_since` |
| Terms of lease | 284, 229.6, 34, 9 | `supply_sites.lease_terms` (upper) |
| Name of landlord / agent | 201.5, 218.2, 116, 9 | `supply_sites.landlord_name` (upper) |
| Contact no. of landlord / agent | 167.2, 206.7, 150, 9 | `supply_sites.landlord_contact` |
| ✓ Sector: GP 24HR / GP Night Saver / LVMD | 92.1 / 169.1 / 216, 167.7, 13.9 × 9.7 | application: sector (default from the contract: night rate → Night Saver, day rate only → 24HR) |
| ✓ Pricing: Fixed / Variable | 85.1 / 149.4, 143.5, 22.4 × 9.7 | `energy_contracts.price_type`: fixed or fully fixed → Fixed; variable → Variable |
| GP 24 HR unit day rate | 143, 119.3, 48.5, 9.7 | `energy_contracts.day_rate` × 100, when the sector is GP 24HR |
| GP Night Saver unit day rate | 167.5, 106.4, 48.5, 9.7 | `energy_contracts.day_rate` × 100, when Night Saver |
| GP Night Saver unit night rate | 175, 93.4, 48.5, 9.7 | `energy_contracts.night_rate` × 100, when Night Saver |
| ✓ Actual requirement: New connection / C.O.L.E. / Renewal | 400.9, 724.4 · 441.5 / 490.2, 723.4, 6.8 | application: requirements (default: new supply point on the case → New connection; change of legal entity; sale type renewal) |
| ✓ Re-energise meter / Change of supplier | 407.1 / 493, 710.5, 6.8 | application: requirements (default from the opportunity's supply changes) |
| MPRN no | 342, 674, 186, 16 | first meter row: `meter_points.mprn` |
| MCC code | 536, 674, 55, 16 | first meter row: `meter_points.mcc_code` (upper) |
| ✓ Existing Flogas customer: Yes / No | 471.6 / 502.7, 654.9, 6.8 | application (default Yes when the current supplier on the contract is Flogas) |
| Account / GPRN no | 407, 631.5, 187, 17 | application: existing Flogas account, only when an existing customer (default: the contract's current supplier account when that supplier is Flogas) |
| Meter reading: 24hrs / day | 380, 594.5, 214, 17 | first meter row: latest 24-hour (GP 24HR) or day reading |
| Meter reading: night | 364, 569, 230, 17 | first meter row: latest night reading |
| Meter reading: wattless | 377, 544.5, 217, 17 | first meter row: latest wattless reading |
| Date of reading | 399, 519.5, 195, 17 | date of those readings (dd/mm/yyyy) |
| Date of expected changeover | 449, 494.5, 145, 17 | `energy_contracts.proposed_activation_date` |
| Commitment period | 412, 469, 182, 17 | `energy_contracts.term_months`, as "24 MONTHS" |
| Signed by or on behalf of the customer | 337, 427.5, 256, 23 | customer's signature (online signing link or uploaded) |
| Name (block capitals) | 380, 347, 214, 19.5 | application: signatory name (default: account contact) (upper) |
| Position held at company | 433, 322.5, 161, 17 | application: signatory position (default: contact's job title) (upper) |
| Date | 360, 297.5, 234, 17 | date the customer signed |
| Agency ID | 416, 260.5, 178, 10 | `suppliers.agency_id` for Flogas (upper) |
| Agency name / stamp | 416, 245.5, 178, 10 | broker profile company name (upper) |
| Agent signature (optional) | 340, 205.5, 250, 30 | broker's signature, only when the application asks for it |
| Agent name | 385, 177.5, 209, 14 | the opportunity's salesperson (upper) |
| Signed on behalf of Flogas | — | never filled: Flogas signs |
| Flogas name (block capitals) | 406, 90, 181, 20 | application: office use, normally blank (upper) |
| Date of activation | 415, 63.5, 172, 16 | application: office use, normally blank |

### Page 2 — SEPA Direct Debit Mandate

Left blank (apart from the meter table) when the application isn't paying by direct debit.

| PDF location | Box (x, y, w, h) | CRM / application value |
| --- | --- | --- |
| Debtor name | 124, 692.5, 250, 19.5 | bank account name on file (upper) |
| Unique mandate reference | 509, 692.5, 85, 19.5 | application: office use, normally blank |
| Debtor address, lines 1–3 | 137, 671.5, 457, 11 · 67, 657 / 643, 527, 11 | the billing address (or supply address when billing is the same), or a separate debtor address (upper) |
| IBAN account no | 139, 613.5, 455, 19.5 | bank account IBAN (restricted) |
| Bank BIC no | 118, 585.5, 300, 19.5 | bank account BIC (restricted) |
| Payment type: Recurrent | — | printed on the form; nothing to fill |
| Signature (1) and date | 113, 529.5, 310, 19.5 · 468, 529.5, 126, 19.5 | customer's signature and the date they signed |
| Signature (2) and date | 113, 501, 310, 19.5 · 468, 501, 126, 19.5 | second account holder's signature and date, only when one is named |
| MPRN/MCC, rows 1–12 | 61, row + 1.5, 263, 19.5 | each meter row: "MPRN / MCC" |
| Meter read: day/night, rows 1–12 | 330, row + 1.5, 263, 19.5 | each meter row: "day / night" (or the 24-hour reading) |

Row bottoms (y): 317.5, 294.9, 272.2, 249.5, 226.8, 204.1, 181.5, 158.8, 136.1, 113.4, 90.8, 68.1.

## Setting up the template

The Flogas PDF belongs to Flogas and isn't committed. An administrator uploads it once under
**Admin → Supplier forms** (or `npm run forms:presets -w @uo/api -- <folder>`). The upload is
recognised by its SHA-256, linked to the Flogas supplier and marked as the Flogas electricity
workflow template. A new Flogas revision with a different hash needs its boxes measured and a
new layout version before it can be used.

## Verifying the layout

`apps/api/test/unit/flogas-layout.test.ts` checks that every mapped box lies inside its page and
that no two filled boxes overlap. `npm run flogas:fixture -w @uo/api -- <flogas.pdf> <out-folder>`
fills the real PDF with realistic dummy data (long names, a three-line address, twelve meter
rows, every tick box and both mandate signatures) and writes the PDF plus a PNG of each page
for a visual check.
