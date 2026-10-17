import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { callOutcomeSchema, callbackPhoneSchema, startCallSchema } from "@uo/shared";
import type { z } from "zod";
import { ENV, type Env } from "../config/env";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { CallsService } from "./calls.service";
import { ManualTelephony, RingCentralTelephony, TELEPHONY_PROVIDER } from "./telephony";

const Id = new ParseUUIDPipe({ version: "4" });

@ApiTags("calls")
@Controller()
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  /** Which phone system is configured, and the user's own phone (rung first for bridged calls). */
  @Get("telephony")
  async info(@CurrentUser() a: Actor) {
    return this.calls.info(await this.calls.myPhone(a));
  }

  @Put("telephony/my-phone")
  setPhone(@CurrentUser() a: Actor, @Body(new ZodPipe(callbackPhoneSchema)) body: z.infer<typeof callbackPhoneSchema>) {
    return this.calls.setMyPhone(a, body.phone);
  }

  @Get("opportunities/:id/call-numbers")
  numbers(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.calls.numbers(a, id);
  }

  @Get("opportunities/:id/calls")
  list(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.calls.list(a, id);
  }

  @Post("opportunities/:id/calls")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  start(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(startCallSchema)) body: z.infer<typeof startCallSchema>) {
    return this.calls.start(a, id, body);
  }

  @Get("calls/:id")
  get(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.calls.get(a, id);
  }

  @Post("calls/:id/cancel")
  cancel(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.calls.cancel(a, id);
  }

  /** A short-lived link to play the call's recording (audited as sensitive access). */
  @Get("calls/:id/recording")
  recording(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.calls.recordingUrl(a, id);
  }

  @Post("calls/:id/outcome")
  outcome(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(callOutcomeSchema)) body: z.infer<typeof callOutcomeSchema>) {
    return this.calls.recordOutcome(a, id, body);
  }
}

@Module({
  controllers: [CallsController],
  providers: [
    CallsService,
    {
      provide: TELEPHONY_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.TELEPHONY_PROVIDER === "ringcentral"
          ? new RingCentralTelephony({
              serverUrl: env.RINGCENTRAL_SERVER_URL.replace(/\/$/, ""),
              clientId: env.RINGCENTRAL_CLIENT_ID!,
              clientSecret: env.RINGCENTRAL_CLIENT_SECRET!,
              jwt: env.RINGCENTRAL_JWT!,
              callerId: env.RINGCENTRAL_CALLER_ID,
              playPrompt: env.RINGCENTRAL_PLAY_PROMPT,
            })
          : new ManualTelephony(),
    },
  ],
  exports: [CallsService],
})
export class CallsModule {}
