-- CreateEnum
CREATE TYPE "SupplyChange" AS ENUM ('change_of_supplier', 'change_of_legal_entity', 'reenergise_meter');

-- CreateEnum
CREATE TYPE "ProductInterest" AS ENUM ('electricity', 'gas', 'payment_services');

-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "contact_role" TEXT,
ADD COLUMN     "expected_close_date" DATE,
ADD COLUMN     "product_interest" "ProductInterest"[] DEFAULT ARRAY[]::"ProductInterest"[],
ADD COLUMN     "supply_changes" "SupplyChange"[] DEFAULT ARRAY[]::"SupplyChange"[],
ADD COLUMN     "visit_date" DATE;
