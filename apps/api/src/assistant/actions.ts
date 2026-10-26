import { Injectable } from "@nestjs/common";
import type { AssistantAction, Prisma } from "@prisma/client";
import {
  ACTIVITY_TYPES,
  ASSISTANT_ACTION_KINDS,
  ASSISTANT_ACTION_PAYLOADS,
  ASSISTANT_ACTION_TTL_HOURS,
  type AssistantActionKind,
  type AssistantActionPayload,
  PRIORITIES,
  STAGES,
  STAGE_KEYS,
  assistantDealFieldsSchema,
  can,
  createOpportunitySchema,
  formatDate,
} from "@uo/shared";
import { z } from "zod";
import { ActivitiesService } from "../activities/activities.service";
import { AuditService } from "../audit/audit.service";
import type { Actor } from "../common/actor";
import { Conflict, Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { opportunityNumber } from "../common/values";
import { IntegrationsService } from "../integrations/integrations.service";
import { OpportunityAccess } from "../opportunities/access.service";
import { OpportunitiesService } from "../opportunities/opportunities.service";

const dealRef = z.string().trim().min(1).max(60).describe('The deal\'s id, or its number such as "UO-000123".');
const taskRef = z.string().uuid().describe("The task's id, from list_tasks.");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.");

/** What Claude sends to each propose_ tool: deals by number or id, dates as YYYY-MM-DD. */
export const PROPOSAL_INPUTS = {
  create_task: z.object({
    deal: dealRef.optional().describe("The deal the task is for; leave out for a task of the user's own."),
    summary: z.string().trim().min(1).max(300),
    type: z.enum(ACTIVITY_TYPES).default("todo"),
    dueDate: day,
    priority: z.enum(PRIORITIES).default("normal"),
    note: z.string().trim().max(2000).optional(),
  }),
  complete_task: z.object({ task: taskRef, note: z.string().trim().max(2000).optional().describe("The outcome, e.g. what the customer said.") }),
  reschedule_task: z.object({ task: taskRef, dueDate: day }),
  set_follow_up: z.object({ deal: dealRef, date: day, nextAction: z.string().trim().max(300).optional() }),
  create_lead: createOpportunitySchema.pick({ name: true, serviceType: true, companyName: true, contactName: true, email: true, phone: true, followUpDate: true, nextAction: true }),
  update_deal: z.object({ deal: dealRef, fields: assistantDealFieldsSchema }),
  move_stage: z.object({ deal: dealRef, stage: z.enum(STAGE_KEYS) }),
  log_note: z.object({ deal: dealRef, kind: z.enum(["note", "call"]).default("note"), body: z.string().trim().min(1).max(5000), direction: z.enum(["inbound", "outbound"]).optional().describe("For calls: who rang whom.") }),
  send_email: z.object({ deal: dealRef, to: z.string().email(), subject: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(20000) }),
} satisfies Record<AssistantActionKind, z.ZodType>;

export const PROPOSAL_DESCRIPTIONS: Record<AssistantActionKind, string> = {
  create_task: "Prepare a new task (a call, email, to-do…) for the user, on a deal or on its own.",
  complete_task: "Prepare marking one of the user's open tasks done, with an optional outcome note.",
  reschedule_task: "Prepare moving an open task to a new due date.",
  set_follow_up: "Prepare setting a deal's follow-up date (and optionally its next action).",
  create_lead: "Prepare a new lead (opportunity) owned by the user. Use find_deals first to avoid a duplicate.",
  update_deal: "Prepare changes to a deal's contact name, company, email, phone, next action, expected revenue or expected close date.",
  move_stage: "Prepare moving a deal to another stage. If the stage's requirements aren't met you get them back instead; tell the user what's missing. Live / Won is only reached through Activate.",
  log_note: "Prepare adding a note, or a call the user made or took, to a deal's timeline.",
  send_email: "Prepare an email to a customer from a deal, sent from the user's mailbox once they confirm. Write it in the user's voice; get the address from get_deal.",
};

export const proposalTool = (kind: AssistantActionKind) => `propose_${kind}`;
export const proposalKind = (tool: string): AssistantActionKind | null => {
  const kind = tool.replace(/^propose_/, "");
  return tool.startsWith("propose_") && (ASSISTANT_ACTION_KINDS as readonly string[]).includes(kind) ? (kind as AssistantActionKind) : null;
};

export interface Prepared {
  kind: AssistantActionKind;
  summary: string;
  payload: AssistantActionPayload;
  opportunityId: string | null;
}

export type ActionView = Pick<AssistantAction, "id" | "kind" | "summary" | "status" | "error" | "createdAt"> & { payload: unknown; link: string | null };

const ref = (n: number) => `UO-${String(n).padStart(6, "0")}`;
const stageName = (key: string) => STAGES.find((s) => s.key === key)?.name ?? key;
/** Errors whose messages are written for users; anything else is a bug and stays generic. */
const userFacing = (e: unknown): e is Error => e instanceof RuleViolation || e instanceof Forbidden || e instanceof NotFound || e instanceof Conflict;

/**
 * Changes the assistant prepares and the user confirms. `prepare` only checks and describes; it
 * writes nothing. `confirm` makes the change with the user's own access, through the same
 * services the screens use, so access rules, stage gates, the timeline and the audit log apply.
 */
@Injectable()
export class AssistantActions {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly opportunities: OpportunitiesService,
    private readonly activities: ActivitiesService,
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditService,
  ) {}

  /** A deal the user may change, by id or number. One they can only view is refused here, not at Confirm. */
  private async deal(actor: Actor, ref: string) {
    let id = ref;
    if (!/^[0-9a-f-]{36}$/i.test(ref)) {
      const n = opportunityNumber(ref);
      const found = n ? await this.prisma.opportunity.findFirst({ where: { AND: [this.access.visibleWhere(actor), { number: n }] }, select: { id: true } }) : null;
      if (!found) throw new NotFound("Opportunity");
      id = found.id;
    }
    return this.access.writable(actor, id);
  }

  private async task(actor: Actor, id: string) {
    const a = await this.prisma.activity.findUnique({ where: { id }, include: { opportunity: { select: { number: true } } } });
    if (!a || (a.ownerId !== actor.id && !can(actor, "opportunity.write_all"))) throw new NotFound("Task");
    if (a.status !== "open") throw new RuleViolation(["That task is already closed."]);
    return a;
  }

  /** Checks a proposal and describes it. Throws user-facing errors, which the model passes on. */
  async prepare(actor: Actor, kind: AssistantActionKind, raw: unknown): Promise<Prepared> {
    switch (kind) {
      case "create_task": {
        const input = PROPOSAL_INPUTS.create_task.parse(raw);
        const opp = input.deal ? await this.deal(actor, input.deal) : null;
        const payload = { type: input.type, summary: input.summary, note: input.note ?? null, dueDate: input.dueDate, priority: input.priority, opportunityId: opp?.id ?? null };
        return { kind, payload, opportunityId: opp?.id ?? null, summary: `${input.summary}, due ${formatDate(input.dueDate)}${opp ? ` (${ref(opp.number)})` : ""}` };
      }
      case "complete_task": {
        const input = PROPOSAL_INPUTS.complete_task.parse(raw);
        const a = await this.task(actor, input.task);
        return { kind, payload: { activityId: a.id, note: input.note ?? null }, opportunityId: a.opportunityId, summary: `Mark done: ${a.summary}${input.note ? ` (${input.note})` : ""}` };
      }
      case "reschedule_task": {
        const input = PROPOSAL_INPUTS.reschedule_task.parse(raw);
        const a = await this.task(actor, input.task);
        return { kind, payload: { activityId: a.id, dueDate: input.dueDate }, opportunityId: a.opportunityId, summary: `Move "${a.summary}" to ${formatDate(input.dueDate)}` };
      }
      case "set_follow_up": {
        const input = PROPOSAL_INPUTS.set_follow_up.parse(raw);
        const opp = await this.deal(actor, input.deal);
        return {
          kind,
          payload: { opportunityId: opp.id, followUpDate: input.date, nextAction: input.nextAction ?? null },
          opportunityId: opp.id,
          summary: `Follow up on ${ref(opp.number)} ${opp.name} on ${formatDate(input.date)}${input.nextAction ? `: ${input.nextAction}` : ""}`,
        };
      }
      case "create_lead": {
        if (!can(actor, "opportunity.create")) throw new Forbidden("You can't create leads.");
        const payload = PROPOSAL_INPUTS.create_lead.parse(raw);
        return { kind, payload, opportunityId: null, summary: `New lead: ${payload.name}${payload.companyName ? ` (${payload.companyName})` : ""}` };
      }
      case "update_deal": {
        const input = PROPOSAL_INPUTS.update_deal.parse(raw);
        const fields = Object.fromEntries(Object.entries(input.fields).filter(([, v]) => v !== undefined));
        if (!Object.keys(fields).length) throw new RuleViolation(["Say which details to change."]);
        const opp = await this.deal(actor, input.deal);
        const described = Object.entries(fields).map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()} → ${v ?? "(blank)"}`);
        return { kind, payload: { opportunityId: opp.id, fields }, opportunityId: opp.id, summary: `Update ${ref(opp.number)}: ${described.join(", ")}` };
      }
      case "move_stage": {
        const input = PROPOSAL_INPUTS.move_stage.parse(raw);
        if (input.stage === "live_won") throw new RuleViolation(["Use Activate on the deal to move it to Live / Won."]);
        const opp = await this.deal(actor, input.deal);
        const { issues } = await this.opportunities.gatePreview(actor, opp.id, input.stage);
        if (issues.length) throw new RuleViolation(issues);
        return { kind, payload: { opportunityId: opp.id, stage: input.stage }, opportunityId: opp.id, summary: `Move ${ref(opp.number)} ${opp.name} to ${stageName(input.stage)}` };
      }
      case "log_note": {
        const input = PROPOSAL_INPUTS.log_note.parse(raw);
        const opp = await this.deal(actor, input.deal);
        const what = input.kind === "call" ? "Log a call" : "Add a note";
        return {
          kind,
          payload: { opportunityId: opp.id, entry: { kind: input.kind, body: input.body, direction: input.direction ?? null } },
          opportunityId: opp.id,
          summary: `${what} on ${ref(opp.number)} ${opp.name}`,
        };
      }
      case "send_email": {
        const input = PROPOSAL_INPUTS.send_email.parse(raw);
        const opp = await this.deal(actor, input.deal);
        return { kind, payload: { opportunityId: opp.id, email: { to: input.to, subject: input.subject, body: input.body } }, opportunityId: opp.id, summary: `Email ${input.to}: ${input.subject}` };
      }
    }
  }

  /** Stores the proposals an answer made, after the answer itself is stored. */
  async save(actor: Actor, messageId: string, prepared: Prepared[]): Promise<ActionView[]> {
    const rows = [];
    for (const p of prepared) {
      rows.push(
        await this.prisma.assistantAction.create({
          data: { messageId, userId: actor.id, kind: p.kind, summary: p.summary, payload: p.payload as Prisma.InputJsonValue, opportunityId: p.opportunityId },
        }),
      );
    }
    return rows.map((r) => this.view(r));
  }

  view(a: AssistantAction): ActionView {
    const result = (a.result ?? {}) as { opportunityId?: string };
    const dealId = result.opportunityId ?? a.opportunityId;
    return { id: a.id, kind: a.kind, summary: a.summary, status: a.status, error: a.error, createdAt: a.createdAt, payload: a.payload, link: dealId ? `/opportunities/${dealId}` : a.kind.endsWith("_task") ? "/activities" : null };
  }

  private async own(actor: Actor, id: string) {
    const a = await this.prisma.assistantAction.findUnique({ where: { id } });
    if (!a || a.userId !== actor.id) throw new NotFound("Suggestion");
    return a;
  }

  async dismiss(actor: Actor, id: string) {
    const a = await this.own(actor, id);
    const { count } = await this.prisma.assistantAction.updateMany({ where: { id, status: "pending" }, data: { status: "dismissed", decidedAt: new Date() } });
    if (!count) throw new Conflict("This suggestion has already been handled.");
    return this.view({ ...a, status: "dismissed" });
  }

  /** Makes the change, once. A failure is recorded on the card and passed on (422 with the reasons, for rule failures). */
  async confirm(actor: Actor, id: string) {
    const a = await this.own(actor, id);
    if (a.status !== "pending") throw new Conflict("This suggestion has already been handled.");
    if (Date.now() - a.createdAt.getTime() > ASSISTANT_ACTION_TTL_HOURS * 3_600_000) throw new RuleViolation(["This suggestion has expired. Ask the assistant again."]);
    // Claim it first, so a double click can't run it twice.
    const { count } = await this.prisma.assistantAction.updateMany({ where: { id, status: "pending" }, data: { status: "confirming", decidedAt: new Date() } });
    if (!count) throw new Conflict("This suggestion has already been handled.");
    const kind = a.kind as AssistantActionKind;
    try {
      const result = await this.execute(actor, a.id, kind, ASSISTANT_ACTION_PAYLOADS[kind].parse(a.payload));
      const done = await this.prisma.assistantAction.update({ where: { id }, data: { status: "done", result: result as Prisma.InputJsonValue } });
      await this.audit.log(actor, { action: "assistant.action", entityType: "assistant_action", entityId: id, summary: `Confirmed an assistant suggestion: ${ASSISTANT_KIND_NAMES[kind]}`, data: { kind, opportunityId: a.opportunityId, ...result } });
      return this.view(done);
    } catch (e) {
      const error = userFacing(e) ? (e instanceof RuleViolation ? e.issues.join(" ") : e.message) : "Something went wrong. Nothing was changed; try it on the deal itself.";
      await this.prisma.assistantAction.update({ where: { id }, data: { status: "failed", error } });
      throw e;
    }
  }

  private async execute(actor: Actor, actionId: string, kind: AssistantActionKind, payload: AssistantActionPayload): Promise<Record<string, string>> {
    switch (kind) {
      case "create_task": {
        const p = payload as AssistantActionPayload<"create_task">;
        const act = await this.activities.create(actor, { ...p, priority: p.priority ?? "normal", opportunityId: p.opportunityId ?? null });
        return { activityId: act.id };
      }
      case "complete_task": {
        const p = payload as AssistantActionPayload<"complete_task">;
        await this.activities.complete(actor, p.activityId, p.note);
        return { activityId: p.activityId };
      }
      case "reschedule_task": {
        const p = payload as AssistantActionPayload<"reschedule_task">;
        await this.activities.update(actor, p.activityId, { dueDate: p.dueDate });
        return { activityId: p.activityId };
      }
      case "set_follow_up": {
        const p = payload as AssistantActionPayload<"set_follow_up">;
        await this.opportunities.update(actor, p.opportunityId, { followUpDate: p.followUpDate, ...(p.nextAction ? { nextAction: p.nextAction } : {}) });
        return { opportunityId: p.opportunityId };
      }
      case "create_lead": {
        const { id } = await this.opportunities.create(actor, createOpportunitySchema.parse({ ...(payload as AssistantActionPayload<"create_lead">), leadSource: "manual" }));
        return { opportunityId: id };
      }
      case "update_deal": {
        const p = payload as AssistantActionPayload<"update_deal">;
        await this.opportunities.update(actor, p.opportunityId, p.fields);
        return { opportunityId: p.opportunityId };
      }
      case "move_stage": {
        const p = payload as AssistantActionPayload<"move_stage">;
        await this.opportunities.moveStage(actor, p.opportunityId, p.stage);
        return { opportunityId: p.opportunityId };
      }
      case "log_note": {
        const p = payload as AssistantActionPayload<"log_note">;
        await this.opportunities.addTimelineEntry(actor, p.opportunityId, p.entry);
        return { opportunityId: p.opportunityId };
      }
      case "send_email": {
        const p = payload as AssistantActionPayload<"send_email">;
        // The action id is the idempotency key: the same suggestion can never send twice.
        await this.integrations.sendEmail(actor, p.opportunityId, { ...p.email, idempotencyKey: `assistant-${actionId}` });
        return { opportunityId: p.opportunityId };
      }
    }
  }
}

/** For the audit log, which never carries the note or email text itself. */
const ASSISTANT_KIND_NAMES: Record<AssistantActionKind, string> = {
  create_task: "new task",
  complete_task: "task completed",
  reschedule_task: "task rescheduled",
  set_follow_up: "follow-up set",
  create_lead: "new lead",
  update_deal: "deal details changed",
  move_stage: "stage moved",
  log_note: "timeline entry",
  send_email: "email sent",
};
