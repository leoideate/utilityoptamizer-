import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { DEFAULT_WORKFLOW_REMINDERS, type WorkflowReminders, createUserSchema, passwordSchema, updateUserSchema, workflowRemindersSchema } from "@uo/shared";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser, RequireCapability } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { StagesService } from "../opportunities/stages.service";
import { AdminService, retentionSchema, supplierSchema } from "./admin.service";
import { RetentionService } from "./retention.service";

const Id = new ParseUUIDPipe({ version: "4" });
const auditQuery = z.object({
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  actorId: z.string().uuid().optional(),
  action: z.string().max(50).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

@ApiTags("admin")
@Controller()
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly stages: StagesService,
    private readonly retention: RetentionService,
  ) {}

  @Get("users/assignable")
  assignable() {
    return this.admin.assignableUsers();
  }

  @Get("suppliers")
  suppliers(@Query("kind") kind?: "energy" | "merchant") {
    return this.admin.suppliers(kind);
  }

  @Get("teams")
  teams() {
    return this.admin.teams();
  }

  @Get("admin/users")
  users(@CurrentUser() a: Actor) {
    return this.admin.users(a);
  }

  @Post("admin/users")
  createUser(@CurrentUser() a: Actor, @Body(new ZodPipe(createUserSchema)) body: z.infer<typeof createUserSchema>) {
    return this.admin.createUser(a, body);
  }

  @Patch("admin/users/:id")
  @HttpCode(204)
  updateUser(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(updateUserSchema)) body: z.infer<typeof updateUserSchema>) {
    return this.admin.updateUser(a, id, body);
  }

  @Post("admin/users/:id/password")
  @HttpCode(204)
  resetPassword(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ password: passwordSchema }))) body: { password: string }) {
    return this.admin.resetPassword(a, id, body.password);
  }

  @Post("admin/users/:id/mfa/disable")
  @HttpCode(204)
  disableMfa(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.admin.disableMfa(a, id);
  }

  @Post("admin/teams")
  createTeam(@CurrentUser() a: Actor, @Body(new ZodPipe(z.object({ name: z.string().trim().min(1).max(100) }))) body: { name: string }) {
    return this.admin.createTeam(a, body.name);
  }

  @Post("admin/suppliers")
  createSupplier(@CurrentUser() a: Actor, @Body(new ZodPipe(supplierSchema)) body: z.infer<typeof supplierSchema>) {
    return this.admin.saveSupplier(a, body);
  }

  @Patch("admin/suppliers/:id")
  updateSupplier(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(supplierSchema)) body: z.infer<typeof supplierSchema>) {
    return this.admin.saveSupplier(a, body, id);
  }

  @Patch("admin/stages/:id")
  @RequireCapability("admin.pipeline")
  renameStage(@Param("id", Id) id: string, @Body(new ZodPipe(z.object({ name: z.string().trim().min(1).max(80) }))) body: { name: string }) {
    return this.stages.rename(id, body.name);
  }

  /** Idempotent: safe to run any time. */
  @Post("admin/stages/sync")
  @RequireCapability("admin.pipeline")
  syncStages() {
    return this.stages.sync();
  }

  @Get("admin/settings/worldpay")
  @RequireCapability("admin.integrations")
  async worldpaySettings() {
    return { submissionEmail: await this.admin.getSetting<string | null>("worldpay.submissionEmail", null), autoAssignLeads: await this.admin.getSetting("automation.autoAssignLeads", true) };
  }

  @Put("admin/settings/worldpay")
  @HttpCode(204)
  async saveWorldpay(@CurrentUser() a: Actor, @Body(new ZodPipe(z.object({ submissionEmail: z.string().email().nullable(), autoAssignLeads: z.boolean() }))) body: { submissionEmail: string | null; autoAssignLeads: boolean }) {
    await this.admin.setSetting(a, "worldpay.submissionEmail", body.submissionEmail);
    await this.admin.setSetting(a, "automation.autoAssignLeads", body.autoAssignLeads);
  }

  /** Reminder and escalation intervals for the back-office workflows. */
  @Get("admin/settings/workflow")
  @RequireCapability("admin.pipeline")
  async workflowSettings() {
    const saved = workflowRemindersSchema.safeParse(await this.admin.getSetting<unknown>("workflow.reminders", null));
    return saved.success ? saved.data : DEFAULT_WORKFLOW_REMINDERS;
  }

  @Put("admin/settings/workflow")
  @RequireCapability("admin.pipeline")
  @HttpCode(204)
  async saveWorkflow(@CurrentUser() a: Actor, @Body(new ZodPipe(workflowRemindersSchema)) body: WorkflowReminders) {
    await this.admin.setSetting(a, "workflow.reminders", body);
  }

  @Get("admin/retention")
  @RequireCapability("admin.retention")
  getRetention() {
    return this.admin.retention();
  }

  @Put("admin/retention")
  @HttpCode(204)
  setRetention(@CurrentUser() a: Actor, @Body(new ZodPipe(retentionSchema)) body: z.infer<typeof retentionSchema>) {
    return this.admin.setSetting(a, "retention.policy", body);
  }

  @Post("admin/retention/run")
  @RequireCapability("admin.retention")
  runRetention() {
    return this.retention.run();
  }

  @Get("admin/audit-log")
  auditLog(@CurrentUser() a: Actor, @Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>) {
    return this.admin.auditLog(a, q);
  }
}
