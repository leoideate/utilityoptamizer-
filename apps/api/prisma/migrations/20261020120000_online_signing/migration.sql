-- AlterTable
ALTER TABLE "form_signatures" ADD COLUMN     "consent_text" TEXT,
ADD COLUMN     "document_sha256" TEXT,
ADD COLUMN     "signer_email" TEXT,
ADD COLUMN     "signer_ip" TEXT,
ADD COLUMN     "signer_user_agent" TEXT,
ADD COLUMN     "signing_link_id" UUID;

-- CreateTable
CREATE TABLE "signing_links" (
    "id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "role" "SignerRole" NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "opened_at" TIMESTAMP(3),
    "signed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signing_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signing_links_token_hash_key" ON "signing_links"("token_hash");

-- CreateIndex
CREATE INDEX "signing_links_form_id_idx" ON "signing_links"("form_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_signatures_signing_link_id_key" ON "form_signatures"("signing_link_id");

-- AddForeignKey
ALTER TABLE "form_signatures" ADD CONSTRAINT "form_signatures_signing_link_id_fkey" FOREIGN KEY ("signing_link_id") REFERENCES "signing_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signing_links" ADD CONSTRAINT "signing_links_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "generated_forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Signing links change state (opened, signed, revoked) but are never deleted: they are the
-- record of who was asked to sign what.
CREATE TRIGGER signing_links_permanent
  BEFORE DELETE ON signing_links
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

-- A link is signed at most once, and only while it is open.
ALTER TABLE signing_links ADD CONSTRAINT signing_links_signed_or_revoked CHECK (signed_at IS NULL OR revoked_at IS NULL);
