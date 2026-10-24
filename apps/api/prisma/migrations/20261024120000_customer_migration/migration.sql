-- Existing customers imported from the master sheet (scripts/migrate-customers.ts).
ALTER TYPE "LeadSource" ADD VALUE 'migration';

-- Identifies the sheet row an opportunity came from, so importing twice creates nothing new.
ALTER TABLE "opportunities" ADD COLUMN "import_key" TEXT;
CREATE UNIQUE INDEX "opportunities_import_key_key" ON "opportunities"("import_key");
