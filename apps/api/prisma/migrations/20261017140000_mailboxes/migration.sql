-- CreateEnum
CREATE TYPE "MailProviderId" AS ENUM ('microsoft', 'google');

-- CreateEnum
CREATE TYPE "MailboxStatus" AS ENUM ('active', 'reauth_required', 'disconnected');

-- CreateTable
CREATE TABLE "mailboxes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "MailProviderId" NOT NULL,
    "address" TEXT NOT NULL,
    "tokens_enc" TEXT,
    "status" "MailboxStatus" NOT NULL DEFAULT 'active',
    "sync_state" JSONB,
    "last_synced_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "thread_id" TEXT,
    "internet_message_id" TEXT,
    "direction" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "from_name" TEXT,
    "to_addresses" TEXT[],
    "cc_addresses" TEXT[],
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "body_enc" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "has_attachments" BOOLEAN NOT NULL DEFAULT false,
    "customer_id" UUID,
    "opportunity_id" UUID,
    "timeline_logged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_user_id_provider_key" ON "mailboxes"("user_id", "provider");

-- CreateIndex
CREATE INDEX "email_messages_mailbox_id_direction_sent_at_idx" ON "email_messages"("mailbox_id", "direction", "sent_at");

-- CreateIndex
CREATE INDEX "email_messages_opportunity_id_sent_at_idx" ON "email_messages"("opportunity_id", "sent_at");

-- CreateIndex
CREATE INDEX "email_messages_customer_id_sent_at_idx" ON "email_messages"("customer_id", "sent_at");

-- CreateIndex
CREATE INDEX "email_messages_thread_id_idx" ON "email_messages"("thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_mailbox_id_provider_message_id_key" ON "email_messages"("mailbox_id", "provider_message_id");

-- AddForeignKey
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Synced email is history: it's updated as it's read or linked to a deal, but never deleted
-- (disconnecting a mailbox keeps what was synced).
CREATE TRIGGER email_messages_permanent
  BEFORE DELETE ON email_messages
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();
