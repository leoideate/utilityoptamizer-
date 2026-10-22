-- AlterEnum
ALTER TYPE "SignerRole" ADD VALUE 'account_holder_2';

-- AlterTable
ALTER TABLE "form_templates" ADD COLUMN     "workflow" TEXT;

-- AlterTable
ALTER TABLE "signing_links" ADD COLUMN     "decline_reason" TEXT,
ADD COLUMN     "declined_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "supplier_applications" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "restricted_enc" TEXT,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_application_versions" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "form_id" UUID NOT NULL,
    "layout_version" TEXT NOT NULL,
    "data_enc" TEXT NOT NULL,
    "data_sha256" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_application_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_applications_opportunity_id_kind_key" ON "supplier_applications"("opportunity_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_application_versions_form_id_key" ON "supplier_application_versions"("form_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_application_versions_application_id_version_key" ON "supplier_application_versions"("application_id", "version");

-- AddForeignKey
ALTER TABLE "supplier_applications" ADD CONSTRAINT "supplier_applications_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_application_versions" ADD CONSTRAINT "supplier_application_versions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "supplier_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_application_versions" ADD CONSTRAINT "supplier_application_versions_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "generated_forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Supplier applications are kept for good; their versions are the record of what was generated
-- and sent, so they are never changed or deleted.
CREATE TRIGGER supplier_applications_permanent
  BEFORE DELETE ON supplier_applications
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

CREATE TRIGGER supplier_application_versions_append_only
  BEFORE UPDATE OR DELETE ON supplier_application_versions
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

-- A link ends one way: signed, declined or cancelled.
ALTER TABLE signing_links ADD CONSTRAINT signing_links_declined_alone CHECK (declined_at IS NULL OR (signed_at IS NULL AND revoked_at IS NULL));
