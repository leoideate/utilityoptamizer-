import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { emailSchema } from "@uo/shared";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser, RequireCapability } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { IntegrationsService } from "./integrations.service";

const Id = new ParseUUIDPipe({ version: "4" });
/** The client sends a fresh idempotency key per message, so a double-click or retry doesn't send twice. */
const replySchema = z.object({ body: z.string().min(1).max(20000), idempotencyKey: z.string().min(8).max(100) });
const whatsappSchema = z.object({ to: z.string().regex(/^\+?\d{8,15}$/, "Use international format, e.g. +353871234567."), body: z.string().min(1).max(4000), idempotencyKey: z.string().min(8).max(100) });

@ApiTags("integrations")
@Controller()
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Post("opportunities/:id/emails")
  email(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(emailSchema)) body: z.infer<typeof emailSchema>) {
    return this.integrations.sendEmail(a, id, body);
  }

  @Post("opportunities/:id/whatsapp")
  whatsapp(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(whatsappSchema)) body: z.infer<typeof whatsappSchema>) {
    return this.integrations.sendWhatsApp(a, id, body);
  }

  @Post("opportunities/:id/submission-pack")
  submission(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.integrations.sendSubmissionPack(a, id);
  }

  @Get("integrations/status")
  status(@CurrentUser() a: Actor) {
    return this.integrations.status(a);
  }

  @Post("emails/:id/reply")
  reply(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(replySchema)) body: z.infer<typeof replySchema>) {
    return this.integrations.replyEmail(a, id, body);
  }

  @Get("admin/integration-jobs")
  @RequireCapability("admin.integrations")
  jobs(@Query("status") status?: "failed" | "dead" | "pending" | "succeeded") {
    return this.integrations.list(status);
  }

  @Post("admin/integration-jobs/:id/retry")
  @HttpCode(204)
  retry(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.integrations.retry(a, id);
  }
}
