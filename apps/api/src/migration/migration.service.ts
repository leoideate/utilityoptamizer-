import { Injectable } from "@nestjs/common";
import type { Prisma, Supplier } from "@prisma/client";
import { type MigrationRow, addDays, parseSheetRow, sameSupplier, stageDef, today as businessToday } from "@uo/shared";
import { ActivitiesService } from "../activities/activities.service";
import { AuditService } from "../audit/audit.service";
import { SYSTEM } from "../common/actor";
import { PrismaService } from "../common/prisma.service";
import { dateOnly, phoneKey } from "../common/values";
import { CustomersService } from "../customers/customers.service";
import { DocumentsService } from "../documents/documents.service";
import { NotificationsService } from "../notifications/notifications.service";
import { CryptoService } from "../common/crypto.service";
import { StagesService } from "../opportunities/stages.service";
import { pdfFacts } from "./pdf-facts";
import type { SheetTab } from "./sheet";

export interface ImportOptions {
  /** Write to the database. Without it nothing changes and the report says what would happen. */
  commit: boolean;
  /** Import meter numbers in a non-standard format, recording why (see FORMAT_EXCEPTION_REASON). */
  allowFormatExceptions?: boolean;
  /** Add suppliers the CRM doesn't have yet instead of skipping their rows. */
  createSuppliers?: boolean;
  /** Sheet sales agent names (any case) mapped to a user id, or null to leave their deals unassigned. */
  agents?: Record<string, string | null>;
  today?: string;
}

export interface ReportLine {
  tab: string;
  line: number;
  /** created (or would be, in a dry run), exists (imported before), skipped. */
  action: "created" | "exists" | "skipped";
  business: string;
  customer: string;
  detail: string;
  warnings: string;
}

export interface DocumentLine {
  file: string;
  /** attached (or would be, in a dry run), exists (already uploaded), review (no single match). */
  action: "attached" | "exists" | "review";
  deal: string;
  found: string;
  detail: string;
}

export interface CustomersImport {
  lines: ReportLine[];
  /** Every distinct status in the sheet with its row count, to confirm how they were treated. */
  statuses: Record<string, number>;
  suppliersToCreate: string[];
  unmatchedAgents: string[];
  /** Live contracts ending within the renewal window: the 07:00 job opens renewals for them. */
  renewalsSoon: number;
  ignoredColumns: string[];
  /** Deals whose MPRN/GPRN is missing or unverified; each gets a task for an administrator. */
  meterChecks: number;
  /** Rows the sheet says never went ahead (Rejected, Cancel...), imported as lost deals. */
  lost: number;
}

/** How far ahead the renewal job looks (automations/renewals.service.ts). */
const RENEWAL_WINDOW_DAYS = 120;

const ref = (n: number) => `UO-${String(n).padStart(6, "0")}`;
const FUEL_LABEL = { electricity: "electricity", gas: "gas", merchant_services: "card payments" } as const;

/**
 * One-off migration of existing customers from the master sheet (scripts/migrate-customers.ts).
 * Each row becomes a customer (reused when it matches exactly one existing customer), a won
 * opportunity and, for energy, a supply site, meter point and live or ended contract.
 *
 * Imported deals skip the stage gates on purpose: they were signed before the CRM existed. Each is
 * audited as `migration.import` and keyed by `importKey`, so a second run creates nothing new.
 */
