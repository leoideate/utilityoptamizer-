import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { morningSummarySchema } from "@uo/shared";
import type { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { AttentionService } from "./attention.service";

@ApiTags("attention")
@Controller("attention")
export class AttentionController {
  constructor(private readonly attention: AttentionService) {}

  /** "Needs your attention" for the signed-in user: stuck deals, overdue tasks, follow-ups and renewals due. */
  @Get()
  get(@CurrentUser() a: Actor) {
    return this.attention.forUser(a);
  }

  /** The user's own morning summary switch (Account page). */
  @Get("morning-summary")
  async morningSummary(@CurrentUser() a: Actor) {
    return { enabled: await this.attention.morningSummaryEnabled(a) };
  }

  @Put("morning-summary")
  setMorningSummary(@CurrentUser() a: Actor, @Body(new ZodPipe(morningSummarySchema)) body: z.infer<typeof morningSummarySchema>) {
    return this.attention.setMorningSummary(a, body.enabled);
  }
}
