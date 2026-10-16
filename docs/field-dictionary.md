# Field dictionary

Generated from `apps/api/prisma/schema.prisma` (`node scripts/gen-field-dictionary.js`). Table and column names are the database (snake_case) names. Columns ending in `_enc` hold AES-256-GCM ciphertext.

## users

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| name | String | ✓ |  |
| email | String | ✓ | Unique |
| password_hash | String | ✓ |  |
| active | Boolean | ✓ | Default true |
| team_id | UUID |  |  |
| mfa_secret_enc | String |  | TOTP secret (encrypted). MFA is enforced at login when mfaEnabled is true |
| mfa_enabled | Boolean | ✓ | Default false |
| mfa_last_step | Int |  | Last TOTP time step accepted, so a code can't be used twice |
| failed_logins | Int | ✓ | Default 0 |
| locked_until | DateTime |  |  |
| last_login_at | DateTime |  |  |
| callback_phone | String |  | The user's own phone (E.164). Click-to-call rings this number first, then connects the customer |
| created_at | DateTime | ✓ | Default now() |
| updated_at | DateTime | ✓ |  |

## user_roles

| Column | Type | Required | Notes |
|---|---|:-:|---|
| user_id | UUID | ✓ |  |
| role | Enum: administrator, manager, salesperson, operations, compliance, finance | ✓ |  |

## sessions

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| token_hash | String | ✓ | SHA-256 of the session token; the token itself is only ever in the cookie. Unique |
| csrf_token | String | ✓ |  |
| user_id | UUID | ✓ |  |
| ip | String |  |  |
| user_agent | String |  |  |
| expires_at | DateTime | ✓ |  |
| last_seen_at | DateTime | ✓ | Updated (at most once a minute) on use; sessions idle longer than SESSION_IDLE_MINUTES end. Default now() |
| created_at | DateTime | ✓ | Default now() |

## sales_teams

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| name | String | ✓ | Unique |

## stages

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| key | String |  | Stable key used by code and migrations. Null for admin-created extra stages. Unique |
| name | String | ✓ |  |
| sequence | Int | ✓ |  |
| probability | Int | ✓ | Default 10 |
| active | Boolean | ✓ | Default true |

## suppliers

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| name | String | ✓ |  |
| kind | Enum: energy, merchant | ✓ |  |
| submission_email | String |  | Where "Send submission pack" emails applications. Optional |
| active | Boolean | ✓ | Default true |

## customers

Permanent customer record. Merged duplicates are kept with merged_into_id set.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| legal_name | String | ✓ |  |
| trading_name | String |  |  |
| business_type | String |  |  |
| industry | String |  |  |
| company_reg_number | String |  |  |
| vat_registered | Enum: yes, no, pending |  |  |
| vat_number | String |  |  |
| incorporation_date | Date |  |  |
| country_of_incorporation | String |  |  |
| website | String |  |  |
| phone | String |  |  |
| phone_key | String |  | Last 9 digits of phone, for duplicate detection |
| email | String |  |  |
| advertising_method | String |  |  |
| active | Boolean | ✓ | Default true |
| merged_into_id | UUID |  | Set when this record was merged into another. The record is kept, never deleted |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |
| updated_at | DateTime | ✓ |  |

## customer_addresses

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| customer_id | UUID | ✓ |  |
| kind | Enum: registered, trading, billing, postal | ✓ | Default trading |
| line1 | String | ✓ |  |
| line2 | String |  |  |
| city | String |  |  |
| county | String |  |  |
| postcode | String |  |  |
| country | String | ✓ | Default "IE" |

## customer_contacts

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| customer_id | UUID | ✓ |  |
| first_name | String | ✓ |  |
| last_name | String |  |  |
| job_title | String |  |  |
| email | String |  |  |
| phone | String |  |  |
| mobile | String |  |  |
| phone_key | String |  |  |
| mobile_key | String |  |  |
| is_primary | Boolean | ✓ | Default false |
| created_at | DateTime | ✓ | Default now() |

## bank_accounts

Restricted (bank.read). Values encrypted; only the IBAN's last four digits are stored in clear.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| customer_id | UUID | ✓ |  |
| account_name_enc | String | ✓ |  |
| iban_enc | String | ✓ |  |
| iban_last4 | String | ✓ |  |
| bic_enc | String |  |  |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |

## opportunities

