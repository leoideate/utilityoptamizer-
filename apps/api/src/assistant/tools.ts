import { Injectable } from "@nestjs/common";
import { ASSISTANT_ACTION_KINDS, STAGES, STAGE_KEYS, type StageKey, gateIssueArea, opportunityListQuerySchema } from "@uo/shared";
import { z } from "zod";
import { ActivitiesService } from "../activities/activities.service";
import type { Actor } from "../common/actor";
import { Conflict, Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { isoDay, opportunityNumber } from "../common/values";
import { DocumentsService } from "../documents/documents.service";
import { EnergyService } from "../energy/energy.service";
import { OpportunityAccess } from "../opportunities/access.service";
import { OpportunitiesService } from "../opportunities/opportunities.service";
import { BordGaisElectricityService } from "../supplier-applications/bord-gais-electricity/bord-gais-electricity.service";
import { FlogasElectricityService } from "../supplier-applications/flogas-electricity/flogas-electricity.service";
import { PROPOSAL_DESCRIPTIONS, PROPOSAL_INPUTS, proposalTool } from "./actions";

/** The longest tool result passed to the model; longer ones are cut. */
const MAX_RESULT = 4000;
const DAY_MS = 86_400_000;

const dealRef = z.string().trim().min(1).max(60).describe('The deal\'s id, or its number such as "UO-000123".');
const views = opportunityListQuerySchema.shape.view.unwrap().options;

/** The lookup tools Claude may call. Read-only, run with the asking user's own access. Changes go through the propose_ tools (actions.ts). */
export const TOOL_INPUTS = {
  get_deal: z.object({ deal: dealRef }),
  what_blocks: z.object({ deal: dealRef, stage: z.enum(STAGE_KEYS).describe("The stage the user wants to move the deal to.") }),
  list_documents: z.object({ deal: dealRef }),
  list_tasks: z.object({ deal: dealRef.optional(), due: z.enum(["overdue", "today", "week"]).optional() }),
  find_deals: z.object({
    view: z.enum(views).default("my_open"),
    stage: z.enum(STAGE_KEYS).optional(),
    search: z.string().trim().max(100).optional().describe("Customer, company, contact or deal number."),
  }),
  energy_details: z.object({ deal: dealRef }),
  application_issues: z.object({ deal: dealRef }),
} as const;
export type ToolName = keyof typeof TOOL_INPUTS;

const DESCRIPTIONS: Record<ToolName, string> = {
  get_deal: "A deal's stage, owner, customer and contacts, supplier and dates, plus what it still needs before each later stage.",
  what_blocks: "What stops a deal moving to a given stage, with the tab where each item is fixed.",
  list_documents: "A deal's document checklist: which documents are required, received, approved, rejected or expiring.",
  list_tasks: "Open tasks for a deal, or the user's own open tasks when no deal is given.",
  find_deals:
    "Deals the user can see, newest activity first (25 at most), with how long each has been at its stage. Views: my_open (the user's open deals), missing_documents, unsigned, awaiting_customer, awaiting_supplier, renewals_due, compliance_queries, unassigned, all.",
  energy_details: "A deal's supply sites, meters (MPRN/GPRN) and energy contracts with current and chosen suppliers.",
  application_issues:
    "The supplier's own application form for a deal (Flogas or Bord Gáis electricity), if one applies, and what it still needs before it can go for signature, with links. Its Fill from bill button fills meter and address details from the uploaded bill.",
};

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: "input" }) as { type: "object"; [k: string]: unknown };

/** Tool definitions in the Messages API format, from the Zod inputs: the lookups, then the propose_ tools. */
export function toolDefinitions() {
  return [
    ...(Object.keys(TOOL_INPUTS) as ToolName[]).map((name) => ({ name, description: DESCRIPTIONS[name], input_schema: schema(TOOL_INPUTS[name]) })),
    ...ASSISTANT_ACTION_KINDS.map((kind) => ({
      name: proposalTool(kind),
      description: `${PROPOSAL_DESCRIPTIONS[kind]} Nothing changes until the user clicks Confirm on the card this shows.`,
      input_schema: schema(PROPOSAL_INPUTS[kind]),
    })),
  ];
}

