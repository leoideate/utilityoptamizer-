-- AlterTable
ALTER TABLE "call_logs" ADD COLUMN     "rc_recording_id" TEXT,
ADD COLUMN     "recording_deleted_at" TIMESTAMP(3),
ADD COLUMN     "recording_key" TEXT,
ADD COLUMN     "recording_mime" TEXT,
ADD COLUMN     "recording_scan" "ScanStatus",
ADD COLUMN     "recording_size" INTEGER;