One sale (new or renewal). Permanent: can't be deleted or archived (database trigger).

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| number | Int | ✓ | Human-friendly number shown as UO-000123. Unique. Default autoincrement() |
| name | String | ✓ |  |
| customer_id | UUID |  |  |
| contact_name | String |  |  |
| company_name | String |  |  |
| email | String |  |  |
| phone | String |  |  |
| owner_id | UUID |  |  |
| team_id | UUID |  |  |
| stage_id | UUID | ✓ |  |
| stage_entered_at | DateTime | ✓ | Default now() |
| active | Boolean | ✓ | Opportunities are permanent records. No code path sets this to false. Default true |
| outcome | Enum: open, won, lost | ✓ | Default open |
| probability | Int | ✓ | Default 5 |
| expected_revenue | Decimal(14, 2) |  |  |
| service_type | Enum: electricity, gas, dual_fuel, merchant_services | ✓ |  |
| sale_type | Enum: new_sale, renewal | ✓ | Default new_sale |
| lead_source | Enum: manual, telephone, email, website, whatsapp, referral, existing_customer, business_card, csv_import, api, renewal | ✓ | Default manual |
| lead_source_detail | String |  |  |
| campaign | String |  |  |
| next_action | String |  |  |
| follow_up_date | Date |  |  |
| expected_close_date | Date |  |  |
| visit_date | Date |  | Date of the site visit, if one took place |
| contact_role | String |  | Role of the captured contact (owner, manager, bookkeeper...) before a Customer exists |
| product_interest | Enum: electricity, gas, payment_services | ✓ | Default [] |
| supply_changes | Enum: change_of_supplier, change_of_legal_entity, reenergise_meter | ✓ | What changes at the supply point; each adds required documents to the checklist. Default [] |
| internal_approval | Enum: not_requested, pending, approved, rejected | ✓ | Default not_requested |
| internal_approval_by_id | UUID |  |  |
| internal_approval_at | DateTime |  |  |
| selected_supplier_id | UUID |  |  |
| application_status | String |  |  |
| won_at | DateTime |  |  |
| lost_at | DateTime |  |  |
| lost_reason | String |  |  |
| activation_date | Date |  |  |
| renewal_date | Date |  |  |
| previous_opportunity_id | UUID |  |  |
| renewal_source_key | String |  | Identifies the contract(s) a renewal came from. Unique, so renewals can't be duplicated. Unique |
| first_contact_at | DateTime |  |  |
| last_contact_at | DateTime |  |  |
| converted_at | DateTime |  |  |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |
| updated_at | DateTime | ✓ |  |

## stage_history

One row per stage visit; drives "average time in each stage".

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID | ✓ |  |
| stage_id | UUID | ✓ |  |
| entered_at | DateTime | ✓ | Default now() |
| left_at | DateTime |  |  |
| user_id | UUID |  |  |

## supply_sites

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| customer_id | UUID |  |  |
| opportunity_id | UUID |  |  |
| label | String |  |  |
| line1 | String | ✓ |  |
| line2 | String |  |  |
| city | String |  |  |
| county | String |  |  |
| postcode | String |  |  |
| country | String | ✓ | Default "IE" |
| service_type | Enum: electricity, gas, dual_fuel, merchant_services | ✓ |  |
| occupancy_type | Enum: owner_occupied, rented, landlord_supply, other |  |  |
| landlord_name | String |  |  |
| landlord_contact | String |  |  |
| customer_sector | String |  |  |
| annual_consumption_kwh | Decimal(14, 2) |  |  |
| created_at | DateTime | ✓ | Default now() |

## meter_points

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| site_id | UUID | ✓ |  |
| fuel | Enum: electricity, gas | ✓ |  |
| meter_type | String |  |  |
| mprn | String |  |  |
| gprn | String |  |  |
| meter_number | String |  |  |
| mcc_code | String |  |  |
| format_exception_reason | String |  | Why an identifier doesn't match the standard format (new connection, NI site...) |

## meter_readings

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| meter_point_id | UUID | ✓ |  |
| reading_type | Enum: actual, estimated, customer, smart | ✓ |  |
| register | String |  |  |
| value | Decimal(14, 2) | ✓ |  |
| reading_date | Date | ✓ |  |
| document_item_id | UUID |  | Bill or photo the reading came from |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |

## energy_contracts

