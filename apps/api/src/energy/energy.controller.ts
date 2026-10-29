import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { comparisonQuoteSchema, energyContractSchema, meterPointSchema, meterReadingSchema, removeWithReasonSchema, supplySiteSchema } from "@uo/shared";
import type { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { EnergyService } from "./energy.service";

const Id = new ParseUUIDPipe({ version: "4" });

@ApiTags("energy")
@Controller()
export class EnergyController {
  constructor(private readonly energy: EnergyService) {}

  @Get("opportunities/:id/energy")
  workspace(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.energy.workspace(a, id);
  }

  @Post("opportunities/:id/sites")
  addSite(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(supplySiteSchema)) body: z.infer<typeof supplySiteSchema>) {
    return this.energy.addSite(a, id, body);
  }

  @Patch("sites/:id")
  @HttpCode(204)
  updateSite(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(supplySiteSchema.partial())) body: Partial<z.infer<typeof supplySiteSchema>>) {
    return this.energy.updateSite(a, id, body);
  }

  /** Removes a site added by mistake, with its meters; sites other records rely on are kept. */
  @Post("sites/:id/remove")
  @HttpCode(204)
  removeSite(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(removeWithReasonSchema)) body: z.infer<typeof removeWithReasonSchema>) {
    return this.energy.removeSite(a, id, body.reason);
  }

  @Post("sites/:id/meters")
  addMeter(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(meterPointSchema)) body: z.infer<typeof meterPointSchema>) {
    return this.energy.addMeterPoint(a, id, body);
  }

  @Patch("meters/:id")
  updateMeter(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(meterPointSchema)) body: z.infer<typeof meterPointSchema>) {
    return this.energy.updateMeterPoint(a, id, body);
  }

  @Post("meters/:id/readings")
  addReading(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(meterReadingSchema)) body: z.infer<typeof meterReadingSchema>) {
    return this.energy.addReading(a, id, body);
  }

  @Post("opportunities/:id/contracts")
  addContract(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(energyContractSchema)) body: z.infer<typeof energyContractSchema>) {
    return this.energy.addContract(a, id, body);
  }

  @Patch("contracts/:id")
  @HttpCode(204)
  updateContract(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(energyContractSchema.partial())) body: Partial<z.infer<typeof energyContractSchema>>) {
    return this.energy.updateContract(a, id, body);
  }

  @Post("opportunities/:id/quotes")
  addQuote(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(comparisonQuoteSchema)) body: z.infer<typeof comparisonQuoteSchema>) {
    return this.energy.addQuote(a, id, body);
  }

  @Post("quotes/:id/select")
  @HttpCode(204)
  selectQuote(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.energy.selectQuote(a, id);
  }
}
