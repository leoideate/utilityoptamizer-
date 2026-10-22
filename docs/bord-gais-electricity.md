# Bord Gáis Energy electricity application

The Bord Gáis Energy **Business Electricity Customer Agreement Form** (fixed and variable
product, single site, `BGE/BE/CAF/FVS/0618`; one A4 page, 595 × 842 pt, SHA-256
`7ae07d50…a404c`) is filled straight from the CRM. Unlike the Flogas form, this PDF has
fillable fields (132 AcroForm widgets), so the CRM **fills the PDF's own fields** and regenerates
their appearances instead of drawing over a flat page.

It follows the supplier-application pattern described in `docs/flogas-electricity.md`; this page
covers what differs.

## When it shows

The **Bord Gáis form** tab shows when Product Interest includes **Electricity**, the selected
supplier is **Bord Gáis Energy** and the deal is an energy deal
(`bordGaisElectricityApplies`, `packages/shared/src/bord-gais.ts`). The canonical supplier name
is "Bord Gáis Energy". `isBordGaisSupplier` also accepts the old spellings "Bord Gais",
"Board Gais" and "Bord Gas" (with or without "Energy", accents and case ignored), and a migration
renames existing suppliers with those spellings when no canonical supplier exists yet.

Changing the supplier or product keeps the draft and every version, hides the tab and blocks
generating and sending. The details card warns first when a document was generated.

## Architecture

| Need | Reused | Added |
| --- | --- | --- |
| Supplier application, answers, versions, statuses | `SupplierApplication`, `SupplierApplicationVersion`, `applicationStatus` (shared with Flogas) | kind `bord_gais_electricity` |
| Versions, sending, resending, history | `ApplicationDocuments` (extracted from the Flogas service so both use it) | routes under `/api/opportunities/:id/bord-gais-electricity` (view, save draft, preview, versions, send, resend, history) |
| Template | `FormTemplate.workflow` recognised by SHA-256 | workflow `bord_gais_electricity`; a migration marks an already-uploaded copy of this PDF |
| PDF filling | `GeneratedForm` field snapshot + encrypted values | `forms/acroform.ts`: fills AcroForm fields by name, regenerates appearances, draws the three items that have no field, and verifies stored values and visible appearances after reopening. Fields carry a `pdfField` name in the snapshot; `FormsService` uses the AcroForm filler for any form whose fields name PDF fields, so signed copies are built the same way. |
| Signed copy | Online signing, evidence page, second-person review | The signed copy draws the signature images into the `_es_:signer:signature` boxes, sets the signing dates and is **flattened**. The generated (unsigned) version keeps its fields filled and editable. |

## Database changes (migration `20261023100000_bord_gais_electricity`)