/** The tab a "can't move yet" issue is fixed on (the web's gateIssueTarget, without supplier-specific tabs). */
export function issueTab(issue: string, energy: boolean) {
  const { area } = gateIssueArea(issue);
  if (area === "approval" || area === "details") return "overview";
  if (area === "supply") return energy ? "energy" : "worldpay";
  if (area === "worldpay" || area === "documents" || area === "signatures") return area;
  return "forms";
}

const days = (since: Date) => Math.floor((Date.now() - since.getTime()) / DAY_MS);
const stageName = (key: string) => STAGES.find((s) => s.key === key)?.name ?? key;

@Injectable()
export class AssistantTools {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly opportunities: OpportunitiesService,
    private readonly documents: DocumentsService,
    private readonly activities: ActivitiesService,
    private readonly energy: EnergyService,
    private readonly flogas: FlogasElectricityService,
    private readonly bordGais: BordGaisElectricityService,
  ) {}

  /**
   * Runs one tool call and returns its result as compact JSON text. A deal the user can't see
   * gives the same "not found" as one that doesn't exist.
   */
  async run(actor: Actor, name: string, input: unknown): Promise<{ text: string; error: boolean }> {
    if (!(name in TOOL_INPUTS)) return { text: `Unknown tool ${name}.`, error: true };
    const parsed = TOOL_INPUTS[name as ToolName].safeParse(input);
    if (!parsed.success) return { text: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`, error: true };
    try {
      const result = await this.call(actor, name as ToolName, parsed.data);
      const text = JSON.stringify(result);
      return { text: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}…(cut)` : text, error: false };
    } catch (e) {
      // Shown to the model as a tool error, like the API would show them to the user.
      if (e instanceof NotFound || e instanceof Forbidden || e instanceof RuleViolation || e instanceof Conflict) return { text: e.message, error: true };
      throw e;
    }
  }

  /** A deal id from an id or a number, only if the user can read it. */
  async dealId(actor: Actor, ref: string): Promise<string> {
    if (/^[0-9a-f-]{36}$/i.test(ref)) return (await this.access.readable(actor, ref)).id;
    const n = opportunityNumber(ref);
    const opp = n ? await this.prisma.opportunity.findFirst({ where: { AND: [this.access.visibleWhere(actor), { number: n }] }, select: { id: true } }) : null;
    if (!opp) throw new NotFound("Opportunity");
    return opp.id;
  }

  private async call(actor: Actor, name: ToolName, input: Record<string, unknown>) {
    switch (name) {
      case "get_deal":
        return this.getDeal(actor, await this.dealId(actor, input.deal as string));
      case "what_blocks": {
        const id = await this.dealId(actor, input.deal as string);
        const { issues } = await this.opportunities.gatePreview(actor, id, input.stage as StageKey);
        const opp = await this.prisma.opportunity.findUniqueOrThrow({ where: { id }, select: { serviceType: true } });
        const energy = opp.serviceType !== "merchant_services";
        return { stage: stageName(input.stage as string), ready: issues.length === 0, issues: issues.map((issue) => ({ issue, link: `/opportunities/${id}?tab=${issueTab(issue, energy)}` })) };
      }
      case "list_documents": {
        const id = await this.dealId(actor, input.deal as string);
        const items = await this.documents.checklist(actor, id);
        return items.map((i) => ({
          document: i.label,
          required: i.required,
          received: i.received,
          approval: i.approval,
          requested: isoDay(i.requestedAt),
          expires: isoDay(i.expiryDate),
          versions: i.versions.length,
        }));
      }
      case "list_tasks": {
        const opportunityId = input.deal ? await this.dealId(actor, input.deal as string) : undefined;
        const page = await this.activities.list(actor, { scope: "mine", opportunityId, due: input.due as "overdue" | "today" | "week" | undefined, page: 1, pageSize: 25 });
        return (page.items as { id: string; summary: string; type: string; dueDate: Date | null; priority: string; owner: { name: string } | null; opportunity: { id: string; number: number; name: string } | null }[]).map((a) => ({
          id: a.id,
          task: a.summary,
          type: a.type,
          due: isoDay(a.dueDate),
          priority: a.priority,
          owner: a.owner?.name ?? null,
          deal: a.opportunity ? { number: a.opportunity.number, name: a.opportunity.name, link: `/opportunities/${a.opportunity.id}` } : null,
        }));
      }
      case "find_deals": {
        const page = await this.opportunities.list(actor, opportunityListQuerySchema.parse({ view: input.view, stage: input.stage, q: input.search, page: 1, pageSize: 25 }));
        const items = page.items as { id: string; number: number; name: string; outcome: string; stageEnteredAt: Date; followUpDate: Date | null; stage: { key: string; name: string }; owner: { name: string } | null; customer: { legalName: string } | null; companyName: string | null }[];
        return {
          total: page.total,
          deals: items.map((o) => ({
            number: o.number,
            name: o.name,
            customer: o.customer?.legalName ?? o.companyName,
            stage: o.stage.name,
            daysAtStage: days(o.stageEnteredAt),
            outcome: o.outcome,
            owner: o.owner?.name ?? "Unassigned",
            followUp: isoDay(o.followUpDate),
            link: `/opportunities/${o.id}`,
          })),
        };
      }
      case "application_issues": {
        const id = await this.dealId(actor, input.deal as string);
        const forms = [
          { form: "Flogas electricity", tab: "flogas", r: await this.flogas.outstanding(actor, id) },
          { form: "Bord Gáis electricity", tab: "bord-gais", r: await this.bordGais.outstanding(actor, id) },
        ].filter((f) => f.r.applies);
        if (!forms.length) return { form: null, note: "No supplier application form applies: those are for Electricity deals with Flogas or Bord Gáis Energy selected. Other suppliers use the Forms tab." };
        return forms.map((f) => ({ form: f.form, ready: f.r.issues.length === 0, link: `/opportunities/${id}?tab=${f.tab}`, stillNeeded: f.r.issues.map((i) => i.message) }));
      }
      case "energy_details": {
        const id = await this.dealId(actor, input.deal as string);
        const w = await this.energy.workspace(actor, id);
        return {
          sites: w.sites.map((s) => ({
            address: [s.line1, s.line2, s.city, s.county, s.postcode].filter(Boolean).join(", "),
            annualConsumptionKwh: s.annualConsumptionKwh,
            meters: s.meterPoints.map((m) => ({ fuel: m.fuel, mprn: m.mprn, gprn: m.gprn, meterNumber: m.meterNumber, readings: m.readings.length })),
          })),
          contracts: w.contracts.map((c) => ({
            fuel: c.fuel,
            status: c.status,
            currentSupplier: c.existingSupplierName,
            newSupplier: c.selectedSupplier?.name ?? null,
            currentContractEnd: isoDay(c.currentContractEndDate),
            proposedStart: isoDay(c.proposedActivationDate),
            termMonths: c.termMonths,
            contractEnd: isoDay(c.contractEndDate),
          })),
          link: `/opportunities/${id}?tab=energy`,
        };
      }
    }
  }

  private async getDeal(actor: Actor, id: string) {
    const w = await this.opportunities.workspace(actor, id);
    const primary = w.customer?.contacts.find((c) => c.isPrimary) ?? w.customer?.contacts[0];
    return {
      number: w.number,
      name: w.name,
      link: `/opportunities/${id}`,
      stage: w.stage.name,
      daysAtStage: days(w.stageEnteredAt),
      outcome: w.outcome,
      serviceType: w.serviceType,
      saleType: w.saleType,
      owner: w.owner?.name ?? "Unassigned",
      customer: w.customer ? { name: w.customer.legalName, tradingName: w.customer.tradingName, link: `/customers/${w.customer.id}` } : w.companyName,
      contact: primary ? { name: [primary.firstName, primary.lastName].filter(Boolean).join(" "), email: primary.email, phone: primary.mobile ?? primary.phone } : w.contactName,
      supplier: w.selectedSupplier?.name ?? null,
      followUp: isoDay(w.followUpDate),
      renewalDate: isoDay(w.renewalDate),
      openTasks: w._count.activities,
      // What each later stage still needs (empty: ready).
      stillNeeded: Object.fromEntries(Object.entries(w.gates).map(([stage, issues]) => [stageName(stage), issues])),
      canEdit: w.permissions.write,
    };
  }
}
