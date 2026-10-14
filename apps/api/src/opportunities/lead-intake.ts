import { Body, Controller, Headers, HttpCode, Inject, Injectable, Post, Req, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { LEAD_SOURCES, SERVICE_TYPES, createOpportunitySchema } from "@uo/shared";
import type { Request } from "express";
import { z } from "zod";
import { ENV, type Env } from "../config/env";
import { AuditService } from "../audit/audit.service";
import { type Actor, SYSTEM } from "../common/actor";
import { CurrentUser, Public, SkipCsrf } from "../common/decorators";
import { Forbidden, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { uploadInterceptor } from "../documents/documents.controller";
import { verifyWebhook } from "../signatures/provider";
import { OpportunitiesService } from "./opportunities.service";

/** Parses RFC 4180 CSV (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const SERVICE_ALIASES: Record<string, (typeof SERVICE_TYPES)[number]> = {
  electricity: "electricity",
  electric: "electricity",
  power: "electricity",
  gas: "gas",
  "dual fuel": "dual_fuel",
  dual_fuel: "dual_fuel",
  dual: "dual_fuel",
  worldpay: "merchant_services",
  merchant: "merchant_services",
  "merchant services": "merchant_services",
  merchant_services: "merchant_services",
  "card payments": "merchant_services",
};

const COLUMN_ALIASES: Record<string, string> = {
  name: "name",
  "opportunity name": "name",
  opportunity: "name",
  service: "serviceType",
  "service type": "serviceType",
  servicetype: "serviceType",
  company: "companyName",
  "company name": "companyName",
  business: "companyName",
  contact: "contactName",
  "contact name": "contactName",
  email: "email",
  phone: "phone",
  telephone: "phone",
  mobile: "phone",
  campaign: "campaign",
  source: "leadSourceDetail",
  "source detail": "leadSourceDetail",
  notes: "nextAction",
  "next action": "nextAction",
  "expected revenue": "expectedRevenue",
};

export const leadPayloadSchema = z.object({
  /** Unique per lead from the sending system; the same id is never imported twice. */
  externalId: z.string().min(1).max(200),
  name: z.string().trim().max(200).optional(),
  serviceType: z.enum(SERVICE_TYPES),
  companyName: z.string().trim().max(200).optional(),
  contactName: z.string().trim().max(200).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().max(40).optional(),
  message: z.string().max(5000).optional(),
  campaign: z.string().max(200).optional(),
  source: z.enum(["website", "api", "email", "whatsapp", "referral"]).default("website"),
});

@Injectable()
export class LeadIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly opportunities: OpportunitiesService,
    private readonly audit: AuditService,
  ) {}

  /** Imports leads from CSV. Valid rows are created; invalid rows are reported with their line number. */
  async importCsv(actor: Actor, csv: string) {
    const rows = parseCsv(csv.replace(/^\uFEFF/, ""));
    if (rows.length < 2) throw new RuleViolation(["The file needs a header row and at least one lead."]);
    if (rows.length > 2001) throw new RuleViolation(["Import up to 2,000 leads at a time."]);
    const header = rows[0].map((h) => COLUMN_ALIASES[h.trim().toLowerCase()] ?? null);
    if (!header.includes("serviceType")) throw new RuleViolation(['Add a "Service" column (Electricity, Gas, Dual fuel or Worldpay).']);
    const created: string[] = [];
    const errors: { line: number; issues: string[] }[] = [];
    for (const [i, row] of rows.slice(1).entries()) {
      const rec: Record<string, string> = {};
      header.forEach((key, j) => {
        if (key && row[j]?.trim()) rec[key] = row[j].trim();
      });
      const service = SERVICE_ALIASES[(rec.serviceType ?? "").toLowerCase()];
      const parsed = createOpportunitySchema.safeParse({
        ...rec,
        name: rec.name || [rec.companyName || rec.contactName, service === "merchant_services" ? "Worldpay" : rec.serviceType].filter(Boolean).join(" – "),
        serviceType: service,
        expectedRevenue: rec.expectedRevenue ? Number(rec.expectedRevenue.replace(/[€,\s]/g, "")) : undefined,
        leadSource: "csv_import",
        ownerId: null,
      });
      if (!parsed.success) {
        errors.push({ line: i + 2, issues: parsed.error.issues.map((x) => (x.path[0] === "serviceType" ? `Unknown service "${rec.serviceType ?? ""}"` : `${x.path.join(".")}: ${x.message}`)) });
        continue;
      }
      created.push((await this.opportunities.create(actor, parsed.data)).id);
    }
    await this.audit.log(actor, { action: "import.csv", entityType: "opportunity", summary: `Imported ${created.length} lead(s) from CSV`, data: { created: created.length, rejected: errors.length } });
    return { created: created.length, errors };
  }

  /** Website / API lead. Idempotent on (source, externalId). Unassigned leads are auto-assigned by the lead job. */
  async intake(payload: z.infer<typeof leadPayloadSchema>) {
    const key = `lead:${payload.source}:${payload.externalId}`;
    const existing = await this.prisma.auditLog.findFirst({ where: { action: "lead.intake", entityType: "lead", entityId: key } });
    if (existing) return { status: "duplicate" as const };
    const { id } = await this.opportunities.create(SYSTEM, {
      name: payload.name || `${payload.companyName || payload.contactName || "Website enquiry"} – ${payload.serviceType === "merchant_services" ? "Worldpay" : payload.serviceType.replace("_", " ")}`,
      serviceType: payload.serviceType,
      saleType: "new_sale",
      companyName: payload.companyName ?? null,
      contactName: payload.contactName ?? null,
      email: payload.email ?? null,
      phone: payload.phone ?? null,
      campaign: payload.campaign ?? null,
      leadSource: LEAD_SOURCES.includes(payload.source) ? payload.source : "api",
      leadSourceDetail: `Reference ${payload.externalId}`,
      ownerId: null,
    });
    if (payload.message) await this.audit.timeline(SYSTEM, { opportunityId: id, kind: "note", direction: "inbound", body: payload.message });
    await this.audit.log(SYSTEM, { action: "lead.intake", entityType: "lead", entityId: key, summary: "Lead received", data: { opportunityId: id } });
    return { status: "created" as const, id };
  }
}

@ApiTags("leads")
@Controller()
export class LeadIntakeController {
  constructor(
    private readonly intake: LeadIntakeService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** CSV columns: Name, Service, Company, Contact, Email, Phone, Campaign, Source, Notes, Expected revenue. */
  @Post("opportunities/import")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(uploadInterceptor())
  importCsv(@CurrentUser() a: Actor, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new RuleViolation(["Choose a CSV file."]);
    if (file.size > 5 * 1024 * 1024) throw new RuleViolation(["CSV files must be 5 MB or smaller."]);
    return this.intake.importCsv(a, file.buffer.toString("utf8"));
  }

  /**
   * Inbound leads from the website or another system. Authenticated by HMAC like the signature
   * webhook (header x-uo-signature, secret LEAD_WEBHOOK_SECRET), not by a session.
   */
  @Public()
  @SkipCsrf()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("public/leads")
  @HttpCode(200)
  async lead(@Req() req: Request & { rawBody?: Buffer }, @Headers("x-uo-signature") signature?: string, @Body() _body?: unknown) {
    const raw = req.rawBody?.toString("utf8") ?? "";
    if (!this.env.LEAD_WEBHOOK_SECRET || !verifyWebhook(this.env.LEAD_WEBHOOK_SECRET, raw, signature)) throw new Forbidden("Invalid signature.");
    return this.intake.intake(leadPayloadSchema.parse(JSON.parse(raw)));
  }
}
