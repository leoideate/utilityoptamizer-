import { Body, type CanActivate, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { assistantFeedbackSchema, assistantMessageSchema } from "@uo/shared";
import type { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser, RequireCapability } from "../common/decorators";
import { NotFound } from "../common/errors";
import { ZodPipe } from "../common/zod.pipe";
import { ENV, type Env, assistantEnabled } from "../config/env";
import { AssistantService } from "./assistant.service";

const Id = new ParseUUIDPipe({ version: "4" });

/** Every assistant route answers 404 while the assistant is off (no Anthropic key, or AI_ASSISTANT_ENABLED=false). */
@Injectable()
export class AssistantEnabledGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate() {
    if (!assistantEnabled(this.env)) throw new NotFound("The assistant is turned off.");
    return true;
  }
}

@ApiTags("assistant")
@Controller("assistant")
@UseGuards(AssistantEnabledGuard)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  /** Ask a question. Read-only: the assistant looks things up with the asker's own access. */
  @Post("messages")
  @HttpCode(200)
  @RequireCapability("assistant.use")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  ask(@CurrentUser() a: Actor, @Body(new ZodPipe(assistantMessageSchema)) body: z.infer<typeof assistantMessageSchema>) {
    return this.assistant.ask(a, body);
  }

  @Get("conversations/:id/messages")
  @RequireCapability("assistant.use")
  messages(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.assistant.messages(a, id);
  }

  @Post("messages/:id/feedback")
  @HttpCode(204)
  @RequireCapability("assistant.use")
  feedback(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(assistantFeedbackSchema)) body: z.infer<typeof assistantFeedbackSchema>) {
    return this.assistant.feedback(a, id, body);
  }

  /** Answers people marked unhelpful (managers and administrators). */
  @Get("feedback")
  @RequireCapability("assistant.review")
  unhelpful(@CurrentUser() a: Actor) {
    return this.assistant.unhelpful(a);
  }
}
