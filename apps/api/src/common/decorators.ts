import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Capability } from "@uo/shared";
import type { Request } from "express";
import type { Actor } from "./actor";

export const IS_PUBLIC = "uo:public";
export const SKIP_CSRF = "uo:skip-csrf";
export const CAPABILITY = "uo:capability";

/** No session required (login, health, inbound webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Exempt from CSRF (only for endpoints authenticated another way, e.g. signed webhooks). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);
/** Requires a capability from the shared security matrix. */
export const RequireCapability = (cap: Capability) => SetMetadata(CAPABILITY, cap);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: Actor }>();
  if (!req.user) throw new Error("CurrentUser used on a public route");
  return req.user;
});
