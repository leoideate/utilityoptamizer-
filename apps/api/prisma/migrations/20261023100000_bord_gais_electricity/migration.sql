
ALTER TYPE "LegalEntity" ADD VALUE 'state_body';
ALTER TYPE "LegalEntity" ADD VALUE 'co_operative';

-- AlterTable
ALTER TABLE "meter_readings" ADD COLUMN     "meter_serial" TEXT,
ADD COLUMN     "raw_value" TEXT;


-- Old spellings of Bord Gáis Energy ("Bord Gais", "Board Gais", "Bord Gas", with or without
-- "Energy") become the canonical name, so the Bord Gáis application finds them. Only when exactly
-- one such supplier exists and the canonical one doesn't: suppliers are never merged here.
WITH aliases AS (
  SELECT id FROM suppliers
  WHERE kind = 'energy'
    AND name <> 'Bord Gáis Energy'
    AND regexp_replace(translate(lower(name), 'áà', 'aa'), '[^a-z]', '', 'g') IN ('bordgais', 'bordgaisenergy', 'boardgais', 'boardgaisenergy', 'bordgas', 'bordgasenergy')
)
UPDATE suppliers SET name = 'Bord Gáis Energy'
WHERE id IN (SELECT id FROM aliases)
  AND (SELECT count(*) FROM aliases) = 1
  AND NOT EXISTS (SELECT 1 FROM suppliers WHERE kind = 'energy' AND name = 'Bord Gáis Energy');

-- A copy of the Bord Gáis electricity form uploaded before this release becomes the workflow's
-- template (its layout now lives in code), and leaves the generic form filler.
UPDATE form_templates SET workflow = 'bord_gais_electricity'
WHERE sha256 = '7ae07d501d0413ab6c9474aa0549bac2dafff7c0ab8149e7f4619863443a404c' AND workflow IS NULL;
