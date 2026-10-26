import { z } from "zod";
import { activitySchema, createOpportunitySchema, emailSchema, timelineEntrySchema, updateOpportunitySchema } from "./schemas";
import { STAGE_KEYS } from "./stages";

/**
 * Changes the CRM assistant may prepare. The assistant never writes: it stores a proposal, the
 * user reads it on a card and clicks Confirm, and only then does the API make the change through
 * the usual services, as that user, with the usual checks (access, stage gates, audit).
 */
export const ASSISTANT_ACTION_KINDS = ["create_task", "complete_task", "reschedule_task", "set_follow_up", "create_lead", "update_deal", "move_stage", "log_note", "send_email"] as const;
export type AssistantActionKind = (typeof ASSISTANT_ACTION_KINDS)[number];

export const ASSISTANT_ACTION_LABELS: Record<AssistantActionKind, string> = {
  create_task: "New task",
  complete_task: "Complete task",
  reschedule_task: "Reschedule task",
  set_follow_up: "Set follow-up",
  create_lead: "New lead",
  update_deal: "Update deal",
  move_stage: "Move stage",
  log_note: "Add to timeline",
  send_email: "Send email",
};

/** pending → confirming → done | failed, or pending → dismissed. A database trigger allows only these moves. */
export const ASSISTANT_ACTION_STATUSES = ["pending", "confirming", "done", "failed", "dismissed"] as const;
export type AssistantActionStatus = (typeof ASSISTANT_ACTION_STATUSES)[number];

/** A proposal can be confirmed for this long; after that the user asks again (the deal may have moved on). */
export const ASSISTANT_ACTION_TTL_HOURS = 24;

/** Deal fields the assistant may change. Everything else stays on the deal's own form. */
export const assistantDealFieldsSchema = updateOpportunitySchema.pick({
  contactName: true,
  companyName: true,
  email: true,
  phone: true,
  nextAction: true,
  expectedRevenue: true,
  expectedCloseDate: true,
});

/** What is stored for each kind: ids resolved, ready for the service that makes the change. */
export const ASSISTANT_ACTION_PAYLOADS = {
  create_task: activitySchema.pick({ type: true, summary: true, note: true, dueDate: true, priority: true, opportunityId: true }),
  complete_task: z.object({ activityId: z.string().uuid(), note: z.string().trim().max(2000).nullable().optional() }),
  reschedule_task: z.object({ activityId: z.string().uuid(), dueDate: activitySchema.shape.dueDate }),
  set_follow_up: z.object({ opportunityId: z.string().uuid(), followUpDate: activitySchema.shape.dueDate, nextAction: z.string().trim().max(300).nullable().optional() }),
  create_lead: createOpportunitySchema.pick({ name: true, serviceType: true, companyName: true, contactName: true, email: true, phone: true, followUpDate: true, nextAction: true }),
  update_deal: z.object({ opportunityId: z.string().uuid(), fields: assistantDealFieldsSchema }),
  move_stage: z.object({ opportunityId: z.string().uuid(), stage: z.enum(STAGE_KEYS) }),
  log_note: z.object({ opportunityId: z.string().uuid(), entry: timelineEntrySchema.pick({ kind: true, body: true, direction: true }).extend({ kind: z.enum(["note", "call"]) }) }),
  send_email: z.object({ opportunityId: z.string().uuid(), email: emailSchema.omit({ idempotencyKey: true }) }),
} satisfies Record<AssistantActionKind, z.ZodType>;
export type AssistantActionPayload<K extends AssistantActionKind = AssistantActionKind> = z.infer<(typeof ASSISTANT_ACTION_PAYLOADS)[K]>;