@Injectable()
export class MigrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly stages: StagesService,
    private readonly documents: DocumentsService,
    private readonly activities: ActivitiesService,
    private readonly notifications: NotificationsService,
  ) {}

  async importCustomers(tabs: SheetTab[], opts: ImportOptions): Promise<CustomersImport> {
    const today = opts.today ?? businessToday();
    const result: CustomersImport = { lines: [], statuses: {}, suppliersToCreate: [], unmatchedAgents: [], renewalsSoon: 0, ignoredColumns: [...new Set(tabs.flatMap((t) => t.ignored))], meterChecks: 0, lost: 0 };
    const suppliers = await this.prisma.supplier.findMany();
    const users = await this.prisma.user.findMany({ where: { active: true }, select: { id: true, name: true } });
    const userByName = new Map(users.map((u) => [u.name.trim().toLowerCase(), u.id]));
    // Names chosen on the import screen; only active users count, and null means "leave unassigned".
    const activeIds = new Set(users.map((u) => u.id));
    const agents = new Map(Object.entries(opts.agents ?? {}).flatMap(([name, id]) => (id === null || activeIds.has(id) ? [[name.trim().toLowerCase(), id] as const] : [])));
    const liveWon = await this.stages.idFor("live_won");
    // Lost deals (Rejected, Cancel...) stay at Submitted: they reached the supplier, which is where they stopped.
    const submitted = await this.stages.idFor("submitted");
    // Missing or unverified meter numbers go to an administrator to fix.
    const admins = await this.prisma.user.findMany({ where: { active: true, roles: { some: { role: "administrator" } } }, select: { id: true }, orderBy: { createdAt: "asc" } });
    // Customers a dry run would create, so later rows for the same business show as reused.
    const planned: { keys: string[]; label: string }[] = [];
    // Customers created in this run by name, to flag a later row with the same name that nothing else ties to it.
    const createdNames = new Map<string, string>();
    // Customers this run created: a later row matching several of them is the same business seen
    // through different details (phone on one row, email on another), not an ambiguous match.
    const createdIds = new Map<string, string>();
    // Import keys seen in this run: a second row with the same meter, dates and status is kept as its own record.
    const runKeys = new Map<string, number>();

    for (const tab of tabs) {
      for (const { line, cells } of tab.rows) {
        const status = String(cells.contractStatus ?? "").trim() || "(blank)";
        result.statuses[status] = (result.statuses[status] ?? 0) + 1;
        const parsed = parseSheetRow(tab.name, line, cells, { today, allowFormatExceptions: opts.allowFormatExceptions });
        const report = (action: ReportLine["action"], detail: string, customer = "", extra: string[] = []) =>
          result.lines.push({ tab: tab.name, line, action, business: parsed.row?.legalName ?? String(cells.businessName ?? ""), customer, detail, warnings: [...parsed.warnings, ...extra].join(" ") });
        const row = parsed.row;
        if (!row) {
          report("skipped", parsed.issues.join(" "));
          continue;
        }
        const twin = runKeys.get(row.importKey);
        runKeys.set(row.importKey, twin ?? line);
        if (twin !== undefined) {
          row.importKey = `${row.importKey}:row${line}`;
          parsed.warnings.push(`Same meter, dates and status as row ${twin}; imported as a separate record.`);
        }
        const existing = await this.prisma.opportunity.findUnique({ where: { importKey: row.importKey }, select: { number: true } });
        if (existing) {
          report("exists", `Already imported as ${ref(existing.number)}.`);
          continue;
        }

        let supplier = suppliers.find((s) => s.kind === row.supplier.kind && sameSupplier(s.name, row.supplier.name));
        if (!supplier) {
          if (!opts.createSuppliers) {
            report("skipped", `Supplier "${row.supplier.name}" isn't in the CRM. Add it under Administration, or run with --create-suppliers.`);
            if (!result.suppliersToCreate.includes(row.supplier.name)) result.suppliersToCreate.push(row.supplier.name);
            continue;
          }
          if (!result.suppliersToCreate.includes(row.supplier.name)) result.suppliersToCreate.push(row.supplier.name);
          if (opts.commit) {
            supplier = await this.prisma.supplier.create({ data: { name: row.supplier.name, kind: row.supplier.kind } });
            suppliers.push(supplier);
          }
        }

        const extra: string[] = [];
        const mapped = row.salesAgent ? agents.get(row.salesAgent.trim().toLowerCase()) : undefined;
        const ownerId = mapped !== undefined ? (mapped ?? undefined) : row.salesAgent ? userByName.get(row.salesAgent.trim().toLowerCase()) : undefined;
        if (row.salesAgent && !ownerId && mapped !== null) {
          extra.push(`No active user called "${row.salesAgent}"; left unassigned.`);
          if (!result.unmatchedAgents.includes(row.salesAgent)) result.unmatchedAgents.push(row.salesAgent);
        }

        const matches = await this.customers.findDuplicates({ email: row.email, phone: row.phone, legalName: row.legalName, postcode: row.address?.postcode });
        const ours = matches.length > 1 && matches.every((m) => createdIds.has(m.customer.id));
        if (ours) {
          const order = [...createdIds.keys()];
          matches.sort((x, y) => order.indexOf(x.customer.id) - order.indexOf(y.customer.id));
          extra.push(`Also matches ${matches.slice(1).map((m) => createdIds.get(m.customer.id)).join(", ")}, created earlier in this import; added to ${createdIds.get(matches[0].customer.id)}. Merge them under Customers if they're one business.`);
          matches.splice(1);
        }
        if (matches.length > 1) {
          report("skipped", `Matches ${matches.length} existing customers (${matches.map((m) => `${m.customer.legalName}: ${m.reasons.join(", ")}`).join("; ")}). Merge them first or correct the row.`, "", extra);
          continue;
        }
        const keys = this.customerKeys(row);
        const plannedMatch = matches.length ? undefined : planned.find((p) => p.keys.some((k) => keys.includes(k)));
        const customerLabel = matches[0] ? `existing: ${matches[0].customer.legalName} (${matches[0].reasons.join(", ")})` : plannedMatch ? `same as ${plannedMatch.label}` : "new";
        // Same name but no shared email, phone or Eircode: kept separate (customers are never merged
        // automatically), and flagged so a manager can merge them if they're one business.
        if (customerLabel === "new") {
          const name = this.nameKey(row.legalName);
          const earlier = createdNames.get(name);
          const existingSameName = earlier ? null : await this.prisma.customer.findFirst({ where: { legalName: { equals: row.legalName, mode: "insensitive" }, mergedIntoId: null }, select: { legalName: true } });
          if (earlier || existingSameName) extra.push(`Same name as ${earlier ?? `existing customer ${existingSameName!.legalName}`}, but no shared email, phone or Eircode, so it's a separate customer. If it's the same business, merge them under Customers.`);
          if (!earlier) createdNames.set(name, `${tab.name} row ${line}`);
        }

        if (row.outcome === "lost") result.lost++;
        if (row.contractStatus === "live" && row.endDate && row.endDate <= addDays(today, RENEWAL_WINDOW_DAYS)) result.renewalsSoon++;
        if (row.meterCheck) result.meterChecks++;
        if (!opts.commit) {
          if (!matches.length && !plannedMatch) planned.push({ keys, label: `${tab.name} row ${line}` });
          report("created", this.describe(row), customerLabel, extra);
          continue;
        }
        const { number, customerId } = await this.prisma.$transaction((tx) => this.write(tx, row, { customerId: matches[0]?.customer.id, ownerId, supplier: supplier!, stageId: row.outcome === "lost" ? submitted : liveWon, adminId: admins[0]?.id ?? null, today }));
        if (!matches.length) createdIds.set(customerId, `${row.legalName} (${tab.name} row ${line})`);
        report("created", `${ref(number)}: ${this.describe(row)}`, customerLabel, extra);
      }
    }
    if (opts.commit && result.meterChecks) {
      for (const a of admins) {
        await this.notifications.notify(a.id, {
          title: `${result.meterChecks} imported customer${result.meterChecks === 1 ? "" : "s"} need an MPRN or GPRN added or checked`,
          body: "The master sheet had missing or non-standard meter numbers. Each deal has a task \"Add the missing…\" or \"Check the…\" under My tasks.",
          link: "/activities",
        });
      }
    }
    return result;
  }

  /**
   * Attaches signed supplier PDFs to imported deals as "Supplier application form" documents.
   * A PDF is matched by the MPRN/GPRN in its fields, text or name, else by an imported customer's
   * name; `manual` maps file names to a deal number (UO-000123) or meter number for the rest.
   */
  async importDocuments(files: { name: string; buffer: Buffer }[], opts: { commit: boolean; manual?: Map<string, string> }): Promise<DocumentLine[]> {
    const lines: DocumentLine[] = [];
    const imported = await this.prisma.opportunity.findMany({
      where: { importKey: { not: null } },
      select: { id: true, number: true, customer: { select: { legalName: true, tradingName: true } } },
    });
    const label = (o: { number: number; customer: { legalName: string } | null }) => `${ref(o.number)} ${o.customer?.legalName ?? ""}`.trim();
    for (const { name, buffer } of files) {
      const push = (action: DocumentLine["action"], deal: string, found: string, detail: string) => lines.push({ file: name, action, deal, found, detail });
      const sha256 = CryptoService.sha256(buffer);
      const existing = await this.prisma.documentVersion.findFirst({ where: { sha256 }, select: { item: { select: { opportunity: { select: { number: true, customer: { select: { legalName: true } } } } } } } });
      if (existing) {
        push("exists", label(existing.item.opportunity), "", "This PDF is already uploaded.");
        continue;
      }
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        push("review", "", "", "Not a PDF.");
        continue;
      }

      let candidates: { id: string; number: number; customer: { legalName: string } | null }[];
      let found: string;
      let how: string;
      const manual = opts.manual?.get(name)?.trim();
      if (manual) {
        const n = /^UO-?0*(\d+)$/i.exec(manual)?.[1];
        candidates = n ? await this.prisma.opportunity.findMany({ where: { number: Number(n) }, select: { id: true, number: true, customer: { select: { legalName: true } } } }) : await this.byMeter([manual.replace(/\s/g, "")], [manual.replace(/\s/g, "")]);
        found = manual;
        how = "your match";
      } else {
        const facts = await pdfFacts(buffer, name);
        found = [...facts.mprns.map((m) => `MPRN ${m}`), ...facts.gprns.map((g) => `GPRN ${g}`)].join(" ");
        candidates = facts.mprns.length || facts.gprns.length ? await this.byMeter(facts.mprns, facts.gprns) : [];
        how = `meter number in the ${facts.sources.join(", ")}`;
        if (!candidates.length) {
          const norm = (x: string) => x.toLowerCase().replace(/\b(ltd|limited|t\/a|the)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
          const text = ` ${norm(facts.text)} `;
          candidates = imported.filter((o) => [o.customer?.legalName, o.customer?.tradingName].some((n) => n && norm(n).length >= 4 && text.includes(` ${norm(n)} `)));
          how = "business name";
        }
      }
      const unique = [...new Map(candidates.map((c) => [c.id, c])).values()];
      if (unique.length !== 1) {
        push("review", unique.map(label).join("; "), found, unique.length ? `Matches ${unique.length} deals by ${how}; say which in the match column.` : manual ? `No deal for "${manual}".` : "No imported deal matches its meter numbers or business name; fill in the match column.");
        continue;
      }
      const deal = unique[0];
      if (opts.commit) {
        const item = await this.documents.addItem(SYSTEM, deal.id, { documentType: "application_form", required: false });
        await this.documents.upload(SYSTEM, item.id, { originalname: name, mimetype: "application/pdf", size: buffer.length, buffer });
      }
      push("attached", label(deal), found, `Matched by ${how}.`);
    }
    return lines;
  }

  /** Deals whose sites have one of these meter numbers, imported ones first. */
  private async byMeter(mprns: string[], gprns: string[]) {
    const meters = await this.prisma.meterPoint.findMany({
      where: { OR: [{ mprn: { in: mprns } }, { gprn: { in: gprns } }] },
      select: { site: { select: { opportunity: { select: { id: true, number: true, importKey: true, customer: { select: { legalName: true } } } } } } },
    });
    const opps = meters.flatMap((m) => (m.site.opportunity ? [m.site.opportunity] : []));
    const fromSheet = opps.filter((o) => o.importKey);
    return fromSheet.length ? fromSheet : opps;
  }

  private customerKeys(row: MigrationRow) {
    return [row.email && `e:${row.email}`, phoneKey(row.phone) && `p:${phoneKey(row.phone)}`, row.address?.postcode && `n:${row.legalName.toLowerCase()}|${row.address.postcode.toLowerCase()}`].filter((k): k is string => !!k);
  }

  private describe(row: MigrationRow) {
    const meter = row.mprn ? `MPRN ${row.mprn}` : row.gprn ? `GPRN ${row.gprn}` : null;
    const until = row.outcome === "lost" ? `lost (${row.sheetStatus})` : row.endDate ? `${row.contractStatus === "ended" ? "ended" : "until"} ${row.endDate}` : null;
    return [`${row.supplier.name} ${FUEL_LABEL[row.serviceType]}`, meter, row.product, until].filter(Boolean).join(", ");
  }

  /** A business name for comparison: case, punctuation and "Ltd/Limited" ignored. */
  private nameKey(name: string) {
    return name.toLowerCase().replace(/\b(ltd|limited|teoranta|t\/a)\b/g, "").replace(/[^a-z0-9]/g, "");
  }

  private async write(tx: Prisma.TransactionClient, row: MigrationRow, ctx: { customerId?: string; ownerId?: string; supplier: Supplier; stageId: string; adminId: string | null; today: string }): Promise<{ number: number; customerId: string }> {
    let customerId = ctx.customerId;
    if (!customerId) {
      const [first, ...rest] = (row.contactName ?? "").split(/\s+/).filter(Boolean);
      const customer = await tx.customer.create({
        data: {
          legalName: row.legalName,
          tradingName: row.tradingName,
          email: row.email,
          phone: row.phone,
          phoneKey: phoneKey(row.phone),
          addresses: row.address?.line1 ? { create: [{ kind: "trading", ...row.address }] } : undefined,
          contacts: first ? { create: [{ firstName: first, lastName: rest.join(" ") || null, email: row.email, phone: row.phone, phoneKey: phoneKey(row.phone), isPrimary: true }] } : undefined,
        },
      });
      customerId = customer.id;
      await this.audit.record(
        SYSTEM,
        { action: "customer.create", entityType: "customer", entityId: customerId, summary: `Created customer ${row.legalName} from the master sheet` },
        { customerId, kind: "system", body: "Customer created from the master sheet." },
        tx,
      );
    }

    const wonAt = row.signDate ?? row.startDate;
    const lost = row.outcome === "lost";
    const opp = await tx.opportunity.create({
      data: {
        name: `${row.tradingName ?? row.legalName} – ${FUEL_LABEL[row.serviceType]}`,
        customerId,
        companyName: row.legalName,
        contactName: row.contactName,
        email: row.email,
        phone: row.phone,
        phoneKey: phoneKey(row.phone),
        ownerId: ctx.ownerId ?? null,
        stageId: ctx.stageId,
        stageEnteredAt: wonAt ? new Date(`${wonAt}T00:00:00Z`) : new Date(),
        outcome: row.outcome,
        probability: lost ? 0 : stageDef("live_won").probability,
        serviceType: row.serviceType,
        saleType: row.saleType,
        leadSource: "migration",
        leadSourceDetail: `Master sheet, ${row.tab} tab, row ${row.line}`,
        applicationStatus: row.sheetStatus,
        selectedSupplierId: ctx.supplier.id,
        wonAt: lost ? null : wonAt ? new Date(`${wonAt}T00:00:00Z`) : new Date(),
        lostAt: lost ? (wonAt ? new Date(`${wonAt}T00:00:00Z`) : new Date()) : null,
        lostReason: lost ? `Master sheet status: ${row.sheetStatus}` : null,
        activationDate: lost ? null : dateOnly(row.startDate),
        renewalDate: row.contractStatus === "live" ? dateOnly(row.endDate) : null,
        importKey: row.importKey,
      },
    });
    await tx.stageHistory.create({ data: { opportunityId: opp.id, stageId: ctx.stageId, enteredAt: opp.stageEnteredAt } });

    if (row.fuel) {
      const a = row.address;
      const site = await tx.supplySite.create({
        data: {
          customerId,
          opportunityId: opp.id,
          line1: a?.line1 || "Address not recorded",
          line2: a?.line2,
          city: a?.city,
          county: a?.county,
          postcode: a?.postcode,
          country: row.country,
          serviceType: row.serviceType,
          meterPoints: { create: [{ fuel: row.fuel, mprn: row.mprn, gprn: row.gprn, formatExceptionReason: row.formatExceptionReason }] },
        },
      });
      await tx.energyContract.create({
        data: {
          opportunityId: opp.id,
          customerId,
          siteId: site.id,
          fuel: row.fuel,
          selectedSupplierId: ctx.supplier.id,
          status: row.contractStatus,
          termMonths: row.termMonths,
          activationDate: lost ? null : dateOnly(row.startDate),
          contractEndDate: dateOnly(row.endDate),
          pricingPlan: row.product,
        },
      });
      if (row.meterCheck) {
        const id = row.fuel === "gas" ? "GPRN" : "MPRN";
        await this.activities.ensureAutomated(tx, {
          opportunityId: opp.id,
          customerId,
          type: "todo",
          summary:
            row.meterCheck === "missing"
              ? `Add the missing ${id} (imported without one)`
              : row.meterCheck === "fuel"
                ? `Check this is ${row.fuel} and the ${id} ${row.mprn ?? row.gprn}: the sheet had no utility type`
                : `Check the ${id} ${row.mprn ?? row.gprn}: it isn't in the standard format`,
          note: `From the master sheet (${row.tab} tab, row ${row.line}). Take it from the customer's bill or the supplier, then update the meter on the Energy tab.`,
          dueDate: addDays(ctx.today, 7),
          priority: "high",
          ownerId: ctx.adminId,
          automationKey: "migration_meter_check",
        });
      }
    }

    await this.audit.record(
      SYSTEM,
      { action: "migration.import", entityType: "opportunity", entityId: opp.id, summary: `Imported ${opp.name} from the master sheet (${row.tab} tab, row ${row.line})`, data: { importKey: row.importKey, tab: row.tab, line: row.line } },
      {
        opportunityId: opp.id,
        customerId,
        kind: "system",
        body: ["Imported from the master sheet.", ...row.notes.map((n) => `${n.label}: ${n.value}`)].join("\n"),
      },
      tx,
    );
    return { number: opp.number, customerId: customerId! };
  }
}
