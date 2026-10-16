-- CreateEnum
CREATE TYPE "CustomerPath" AS ENUM ('existing_client', 'new_to_us');

-- CreateEnum
CREATE TYPE "SupplyPath" AS ENUM ('known_supply_point', 'new_supply_point');

-- CreateEnum
CREATE TYPE "LeaseStatus" AS ENUM ('draft', 'signed');

-- CreateEnum
CREATE TYPE "RenewalRoute" AS ENUM ('full_form', 'rate_card_only');

-- CreateEnum
CREATE TYPE "ResponseOutcome" AS ENUM ('accepted', 'changes_required', 'rejected', 'change_confirmed');

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "mono_copy_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "outgoing_consent_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "renewal_route" "RenewalRoute" NOT NULL DEFAULT 'full_form';

-- AlterTable
ALTER TABLE "generated_forms" ADD COLUMN     "change_reason" TEXT,
ADD COLUMN     "changed_since_previous" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "mono_version_id" UUID,
ADD COLUMN     "previous_form_id" UUID;

-- CreateTable
CREATE TABLE "workflow_cases" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "customer_path" "CustomerPath",
    "request_channel" TEXT,
    "request_received_at" DATE,
    "request_note" TEXT,
    "supply_path" "SupplyPath",
    "site_id" UUID,
    "outgoing_customer_id" UUID,
    "outgoing_account_ref" TEXT,
    "outgoing_contract_ref" TEXT,
    "occupancy_date" DATE,
    "supply_source" TEXT,
    "supply_verified_by_id" UUID,
    "supply_verified_at" TIMESTAMP(3),
    "notice_deadline" DATE,
    "target_submission_date" DATE,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lease_checks" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "status" "LeaseStatus" NOT NULL,
    "landlord_name" TEXT NOT NULL,
    "tenant_name" TEXT NOT NULL,
    "tenancy_start_date" DATE,
    "landlord_matches" BOOLEAN NOT NULL,
    "tenant_matches" BOOLEAN NOT NULL,
    "address_matches" BOOLEAN NOT NULL,
    "dates_match" BOOLEAN NOT NULL,
    "signed_by_landlord" BOOLEAN NOT NULL,
    "signed_by_tenant" BOOLEAN NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "notes" TEXT,
    "verified_by_id" UUID,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lease_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms_checks" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "snapshot_hash" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "verified_by_id" UUID,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "recipient" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sent_at" DATE NOT NULL,
    "files" JSONB NOT NULL,
    "delivery_evidence" TEXT NOT NULL,
    "note" TEXT,
    "recorded_by_id" UUID,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_responses" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "outcome" "ResponseOutcome" NOT NULL,
    "received_via" TEXT NOT NULL,
    "received_at" DATE NOT NULL,
    "external_reference" TEXT,
    "effective_date" DATE,
    "reason" TEXT,
    "correction_owner_id" UUID,
    "correction_due_date" DATE,
    "recorded_by_id" UUID,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supply_occupancies" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "from_date" DATE,
    "opportunity_id" UUID,
    "recorded_by_id" UUID,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_occupancies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_cases_opportunity_id_key" ON "workflow_cases"("opportunity_id");

-- CreateIndex
CREATE INDEX "workflow_cases_site_id_idx" ON "workflow_cases"("site_id");

-- CreateIndex
CREATE INDEX "workflow_cases_outgoing_customer_id_idx" ON "workflow_cases"("outgoing_customer_id");

-- CreateIndex
CREATE INDEX "lease_checks_opportunity_id_idx" ON "lease_checks"("opportunity_id");

-- CreateIndex
CREATE INDEX "terms_checks_opportunity_id_idx" ON "terms_checks"("opportunity_id");

-- CreateIndex
CREATE INDEX "submissions_opportunity_id_idx" ON "submissions"("opportunity_id");

-- CreateIndex
CREATE INDEX "submission_responses_submission_id_idx" ON "submission_responses"("submission_id");

-- CreateIndex
CREATE INDEX "submission_responses_opportunity_id_idx" ON "submission_responses"("opportunity_id");

-- CreateIndex
CREATE INDEX "supply_occupancies_site_id_idx" ON "supply_occupancies"("site_id");

-- CreateIndex
CREATE INDEX "supply_occupancies_customer_id_idx" ON "supply_occupancies"("customer_id");

-- AddForeignKey
ALTER TABLE "workflow_cases" ADD CONSTRAINT "workflow_cases_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_cases" ADD CONSTRAINT "workflow_cases_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "supply_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_cases" ADD CONSTRAINT "workflow_cases_outgoing_customer_id_fkey" FOREIGN KEY ("outgoing_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lease_checks" ADD CONSTRAINT "lease_checks_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms_checks" ADD CONSTRAINT "terms_checks_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_responses" ADD CONSTRAINT "submission_responses_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_occupancies" ADD CONSTRAINT "supply_occupancies_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "supply_sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_occupancies" ADD CONSTRAINT "supply_occupancies_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Evidence is never changed or deleted: lease and terms checks, submissions, external responses
-- and the occupancy history of a supply point.
CREATE TRIGGER lease_checks_append_only
  BEFORE UPDATE OR DELETE ON lease_checks
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

CREATE TRIGGER terms_checks_append_only
  BEFORE UPDATE OR DELETE ON terms_checks
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

CREATE TRIGGER submissions_append_only
  BEFORE UPDATE OR DELETE ON submissions
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

CREATE TRIGGER submission_responses_append_only
  BEFORE UPDATE OR DELETE ON submission_responses
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

CREATE TRIGGER supply_occupancies_append_only
  BEFORE UPDATE OR DELETE ON supply_occupancies
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

-- A case is updated as details arrive (every change is audited) but never deleted.
CREATE TRIGGER workflow_cases_permanent
  BEFORE DELETE ON workflow_cases
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();