Live/ended contracts are read-only history; renewals create new rows.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID | ✓ |  |
| customer_id | UUID |  |  |
| site_id | UUID |  |  |
| fuel | Enum: electricity, gas | ✓ |  |
| existing_supplier_name | String |  |  |
| existing_supplier_account | String |  |  |
| selected_supplier_id | UUID |  |  |
| current_contract_start_date | Date |  |  |
| current_contract_end_date | Date |  |  |
| proposed_activation_date | Date |  |  |
| activation_date | Date |  |  |
| term_months | Int |  |  |
| contract_end_date | Date |  | End of the contract we placed; set at activation and drives renewals |
| pricing_plan | String |  |  |
| day_rate | Decimal(10, 4) |  |  |
| night_rate | Decimal(10, 4) |  |  |
| peak_rate | Decimal(10, 4) |  |  |
| other_rate | Decimal(10, 4) |  |  |
| gas_rate | Decimal(10, 4) |  |  |
| standing_charge | Decimal(10, 4) |  |  |
| supplier_reference | String |  |  |
| status | Enum: draft, quoted, selected, signed, submitted, live, ended, cancelled | ✓ | Default draft |
| previous_contract_id | UUID |  | The contract this one renews. Historical contracts are never modified |
| created_at | DateTime | ✓ | Default now() |
| updated_at | DateTime | ✓ |  |

## comparison_quotes

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID | ✓ |  |
| supplier_id | UUID | ✓ |  |
| fuel | Enum: electricity, gas | ✓ |  |
| term_months | Int | ✓ |  |
| day_rate | Decimal(10, 4) |  |  |
| night_rate | Decimal(10, 4) |  |  |
| gas_rate | Decimal(10, 4) |  |  |
| standing_charge | Decimal(10, 4) |  |  |
| estimated_annual_cost | Decimal(14, 2) |  |  |
| estimated_commission | Decimal(14, 2) |  |  |
| notes | String |  |  |
| selected | Boolean | ✓ | Default false |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |

## merchant_applications

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID | ✓ |  |
| customer_id | UUID |  |  |
| campaign | String |  |  |
| legal_entity | Enum: sole_trader, partnership, limited_company, plc, charity_club, other |  |  |
| nature_of_business | String |  |  |
| estimated_annual_turnover | Decimal(14, 2) |  |  |
| card_turnover_pct | Decimal(5, 2) |  |  |
| average_transaction_value | Decimal(12, 2) |  |  |
| settlement_period | String |  |  |
| dashboard_requested | Boolean | ✓ | Default false |
| website | String |  |  |
| advertising_method | String |  |  |
| application_reference | String |  |  |
| customer_accepted_at | DateTime |  |  |
| submission_date | Date |  |  |
| approval_date | Date |  |  |
| activation_date | Date |  |  |
| term_months | Int |  |  |
| contract_end_date | Date |  |  |
| status | Enum: draft, ready, submitted, compliance_query, approved, declined, live, cancelled | ✓ | Default draft |
| previous_application_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |
| updated_at | DateTime | ✓ |  |

## merchant_pricing

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| application_id | UUID | ✓ |  |
| product | String | ✓ |  |
| quantity | Int | ✓ | Default 1 |
| minimum_monthly_charge | Decimal(10, 2) |  |  |
| product_monthly_fee | Decimal(10, 2) |  |  |
| debit_rate | Decimal(6, 3) |  |  |
| credit_rate | Decimal(6, 3) |  |  |
| commercial_rate | Decimal(6, 3) |  |  |
| amex_rate | Decimal(6, 3) |  |  |
| authorisation_fee | Decimal(8, 4) |  |  |
| offer_type | String |  |  |

## principals

Restricted. Date of birth and nationality are encrypted; presence flags let rules run without decrypting. Restricted. Personal values are encrypted; has_* flags let validation run without decrypting.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| application_id | UUID | ✓ |  |
| role | Enum: owner, partner, director, shareholder, trustee, signatory | ✓ |  |
| title | String |  |  |
| first_name | String | ✓ |  |
| middle_name | String |  |  |
| last_name | String | ✓ |  |
| dob_enc | String |  |  |
| nationality_enc | String |  |  |
| has_dob | Boolean | ✓ | Default false |
| has_nationality | Boolean | ✓ | Default false |
| ownership_pct | Decimal(5, 2) |  |  |
| email | String |  |  |
| phone | String |  |  |
| created_at | DateTime | ✓ | Default now() |

## principal_addresses

Residential address history (restricted, address encrypted).

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| principal_id | UUID | ✓ |  |
| address_enc | String | ✓ |  |
| from_date | Date | ✓ |  |
| to_date | Date |  |  |

