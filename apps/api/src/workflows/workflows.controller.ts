import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CASE_KINDS, leaseCheckSchema, submissionResponseSchema, submissionSchema, supplyPointSearchSchema, workflowCaseSchema } from "@uo/shared";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { WorkflowsService } from "./workflows.service";

const Id = new ParseUUIDPipe({ version: "4" });
const dashboardQuery = z.object({
  kind: z.enum(CASE_KINDS).optional(),
  ownerId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  dueBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

@ApiTags("workflows")
@Controller()
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  /** The case: kind, derived status and steps, checklist, lease, terms, submissions and responses. */
  @Get("opportunities/:id/case")
  overview(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.workflows.overview(a, id);
  }

  @Put("opportunities/:id/case")
  @HttpCode(204)
  save(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(workflowCaseSchema)) body: z.infer<typeof workflowCaseSchema>) {
    return this.workflows.saveCase(a, id, body);
  }

  /** Find a supply point by MPRN/GPRN, address, Eircode or customer name. */
  @Get("supply-points")
  search(@CurrentUser() a: Actor, @Query(new ZodPipe(supplyPointSearchSchema)) q: z.infer<typeof supplyPointSearchSchema>) {
    return this.workflows.searchSupplyPoints(a, q.q);
  }

  @Post("opportunities/:id/lease-checks")
  lease(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(leaseCheckSchema)) body: z.infer<typeof leaseCheckSchema>) {
    return this.workflows.checkLease(a, id, body);
  }

  @Post("opportunities/:id/terms-checks")
  terms(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.workflows.verifyTerms(a, id);
  }

  @Post("opportunities/:id/submissions")
  submit(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(submissionSchema)) body: z.infer<typeof submissionSchema>) {
    return this.workflows.recordSubmission(a, id, body);
  }

  @Post("submissions/:id/responses")
  respond(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(submissionResponseSchema)) body: z.infer<typeof submissionResponseSchema>) {
    return this.workflows.recordResponse(a, id, body);
  }

  /** Cases by where they stand (due, overdue, awaiting approval, ready, sent, rejected, completed). */
  @Get("cases")
  dashboard(@CurrentUser() a: Actor, @Query(new ZodPipe(dashboardQuery)) q: z.infer<typeof dashboardQuery>) {
    return this.workflows.dashboard(a, q);
  }
}
