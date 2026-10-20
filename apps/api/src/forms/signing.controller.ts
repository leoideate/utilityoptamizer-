import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, StreamableFile } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { publicSignSchema, signingLinkSchema } from "@uo/shared";
import type { Request } from "express";
import type { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser, Public } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { SigningService } from "./signing.service";

const Id = new ParseUUIDPipe({ version: "4" });

/** Online signing links: staff send them; signers use them without a CRM account. */
@ApiTags("forms")
@Controller()
export class SigningController {
  constructor(private readonly signing: SigningService) {}

  @Get("forms/:id/signing-links")
  list(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.signing.list(a, id);
  }

  /** Emails one signer a link to sign this form online. The link's URL is only returned here, once. */
  @Post("forms/:id/signing-links")
  create(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(signingLinkSchema)) body: z.infer<typeof signingLinkSchema>) {
    return this.signing.createLink(a, id, body);
  }

  @Post("signing-links/:id/resend")
  resend(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.signing.resend(a, id);
  }

  @Post("signing-links/:id/revoke")
  @HttpCode(204)
  revoke(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.signing.revoke(a, id);
  }

  // The routes below are authenticated by the link's token: 32 random bytes, stored hashed,
  // expiring and single use. They have no session, so the CSRF guard still checks the Origin.

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("public/sign/:token")
  view(@Param("token") token: string) {
    return this.signing.publicView(token);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("public/sign/:token/document")
  async document(@Param("token") token: string) {
    return new StreamableFile(await this.signing.publicDocument(token), { type: "application/pdf", disposition: "inline" });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("public/sign/:token")
  sign(@Param("token") token: string, @Body(new ZodPipe(publicSignSchema)) body: z.infer<typeof publicSignSchema>, @Req() req: Request, @Headers("user-agent") ua?: string) {
    return this.signing.publicSign(token, body, req.ip ?? null, ua ?? null);
  }
}