## merchant_risk

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| application_id | UUID | ✓ | Unique |
| third_party_fulfilment | Boolean | ✓ | Default false |
| stock_stored_elsewhere | Boolean | ✓ | Default false |
| deposits_accepted | Boolean | ✓ | Default false |
| deposit_txn_pct | Decimal(5, 2) |  |  |
| deposit_value_pct | Decimal(5, 2) |  |  |
| deposit_lead_days | Int |  |  |
| balance_lead_days | Int |  |  |
| full_prepayment_accepted | Boolean | ✓ | Default false |
| full_prepayment_pct | Decimal(5, 2) |  |  |
| full_payment_lead_days | Int |  |  |
| compliance_status | Enum: not_started, in_review, query_raised, approved, rejected | ✓ | Default not_started |
| restricted_notes_enc | String |  |  |
| reviewed_by_id | UUID |  |  |
| reviewed_at | DateTime |  |  |

## document_items

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID | ✓ |  |
| customer_id | UUID |  |  |
| merchant_application_id | UUID |  |  |
| energy_contract_id | UUID |  |  |
| document_type | String | ✓ |  |
| required | Boolean | ✓ | Default true |
| sensitive | Boolean | ✓ | Default false |
| requested_at | DateTime |  |  |
| received | Boolean | ✓ | Default false |
| received_at | DateTime |  |  |
| approval | Enum: pending, approved, rejected | ✓ | Default pending |
| reviewer_id | UUID |  |  |
| reviewed_at | DateTime |  |  |
| review_notes | String |  |  |
| expiry_date | Date |  |  |
| created_at | DateTime | ✓ | Default now() |

## document_versions

Every upload is a new version; nothing is overwritten. Every upload is a new version; nothing is overwritten.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| item_id | UUID | ✓ |  |
| version | Int | ✓ |  |
| storage_key | String | ✓ | Unique |
| filename | String | ✓ |  |
| mime_type | String | ✓ |  |
| size | Int | ✓ |  |
| sha256 | String | ✓ |  |
| scan_status | Enum: pending, clean, infected, error, skipped | ✓ | Default pending |
| uploaded_by_id | UUID |  |  |
| uploaded_at | DateTime | ✓ | Default now() |

## FormTemplate

A supplier PDF with positioned fields. Field layout changes bump `version`; generated forms keep a snapshot.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| name | String | ✓ |  |
| supplier_id | UUID |  |  |
| document_type | String | ✓ |  |
| version | Int | ✓ | Default 1 |
| storage_key | String | ✓ | Unique |
| filename | String | ✓ |  |
| sha256 | String | ✓ |  |

## generated_forms

One filled copy of a template for an opportunity. Never edited; regenerating supersedes it.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID | ✓ |  |
| template_id | UUID | ✓ |  |
| template_version | Int | ✓ |  |
| fields | Json | ✓ | Field layout used, so the exact copy can be reproduced |
| values_enc | String | ✓ | Encrypted JSON of the values written (may include an IBAN) |
| changed_fields | Json | ✓ | Field ids whose value was typed or changed instead of coming from the CRM. Default "[]" |
| iban_change_confirmed | Boolean | ✓ | Default false |
| document_item_id | UUID | ✓ |  |
| version_id | UUID | ✓ | The unsigned generated PDF |
| signed_version_id | UUID |  | The PDF with signatures applied, once every required signer has one |
| status | Enum: generated, awaiting_review, approved, rejected, superseded | ✓ | Default generated |
| qc_passed | Boolean | ✓ |  |
| qc_issues | Json | ✓ | Default "[]" |
| reviewed_by_id | UUID |  |  |
| reviewed_at | DateTime |  |  |
| review_note | String |  |  |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |

## form_signatures

An uploaded signature image, authorised for one generated form only.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| form_id | UUID | ✓ |  |
| role | Enum: customer, broker | ✓ |  |
| signer_name | String | ✓ |  |
| signer_capacity | String |  |  |
| authorisation | String | ✓ |  |
| note | String |  |  |
| storage_key | String | ✓ | Unique |
| sha256 | String | ✓ |  |
| uploaded_by_id | UUID |  |  |
| uploaded_at | DateTime | ✓ | Default now() |

## bill_checks

