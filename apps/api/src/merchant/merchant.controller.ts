import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { complianceReviewSchema, merchantApplicationSchema, merchantPricingSchema, principalSchema, riskSchema } from "@uo/shared";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { MerchantService } from "./merchant.service";

const Id = new ParseUUIDPipe({ version: "4" });

@ApiTags("worldpay")
@Controller()
export class MerchantController {
  constructor(private readonly merchant: MerchantService) {}

  @Get("opportunities/:id/merchant")
  workspace(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.merchant.workspace(a, id);
  }

  @Post("opportunities/:id/merchant-applications")
  create(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(merchantApplicationSchema)) body: z.infer<typeof merchantApplicationSchema>) {
    return this.merchant.createApplication(a, id, body);
  }

  @Patch("merchant-applications/:id")
  @HttpCode(204)
  update(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(merchantApplicationSchema.partial())) body: Partial<z.infer<typeof merchantApplicationSchema>>) {
    return this.merchant.updateApplication(a, id, body);
  }

  @Post("merchant-applications/:id/accept")
  @HttpCode(204)
  accept(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.merchant.recordCustomerAcceptance(a, id);
  }

  @Post("merchant-applications/:id/approve")
  @HttpCode(204)
  approve(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ reference: z.string().max(100).optional() }))) body: { reference?: string }) {
    return this.merchant.recordApproval(a, id, body.reference);
  }

  @Post("merchant-applications/:id/pricing")
  addPricing(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(merchantPricingSchema)) body: z.infer<typeof merchantPricingSchema>) {
    return this.merchant.addPricing(a, id, body);
  }

  @Delete("merchant-pricing/:id")
  @HttpCode(204)
  removePricing(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.merchant.removePricing(a, id);
  }

  @Post("merchant-applications/:id/principals")
  addPrincipal(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(principalSchema)) body: z.infer<typeof principalSchema>) {
    return this.merchant.addPrincipal(a, id, body);
  }

  @Patch("principals/:id")
  @HttpCode(204)
  updatePrincipal(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(principalSchema.partial())) body: Partial<z.infer<typeof principalSchema>>) {
    return this.merchant.updatePrincipal(a, id, body);
  }

  @Delete("principals/:id")
  @HttpCode(204)
  removePrincipal(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.merchant.removePrincipal(a, id);
  }

  @Put("merchant-applications/:id/risk")
  @HttpCode(204)
  risk(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(riskSchema)) body: z.infer<typeof riskSchema>) {
    return this.merchant.saveRisk(a, id, body);
  }

  @Post("merchant-applications/:id/compliance-review")
  @HttpCode(204)
  review(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(complianceReviewSchema)) body: z.infer<typeof complianceReviewSchema>) {
    return this.merchant.review(a, id, body);
  }
}