- `LegalEntity` gains `state_body` and `co_operative` (the form's organisation types).
- `meter_readings` gains `raw_value` (the reading exactly as read, so leading zeroes and the digit
  after the slash survive) and `meter_serial` (which of the site's two meters it was read from).
- Suppliers named with an old spelling of Bord Gáis Energy are renamed when no canonical supplier
  exists.
- An existing `form_templates` row for this PDF is marked `workflow = 'bord_gais_electricity'`.

The old overlay preset for this PDF (`forms/presets/bord-gais-electricity.ts`) is retired: the
workflow layout is now the only mapping for it.

## Where each value lives

- **Customer:** legal name, trading name, organisation type (`legal_entity`), main activity
  (`business_type`), date established (`incorporation_date`), CRO number, number of employees,
  telephone, priority customer, marketing preferences.
- **Customer addresses:** account-holder address (registered, else trading), home address, billing
  address.
- **Primary contact:** contact name, position, email, landline, mobile.
- **Supply site:** site name (`label`), supply address, estimated annual consumption.
- **Meter point:** MPRN, MIC, DG code, voltage, MCC, profile class, meter serial 1
  (`meter_number`), meter serial 2 (`meter_serial_2`).
- **Meter readings:** one row per meter and register, with `raw_value` and `meter_serial`. A
  changed reading is a new row.
- **Electricity contract:** existing supplier, price plan name (`pricing_plan`), commitment period
  (`term_months`), rate type (`price_type`), and the rate row for that type (see Rates).
- **Bank account (encrypted):** IBAN, BIC, account holder name.
- **Application answers (Bord Gáis only):** account holder's name when it differs from the legal
  name, premises contact (name, telephone, fax, email, mobile) when it differs from the account
  contact, billing contact name, where the bill goes (account-holder address, supply address or a
  separate one), confirmation period end date when it differs from the calculated one, the rate
  cells the contract has no column for, discounts, the broader-marketing answer, signatory name,
  direct debit yes/no, mandate reference, second account holder.

### Rates

The contract holds the rates of the row that matches the rate type (Fixed Energy Rate → *Energy
Rate* row; Fully Fixed Rate → *Fully Fixed Rate* row; Variable Rate → *Variable Rate* row):
`day_rate` is *24hr rate Block 1* (or *Day rate Block 1* when there is a night rate),
`night_rate`, `night_storage_rate`, `summer_day_rate`, `winter_day_rate` and `standing_charge`.
Every other cell (Block 2 columns, the *Non-energy Rate* row and the other rows) is an application
answer. Unit rates are cent per kWh and the standing charge is cent per day, to two decimals (the
contract stores euro to four), never negative.

Discounts (percent, 0–100) show only for the Variable Rate.

## CRM-to-PDF field mapping

Every widget on the page, by its AcroForm name. "Comb" means one character per printed box.
Ticked boxes use the on-state named in the widget's own appearance dictionary.

### Step 1: account holder details

| PDF field | CRM key | Value |
| --- | --- | --- |
| `Text 6` | `account.legalName` | customer legal name |
| `Text 61` | `account.tradingName` | customer trading name |
| `Text 62` | `account.holderName` | answer, else the legal name |
| `Text 63` | `account.address` | registered (else trading) address, one line |
| `Text 64` | `account.mainActivity` | business type |
| `Date32_es_:signer:date` | `account.dateEstablished` | date established, dd/mm/yyyy (see ambiguity 3) |
| `Check Box 78` (on `Yes`) | `account.type = limited_company` | Limited Co. |
| `Check Box 9` (on `Yes`) | `account.type = plc` | Plc |
| `Check Box 12` (on `Yes`) | `account.type = state_body` | State Body |
| `Check Box 79` (on `Yes`) | `account.type = co_operative` | Co-operative |
| `Check Box 10` (on `Yes`) | `account.type = charity_club` | Association |
| `Check Box 8` (on `Yes`) | `account.type = sole_trader` | Sole Trader |
| `Check Box 13` (on `Yes`) | `account.type = partnership` | Partnership |
| `Text 66` | `account.croNumber` | CRO number |
| *(no field)* drawn at 256, 652.5 (32 × 12) | `account.employees` | number of employees |
| `Text 65` | `account.homeAddress` | home address, one line |
| `Text33` | `contact.name` | primary contact |
| `Text34` | `contact.position` | contact job title |
| `Text36` | `contact.email` | contact email, else customer email |
| `Text35` | `contact.telephone` | contact landline, else customer telephone |
| `Text611` | `contact.mobile` | contact mobile |

### Premises to be supplied and billing

| PDF field | CRM key | Value |
| --- | --- | --- |
| `Text 16` | `premises.siteName` | site label |
| `Text 26` | `premises.address[0]` | supply address, wrapped over two lines |
| `Address` | `premises.address[1]` | |
| `Text 36` | `premises.contactName` | answer, else the account contact |
| `Text 46` | `premises.telephone` | answer, else the contact's telephone |
| `Text 666` | `premises.fax` | answer |
| `Text 56` | `premises.email` | answer, else the contact's email |
| `Text 76` | `premises.mobile` | answer, else the contact's mobile |
| `Check Box31` (on `Yes`) | `premises.priorityCustomer` | customer priority flag |
| `Text612` | `billing.contactName` | answer, else the account contact |
| `Text613` | `billing.address[0]` | the chosen billing address, wrapped over three lines |
| `Address 1` | `billing.address[1]` | |
| `Address 2` | `billing.address[2]` | |

### Steps 2 and 3: supply and meters

| PDF field | CRM key | Value |
| --- | --- | --- |
| `M` (comb 11) | `supply.mprn` | MPRN |
| `MICRow1` | `supply.mic` | MIC (kVA) |
| `DG codeRow1` | `supply.dgCode` | DG / DUoS group |
| `VoltageRow1` | `supply.voltage` | voltage |
| `MCCRow1` | `supply.mcc` | MCC |
| `Profile classRow1` | `supply.profileClass` | profile class |
| `Text37` | `supply.existingSupplier` | contract's current supplier |
| `Text38` | `supply.annualConsumption` | estimated annual consumption, "… kWh" |
| `Meter serial No 1` (comb 9) | `meters[0].serial` | meter number |
| `Meter serial No 2` (comb 9) | `meters[1].serial` | second meter serial |

Readings: each register has four fields: meter 1 before the slash (comb 5), meter 1 after the
slash (comb 1), meter 2 before (comb 5), meter 2 after (comb 1).

| Register | Meter 1 | Meter 1 after "/" | Meter 2 | Meter 2 after "/" |
| --- | --- | --- | --- | --- |
| 24 hour | `undefined` | `undefined_2` | `undefined_3` | `undefined_4` |
| Day | `undefined_5` | `undefined_6` | `undefined_7` | `undefined_8` |
| Night | `undefined_9` | `undefined_10` | `undefined_11` | `undefined_12` |
| Night storage | `Night storage` | `undefined_13` | `undefined_14` | `undefined_15` |
| Wattless | `undefined_16` | `undefined_17` | `undefined_18` | `undefined_19` |

A reading is typed as read, e.g. `01234` or `01234.5`: up to five digits go before the slash and
one digit after it (see ambiguity 1).

### Step 4: agreement period and rates

| PDF field | CRM key | Value |
| --- | --- | --- |
| *(no field)* drawn at 100, 430 (124 × 12) | `agreement.pricePlan` | contract pricing plan |
| *(no field)* drawn at 366, 430 (68 × 12) | `agreement.confirmationEndDate` | answer, else start + commitment − 1 day |
| `Fixed Energy Rate` (on `On`) | `agreement.rateType = fixed` | checkbox |
| `Variable Rate` (text) | `agreement.rateType = variable` | "X" (ambiguity 2) |
| `Fully Fixed Rate` (text) | `agreement.rateType = fully_fixed` | "X" (ambiguity 2) |
| `Check Box39` / `40` / `41` / `42` (on `Yes`) | `agreement.commitment` | 12 / 18 / 24 / 36 months |

Rate table: 36 fields named `<column><row>`, mapped to `agreement.rates.<row>.<column>`:

- columns `24hr rate Block 1`, `24hr rate Block 2`, `Day rate Block 1`, `Day rate Block 2`,
  `Night rate`, `Night storage rate`, `Summer day rate`, `Winter day rate`, `Standing charge`;
- rows `Energy Rate`, `Nonenergy Rate`, `Fully Fixed Rate`, `Variable Rate`.

Discount table: `12 monthsYear 1 discount`, `24 monthsYear 1 discount`,
`36 monthsYear 1 discount`, `24 monthsYear 2 discount`, `36 monthsYear 2 discount`,
`36 monthsYear 3 discount` → `agreement.discounts.y<year>_<months>`. The cells
`12 monthsYear 2 discount`, `12 monthsYear 3 discount` and `24 monthsYear 3 discount` are greyed
out on the form (no year 2 or 3 in a shorter commitment) and are always left blank.

### Declaration, marketing and agent

| PDF field | CRM key | Value |
| --- | --- | --- |
| `Text46` | `declaration.name` | signatory name (answer, else the account contact) |
| `Signature45_es_:signer:signature` | `customer.signature` | customer's signature image |
| `Date44_es_:signer:date` | `customer.signatureDate` | date the customer signed |
| `EMAIL` (on `On`) | `marketing.noEmail` | ticked when the customer does **not** want offers by email |
| `POST` (on `On`) | `marketing.noPost` | ticked when not by post |
| `PHONE including mobile` (on `On`) | `marketing.noPhone` | ticked when not by phone |
| `SMS` (on `On`) | `marketing.noSms` | ticked when not by SMS |
| `of products and services … I would like to receive this` (on `On`) | `marketing.broader` | ticked when the customer **would like** broader marketing (ambiguity 4) |
| `Text43` | `agent.name` | the deal's salesperson |

### SEPA direct debit mandate

Creditor name and address (Bord Gáis Energy, One Warrington Place, Dublin 2), creditor identifier
(IE43SDD300249) and "Type of payment: Recurrent payment" are printed on the form.

| PDF field | CRM key | Value |
| --- | --- | --- |
| `Text47` | `directDebit.mandateReference` | answer; normally left for Bord Gáis |
| `Text48` (made comb 36) | `directDebit.iban` | IBAN (restricted) |
| `Text49` (made comb 11) | `directDebit.bic` | BIC (restricted) |
| `Text78` | `directDebit.accountHolder` | bank account name (restricted) |
| `Signature51_es_:signer:signature` | `directDebit.signature` | customer's signature image |
| `Signature52_es_:signer:signature` | `directDebit.secondSignature` | second account holder's signature image |
| `Date50_es_:signer:date` (made comb 6) | `directDebit.signatureDate` | DDMMYY when the customer signed |
| `Date53_es_:signer:date` | `directDebit.signatureDate` | dd/mm/yyyy when the customer signed |

## Ambiguities that need a visual confirmation

1. **The single box after "/" in each reading row.** Read here as the digit after the decimal
   point (the red tenths dial). If Bord Gáis means something else, only `splitReading` in
   `bord-gais-electricity/layout.ts` changes.
2. **`Variable Rate` and `Fully Fixed Rate` are text fields, not checkboxes**, unlike
   `Fixed Energy Rate`. They are filled with "X". The template also **prints a tick inside the
   Fully Fixed Rate box as part of its artwork** (not a field value), so every copy would look
   Fully Fixed. The CRM covers the inside of that box with white; when Fully Fixed is chosen, the
   field's "X" is drawn above the cover.
3. **"Date established" is named `Date32_es_:signer:date`**, an e-signature date tag. An e-sign
   service that reads these tags would overwrite it with the signing date. The CRM fills it with
   the date the business was established and never treats it as a signature date.
4. **The broader-marketing box is an opt-in.** Its wording is "… I would like to receive this", so
   ticked means the customer wants broader marketing. The four boxes above it are opt-outs
   ("Please tick these boxes if you do not want to receive these offers"). The CRM keeps the
   form's meaning for each and labels them accordingly.
5. **"CRO" is the CRO number, not an organisation type**, and **"No. of Employees", "Price plan
   name" and "Confirmation Period End Date" have no fields**: those three are drawn on the page at
   the printed lines.
6. **The mandate has two dates** (`*Date:` in six boxes and "Mandate date of signature"). Both are
   filled with the date the customer signed.
7. **The IBAN, BIC and `*Date` fields aren't combed** although the page prints 36, 11 and 6 boxes;
   the filler makes them comb fields of those lengths so each character sits in a box.
8. **`Address` and `Address 1` have no default appearance (`/DA`)**, so a PDF library can't size
   their text. The filler gives any such field the form's usual `/Helv 0 Tf 0 g`.

## Electronic signature

The same first-party online signing as Flogas: the customer signs the declaration and the mandate
in one session; a second account holder, when named, gets their own link for the 2nd signature.
Signers can decline; links expire after 14 days and work once. When everyone has signed, the
signed copy is built from the version's stored values (never from the current CRM), checked,
flattened and sent for review by a second person. Generated and signed versions are immutable;
changing anything after sending needs a new version.

## Validation before generating or sending

Legal name; account-holder address; organisation type; CRO number for a limited company or PLC;
home address for a sole trader or partnership; contact name; email or telephone; supply address;
MPRN; meter serial 1 (and serial 2 when meter 2 has readings), readings in the form's format;
existing supplier; estimated annual consumption; price plan; commitment period of 12, 18, 24 or 36
months; rate type; at least one unit rate in the row for the rate type; the marketing preferences
answered; signatory name; and, with direct debit, the IBAN, the BIC and the account holder name.
