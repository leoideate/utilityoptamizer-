-- CreateEnum
CREATE TYPE "ChatChannelKind" AS ENUM ('direct', 'channel', 'deal');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('initiated', 'ringing_agent', 'ringing_customer', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'canceled');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "callback_phone" TEXT;

-- CreateTable
CREATE TABLE "chat_channels" (
    "id" UUID NOT NULL,
    "kind" "ChatChannelKind" NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "direct_key" TEXT,
    "opportunity_id" UUID,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMP(3),

    CONSTRAINT "chat_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_members" (
    "channel_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_members_pkey" PRIMARY KEY ("channel_id","user_id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "author_id" UUID,
    "body" TEXT,
    "mentions" UUID[] DEFAULT ARRAY[]::UUID[],
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_message_revisions" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_message_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_logs" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID,
    "customer_id" UUID,
    "contact_id" UUID,
    "user_id" UUID NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "to_number" TEXT NOT NULL,
    "agent_number" TEXT,
    "provider" TEXT NOT NULL,
    "provider_call_id" TEXT,
    "status" "CallStatus" NOT NULL DEFAULT 'initiated',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_sec" INTEGER,
    "outcome" TEXT,
    "notes" TEXT,
    "logged_at" TIMESTAMP(3),

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_channels_direct_key_key" ON "chat_channels"("direct_key");

-- CreateIndex
CREATE UNIQUE INDEX "chat_channels_opportunity_id_key" ON "chat_channels"("opportunity_id");

-- CreateIndex
CREATE INDEX "chat_members_user_id_idx" ON "chat_members"("user_id");

-- CreateIndex
CREATE INDEX "chat_messages_channel_id_created_at_idx" ON "chat_messages"("channel_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_attachments_storage_key_key" ON "chat_attachments"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "call_logs_provider_call_id_key" ON "call_logs"("provider_call_id");

-- CreateIndex
CREATE INDEX "call_logs_opportunity_id_started_at_idx" ON "call_logs"("opportunity_id", "started_at");

-- CreateIndex
CREATE INDEX "call_logs_user_id_started_at_idx" ON "call_logs"("user_id", "started_at");

-- AddForeignKey
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_message_revisions" ADD CONSTRAINT "chat_message_revisions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Message revisions are history: they can be added, never changed or removed silently.
CREATE TRIGGER chat_message_revisions_append_only
  BEFORE UPDATE OR DELETE ON chat_message_revisions
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();
