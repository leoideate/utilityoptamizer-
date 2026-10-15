-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_last_step" INTEGER;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

