-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ringcentral_extension_id" TEXT;

-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "phone_key" TEXT;

-- AlterTable
ALTER TABLE "call_logs" ADD COLUMN     "rc_record_id" TEXT,
ADD COLUMN     "rc_session_id" TEXT,
ALTER COLUMN "user_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_ringcentral_extension_id_key" ON "users"("ringcentral_extension_id");

-- CreateIndex
CREATE INDEX "opportunities_phone_key_idx" ON "opportunities"("phone_key");

-- CreateIndex
CREATE UNIQUE INDEX "call_logs_rc_record_id_key" ON "call_logs"("rc_record_id");

-- CreateIndex
CREATE INDEX "call_logs_rc_session_id_idx" ON "call_logs"("rc_session_id");

