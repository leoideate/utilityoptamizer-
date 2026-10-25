import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CAPABILITIES, type Capability, can } from "@uo/shared";
import type { CookieOptions, Response } from "express";
import { z } from "zod";
import { ENV, type Env } from "../config/env";
import { Public } from "../common/decorators";
import { Forbidden } from "../common/errors";
import { ZodPipe } from "../common/zod.pipe";
import { type AuthedRequest, CSRF_COOKIE, SESSION_COOKIE } from "./guards";
import { SsoError, SsoService } from "./sso.service";

export const SSO_FLOW_COOKIE = "uo_sso";
export const SSO_MFA_COOKIE = "uo_sso_mfa";
const SSO_PATH = "/api/auth/sso";

@ApiTags("auth")
@Controller("auth")
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private base(): CookieOptions {
    return { secure: this.env.COOKIE_SECURE, sameSite: "lax", httpOnly: true };
  }

  private setSession(res: Response, s: { token: string; csrfToken: string; expiresAt: Date }) {
    res.cookie(SESSION_COOKIE, s.token, { ...this.base(), path: "/", expires: s.expiresAt });
    res.cookie(CSRF_COOKIE, s.csrfToken, { ...this.base(), httpOnly: false, path: "/", expires: s.expiresAt });
  }

  /** Configured SSO providers, for the login page. */
  @Public()
  @Get("providers")
  providers() {
    return this.sso.providers().map((p) => ({ id: p.id, label: p.label }));
  }

  /** Redirects the browser to the provider's sign-in page. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("sso/:provider/start")
  async start(@Param("provider") provider: string, @Query("next") next: string | undefined, @Res() res: Response) {
    try {
      const { url, cookie, maxAgeMs } = await this.sso.start(provider, next ?? "/");
      res.cookie(SSO_FLOW_COOKIE, cookie, { ...this.base(), path: SSO_PATH, maxAge: maxAgeMs });
      res.redirect(302, url);
    } catch (e) {
      res.redirect(302, `/login?error=${e instanceof SsoError ? e.code : "sso_failed"}`);
    }
  }

  /** The provider redirects here. Success sets the session cookies and returns to the app. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("sso/:provider/callback")
  async callback(
    @Param("provider") provider: string,
    @Query() q: { code?: string; state?: string; error?: string },
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    res.clearCookie(SSO_FLOW_COOKIE, { ...this.base(), path: SSO_PATH });
    try {
      const result = await this.sso.callback(provider, q, req.cookies?.[SSO_FLOW_COOKIE], { ip: req.ip, userAgent: req.headers["user-agent"] });
      if (result.kind === "mfa") {
        res.cookie(SSO_MFA_COOKIE, result.cookie, { ...this.base(), path: SSO_PATH, maxAge: 300_000 });
        return res.redirect(302, `/login?mfa=sso&next=${encodeURIComponent(result.next)}`);
      }
      this.setSession(res, result.session);
      res.redirect(302, result.next);
    } catch (e) {
      res.redirect(302, `/login?error=${e instanceof SsoError ? e.code : "sso_failed"}`);
    }
  }

  /** Second step for SSO users with two-factor on (no session yet; the Origin check applies). */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("sso/mfa")
  @HttpCode(200)
  async mfa(@Body(new ZodPipe(z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") }))) body: { code: string }, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    try {
      const { session, next } = await this.sso.completeMfa(req.cookies?.[SSO_MFA_COOKIE], body.code, { ip: req.ip, userAgent: req.headers["user-agent"] });
      res.clearCookie(SSO_MFA_COOKIE, { ...this.base(), path: SSO_PATH });
      this.setSession(res, session);
      const a = session.actor;
      return { user: { id: a.id, name: a.name, roles: a.roles, capabilities: (Object.keys(CAPABILITIES) as Capability[]).filter((c) => can(a, c)), features: { chat: this.env.CHAT_ENABLED, aiReading: !!this.env.ANTHROPIC_API_KEY } }, csrfToken: session.csrfToken, next };
    } catch (e) {
      if (e instanceof SsoError) throw new Forbidden("Your sign-in expired. Start again with Microsoft or Google.");
      throw e;
    }
  }
}
