import { Body, Controller, Headers, HttpCode, Inject, Injectable, Post, Query, Req, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ApiConsumes, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { type ContactInput, LEAD_SOURCES, SELECTABLE_SERVICE_TYPES, SERVICE_TYPES, SERVICE_TYPE_LABELS, type ServiceType, addressSchema, createOpportunitySchema, isEnergyService } from "@uo/shared";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { ENV, type Env } from "../config/env";
import { AuditService } from "../audit/audit.service";
import { type Actor, SYSTEM } from "../common/actor";
import { CurrentUser, Public, SkipCsrf } from "../common/decorators";
import { parseIrishAddress } from "../common/irish-address";
import { Forbidden, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { ZodPipe } from "../common/zod.pipe";
import { CustomersService } from "../customers/customers.service";
import { uploadInterceptor } from "../documents/documents.controller";
import { EnergyService } from "../energy/energy.service";
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

type Address = z.infer<typeof addressSchema>;

export { parseIrishAddress };

/** "Paul McDonald (Owner)" → the name and the role in brackets. */
export function splitContact(text: string): { name: string; role?: string } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(text.trim());
  return m ? { name: m[1].trim(), role: m[2].trim() } : { name: text.trim() };
}

/** Opening hours a listing couldn't give. */
const NO_HOURS = new Set(["not found", "n/a", "na", "-", "unknown", "none"]);

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
  "business name": "companyName",
  contact: "contactName",
  "contact name": "contactName",
  owner: "contactName",
  manager: "contactName",
  "owner name": "contactName",
  "owner / manager": "contactName",
  "owner / manager name": "contactName",
  "owner/manager name": "contactName",
  category: "businessType",
  "business type": "businessType",
  address: "address",
  area: "area",
  "opening hours": "hours",
  hours: "hours",
  "opening/closing": "hours",
  "opening / closing": "hours",
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

export const importQuerySchema = z.object({
  /** Services for rows without a Service value, comma-separated. */
  services: z
    .string()
    .max(200)
    .optional()
    .transform((v) => [...new Set((v ?? "").split(",").map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(z.enum(SELECTABLE_SERVICE_TYPES))),
});

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
    private readonly customers: CustomersService,
    private readonly energy: EnergyService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Imports leads from CSV. Valid rows are created; invalid rows are reported with their line number.
   * A row gets one lead per service: its Service column, or `services` for rows without one. When a
   * row has an address or a category, a customer is created for the business (unless it may already
   * be in the CRM, which is reported and never merged) and energy leads get a supply site there.
   */
  async importCsv(actor: Actor, csv: string, services: ServiceType[] = []) {
    const rows = parseCsv(csv.replace(/^\uFEFF/, ""));
    if (rows.length < 2) throw new RuleViolation(["The file needs a header row and at least one lead."]);
    const header = rows[0].map((h) => COLUMN_ALIASES[h.trim().toLowerCase().replace(/\s+/g, " ")] ?? null);
    if (!header.includes("serviceType") && !services.length) {
      throw new RuleViolation(['Add a "Service" column (Electricity, Gas or Worldpay), or choose the services to create for each row.']);
    }
    if ((rows.length - 1) * Math.max(1, services.length) > 2000) throw new RuleViolation(["Import up to 2,000 leads at a time."]);
    // A file is imported once per set of services: retrying after a lost response would otherwise
    // create every lead again. Claimed before the rows are processed, so a second click is refused too.
    const key = `csv:${createHash("sha256").update(`${[...services].sort().join(",")}\n${csv}`).digest("hex")}`;
    const earlier = await this.prisma.auditLog.findFirst({ where: { action: "import.csv", entityType: "lead_import", entityId: key }, orderBy: { createdAt: "asc" } });
    if (earlier) {
      const on = earlier.createdAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
      throw new RuleViolation([`This file was already imported on ${on} with the same services, so its leads are in the CRM. To add more, import a file with only the new rows.`]);
    }
    await this.audit.log(actor, { action: "import.csv", entityType: "lead_import", entityId: key, summary: `Importing ${rows.length - 1} row(s) from CSV` });
    let created = 0;
    let customers = 0;
    const errors: { line: number; issues: string[] }[] = [];
    const warnings: { line: number; issues: string[] }[] = [];
    for (const [i, row] of rows.slice(1).entries()) {
      const line = i + 2;
      const rec: Record<string, string> = {};
      header.forEach((key, j) => {
        if (key && row[j]?.trim()) rec[key] = row[j].trim();
      });
      const rowServices = rec.serviceType ? [SERVICE_ALIASES[rec.serviceType.toLowerCase()]] : services;
      if (rowServices[0] === "dual_fuel") {
        errors.push({ line, issues: ["Dual fuel isn't offered: import it as an Electricity lead and a Gas lead."] });
        continue;
      }
      if (!rowServices.length) {
        errors.push({ line, issues: ["No service: fill in the Service column or choose the services to create."] });
        continue;
      }
      const contact = rec.contactName ? splitContact(rec.contactName) : undefined;
      const hours = rec.hours && !NO_HOURS.has(rec.hours.toLowerCase()) ? `Opening hours: ${rec.hours}` : undefined;
      const leads = rowServices.map((service) =>
        createOpportunitySchema.safeParse({
          ...rec,
          name: rec.name || [rec.companyName || contact?.name, service ? (service === "merchant_services" ? "Worldpay" : SERVICE_TYPE_LABELS[service]) : rec.serviceType].filter(Boolean).join(" – "),
          serviceType: service,
          contactName: contact?.name,
          contactRole: contact?.role,
          nextAction: [rec.nextAction, hours].filter(Boolean).join(" · ").slice(0, 300) || undefined,
          expectedRevenue: rec.expectedRevenue ? Number(rec.expectedRevenue.replace(/[€,\s]/g, "")) : undefined,
          leadSource: "csv_import",
          ownerId: null,
        }),
      );
      const invalid = leads.find((l) => !l.success);
      if (invalid && !invalid.success) {
        errors.push({ line, issues: invalid.error.issues.map((x) => (x.path[0] === "serviceType" ? `Unknown service "${rec.serviceType ?? ""}"` : `${x.path.join(".")}: ${x.message}`)) });
        continue;
      }
      const address = rec.address ? parseIrishAddress(rec.address, rec.area) : null;
      const customerId = address || rec.businessType ? await this.customerFor(actor, rec, address, contact, line, warnings) : undefined;
      if (customerId) customers++;
      for (const lead of leads) {
        if (!lead.success) continue;
        const { id } = await this.opportunities.create(actor, { ...lead.data, customerId });
        created++;
        if (address && isEnergyService(lead.data.serviceType)) {
          await this.energy.addSite(actor, id, { label: rec.companyName, address, serviceType: lead.data.serviceType, customerSector: rec.businessType });
        }
      }
    }
    await this.audit.log(actor, { action: "import.csv", entityType: "lead_import", entityId: key, summary: `Imported ${created} lead(s) from CSV`, data: { created, customers, rejected: errors.length } });
    return { created, customers, errors, warnings };
  }

  /** A new customer for an imported business, or nothing when it may already be in the CRM. */
  private async customerFor(actor: Actor, rec: Record<string, string>, address: Address | null, contact: { name: string; role?: string } | undefined, line: number, warnings: { line: number; issues: string[] }[]) {
    const legalName = rec.companyName || contact?.name;
    if (!legalName) return undefined;
    const res = await this.customers.create(actor, { legalName, businessType: rec.businessType, phone: rec.phone, email: rec.email, addresses: address ? [address] : undefined });
    if (!res.id) {
      const match = res.duplicates![0];
      warnings.push({ line, issues: [`${legalName} may already be in the CRM as ${match.customer.legalName} (${match.reasons.join(", ").toLowerCase()}). Its leads were created without a customer, so link or create one from the deal.`] });
      return undefined;
    }
    // "Barry FitzGerald / Claire-Marie Thomas (Owners)": one contact each.
    const names = contact ? contact.name.split(/\s*\/\s*/).filter(Boolean) : [];
    for (const [k, name] of names.entries()) {
      const [firstName, ...last] = name.split(/\s+/);
      const input: ContactInput = { firstName, lastName: last.join(" ") || null, jobTitle: contact?.role?.replace(/s$/i, "") || null, phone: k === 0 ? rec.phone : null, email: k === 0 ? rec.email : null, isPrimary: k === 0 };
      await this.customers.addContact(actor, res.id, input);
    }
    return res.id;
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

  /**
   * CSV columns: Name, Service, Company (or Business name), Contact (or Owner / Manager name), Email,
   * Phone, Campaign, Source, Notes, Expected revenue, Category, Address, Area, Opening hours.
   * `services` (comma-separated) gives the services for rows without a Service value.
   */
  @Post("opportunities/import")
  @ApiConsumes("multipart/form-data")
  @ApiQuery({ name: "services", required: false, description: `Services for rows without a Service value, comma-separated: ${SELECTABLE_SERVICE_TYPES.join(", ")}.` })
  @UseInterceptors(uploadInterceptor())
  importCsv(@CurrentUser() a: Actor, @Query(new ZodPipe(importQuerySchema)) q: z.infer<typeof importQuerySchema>, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new RuleViolation(["Choose a CSV file."]);
    if (file.size > 5 * 1024 * 1024) throw new RuleViolation(["CSV files must be 5 MB or smaller."]);
    return this.intake.importCsv(a, file.buffer.toString("utf8"), q.services);
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
