-- CreateTable
CREATE TABLE "assistant_actions" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "opportunity_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "result" JSONB,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_actions_message_id_idx" ON "assistant_actions"("message_id");

-- CreateIndex
CREATE INDEX "assistant_actions_user_id_created_at_idx" ON "assistant_actions"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "assistant_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Proposals keep their content; only the status moves forward once. The retention purge
-- (uo.allow_purge) deletes them with their conversation.
CREATE OR REPLACE FUNCTION uo_assistant_action_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('uo.allow_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'assistant_actions is append-only: DELETE is not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.message_id <> OLD.message_id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind
     OR NEW.summary <> OLD.summary OR NEW.payload <> OLD.payload OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'assistant_actions: a proposal can''t be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.status = 'pending' AND NEW.status IN ('confirming', 'dismissed'))
     OR (OLD.status = 'confirming' AND NEW.status IN ('done', 'failed')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'assistant_actions: % → % is not allowed', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assistant_actions_guard
  BEFORE UPDATE OR DELETE ON assistant_actions
  FOR EACH ROW EXECUTE FUNCTION uo_assistant_action_guard();
