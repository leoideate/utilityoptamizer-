-- CreateEnum
CREATE TYPE "PriceType" AS ENUM ('fixed', 'variable', 'fully_fixed');

-- AlterEnum
ALTER TYPE "AddressKind" ADD VALUE 'home';

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "agency_id" TEXT;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "carbon_tax_exempt" BOOLEAN,
ADD COLUMN     "charity_number" TEXT,
ADD COLUMN     "employees" INTEGER,
ADD COLUMN     "legal_entity" "LegalEntity",
ADD COLUMN     "marketing_email" BOOLEAN,
ADD COLUMN     "marketing_phone" BOOLEAN,
ADD COLUMN     "marketing_post" BOOLEAN,
ADD COLUMN     "marketing_sms" BOOLEAN,
ADD COLUMN     "paperless_billing" BOOLEAN,
ADD COLUMN     "priority_customer" BOOLEAN,
ADD COLUMN     "vat_exempt" BOOLEAN,
ADD COLUMN     "vat_exempt_number" TEXT;

-- AlterTable
ALTER TABLE "customer_contacts" ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "supply_sites" ADD COLUMN     "lease_terms" TEXT,
ADD COLUMN     "occupied_since" DATE;

-- AlterTable
ALTER TABLE "meter_points" ADD COLUMN     "annual_quantity_kwh" DECIMAL(14,2),
ADD COLUMN     "dg_code" TEXT,
ADD COLUMN     "meter_serial_2" TEXT,
ADD COLUMN     "mic" DECIMAL(10,2),
ADD COLUMN     "profile_class" TEXT,
ADD COLUMN     "supply_point_capacity_kwh" DECIMAL(14,2),
ADD COLUMN     "voltage" TEXT;

-- AlterTable
ALTER TABLE "energy_contracts" ADD COLUMN     "night_storage_rate" DECIMAL(10,4),
ADD COLUMN     "price_type" "PriceType",
ADD COLUMN     "summer_day_rate" DECIMAL(10,4),
ADD COLUMN     "winter_day_rate" DECIMAL(10,4);


-- Best guess for existing customers, from what the forms used to infer (staff can correct it).
UPDATE "customers" SET "legal_entity" = CASE
    WHEN "business_type" ~* 'sole' THEN 'sole_trader'::"LegalEntity"
    WHEN "business_type" ~* 'partner' THEN 'partnership'::"LegalEntity"
    WHEN "business_type" ~* '\mplc\M' OR "legal_name" ~* '\mplc\M' THEN 'plc'::"LegalEntity"
    WHEN "business_type" ~* '(limited|\mltd\M|\mdac\M|\mclg\M)' OR "legal_name" ~* '(\mltd\M|limited|\mdac\M|\mclg\M)' THEN 'limited_company'::"LegalEntity"
    WHEN "business_type" ~* '(charity|club|association)' THEN 'charity_club'::"LegalEntity"
  END
WHERE "legal_entity" IS NULL;
