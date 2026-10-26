-- CreateTable
CREATE TABLE "assistant_conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "opportunity_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tools_used" TEXT[],
    "model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_feedback" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_conversations_user_id_created_at_idx" ON "assistant_conversations"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "assistant_messages_conversation_id_created_at_idx" ON "assistant_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "assistant_feedback_helpful_created_at_idx" ON "assistant_feedback"("helpful", "created_at");

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_feedback" ADD CONSTRAINT "assistant_feedback_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "assistant_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Assistant history is append-only; only the retention purge (uo.allow_purge) removes old conversations.
CREATE TRIGGER assistant_conversations_append_only
  BEFORE UPDATE OR DELETE ON assistant_conversations
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

CREATE TRIGGER assistant_messages_append_only
  BEFORE UPDATE OR DELETE ON assistant_messages
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

CREATE TRIGGER assistant_feedback_append_only
  BEFORE UPDATE OR DELETE ON assistant_feedback
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();
