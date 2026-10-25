import { Controller, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { BillReadingService } from "./bill-reading.service";

const Id = new ParseUUIDPipe({ version: "4" });

@ApiTags("documents")
@Controller()
export class BillReadingController {
  constructor(private readonly bills: BillReadingService) {}

  /** Suggested values from an uploaded energy bill, for a person to review. Saves nothing. */
  @Post("document-versions/:id/read-bill")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  read(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.bills.read(a, id);
  }
}