Verification of the previous supplier's bill for a change of supplier.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID | ✓ |  |
| document_version_id | UUID | ✓ | The bill version that was checked; a newer upload needs a new check |
| previous_supplier | String | ✓ |  |
| bill_date | Date |  |  |
| readable | Boolean | ✓ |  |
| customer_name_matches | Boolean | ✓ |  |
| supply_point_matches | Boolean | ✓ |  |
| supplier_matches | Boolean | ✓ |  |
| passed | Boolean | ✓ |  |
| notes | String |  |  |
| verified_by_id | UUID |  |  |
| verified_at | DateTime | ✓ | Default now() |

## signature_templates

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| name | String | ✓ |  |
| provider | String | ✓ |  |
| provider_template_id | String |  |  |
| service_type | Enum: electricity, gas, dual_fuel, merchant_services |  |  |
| active | Boolean | ✓ | Default true |

## signature_requests

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID | ✓ |  |
| template_id | UUID |  |  |
| document_item_id | UUID |  |  |
| title | String | ✓ |  |
| provider | String | ✓ |  |
| provider_request_id | String |  | Unique |
| status | Enum: draft, sent, partially_signed, completed, declined, expired, cancelled | ✓ | Default draft |
| requested_at | DateTime |  |  |
| last_reminder_at | DateTime |  |  |
| completed_at | DateTime |  |  |
| signed_version_id | UUID |  | The signed document, stored as a DocumentVersion |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |

## signers

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| request_id | UUID | ✓ |  |
| role | Enum: customer, broker | ✓ |  |
| name | String | ✓ |  |
| email | String | ✓ |  |
| status | Enum: pending, signed, declined | ✓ | Default pending |
| signed_at | DateTime |  |  |

## activities

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| type | Enum: call, email, whatsapp, meeting, request_documents, review_documents, prepare_comparison, prepare_proposal, obtain_signature, internal_review, submit_application, follow_up_supplier, follow_up_worldpay, renewal_review, compliance_review, todo | ✓ |  |
| summary | String | ✓ |  |
| note | String |  |  |
| due_date | Date | ✓ |  |
| priority | Enum: low, normal, high, urgent | ✓ | Default normal |
| status | Enum: open, done, cancelled | ✓ | Default open |
| reminder_at | DateTime |  |  |
| reminder_sent_at | DateTime |  |  |
| owner_id | UUID |  |  |
| opportunity_id | UUID |  |  |
| customer_id | UUID |  |  |
| automation_key | String |  | Set by automations: at most one OPEN activity per (opportunity, key). Enforced by a partial unique index |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |
| completed_at | DateTime |  |  |

## timeline_entries

Append-only (a database trigger blocks UPDATE and DELETE). Corrections are new entries with `correctsId`. Append-only (trigger). Corrections are new entries with corrects_id.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID |  |  |
| customer_id | UUID |  |  |
| kind | Enum: call, note, email, whatsapp, stage_change, assignment, activity, document, approval, signature, submission, compliance, activation, outcome, system | ✓ |  |
| body | String | ✓ |  |
| direction | String |  |  |
| data | Json |  |  |
| actor_id | UUID |  |  |
| occurred_at | DateTime | ✓ | Default now() |
| created_at | DateTime | ✓ | Default now() |
| corrects_id | UUID |  |  |

## audit_logs

Append-only security/audit log (trigger-protected). Never contains sensitive values. Append-only (trigger). Never contains restricted values.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| actor_id | UUID |  |  |
| action | String | ✓ |  |
| entity_type | String | ✓ |  |
| entity_id | String |  |  |
| summary | String | ✓ |  |
| data | Json |  |  |
| ip | String |  |  |
| created_at | DateTime | ✓ | Default now() |

## notifications

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| user_id | UUID | ✓ |  |
| title | String | ✓ |  |
| body | String |  |  |
| link | String |  |  |
| read_at | DateTime |  |  |
| created_at | DateTime | ✓ | Default now() |

## business_card_scans

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| storage_key | String | ✓ | Unique |
| filename | String | ✓ |  |
| mime_type | String | ✓ |  |
| provider | String | ✓ |  |
| status | Enum: uploaded, processing, processed, failed, confirmed, discarded | ✓ | Default uploaded |
| confidence | Decimal(4, 3) |  |  |
| raw_text | String |  |  |
| parsed | Json |  |  |
| error | String |  |  |
| customer_id | UUID |  |  |
| opportunity_id | UUID |  |  |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |
| updated_at | DateTime | ✓ |  |

## commissions

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID | ✓ |  |
| amount | Decimal(14, 2) | ✓ |  |
| status | Enum: expected, confirmed, paid, clawed_back | ✓ | Default expected |
| note | String |  |  |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |
| updated_at | DateTime | ✓ |  |

