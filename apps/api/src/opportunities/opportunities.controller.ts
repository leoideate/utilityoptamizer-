import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  STAGE_KEYS,
  type StageKey,
  activateSchema,
  approvalSchema,
  assignSchema,
  bulkAssignSchema,
  closeLeadBatchSchema,
  createOpportunitySchema,
  leadPurgeFilterSchema,
  markLostSchema,
  moveStageSchema,
  opportunityListQuerySchema,
  purgeLeadsSchema,
  timelineEntrySchema,
  updateOpportunitySchema,
} from "@uo/shared";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import type { Actor } from "../common/actor";
import { CurrentUser, RequireCapability } from "../common/decorators";
import { NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { ZodPipe } from "../common/zod.pipe";
import { OpportunityAccess } from "./access.service";
import { OpportunitiesService } from "./opportunities.service";
import { StagesService } from "./stages.service";

const Id = new ParseUUIDPipe({ version: "4" });

@ApiTags("opportunities")
@Controller()
export class OpportunitiesController {
  constructor(
    private readonly opps: OpportunitiesService,
    private readonly stages: StagesService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("stages")
  listStages() {
    return this.stages.list();
  }

  /** Saved views: my_open, all, all_won, energy, worldpay, renewals_due, awaiting_*, compliance_queries, missing_documents, unsigned, unassigned, lost. */
  @Get("opportunities")
  list(@CurrentUser() a: Actor, @Query(new ZodPipe(opportunityListQuerySchema)) q: z.infer<typeof opportunityListQuerySchema>) {
    return this.opps.list(a, q);
  }

  @Get("opportunities/board")
  board(@CurrentUser() a: Actor, @Query(new ZodPipe(opportunityListQuerySchema)) q: z.infer<typeof opportunityListQuerySchema>) {
    return this.opps.board(a, q);
  }

  @Post("opportunities")
  create(@CurrentUser() a: Actor, @Body(new ZodPipe(createOpportunitySchema)) body: z.infer<typeof createOpportunitySchema>) {
    return this.opps.create(a, body);
  }

  @Get("opportunities/:id")
  get(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.opps.workspace(a, id);
  }

  @Patch("opportunities/:id")
  @HttpCode(204)
  update(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(updateOpportunitySchema)) body: z.infer<typeof updateOpportunitySchema>) {
    return this.opps.update(a, id, body);
  }

  @Post("opportunities/:id/stage")
  @HttpCode(204)
  move(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(moveStageSchema)) body: { stage: StageKey }) {
    return this.opps.moveStage(a, id, body.stage);
  }

  @Get("opportunities/:id/gates/:stage")
  gate(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Param("stage") stage: string) {
    if (!STAGE_KEYS.includes(stage as StageKey)) throw new NotFound("Stage");
    return this.opps.gatePreview(a, id, stage as StageKey);
  }

  @Post("opportunities/:id/assign")
  @HttpCode(204)
  assign(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(assignSchema)) body: { ownerId: string | null }) {
    return this.opps.assign(a, id, body.ownerId);
  }

  /** Assigns several opportunities at once; those that can't be (e.g. unassigning a won deal) are listed with the reason. */
  @Post("opportunities/bulk-assign")
  @HttpCode(200)
  @RequireCapability("opportunity.assign")
  bulkAssign(@CurrentUser() a: Actor, @Body(new ZodPipe(bulkAssignSchema)) body: z.infer<typeof bulkAssignSchema>) {
    return this.opps.bulkAssign(a, body.ids, body.ownerId);
  }

  @Post("opportunities/:id/approval")
  @HttpCode(204)
  approval(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(approvalSchema)) body: z.infer<typeof approvalSchema>) {
    if (body.decision === "not_requested") throw new RuleViolation(["Choose approved, rejected or pending."]);
    return this.opps.decideApproval(a, id, body.decision, body.note);
  }

  @Post("opportunities/:id/lost")
  @HttpCode(204)
  lost(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(markLostSchema)) body: { reason: string }) {
    return this.opps.markLost(a, id, body.reason);
  }

  /** CSV import batches (by campaign) with leads still open at New Lead, counted by service. */
  @Get("lead-batches")
  @RequireCapability("opportunity.close_batch")
  leadBatches(@CurrentUser() a: Actor) {
    return this.opps.leadBatches(a);
  }

  /** Marks a batch's open New Lead leads (or one service's) lost with one reason. */
  @Post("lead-batches/close")
  @HttpCode(200)
  @RequireCapability("opportunity.close_batch")
  closeLeadBatch(@CurrentUser() a: Actor, @Body(new ZodPipe(closeLeadBatchSchema)) body: z.infer<typeof closeLeadBatchSchema>) {
    return this.opps.closeLeadBatch(a, body);
  }

  /** How many leads at New Lead a purge with this filter would delete, how many it keeps (worked on), and the import batches. */
  @Get("lead-purge")
  @RequireCapability("opportunity.purge")
  purgePreview(@CurrentUser() a: Actor, @Query(new ZodPipe(leadPurgeFilterSchema)) q: z.infer<typeof leadPurgeFilterSchema>) {
    return this.opps.purgePreview(a, q);
  }

  /** Permanently deletes the untouched leads the filter matches. Administrators only. */
  @Post("lead-purge")
  @HttpCode(200)
  @RequireCapability("opportunity.purge")
  purgeLeads(@CurrentUser() a: Actor, @Body(new ZodPipe(purgeLeadsSchema)) body: z.infer<typeof purgeLeadsSchema>) {
    return this.opps.purgeLeads(a, body);
  }

  @Post("opportunities/:id/reopen")
  @HttpCode(204)
  reopen(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.opps.reopen(a, id);
  }

  @Post("opportunities/:id/activate")
  @HttpCode(204)
  activate(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(activateSchema)) body: z.infer<typeof activateSchema>) {
    return this.opps.activate(a, id, body);
  }

  @Post("opportunities/:id/customer")
  @HttpCode(204)
  linkCustomer(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ customerId: z.string().uuid() }))) body: { customerId: string }) {
    return this.opps.linkCustomer(a, id, body.customerId);
  }

  @Post("opportunities/:id/customer/create")
  createCustomer(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.opps.createCustomerFromOpportunity(a, id);
  }

  // --- Timeline -------------------------------------------------------------

  @Get("opportunities/:id/timeline")
  async timeline(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    await this.access.readable(a, id);
    const entries = await this.prisma.timelineEntry.findMany({ where: { opportunityId: id }, orderBy: { occurredAt: "desc" }, take: 500 });
    const users = await this.prisma.user.findMany({ where: { id: { in: entries.map((e) => e.actorId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    // Calls with a playable recording (the timeline entry itself never changes).
    const callIds = entries.map((e) => (e.data as { callId?: string } | null)?.callId).filter((x): x is string => !!x);
    const recorded = new Set(callIds.length ? (await this.prisma.callLog.findMany({ where: { id: { in: callIds }, recordingKey: { not: null } }, select: { id: true } })).map((c) => c.id) : []);
    return entries.map((e) => ({
      ...e,
      actorName: users.find((u) => u.id === e.actorId)?.name ?? (e.actorId ? "Unknown user" : "System"),
      ...(recorded.has((e.data as { callId?: string } | null)?.callId ?? "") ? { recording: true } : {}),
    }));
  }

  /** Log a call, note, email or WhatsApp message. Entries can't be edited; corrections are new entries. */
  @Post("opportunities/:id/timeline")
  addEntry(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(timelineEntrySchema.extend({ correctsId: z.string().uuid().optional() }))) body: z.infer<typeof timelineEntrySchema> & { correctsId?: string }) {
    return this.opps.addTimelineEntry(a, id, body);
  }
}
