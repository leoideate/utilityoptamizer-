-- Where each call came from: the CRM's Call button ("crm", credited to the user who pressed it) or
-- RingCentral's call log ("call_log", e.g. calls made straight from the RingCentral app or a desk phone).
ALTER TABLE "call_logs" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'crm';
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_origin_check" CHECK ("origin" IN ('crm', 'call_log'));

-- Existing imports: RingCentral rows that weren't started by RingOut but carry a call-log record and our number.
UPDATE "call_logs" SET "origin" = 'call_log'
WHERE "provider" = 'ringcentral' AND "provider_call_id" IS NULL AND "rc_record_id" IS NOT NULL AND "agent_number" IS NOT NULL;
