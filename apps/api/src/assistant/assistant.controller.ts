import { Body, type CanActivate, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { assistantFeedbackSchema, assistantMessageSchema, assistantUploadSchema } from "@uo/shared";
import { memoryStorage } from "multer";
import type { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser, RequireCapability } from "../common/decorators";
import { NotFound } from "../common/errors";
import { ZodPipe } from "../common/zod.pipe";
import { ENV, type Env, assistantEnabled } from "../config/env";
import { AssistantActions } from "./actions";
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
  constructor(
    private readonly assistant: AssistantService,
    private readonly actions: AssistantActions,
  ) {}

  /** Ask a question. Read-only: the assistant looks things up with the asker's own access. */
  @Post("messages")
  @HttpCode(200)
  @RequireCapability("assistant.use")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  ask(@CurrentUser() a: Actor, @Body(new ZodPipe(assistantMessageSchema)) body: z.infer<typeof assistantMessageSchema>) {
    return this.assistant.ask(a, body);
  }

  /** Ask with an energy bill or business card attached: the AI reads it, and the details go with the question. The file isn't kept. */
  @Post("messages/upload")
  @HttpCode(200)
  @RequireCapability("assistant.use")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10, parts: 20 } }))
  askWithFile(@CurrentUser() a: Actor, @Body(new ZodPipe(assistantUploadSchema)) body: z.infer<typeof assistantUploadSchema>, @UploadedFile() file?: Express.Multer.File) {
    return this.assistant.askWithFile(a, file, body);
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

  /** Makes a change the assistant prepared. Runs as the user, with every check the screens apply. */
  @Post("actions/:id/confirm")
  @HttpCode(200)
  @RequireCapability("assistant.use")
  confirm(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.actions.confirm(a, id);
  }

  @Post("actions/:id/dismiss")
  @HttpCode(200)
  @RequireCapability("assistant.use")
  dismiss(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.actions.dismiss(a, id);
  }

  /** Answers people marked unhelpful (managers and administrators). */
  @Get("feedback")
  @RequireCapability("assistant.review")
  unhelpful(@CurrentUser() a: Actor) {
    return this.assistant.unhelpful(a);
  }
}
