import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type Capability, can } from "@uo/shared";
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { ENV, type Env } from "../config/env";
import type { Actor } from "../common/actor";
import { CAPABILITY, IS_PUBLIC, SKIP_CSRF } from "../common/decorators";
import { Forbidden } from "../common/errors";
import { AuthService } from "./auth.service";

export const SESSION_COOKIE = "uo_session";
export const CSRF_COOKIE = "uo_csrf";
export const CSRF_HEADER = "x-csrf-token";

export type AuthedRequest = Request & { user?: Actor; sessionId?: string; csrfToken?: string };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Resolves the session cookie into `req.user`. Every route needs a session unless marked @Public(). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const session = await this.auth.resolve(req.cookies?.[SESSION_COOKIE]);
    if (session) {
      req.user = { ...session.actor, ip: req.ip };
      req.sessionId = session.sessionId;
      req.csrfToken = session.csrfToken;
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    if (!session) throw new UnauthorizedException("Please sign in.");
    return true;
  }
}

/**
 * CSRF: double-submit token. The session's token is sent in a readable cookie; state-changing
 * requests must echo it in the X-CSRF-Token header. Requests without a session (login) must
 * come from the web app's origin.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [ctx.getHandler(), ctx.getClass()])) return true;

    const origin = req.headers.origin;
    if (origin && origin !== new URL(this.env.WEB_ORIGIN).origin) throw new Forbidden("Request blocked: unexpected origin.");

    if (!req.sessionId) return true; // public, session-less endpoint (login) — origin checked above
    const header = req.headers[CSRF_HEADER];
    const given = Buffer.from(typeof header === "string" ? header : "");
    const expected = Buffer.from(req.csrfToken ?? "");
    if (given.length === 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new Forbidden("Your session security token is missing or out of date. Refresh the page and try again.");
    }
    return true;
  }
}

/** Enforces @RequireCapability against the shared security matrix. */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const cap = this.reflector.getAllAndOverride<Capability>(CAPABILITY, [ctx.getHandler(), ctx.getClass()]);
    if (!cap) return true;
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user || !can(user, cap)) throw new Forbidden();
    return true;
  }
}
