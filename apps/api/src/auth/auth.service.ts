import { Inject, Injectable } from "@nestjs/common";
import type { Role } from "@uo/shared";
import { ENV, type Env } from "../config/env";
import type { Actor } from "../common/actor";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../common/crypto.service";
import { Forbidden, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from "./passwords";
import { generateSecret, matchTotpStep, otpauthUrl, verifyTotp } from "./totp";

export const MAX_FAILED_LOGINS = 8;
export const LOCKOUT_MINUTES = 15;

export interface SessionInfo {
  actor: Actor;
  csrfToken: string;
  sessionId: string;
}

export class MfaRequired extends Error {
  constructor() {
    super("Enter the 6-digit code from your authenticator app.");
  }
}

/** Generic message: never reveal whether the email exists or the account is locked. */
const BAD_LOGIN = "Email or password is incorrect.";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async login(input: { email: string; password: string; totp?: string; ip?: string; userAgent?: string }) {
    const user = await this.prisma.user.findUnique({ where: { email: input.email }, include: { roles: true } });
    const anon: Actor = { id: "00000000-0000-0000-0000-000000000000", name: "anonymous", roles: [], ip: input.ip };

    if (!user || !user.active) {
      await verifyPassword(input.password, await DUMMY_HASH_PROMISE);
      await this.audit.log(anon, { action: "auth.login_failed", entityType: "user", summary: "Login failed (unknown or inactive account)" });
      throw new Forbidden(BAD_LOGIN);
    }
    const actor: Actor = { id: user.id, name: user.name, roles: user.roles.map((r) => r.role as Role), ip: input.ip };

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.log(actor, { action: "auth.login_locked", entityType: "user", entityId: user.id, summary: "Login attempt while locked" });
      throw new Forbidden(BAD_LOGIN);
    }

    if (!user.passwordLoginEnabled) {
      // Same work and message as a wrong password, and no lockout count: the password isn't checked at all.
      await verifyPassword(input.password, await DUMMY_HASH_PROMISE);
      await this.audit.log(actor, { action: "auth.password_login_refused", entityType: "user", entityId: user.id, summary: "Password sign-in attempted; this account uses single sign-on only" });
      throw new Forbidden(BAD_LOGIN);
    }

    const ok = await verifyPassword(input.password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLogins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : undefined },
      });
      await this.audit.log(actor, {
        action: lock ? "auth.locked" : "auth.login_failed",
        entityType: "user",
        entityId: user.id,
        summary: lock ? `Account locked for ${LOCKOUT_MINUTES} minutes after repeated failures` : "Wrong password",
      });
      throw new Forbidden(BAD_LOGIN);
    }

    if (user.mfaEnabled) {
      if (!input.totp) throw new MfaRequired();
      await this.checkTotp(user, actor, input.totp);
    }
    return this.issueSession(user.id, actor, { ip: input.ip, userAgent: input.userAgent, method: "password" });
  }

  /** Verifies a TOTP code for a user with MFA on; each code works once. Audits failures. */
  async checkTotp(user: { id: string; mfaSecretEnc: string | null }, actor: Actor, code: string) {
    const secret = this.crypto.decrypt(user.mfaSecretEnc);
    const step = secret ? matchTotpStep(secret, code) : null;
    // Conditional update: a code (time step) already used, here or concurrently, is refused.
    const fresh = step === null ? 0 : (await this.prisma.user.updateMany({ where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] }, data: { mfaLastStep: step } })).count;
    if (!fresh) {
      await this.audit.log(actor, { action: "auth.mfa_failed", entityType: "user", entityId: user.id, summary: step === null ? "Wrong authenticator code" : "Authenticator code reused" });
      throw new Forbidden("That code is incorrect.");
    }
  }

  /** Self-service password change: the current password is required, and other sessions end. */
  async changePassword(actor: Actor, sessionId: string, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (!user.passwordLoginEnabled) throw new RuleViolation(["Your account signs in with single sign-on only, so it has no CRM password to change."]);
    if (!(await verifyPassword(current, user.passwordHash))) {
      await this.audit.log(actor, { action: "auth.password_change_failed", entityType: "user", entityId: actor.id, summary: "Wrong current password when changing password" });
      throw new Forbidden("Your current password is incorrect.");
    }
    if (current === next) throw new RuleViolation(["Choose a password you haven't used here before."]);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: actor.id }, data: { passwordHash: await hashPassword(next) } }),
      this.prisma.session.deleteMany({ where: { userId: actor.id, id: { not: sessionId } } }),
    ]);
    await this.audit.log(actor, { action: "auth.password_changed", entityType: "user", entityId: actor.id, summary: "Changed own password; other sessions ended" });
  }

  /** Creates a server-side session after any successful sign-in (password or SSO). */
  async issueSession(userId: string, actor: Actor, meta: { ip?: string; userAgent?: string; method: "password" | "sso"; provider?: string }) {
    const token = CryptoService.token();
    const csrfToken = CryptoService.token(24);
    const expiresAt = new Date(Date.now() + this.env.SESSION_TTL_HOURS * 3_600_000);
    await this.prisma.$transaction([
      this.prisma.session.create({
        data: { tokenHash: CryptoService.sha256(token), csrfToken, userId, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null, expiresAt },
      }),
      this.prisma.user.update({ where: { id: userId }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } }),
    ]);
    await this.audit.log(actor, {
      action: "auth.login",
      entityType: "user",
      entityId: userId,
      summary: meta.method === "sso" ? `Signed in with ${meta.provider}` : "Signed in",
      data: { method: meta.method, ...(meta.provider ? { provider: meta.provider } : {}) },
    });
    return { token, csrfToken, expiresAt, actor };
  }

  async resolve(token: string | undefined): Promise<SessionInfo | null> {
    if (!token) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: CryptoService.sha256(token) },
      include: { user: { include: { roles: true } } },
    });
    if (!session || session.expiresAt < new Date() || !session.user.active) return null;
    const now = Date.now();
    if (now - session.lastSeenAt.getTime() > this.env.SESSION_IDLE_MINUTES * 60_000) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }
    if (now - session.lastSeenAt.getTime() > 60_000) {
      void this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
    }
    return {
      sessionId: session.id,
      csrfToken: session.csrfToken,
      actor: { id: session.user.id, name: session.user.name, roles: session.user.roles.map((r) => r.role as Role) },
    };
  }

  async logout(sessionId: string, actor: Actor) {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
    await this.audit.log(actor, { action: "auth.logout", entityType: "user", entityId: actor.id, summary: "Signed out" });
  }

  /** Ends every session for a user (password reset, deactivation, role change). */
  async revokeAll(userId: string) {
    await this.prisma.session.deleteMany({ where: { userId } });
  }

  async purgeExpiredSessions() {
    const { count } = await this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return count;
  }

  // --- MFA ------------------------------------------------------------------

  /** Step 1: generate a secret. It is stored but not enforced until confirmed with a valid code. */
  async startMfaSetup(actor: Actor) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (user.mfaEnabled) throw new RuleViolation(["Two-factor authentication is already on."]);
    const secret = generateSecret();
    await this.prisma.user.update({ where: { id: actor.id }, data: { mfaSecretEnc: this.crypto.encrypt(secret) } });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  async confirmMfa(actor: Actor, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    const secret = this.crypto.decrypt(user.mfaSecretEnc);
    if (!secret || !verifyTotp(secret, code)) throw new RuleViolation(["That code is incorrect. Check the time on your phone and try again."]);
    await this.prisma.user.update({ where: { id: actor.id }, data: { mfaEnabled: true } });
    await this.audit.log(actor, { action: "auth.mfa_enabled", entityType: "user", entityId: actor.id, summary: "Two-factor authentication turned on" });
  }

  async disableMfa(actor: Actor, targetUserId: string) {
    await this.prisma.user.update({ where: { id: targetUserId }, data: { mfaEnabled: false, mfaSecretEnc: null } });
    await this.audit.log(actor, { action: "auth.mfa_disabled", entityType: "user", entityId: targetUserId, summary: "Two-factor authentication turned off" });
  }
}
