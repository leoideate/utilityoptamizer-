-- A form the customer signed on paper: the scanned signed PDF is uploaded and reviewed by someone else.
ALTER TABLE "generated_forms" ADD COLUMN "signed_copy_uploaded_by_id" UUID;
ALTER TABLE "generated_forms" ADD COLUMN "signed_copy_uploaded_at" TIMESTAMP(3);
