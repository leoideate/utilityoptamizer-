-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('administrator', 'manager', 'salesperson', 'operations', 'compliance', 'finance');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('electricity', 'gas', 'dual_fuel', 'merchant_services');

-- CreateEnum
CREATE TYPE "SaleType" AS ENUM ('new_sale', 'renewal');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('open', 'won', 'lost');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('manual', 'telephone', 'email', 'website', 'whatsapp', 'referral', 'existing_customer', 'business_card', 'csv_import', 'api', 'renewal');

-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('not_requested', 'pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "VatStatus" AS ENUM ('yes', 'no', 'pending');

-- CreateEnum
CREATE TYPE "AddressKind" AS ENUM ('registered', 'trading', 'billing', 'postal');

-- CreateEnum
CREATE TYPE "OccupancyType" AS ENUM ('owner_occupied', 'rented', 'landlord_supply', 'other');

-- CreateEnum
CREATE TYPE "Fuel" AS ENUM ('electricity', 'gas');

-- CreateEnum
CREATE TYPE "ReadingType" AS ENUM ('actual', 'estimated', 'customer', 'smart');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('draft', 'quoted', 'selected', 'signed', 'submitted', 'live', 'ended', 'cancelled');

-- CreateEnum
CREATE TYPE "SupplierKind" AS ENUM ('energy', 'merchant');

-- CreateEnum
CREATE TYPE "LegalEntity" AS ENUM ('sole_trader', 'partnership', 'limited_company', 'plc', 'charity_club', 'other');

-- CreateEnum
CREATE TYPE "PrincipalRole" AS ENUM ('owner', 'partner', 'director', 'shareholder', 'trustee', 'signatory');

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('draft', 'ready', 'submitted', 'compliance_query', 'approved', 'declined', 'live', 'cancelled');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('not_started', 'in_review', 'query_raised', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "DocumentApproval" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('pending', 'clean', 'infected', 'error', 'skipped');

-- CreateEnum
CREATE TYPE "SignatureStatus" AS ENUM ('draft', 'sent', 'partially_signed', 'completed', 'declined', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "SignerRole" AS ENUM ('customer', 'broker');

-- CreateEnum
CREATE TYPE "SignerStatus" AS ENUM ('pending', 'signed', 'declined');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('call', 'email', 'whatsapp', 'meeting', 'request_documents', 'review_documents', 'prepare_comparison', 'prepare_proposal', 'obtain_signature', 'internal_review', 'submit_application', 'follow_up_supplier', 'follow_up_worldpay', 'renewal_review', 'compliance_review', 'todo');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "ActivityStatus" AS ENUM ('open', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "TimelineKind" AS ENUM ('call', 'note', 'email', 'whatsapp', 'stage_change', 'assignment', 'activity', 'document', 'approval', 'signature', 'submission', 'compliance', 'activation', 'outcome', 'system');

-- CreateEnum
CREATE TYPE "OcrStatus" AS ENUM ('uploaded', 'processing', 'processed', 'failed', 'confirmed', 'discarded');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('expected', 'confirmed', 'paid', 'clawed_back');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'dead');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "team_id" UUID,
    "mfa_secret_enc" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_teams" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "sales_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stages" (
    "id" UUID NOT NULL,
    "key" TEXT,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "probability" INTEGER NOT NULL DEFAULT 10,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SupplierKind" NOT NULL,
    "submission_email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trading_name" TEXT,
    "business_type" TEXT,
    "industry" TEXT,
    "company_reg_number" TEXT,
    "vat_registered" "VatStatus",
    "vat_number" TEXT,
    "incorporation_date" DATE,
    "country_of_incorporation" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "phone_key" TEXT,
    "email" TEXT,
    "advertising_method" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "merged_into_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "kind" "AddressKind" NOT NULL DEFAULT 'trading',
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT,
    "county" TEXT,
    "postcode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IE',

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "job_title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "phone_key" TEXT,
    "mobile_key" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "account_name_enc" TEXT NOT NULL,
    "iban_enc" TEXT NOT NULL,
    "iban_last4" TEXT NOT NULL,
    "bic_enc" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "customer_id" UUID,
    "contact_name" TEXT,
    "company_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "owner_id" UUID,
    "team_id" UUID,
    "stage_id" UUID NOT NULL,
    "stage_entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "outcome" "Outcome" NOT NULL DEFAULT 'open',
    "probability" INTEGER NOT NULL DEFAULT 5,
    "expected_revenue" DECIMAL(14,2),
    "service_type" "ServiceType" NOT NULL,
    "sale_type" "SaleType" NOT NULL DEFAULT 'new_sale',
    "lead_source" "LeadSource" NOT NULL DEFAULT 'manual',
    "lead_source_detail" TEXT,
    "campaign" TEXT,
    "next_action" TEXT,
    "follow_up_date" DATE,
    "internal_approval" "ApprovalState" NOT NULL DEFAULT 'not_requested',
    "internal_approval_by_id" UUID,
    "internal_approval_at" TIMESTAMP(3),
    "selected_supplier_id" UUID,
    "application_status" TEXT,
    "won_at" TIMESTAMP(3),
    "lost_at" TIMESTAMP(3),
    "lost_reason" TEXT,
    "activation_date" DATE,
    "renewal_date" DATE,
    "previous_opportunity_id" UUID,
    "renewal_source_key" TEXT,
    "first_contact_at" TIMESTAMP(3),
    "last_contact_at" TIMESTAMP(3),
    "converted_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_history" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "user_id" UUID,

    CONSTRAINT "stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supply_sites" (
    "id" UUID NOT NULL,
    "customer_id" UUID,
    "opportunity_id" UUID,
    "label" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT,
    "county" TEXT,
    "postcode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IE',
    "service_type" "ServiceType" NOT NULL,
    "occupancy_type" "OccupancyType",
    "landlord_name" TEXT,
    "landlord_contact" TEXT,
    "customer_sector" TEXT,
    "annual_consumption_kwh" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_points" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "fuel" "Fuel" NOT NULL,
    "meter_type" TEXT,
    "mprn" TEXT,
    "gprn" TEXT,
    "meter_number" TEXT,
    "mcc_code" TEXT,
    "format_exception_reason" TEXT,

    CONSTRAINT "meter_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_readings" (
    "id" UUID NOT NULL,
    "meter_point_id" UUID NOT NULL,
    "reading_type" "ReadingType" NOT NULL,
    "register" TEXT,
    "value" DECIMAL(14,2) NOT NULL,
    "reading_date" DATE NOT NULL,
    "document_item_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meter_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "energy_contracts" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "customer_id" UUID,
    "site_id" UUID,
    "fuel" "Fuel" NOT NULL,
    "existing_supplier_name" TEXT,
    "existing_supplier_account" TEXT,
    "selected_supplier_id" UUID,
    "current_contract_start_date" DATE,
    "current_contract_end_date" DATE,
    "proposed_activation_date" DATE,
    "activation_date" DATE,
    "term_months" INTEGER,
    "contract_end_date" DATE,
    "pricing_plan" TEXT,
    "day_rate" DECIMAL(10,4),
    "night_rate" DECIMAL(10,4),
    "peak_rate" DECIMAL(10,4),
    "other_rate" DECIMAL(10,4),
    "gas_rate" DECIMAL(10,4),
    "standing_charge" DECIMAL(10,4),
    "supplier_reference" TEXT,
    "status" "ContractStatus" NOT NULL DEFAULT 'draft',
    "previous_contract_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "energy_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparison_quotes" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "fuel" "Fuel" NOT NULL,
    "term_months" INTEGER NOT NULL,
    "day_rate" DECIMAL(10,4),
    "night_rate" DECIMAL(10,4),
    "gas_rate" DECIMAL(10,4),
    "standing_charge" DECIMAL(10,4),
    "estimated_annual_cost" DECIMAL(14,2),
    "estimated_commission" DECIMAL(14,2),
    "notes" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comparison_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_applications" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "customer_id" UUID,
    "campaign" TEXT,
    "legal_entity" "LegalEntity",
    "nature_of_business" TEXT,
    "estimated_annual_turnover" DECIMAL(14,2),
    "card_turnover_pct" DECIMAL(5,2),
    "average_transaction_value" DECIMAL(12,2),
    "settlement_period" TEXT,
    "dashboard_requested" BOOLEAN NOT NULL DEFAULT false,
    "website" TEXT,
    "advertising_method" TEXT,
    "application_reference" TEXT,
    "customer_accepted_at" TIMESTAMP(3),
    "submission_date" DATE,
    "approval_date" DATE,
    "activation_date" DATE,
    "term_months" INTEGER,
    "contract_end_date" DATE,
    "status" "MerchantStatus" NOT NULL DEFAULT 'draft',
    "previous_application_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_pricing" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "product" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "minimum_monthly_charge" DECIMAL(10,2),
    "product_monthly_fee" DECIMAL(10,2),
    "debit_rate" DECIMAL(6,3),
    "credit_rate" DECIMAL(6,3),
    "commercial_rate" DECIMAL(6,3),
    "amex_rate" DECIMAL(6,3),
    "authorisation_fee" DECIMAL(8,4),
    "offer_type" TEXT,

    CONSTRAINT "merchant_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "principals" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "role" "PrincipalRole" NOT NULL,
    "title" TEXT,
    "first_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "last_name" TEXT NOT NULL,
    "dob_enc" TEXT,
    "nationality_enc" TEXT,
    "has_dob" BOOLEAN NOT NULL DEFAULT false,
    "has_nationality" BOOLEAN NOT NULL DEFAULT false,
    "ownership_pct" DECIMAL(5,2),
    "email" TEXT,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "principal_addresses" (
    "id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "address_enc" TEXT NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE,

    CONSTRAINT "principal_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_risk" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "third_party_fulfilment" BOOLEAN NOT NULL DEFAULT false,
    "stock_stored_elsewhere" BOOLEAN NOT NULL DEFAULT false,
    "deposits_accepted" BOOLEAN NOT NULL DEFAULT false,
    "deposit_txn_pct" DECIMAL(5,2),
    "deposit_value_pct" DECIMAL(5,2),
    "deposit_lead_days" INTEGER,
    "balance_lead_days" INTEGER,
    "full_prepayment_accepted" BOOLEAN NOT NULL DEFAULT false,
    "full_prepayment_pct" DECIMAL(5,2),
    "full_payment_lead_days" INTEGER,
    "compliance_status" "ComplianceStatus" NOT NULL DEFAULT 'not_started',
    "restricted_notes_enc" TEXT,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),

    CONSTRAINT "merchant_risk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_items" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "customer_id" UUID,
    "merchant_application_id" UUID,
    "energy_contract_id" UUID,
    "document_type" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "requested_at" TIMESTAMP(3),
    "received" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMP(3),
    "approval" "DocumentApproval" NOT NULL DEFAULT 'pending',
    "reviewer_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_notes" TEXT,
    "expiry_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'pending',
    "uploaded_by_id" UUID,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_template_id" TEXT,
    "service_type" "ServiceType",
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "signature_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "template_id" UUID,
    "document_item_id" UUID,
    "title" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_request_id" TEXT,
    "status" "SignatureStatus" NOT NULL DEFAULT 'draft',
    "requested_at" TIMESTAMP(3),
    "last_reminder_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "signed_version_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signers" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "role" "SignerRole" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "SignerStatus" NOT NULL DEFAULT 'pending',
    "signed_at" TIMESTAMP(3),

    CONSTRAINT "signers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "type" "ActivityType" NOT NULL,
    "summary" TEXT NOT NULL,
    "note" TEXT,
    "due_date" DATE NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "status" "ActivityStatus" NOT NULL DEFAULT 'open',
    "reminder_at" TIMESTAMP(3),
    "reminder_sent_at" TIMESTAMP(3),
    "owner_id" UUID,
    "opportunity_id" UUID,
    "customer_id" UUID,
    "automation_key" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timeline_entries" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID,
    "customer_id" UUID,
    "kind" "TimelineKind" NOT NULL,
    "body" TEXT NOT NULL,
    "direction" TEXT,
    "data" JSONB,
    "actor_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "corrects_id" UUID,

    CONSTRAINT "timeline_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "summary" TEXT NOT NULL,
    "data" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_card_scans" (
    "id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "OcrStatus" NOT NULL DEFAULT 'uploaded',
    "confidence" DECIMAL(4,3),
    "raw_text" TEXT,
    "parsed" JSONB,
    "error" TEXT,
    "customer_id" UUID,
    "opportunity_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_card_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commissions" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'expected',
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_jobs" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "opportunity_id" UUID,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "result" JSONB,
    "idempotency_key" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_teams_name_key" ON "sales_teams"("name");

-- CreateIndex
CREATE UNIQUE INDEX "stages_key_key" ON "stages"("key");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_name_kind_key" ON "suppliers"("name", "kind");

-- CreateIndex
CREATE INDEX "customers_email_idx" ON "customers"("email");

-- CreateIndex
CREATE INDEX "customers_phone_key_idx" ON "customers"("phone_key");

-- CreateIndex
CREATE INDEX "customers_company_reg_number_idx" ON "customers"("company_reg_number");

-- CreateIndex
CREATE INDEX "customers_vat_number_idx" ON "customers"("vat_number");

-- CreateIndex
CREATE INDEX "customers_legal_name_idx" ON "customers"("legal_name");

-- CreateIndex
CREATE INDEX "customer_addresses_customer_id_idx" ON "customer_addresses"("customer_id");

-- CreateIndex
CREATE INDEX "customer_addresses_postcode_idx" ON "customer_addresses"("postcode");

-- CreateIndex
CREATE INDEX "customer_contacts_customer_id_idx" ON "customer_contacts"("customer_id");

-- CreateIndex
CREATE INDEX "customer_contacts_email_idx" ON "customer_contacts"("email");

-- CreateIndex
CREATE INDEX "customer_contacts_phone_key_idx" ON "customer_contacts"("phone_key");

-- CreateIndex
CREATE INDEX "customer_contacts_mobile_key_idx" ON "customer_contacts"("mobile_key");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_number_key" ON "opportunities"("number");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_renewal_source_key_key" ON "opportunities"("renewal_source_key");

-- CreateIndex
CREATE INDEX "opportunities_stage_id_idx" ON "opportunities"("stage_id");

-- CreateIndex
CREATE INDEX "opportunities_owner_id_idx" ON "opportunities"("owner_id");

-- CreateIndex
CREATE INDEX "opportunities_customer_id_idx" ON "opportunities"("customer_id");

-- CreateIndex
CREATE INDEX "opportunities_outcome_idx" ON "opportunities"("outcome");

-- CreateIndex
CREATE INDEX "opportunities_service_type_idx" ON "opportunities"("service_type");

-- CreateIndex
CREATE INDEX "opportunities_renewal_date_idx" ON "opportunities"("renewal_date");

-- CreateIndex
CREATE INDEX "stage_history_opportunity_id_idx" ON "stage_history"("opportunity_id");

-- CreateIndex
CREATE INDEX "supply_sites_customer_id_idx" ON "supply_sites"("customer_id");

-- CreateIndex
CREATE INDEX "supply_sites_opportunity_id_idx" ON "supply_sites"("opportunity_id");

-- CreateIndex
CREATE INDEX "meter_points_site_id_idx" ON "meter_points"("site_id");

-- CreateIndex
CREATE INDEX "meter_points_mprn_idx" ON "meter_points"("mprn");

-- CreateIndex
CREATE INDEX "meter_points_gprn_idx" ON "meter_points"("gprn");

-- CreateIndex
CREATE INDEX "meter_readings_meter_point_id_idx" ON "meter_readings"("meter_point_id");

-- CreateIndex
CREATE INDEX "energy_contracts_opportunity_id_idx" ON "energy_contracts"("opportunity_id");

-- CreateIndex
CREATE INDEX "energy_contracts_status_contract_end_date_idx" ON "energy_contracts"("status", "contract_end_date");

-- CreateIndex
CREATE INDEX "comparison_quotes_opportunity_id_idx" ON "comparison_quotes"("opportunity_id");

-- CreateIndex
CREATE INDEX "merchant_applications_opportunity_id_idx" ON "merchant_applications"("opportunity_id");

-- CreateIndex
CREATE INDEX "merchant_applications_status_contract_end_date_idx" ON "merchant_applications"("status", "contract_end_date");

-- CreateIndex
CREATE INDEX "principals_application_id_idx" ON "principals"("application_id");

-- CreateIndex
CREATE INDEX "principal_addresses_principal_id_idx" ON "principal_addresses"("principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_risk_application_id_key" ON "merchant_risk"("application_id");

-- CreateIndex
CREATE INDEX "document_items_opportunity_id_idx" ON "document_items"("opportunity_id");

-- CreateIndex
CREATE INDEX "document_items_expiry_date_idx" ON "document_items"("expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_storage_key_key" ON "document_versions"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_item_id_version_key" ON "document_versions"("item_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_provider_request_id_key" ON "signature_requests"("provider_request_id");

-- CreateIndex
CREATE INDEX "signature_requests_opportunity_id_idx" ON "signature_requests"("opportunity_id");

-- CreateIndex
CREATE INDEX "activities_owner_id_status_due_date_idx" ON "activities"("owner_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "activities_opportunity_id_idx" ON "activities"("opportunity_id");

-- CreateIndex
CREATE INDEX "timeline_entries_opportunity_id_occurred_at_idx" ON "timeline_entries"("opportunity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "timeline_entries_customer_id_occurred_at_idx" ON "timeline_entries"("customer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "business_card_scans_storage_key_key" ON "business_card_scans"("storage_key");

-- CreateIndex
CREATE INDEX "commissions_opportunity_id_idx" ON "commissions"("opportunity_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_jobs_idempotency_key_key" ON "integration_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "integration_jobs_status_idx" ON "integration_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "sales_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "sales_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_selected_supplier_id_fkey" FOREIGN KEY ("selected_supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_previous_opportunity_id_fkey" FOREIGN KEY ("previous_opportunity_id") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_sites" ADD CONSTRAINT "supply_sites_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_sites" ADD CONSTRAINT "supply_sites_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_points" ADD CONSTRAINT "meter_points_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "supply_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_meter_point_id_fkey" FOREIGN KEY ("meter_point_id") REFERENCES "meter_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "energy_contracts" ADD CONSTRAINT "energy_contracts_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "energy_contracts" ADD CONSTRAINT "energy_contracts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "supply_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "energy_contracts" ADD CONSTRAINT "energy_contracts_selected_supplier_id_fkey" FOREIGN KEY ("selected_supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_quotes" ADD CONSTRAINT "comparison_quotes_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_quotes" ADD CONSTRAINT "comparison_quotes_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_applications" ADD CONSTRAINT "merchant_applications_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_pricing" ADD CONSTRAINT "merchant_pricing_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "merchant_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "principals" ADD CONSTRAINT "principals_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "merchant_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "principal_addresses" ADD CONSTRAINT "principal_addresses_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_risk" ADD CONSTRAINT "merchant_risk_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "merchant_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_items" ADD CONSTRAINT "document_items_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "document_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "signature_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signers" ADD CONSTRAINT "signers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

