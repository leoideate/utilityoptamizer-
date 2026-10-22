import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Put, StreamableFile } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { applicationGenerateSchema, bordGaisSaveSchema, bordGaisSendSchema } from "@uo/shared";
import type { z } from "zod";
import type { Actor } from "../../common/actor";
import { CurrentUser } from "../../common/decorators";
import { ZodPipe } from "../../common/zod.pipe";
import { BordGaisElectricityService } from "./bord-gais-electricity.service";

const Id = new ParseUUIDPipe({ version: "4" });

/** The Bord Gáis Energy electricity application on an opportunity (Electricity + Bord Gáis Energy). */
@ApiTags("supplier-applications")
@Controller("opportunities/:id/bord-gais-electricity")
export class BordGaisElectricityController {
  constructor(private readonly bordGais: BordGaisElectricityService) {}

  @Get()
  view(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.bordGais.view(a, id);
  }

  /** Saves a draft: CRM values go back to their records, Bord Gáis-only answers to the application. */
  @Put()
  save(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(bordGaisSaveSchema)) body: z.infer<typeof bordGaisSaveSchema>) {
    return this.bordGais.save(a, id, body);
  }

  /** The draft on the original PDF, marked as a preview; nothing is stored. */
  @Get("preview")
  @Header("Cache-Control", "no-store")
  async preview(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return new StreamableFile(await this.bordGais.preview(a, id), { type: "application/pdf", disposition: 'inline; filename="bord-gais-electricity-draft.pdf"' });
  }

  @Post("versions")
  generate(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(applicationGenerateSchema)) body: z.infer<typeof applicationGenerateSchema>) {
    return this.bordGais.generate(a, id, body);
  }

  @Post("versions/:formId/send")
  send(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Param("formId", Id) formId: string, @Body(new ZodPipe(bordGaisSendSchema)) body: z.infer<typeof bordGaisSendSchema>) {
    return this.bordGais.send(a, id, formId, body);
  }

  @Post("signing-links/:linkId/resend")
  resend(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Param("linkId", Id) linkId: string) {
    return this.bordGais.resend(a, id, linkId);
  }

  @Get("history")
  history(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.bordGais.history(a, id);
  }
}
