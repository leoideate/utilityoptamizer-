import { Injectable } from "@nestjs/common";
import { Prisma, type Role } from "@prisma/client";
import { RENEWAL_ROUTES, can } from "@uo/shared";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { hashPassword } from "../auth/passwords";
import { SsoService } from "../auth/sso.service";
import type { Actor } from "../common/actor";
import { Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { type Page, pageArgs } from "../common/values";

export const retentionSchema = z.object({
  /** Months after an opportunity is lost before its sensitive documents and principal data are erased. */
  lostSensitiveDataMonths: z.number().int().min(1).max(120),
  /** Months after a live contract ends (and no renewal) before sensitive data is erased. */
  endedSensitiveDataMonths: z.number().int().min(12).max(240),
  /** Years audit-log rows are kept. */
  auditLogYears: z.number().int().min(1).max(20),
  /** Days unconfirmed business-card scans are kept. */
  ocrScanDays: z.number().int().min(1).max(365),
  /** Months call recordings are kept before they're deleted (the call itself stays on the timeline). */
  recordingMonths: z.number().int().min(1).max(120),
});
export type RetentionPolicy = z.infer<typeof retentionSchema>;
export const DEFAULT_RETENTION: RetentionPolicy = { lostSensitiveDataMonths: 24, endedSensitiveDataMonths: 84, auditLogYears: 7, ocrScanDays: 30, recordingMonths: 12 };

export const supplierSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["energy", "merchant"]),
  submissionEmail: z.string().trim().email().nullable().optional().or(z.literal("").transform(() => null)),
  /** Workflow rules by supplier: what a renewal needs, whether a change of entity needs the outgoing holder's consent, black and white copies. */
  renewalRoute: z.enum(RENEWAL_ROUTES).optional(),
  outgoingConsentRequired: z.boolean().optional(),
  monoCopyRequired: z.boolean().optional(),
  active: z.boolean().optional(),
});

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly sso: SsoService,
  ) {}

  private need(actor: Actor, cap: Parameters<typeof can>[1]) {
    if (!can(actor, cap)) throw new Forbidden();
  }

  // --- Users ----------------------------------------------------------------

  async users(actor: Actor) {
    if (!can(actor, "admin.users") && !can(actor, "opportunity.assign")) throw new Forbidden();
    return this.prisma.user.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, active: true, mfaEnabled: true, passwordLoginEnabled: true, lastLoginAt: true, teamId: true, roles: { select: { role: true } }, lockedUntil: true },
    });
  }

  /** Lightweight list for pickers (assign salesperson, task owner). */
  assignableUsers() {
    return this.prisma.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, roles: { select: { role: true } } } });
  }

  async createUser(actor: Actor, input: { name: string; email: string; password: string; roles: Role[]; teamId?: string | null }) {
    this.need(actor, "admin.users");
    if (await this.prisma.user.findUnique({ where: { email: input.email } })) throw new RuleViolation([`A user with email ${input.email} already exists.`]);
    const user = await this.prisma.user.create({
      data: { name: input.name, email: input.email, passwordHash: await hashPassword(input.password), teamId: input.teamId ?? null, roles: { create: input.roles.map((role) => ({ role })) } },
    });
    await this.audit.log(actor, { action: "user.create", entityType: "user", entityId: user.id, summary: `Created user ${user.email}`, data: { roles: input.roles } });
    return { id: user.id };
  }

  async updateUser(actor: Actor, id: string, input: { name?: string; roles?: Role[]; active?: boolean; teamId?: string | null; passwordLogin?: boolean }) {
    this.need(actor, "admin.users");
    if (id === actor.id && input.active === false) throw new RuleViolation(["You can't deactivate your own account."]);
    if (id === actor.id && input.roles && !input.roles.includes("administrator")) throw new RuleViolation(["You can't remove your own Administrator role."]);
    if (input.passwordLogin === false) {
      // Never leave someone with no way in: SSO must work for them first, and admins keep their own fallback.
      if (id === actor.id) throw new RuleViolation(["You can't turn off password sign-in for your own account."]);
      const target = await this.prisma.user.findUnique({ where: { id }, select: { email: true } });
      if (!target) throw new NotFound("User not found.");
      const reason = this.sso.unavailableFor(target.email);
      if (reason) throw new RuleViolation([`${reason} Turn password sign-in off once this user can sign in with single sign-on.`]);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { name: input.name, active: input.active, teamId: input.teamId, passwordLoginEnabled: input.passwordLogin } });
      if (input.roles) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: input.roles.map((role) => ({ userId: id, role })) });
      }
      // Deactivating a user never touches their opportunities: ownership stays for history.
      await this.audit.log(actor, { action: "user.update", entityType: "user", entityId: id, summary: `Updated user: ${Object.keys(input).join(", ")}`, data: input }, tx);
    });
    // Ending sessions on SSO-only means any password session stops now; the user signs back in with SSO.
    if (input.roles || input.active === false || input.passwordLogin === false) await this.auth.revokeAll(id);
  }

  async resetPassword(actor: Actor, id: string, password: string) {
    // Administrators only. People change their own password with POST /auth/password (needs the current one).
    this.need(actor, "admin.users");
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null } });
    await this.auth.revokeAll(id);
    await this.audit.log(actor, { action: "user.password_reset", entityType: "user", entityId: id, summary: "Password reset" });
  }

  async disableMfa(actor: Actor, id: string) {
    this.need(actor, "admin.users");
    await this.auth.disableMfa(actor, id);
  }

  // --- Teams, suppliers ---------------------------------------------------------

  teams() {
    return this.prisma.salesTeam.findMany({ orderBy: { name: "asc" } });
  }

  async createTeam(actor: Actor, name: string) {
    this.need(actor, "admin.users");
    return this.prisma.salesTeam.create({ data: { name } });
  }

  suppliers(kind?: "energy" | "merchant") {
    return this.prisma.supplier.findMany({ where: kind ? { kind } : {}, orderBy: { name: "asc" } });
  }

  async saveSupplier(actor: Actor, input: z.infer<typeof supplierSchema>, id?: string) {
    this.need(actor, "admin.pipeline");
    const s = id ? await this.prisma.supplier.update({ where: { id }, data: input }) : await this.prisma.supplier.create({ data: input });
    await this.audit.log(actor, { action: id ? "supplier.update" : "supplier.create", entityType: "supplier", entityId: s.id, summary: `${id ? "Updated" : "Added"} supplier ${s.name}` });
    return s;
  }

  // --- Settings -------------------------------------------------------------------

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const s = await this.prisma.setting.findUnique({ where: { key } });
    return (s?.value as T) ?? fallback;
  }

  async setSetting(actor: Actor, key: string, value: unknown) {
    this.need(actor, key.startsWith("retention") ? "admin.retention" : key.startsWith("workflow") ? "admin.pipeline" : "admin.integrations");
    await this.prisma.setting.upsert({ where: { key }, create: { key, value: value as Prisma.InputJsonValue }, update: { value: value as Prisma.InputJsonValue } });
    await this.audit.log(actor, { action: "setting.update", entityType: "setting", entityId: key, summary: `Changed setting ${key}` });
  }

  async retention(): Promise<RetentionPolicy> {
    // Policies saved before a setting existed get its default.
    return { ...DEFAULT_RETENTION, ...(await this.getSetting<Partial<RetentionPolicy>>("retention.policy", {})) };
  }

  // --- Audit log ------------------------------------------------------------------

  async auditLog(actor: Actor, q: { entityType?: string; entityId?: string; actorId?: string; action?: string; page: number; pageSize: number }): Promise<Page<unknown>> {
    this.need(actor, "admin.audit");
    const where: Prisma.AuditLogWhereInput = {
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(q.page, q.pageSize) }),
      this.prisma.auditLog.count({ where }),
    ]);
    const actors = await this.prisma.user.findMany({ where: { id: { in: items.map((i) => i.actorId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return { items: items.map((i) => ({ ...i, actorName: actors.find((a) => a.id === i.actorId)?.name ?? (i.actorId ? "Unknown" : "System") })), total, page: q.page, pageSize: q.pageSize };
  }

  async userExists(id: string) {
    if (!(await this.prisma.user.findUnique({ where: { id } }))) throw new NotFound("User");
  }
}
