import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { commissionSchema } from "@uo/shared";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import type { Actor } from "../common/actor";
import { actorRef } from "../common/actor";
import { CurrentUser, RequireCapability } from "../common/decorators";
import { PrismaService } from "../common/prisma.service";
import { opportunityNumber } from "../common/values";
import { ZodPipe } from "../common/zod.pipe";
import { OpportunityAccess } from "../opportunities/access.service";
import { type ReportFilter, ReportsService, reportFilterSchema } from "./reports.service";

const Id = new ParseUUIDPipe({ version: "4" });

@ApiTags("reports")
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
  ) {}

  /** Salespeople get their own figures; report.read roles see the whole business. */
  @Get("reports/dashboard")
  dashboard(@CurrentUser() a: Actor, @Query(new ZodPipe(reportFilterSchema)) f: ReportFilter) {
    return this.reports.dashboard(a, f);
  }

  @Get("reports/commissions.csv")
  @RequireCapability("commission.read")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="commissions.csv"')
  async commissionsCsv(@CurrentUser() a: Actor, @Query(new ZodPipe(reportFilterSchema)) f: ReportFilter) {
    await this.audit.log(a, { action: "export.commissions", entityType: "report", summary: "Exported commissions CSV" });
    return this.reports.commissionCsv(a, f);
  }

  @Get("opportunities/:id/commissions")
  @RequireCapability("commission.read")
  async listCommissions(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    await this.access.readable(a, id);
    return this.prisma.commission.findMany({ where: { opportunityId: id }, orderBy: { createdAt: "asc" } });
  }

  @Post("commissions")
  @RequireCapability("commission.write")
  async addCommission(@CurrentUser() a: Actor, @Body(new ZodPipe(commissionSchema)) body: z.infer<typeof commissionSchema>) {
    await this.access.readable(a, body.opportunityId);
    const c = await this.prisma.commission.create({ data: { ...body, createdById: actorRef(a) } });
    await this.audit.log(a, { action: "commission.create", entityType: "opportunity", entityId: body.opportunityId, summary: `Commission ${body.status}: ${body.amount}` });
    return c;
  }

  @Patch("commissions/:id")
  @RequireCapability("commission.write")
  async updateCommission(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(commissionSchema.omit({ opportunityId: true }).partial())) body: Partial<z.infer<typeof commissionSchema>>) {
    const c = await this.prisma.commission.update({ where: { id }, data: body });
    await this.audit.log(a, { action: "commission.update", entityType: "opportunity", entityId: c.opportunityId, summary: `Commission updated (${Object.keys(body).join(", ")})` });
    return c;
  }

  /** Global search across opportunities and customers the user can see. */
  @Get("search")
  async search(@CurrentUser() a: Actor, @Query(new ZodPipe(z.object({ q: z.string().trim().min(2).max(100) }))) { q }: { q: string }) {
    const n = opportunityNumber(q);
    const [opportunities, customers] = await Promise.all([
      this.prisma.opportunity.findMany({
        where: {
          AND: [
            this.access.visibleWhere(a),
            {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { companyName: { contains: q, mode: "insensitive" } },
                { contactName: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
                ...(n ? [{ number: n }] : []),
                { sites: { some: { meterPoints: { some: { OR: [{ mprn: q.replace(/\s/g, "") }, { gprn: q.replace(/\s/g, "") }] } } } } },
              ],
            },
          ],
        },
        take: 10,
        orderBy: { updatedAt: "desc" },
        select: { id: true, number: true, name: true, outcome: true, serviceType: true, stage: { select: { name: true } } },
      }),
      this.prisma.customer.findMany({
        where: {
          mergedIntoId: null,
          AND: [this.access.customerWhere(a)],
          OR: [
            { legalName: { contains: q, mode: "insensitive" } },
            { tradingName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { companyRegNumber: { equals: q, mode: "insensitive" } },
            { vatNumber: { equals: q, mode: "insensitive" } },
          ],
        },
        take: 10,
        select: { id: true, legalName: true, tradingName: true },
      }),
    ]);
    return { opportunities, customers };
  }
}