## integration_jobs

Outbound integration work (supplier/Worldpay submission, email, WhatsApp, accounting).
Executed by BullMQ with retries; jobs that exhaust retries become `dead` (dead-letter).

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| kind | String | ✓ |  |
| opportunity_id | UUID |  |  |
| payload | Json | ✓ |  |
| status | Enum: pending, running, succeeded, failed, dead | ✓ | Default pending |
| attempts | Int | ✓ | Default 0 |
| last_error | String |  |  |
| result | Json |  |  |
| idempotency_key | String | ✓ | Unique |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |
| updated_at | DateTime | ✓ |  |

## webhook_events

Inbound webhooks, recorded once per provider event id (idempotency).

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| provider | String | ✓ |  |
| event_id | String | ✓ |  |
| payload | Json | ✓ |  |
| status | Enum: pending, running, succeeded, failed, dead | ✓ | Default pending |
| error | String |  |  |
| received_at | DateTime | ✓ | Default now() |
| processed_at | DateTime |  |  |

## settings

| Column | Type | Required | Notes |
|---|---|:-:|---|
| key | String | ✓ | Primary key |
| value | Json | ✓ |  |
| updated_at | DateTime | ✓ |  |

## chat_channels

A conversation: a direct message between two users, a team channel, or the internal discussion on one opportunity.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| kind | Enum: direct, channel, deal | ✓ |  |
| name | String |  |  |
| description | String |  |  |
| is_private | Boolean | ✓ | Private channels are visible to members only. Public channels can be joined by any staff member. Default false |
| direct_key | String |  | For direct messages: the two user ids sorted and joined, so a pair has exactly one conversation. Unique |
| opportunity_id | UUID |  | For deal discussions: access follows the opportunity's permissions. Unique |
| archived | Boolean | ✓ | Default false |
| created_by_id | UUID |  |  |
| created_at | DateTime | ✓ | Default now() |
| last_message_at | DateTime |  |  |

## chat_members

| Column | Type | Required | Notes |
|---|---|:-:|---|
| channel_id | UUID | ✓ |  |
| user_id | UUID | ✓ |  |
| last_read_at | DateTime | ✓ | Default now() |
| muted | Boolean | ✓ | Default false |
| joined_at | DateTime | ✓ | Default now() |

## chat_messages

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| channel_id | UUID | ✓ |  |
| author_id | UUID |  |  |
| body | String |  | Null once deleted (the text is kept in chat_message_revisions) |
| mentions | UUID | ✓ | Default [] |
| edited_at | DateTime |  |  |
| deleted_at | DateTime |  |  |
| created_at | DateTime | ✓ | Default now() |

## chat_message_revisions

Previous text of edited or deleted messages (append-only), for administrators and disputes.

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| message_id | UUID | ✓ |  |
| body | String | ✓ |  |
| created_at | DateTime | ✓ | Default now() |

## chat_attachments

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| message_id | UUID | ✓ |  |
| storage_key | String | ✓ | Unique |
| filename | String | ✓ |  |
| mime_type | String | ✓ |  |
| size | Int | ✓ |  |
| sha256 | String | ✓ |  |
| scan_status | Enum: pending, clean, infected, error, skipped | ✓ | Default pending |
| created_at | DateTime | ✓ | Default now() |

## call_logs

| Column | Type | Required | Notes |
|---|---|:-:|---|
| id | UUID | ✓ | Primary key. Default uuid() |
| opportunity_id | UUID |  |  |
| customer_id | UUID |  |  |
| contact_id | UUID |  |  |
| user_id | UUID | ✓ |  |
| direction | String | ✓ | Default "outbound" |
| to_number | String | ✓ | Customer number (E.164) |
| agent_number | String |  | The staff phone that was rung first (E.164); null for manual calls |
| provider | String | ✓ |  |
| provider_call_id | String |  | Unique |
| status | Enum: initiated, ringing_agent, ringing_customer, in_progress, completed, no_answer, busy, failed, canceled | ✓ | Default initiated |
| started_at | DateTime | ✓ | Default now() |
| answered_at | DateTime |  |  |
| ended_at | DateTime |  |  |
| duration_sec | Int |  |  |
| outcome | String |  |  |
| notes | String |  |  |
| logged_at | DateTime |  | Set once the call has been written to the opportunity timeline (exactly once) |

