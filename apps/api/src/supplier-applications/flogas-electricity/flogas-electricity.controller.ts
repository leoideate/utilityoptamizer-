import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Put, StreamableFile } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { flogasGenerateSchema, flogasSaveSchema, flogasSendSchema } from "@uo/shared";
import type { z } from "zod";
import type { Actor } from "../../common/actor";
import { CurrentUser } from "../../common/decorators";
import { ZodPipe } from "../../common/zod.pipe";
import { FlogasElectricityService } from "./flogas-electricity.service";

const Id = new ParseUUIDPipe({ version: "4" });

/** The Flogas electricity application on an opportunity (Electricity + Flogas). */
@ApiTags("supplier-applications")
@Controller("opportunities/:id/flogas-electricity")
export class FlogasElectricityController {
  constructor(private readonly flogas: FlogasElectricityService) {}

  @Get()
  view(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.flogas.view(a, id);
  }

  /** Saves a draft: CRM values go back to their records, Flogas-only answers to the application. */
  @Put()
  save(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(flogasSaveSchema)) body: z.infer<typeof flogasSaveSchema>) {
    return this.flogas.save(a, id, body);
  }

  /** The draft on the original PDF, marked as a preview; nothing is stored. */
  @Get("preview")
  @Header("Cache-Control", "no-store")
  async preview(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return new StreamableFile(await this.flogas.preview(a, id), { type: "application/pdf", disposition: 'inline; filename="flogas-electricity-draft.pdf"' });
  }

  @Post("versions")
  generate(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(flogasGenerateSchema)) body: z.infer<typeof flogasGenerateSchema>) {
    return this.flogas.generate(a, id, body);
  }

  @Post("versions/:formId/send")
  send(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Param("formId", Id) formId: string, @Body(new ZodPipe(flogasSendSchema)) body: z.infer<typeof flogasSendSchema>) {
    return this.flogas.send(a, id, formId, body);
  }

  @Post("signing-links/:linkId/resend")
  resend(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Param("linkId", Id) linkId: string) {
    return this.flogas.resend(a, id, linkId);
  }

  @Get("history")
  history(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.flogas.history(a, id);
  }
}
