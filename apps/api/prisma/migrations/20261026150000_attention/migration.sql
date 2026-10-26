-- AlterTable
ALTER TABLE "users" ADD COLUMN     "morning_summary" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "attention_digests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "counts" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attention_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attention_digests_user_id_day_key" ON "attention_digests"("user_id", "day");

-- AddForeignKey
ALTER TABLE "attention_digests" ADD CONSTRAINT "attention_digests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

