import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { bankDetailsSchema, contactSchema, customerSchema, customerUpdateSchema, duplicateCheckSchema } from "@uo/shared";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser, RequireCapability } from "../common/decorators";
import { PrismaService } from "../common/prisma.service";
import { ZodPipe } from "../common/zod.pipe";
import { CustomersService } from "./customers.service";

const Id = new ParseUUIDPipe({ version: "4" });
const listQuery = z.object({ q: z.string().max(200).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });

@ApiTags("customers")
@Controller()
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("customers")
  list(@CurrentUser() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.customers.list(a, q);
  }

  /** Returns `{ duplicates }` (nothing created) unless `confirmNew=true`. */
  @Post("customers")
  create(@CurrentUser() a: Actor, @Body(new ZodPipe(customerSchema)) body: z.infer<typeof customerSchema>, @Query("confirmNew") confirmNew?: string) {
    return this.customers.create(a, body, confirmNew === "true");
  }

  @Post("customers/duplicates")
  @HttpCode(200)
  @RequireCapability("customer.read")
  duplicates(@Body(new ZodPipe(duplicateCheckSchema)) body: z.infer<typeof duplicateCheckSchema>) {
    return this.customers.findDuplicates(body);
  }

  @Get("customers/:id")
  get(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.customers.profile(a, id);
  }

  @Patch("customers/:id")
  @HttpCode(204)
  update(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(customerUpdateSchema)) body: z.infer<typeof customerUpdateSchema>) {
    return this.customers.update(a, id, body);
  }

  @Get("customers/:id/timeline")
  @RequireCapability("customer.read")
  timeline(@Param("id", Id) id: string) {
    return this.prisma.timelineEntry.findMany({ where: { customerId: id, opportunityId: null }, orderBy: { occurredAt: "desc" }, take: 200 });
  }

  @Post("customers/:id/merge")
  @HttpCode(204)
  merge(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ sourceId: z.string().uuid() }))) body: { sourceId: string }) {
    return this.customers.merge(a, id, body.sourceId);
  }

  @Post("customers/:id/contacts")
  addContact(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(contactSchema)) body: z.infer<typeof contactSchema>) {
    return this.customers.addContact(a, id, body);
  }

  @Patch("contacts/:id")
  updateContact(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(contactSchema.partial())) body: Partial<z.infer<typeof contactSchema>>) {
    return this.customers.updateContact(a, id, body);
  }

  @Post("customers/:id/bank-accounts")
  addBank(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(bankDetailsSchema)) body: z.infer<typeof bankDetailsSchema>) {
    return this.customers.addBankAccount(a, id, body);
  }

  /** Restricted; each call is written to the audit log. */
  @Get("bank-accounts/:id")
  revealBank(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.customers.revealBankAccount(a, id);
  }
}
