import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { loginSchema, passwordSchema, type Role, ROLES, can, CAPABILITIES, type Capability } from "@uo/shared";
import type { CookieOptions, Response } from "express";
import { z } from "zod";
import { ENV, type Env, assistantEnabled } from "../config/env";
import type { Actor } from "../common/actor";
import { CurrentUser, Public } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { AuthService, MfaRequired } from "./auth.service";
import { type AuthedRequest, CSRF_COOKIE, SESSION_COOKIE } from "./guards";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private cookieBase(): CookieOptions {
    return { secure: this.env.COOKIE_SECURE, sameSite: "lax", path: "/" };
  }

  /** 10 attempts per minute per IP, on top of per-account lockout. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login")
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    try {
      const s = await this.auth.login({ ...body, ip: req.ip, userAgent: req.headers["user-agent"] });
      res.cookie(SESSION_COOKIE, s.token, { ...this.cookieBase(), httpOnly: true, expires: s.expiresAt });
      res.cookie(CSRF_COOKIE, s.csrfToken, { ...this.cookieBase(), httpOnly: false, expires: s.expiresAt });
      return { user: this.describe(s.actor), csrfToken: s.csrfToken };
    } catch (e) {
      if (e instanceof MfaRequired) return { mfaRequired: true, message: e.message };
      throw e;
    }
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @CurrentUser() actor: Actor, @Res({ passthrough: true }) res: Response) {
    if (req.sessionId) await this.auth.logout(req.sessionId, actor);
    res.clearCookie(SESSION_COOKIE, this.cookieBase());
    res.clearCookie(CSRF_COOKIE, this.cookieBase());
  }

  /** Current user, roles and capabilities (the UI uses these to show or hide actions). */
  @Public()
  @Get("me")
  me(@Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthorizedException("Please sign in.");
    return { user: this.describe(req.user), csrfToken: req.csrfToken };
  }

  @Post("password")
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  changePassword(@CurrentUser() actor: Actor, @Req() req: AuthedRequest, @Body(new ZodPipe(z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema }))) body: { currentPassword: string; newPassword: string }) {
    return this.auth.changePassword(actor, req.sessionId!, body.currentPassword, body.newPassword);
  }

  @Post("mfa/setup")
  startMfa(@CurrentUser() actor: Actor) {
    return this.auth.startMfaSetup(actor);
  }

  @Post("mfa/confirm")
  @HttpCode(204)
  confirmMfa(@CurrentUser() actor: Actor, @Body(new ZodPipe(z.object({ code: z.string().regex(/^\d{6}$/) }))) body: { code: string }) {
    return this.auth.confirmMfa(actor, body.code);
  }

  private describe(a: Actor) {
    const capabilities = (Object.keys(CAPABILITIES) as Capability[]).filter((c) => can(a, c));
    return { id: a.id, name: a.name, roles: a.roles.filter((r): r is Role => ROLES.includes(r)), capabilities, features: { chat: this.env.CHAT_ENABLED, aiReading: !!this.env.ANTHROPIC_API_KEY, assistant: assistantEnabled(this.env) } };
  }
}
