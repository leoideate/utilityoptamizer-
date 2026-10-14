import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { signatureRequestSchema } from "@uo/shared";
import type { Request } from "express";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser, Public, SkipCsrf } from "../common/decorators";
import { RuleViolation } from "../common/errors";
import { ZodPipe } from "../common/zod.pipe";
import { uploadInterceptor } from "../documents/documents.controller";
import { WEBHOOK_SIGNATURE_HEADER } from "./provider";
import { SignaturesService } from "./signatures.service";

const Id = new ParseUUIDPipe({ version: "4" });

@ApiTags("signatures")
@Controller()
export class SignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

  @Get("opportunities/:id/signatures")
  list(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.signatures.list(a, id);
  }

  @Post("opportunities/:id/signatures")
  request(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(signatureRequestSchema)) body: z.infer<typeof signatureRequestSchema>) {
    return this.signatures.request(a, id, body);
  }

  @Post("signatures/:id/remind")
  @HttpCode(204)
  remind(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.signatures.remind(a, id);
  }

  @Post("signatures/:id/cancel")
  @HttpCode(204)
  cancel(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.signatures.cancel(a, id);
  }

  /** Manual provider: record a signer's signature, optionally with the signed copy. */
  @Post("signatures/:id/signers/:signerId/signed")
  @HttpCode(204)
  @UseInterceptors(uploadInterceptor())
  signed(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Param("signerId", Id) signerId: string, @UploadedFile() file?: Express.Multer.File) {
    return this.signatures.recordSigned(a, id, signerId, file);
  }

  @Get("signature-templates")
  templates() {
    return this.signatures.templates();
  }

  @Post("signature-templates")
  createTemplate(
    @CurrentUser() a: Actor,
    @Body(new ZodPipe(z.object({ name: z.string().min(1).max(200), serviceType: z.enum(["electricity", "gas", "dual_fuel", "merchant_services"]).nullable().optional(), providerTemplateId: z.string().max(200).nullable().optional() })))
    body: { name: string; serviceType?: "electricity" | "gas" | "dual_fuel" | "merchant_services" | null; providerTemplateId?: string | null },
  ) {
    return this.signatures.createTemplate(a, body);
  }

  /** Inbound e-signature events. Authenticated by HMAC (x-uo-signature), not by session. */
  @Public()
  @SkipCsrf()
  @SkipThrottle()
  @Post("webhooks/signatures")
  @HttpCode(200)
  webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers(WEBHOOK_SIGNATURE_HEADER) signature?: string) {
    if (!req.rawBody) throw new RuleViolation(["Empty body."]);
    return this.signatures.handleWebhook(req.rawBody.toString("utf8"), signature);
  }
}
