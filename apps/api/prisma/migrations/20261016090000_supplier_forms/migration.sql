-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('generated', 'awaiting_review', 'approved', 'rejected', 'superseded');

-- CreateTable
CREATE TABLE "form_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "supplier_id" UUID,
    "document_type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "pages" JSONB NOT NULL,
    "fields" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "form_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_forms" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL,
    "fields" JSONB NOT NULL,
    "values_enc" TEXT NOT NULL,
    "changed_fields" JSONB NOT NULL DEFAULT '[]',
    "iban_change_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "document_item_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "signed_version_id" UUID,
    "status" "FormStatus" NOT NULL DEFAULT 'generated',
    "qc_passed" BOOLEAN NOT NULL,
    "qc_issues" JSONB NOT NULL DEFAULT '[]',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_signatures" (
    "id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "role" "SignerRole" NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_capacity" TEXT,
    "authorisation" TEXT NOT NULL,
    "note" TEXT,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_id" UUID,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_checks" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "previous_supplier" TEXT NOT NULL,
    "bill_date" DATE,
    "readable" BOOLEAN NOT NULL,
    "customer_name_matches" BOOLEAN NOT NULL,
    "supply_point_matches" BOOLEAN NOT NULL,
    "supplier_matches" BOOLEAN NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "notes" TEXT,
    "verified_by_id" UUID,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "form_templates_storage_key_key" ON "form_templates"("storage_key");

-- CreateIndex
CREATE INDEX "form_templates_supplier_id_idx" ON "form_templates"("supplier_id");

-- CreateIndex
CREATE INDEX "generated_forms_opportunity_id_idx" ON "generated_forms"("opportunity_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_signatures_storage_key_key" ON "form_signatures"("storage_key");

-- CreateIndex
CREATE INDEX "form_signatures_form_id_idx" ON "form_signatures"("form_id");

-- CreateIndex
CREATE INDEX "bill_checks_opportunity_id_idx" ON "bill_checks"("opportunity_id");

-- AddForeignKey
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_forms" ADD CONSTRAINT "generated_forms_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_forms" ADD CONSTRAINT "generated_forms_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "form_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_signatures" ADD CONSTRAINT "form_signatures_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "generated_forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_checks" ADD CONSTRAINT "bill_checks_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Signature uploads and bill checks are evidence: never changed or deleted.
CREATE TRIGGER form_signatures_append_only
  BEFORE UPDATE OR DELETE ON form_signatures
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

CREATE TRIGGER bill_checks_append_only
  BEFORE UPDATE OR DELETE ON bill_checks
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

-- Generated forms change status but are never deleted.
CREATE TRIGGER generated_forms_permanent
  BEFORE DELETE ON generated_forms
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();
