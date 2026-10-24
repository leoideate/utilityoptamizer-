-- Persistent notes belong to the opportunity, independently of the timeline.
ALTER TABLE "opportunities" ADD COLUMN "notes" TEXT;
