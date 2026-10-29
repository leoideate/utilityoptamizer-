-- A wrong upload can be removed: the version stays (history) but is no longer the document's file.
ALTER TABLE "document_versions" ADD COLUMN "removed_at" TIMESTAMP(3),
ADD COLUMN "removed_by_id" UUID,
ADD COLUMN "remove_reason" TEXT;
