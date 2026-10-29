import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  CASE_KIND_LABELS,
  DEFAULT_WORKFLOW_REMINDERS,
  DOCUMENT_TYPES,
  RESPONSE_OUTCOME_LABELS,
  RESPONSE_SOURCE_LABELS,
  SUBMISSION_CHANNEL_LABELS,
  type CaseKind,
  type LeaseCheckInput,
  type SubmissionInput,
  type SubmissionResponseInput,
  type WorkflowCaseInput,
  type WorkflowReminders,
  addDays,
  can,
  STAGE_KEYS,
  canReadOpportunity,
  caseChecklist,
  isHandedOver,
  caseKind,
  caseSteps,
  leaseCheckPassed,
  stageGateIssues,
  today,
  workflowRemindersSchema,
} from "@uo/shared";
import { ActivitiesService } from "../activities/activities.service";
import { AuditService } from "../audit/audit.service";
import { type Actor, SYSTEM, actorRef } from "../common/actor";
import { Forbidden, NotFound, RuleViolation, assertRules } from "../common/errors";
import type { Db } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";
import { dateOnly, defined, isoDay } from "../common/values";
import { OpportunityAccess, type OppWithStage } from "../opportunities/access.service";
import { termsSnapshot } from "../opportunities/facts";
import { OpportunitiesService } from "../opportunities/opportunities.service";

const ENERGY = ["electricity", "gas", "dual_fuel"] as const;
const docLabel = (t: string) => (DOCUMENT_TYPES as Record<string, { label: string }>)[t]?.label ?? t;

const CASE_FIELD_LABELS: Record<keyof WorkflowCaseInput, string> = {
  customerPath: "customer path",
  requestChannel: "request channel",
  requestReceivedAt: "request date",
  requestNote: "request note",
  supplyPath: "supply point path",
  siteId: "matched supply point",
  outgoingCustomerId: "outgoing customer",
  outgoingAccountRef: "outgoing account number",
  outgoingContractRef: "outgoing contract reference",
  occupancyDate: "occupancy date",
  supplySource: "source of supply details",
  noticeDeadline: "notice deadline",
  targetSubmissionDate: "target submission date",
};

/** Reminder intervals (Settings → workflow.reminders), falling back to the defaults. */
export async function workflowReminders(db: Db): Promise<WorkflowReminders> {
  const s = await db.setting.findUnique({ where: { key: "workflow.reminders" } });
  const parsed = workflowRemindersSchema.safeParse(s?.value);
  return parsed.success ? parsed.data : DEFAULT_WORKFLOW_REMINDERS;
}

/**
 * The back-office workflows on an energy opportunity (change of legal entity, existing-supplier
 * renewal, change of supplier): case details, supply point matching, lease and terms checks,
 * what was sent to the external party and what came back. Evidence rows are append-only.
 */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OpportunityAccess,
    private readonly audit: AuditService,
    private readonly activities: ActivitiesService,
    private readonly opportunities: OpportunitiesService,
  ) {}

  private static energy(opp: OppWithStage) {
    if (opp.serviceType === "merchant_services") throw new RuleViolation(["Worldpay applications are tracked on the Worldpay application, not as an energy case."]);
  }

  private async userNames(ids: (string | null | undefined)[]) {
    const clean = [...new Set(ids.filter((x): x is string => !!x))];
    const users = clean.length ? await this.prisma.user.findMany({ where: { id: { in: clean } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async siteVisible(actor: Actor, site: { customerId: string | null; opportunity: { ownerId: string | null } | null }) {
    if (can(actor, "opportunity.read_all")) return true;
    if (site.opportunity && canReadOpportunity(actor, site.opportunity)) return true;
    return !!site.customerId && (await this.prisma.customer.count({ where: { AND: [{ id: site.customerId }, this.access.customerWhere(actor)] } })) > 0;
  }

  // --- Overview ----------------------------------------------------------------------

  /** Everything the case card shows: kind, derived status and steps, checklist and evidence. */
  async overview(actor: Actor, opportunityId: string) {
    const opp = await this.access.readable(actor, opportunityId);
    WorkflowsService.energy(opp);
    const facts = await this.opportunities.facts(opportunityId);
    const { kind, steps, status, exception } = caseSteps(facts, opp.outcome);
    const [kase, leaseItems, leaseChecks, contracts, termsChecks, submissions, items, forms, supplier] = await Promise.all([
      this.prisma.workflowCase.findUnique({
        where: { opportunityId },
        include: { site: { include: { meterPoints: true, customer: { select: { id: true, legalName: true } } } }, outgoingCustomer: { select: { id: true, legalName: true } } },
      }),
      this.prisma.documentVersion.findMany({ where: { item: { opportunityId, documentType: "lease_agreement" }, removedAt: null }, orderBy: { uploadedAt: "desc" } }),
      this.prisma.leaseCheck.findMany({ where: { opportunityId }, orderBy: { verifiedAt: "desc" } }),
      this.prisma.energyContract.findMany({ where: { opportunityId } }),
      this.prisma.termsCheck.findMany({ where: { opportunityId }, orderBy: { verifiedAt: "desc" } }),
      this.prisma.submission.findMany({ where: { opportunityId }, orderBy: { recordedAt: "desc" }, include: { responses: { orderBy: { recordedAt: "asc" } } } }),
      this.prisma.documentItem.findMany({ where: { opportunityId }, include: { versions: { where: { removedAt: null }, orderBy: { version: "desc" }, take: 1 } }, orderBy: { createdAt: "asc" } }),
      this.prisma.generatedForm.findMany({ where: { opportunityId, status: { not: "superseded" } }, include: { template: { select: { name: true } } } }),
      opp.selectedSupplierId ? this.prisma.supplier.findUnique({ where: { id: opp.selectedSupplierId } }) : null,
    ]);
    const users = await this.userNames([
      kase?.supplyVerifiedById,
      ...leaseChecks.map((c) => c.verifiedById),
      ...termsChecks.map((c) => c.verifiedById),
      ...submissions.flatMap((s) => [s.recordedById, ...s.responses.flatMap((r) => [r.recordedById, r.correctionOwnerId])]),
    ]);
    const snap = termsSnapshot(contracts, opp.selectedSupplierId);
    const latestLease = leaseItems[0];
    const generatedVersions = new Set(forms.map((f) => f.versionId));

    // Files that can be sent: the latest version of every document, plus each form's signed and black and white copies.
    const files = new Map<string, { versionId: string; label: string; filename: string; version: number; uploadedAt: Date; documentType: string; role: string }>();
    for (const item of items) {
      const v = item.versions[0];
      if (v && v.scanStatus !== "infected") files.set(v.id, { versionId: v.id, label: docLabel(item.documentType), filename: v.filename, version: v.version, uploadedAt: v.uploadedAt, documentType: item.documentType, role: "document" });
    }
    const formVersionIds = forms.flatMap((f) => [f.signedVersionId, f.monoVersionId]).filter((x): x is string => !!x);
    const formVersions = formVersionIds.length ? await this.prisma.documentVersion.findMany({ where: { id: { in: formVersionIds } }, include: { item: true } }) : [];
    for (const f of forms) {
      for (const [id, role] of [
        [f.signedVersionId, "signed form"],
        [f.monoVersionId, "black and white copy"],
      ] as const) {
        const v = formVersions.find((x) => x.id === id);
        if (v) files.set(v.id, { versionId: v.id, label: `${f.template.name} (${role})`, filename: v.filename, version: v.version, uploadedAt: v.uploadedAt, documentType: v.item.documentType, role });
      }
    }

    return {
      kind,
      kindLabel: CASE_KIND_LABELS[kind],
      status,
      exception,
      steps,
      checklist: caseChecklist(facts),
      readyIssues: stageGateIssues(facts, "submitted"),
      case: kase
        ? {
            ...kase,
            requestReceivedAt: isoDay(kase.requestReceivedAt),
            occupancyDate: isoDay(kase.occupancyDate),
            noticeDeadline: isoDay(kase.noticeDeadline),
            targetSubmissionDate: isoDay(kase.targetSubmissionDate),
            supplyVerifiedBy: users.get(kase.supplyVerifiedById ?? "") ?? null,
          }
        : null,
      lease: {
        latest: latestLease ? { versionId: latestLease.id, version: latestLease.version, filename: latestLease.filename, uploadedAt: latestLease.uploadedAt, generatedDraft: generatedVersions.has(latestLease.id) } : null,
        checks: leaseChecks.map((c) => ({ ...c, tenancyStartDate: isoDay(c.tenancyStartDate), verifiedBy: users.get(c.verifiedById ?? "") ?? null, current: c.documentVersionId === latestLease?.id })),
      },
      terms: {
        complete: snap.complete,
        verified: facts.workflow?.terms.verified ?? false,
        current: snap.terms,
        checks: termsChecks.map((c) => ({ id: c.id, verifiedAt: c.verifiedAt, verifiedBy: users.get(c.verifiedById ?? "") ?? null, current: c.snapshotHash === snap.hash })),
      },
      supplier: supplier ? { id: supplier.id, name: supplier.name, renewalRoute: supplier.renewalRoute, outgoingConsentRequired: supplier.outgoingConsentRequired, monoCopyRequired: supplier.monoCopyRequired, submissionEmail: supplier.submissionEmail } : null,
      submissions: submissions.map((s) => ({
        id: s.id,
        recipient: s.recipient,
        channel: s.channel,
        sentAt: isoDay(s.sentAt),
        files: s.files,
        deliveryEvidence: s.deliveryEvidence,
        note: s.note,
        recordedAt: s.recordedAt,
        recordedBy: users.get(s.recordedById ?? "") ?? null,
        responses: s.responses.map((r) => ({
          ...r,
          receivedAt: isoDay(r.receivedAt),
          effectiveDate: isoDay(r.effectiveDate),
          correctionDueDate: isoDay(r.correctionDueDate),
          recordedBy: users.get(r.recordedById ?? "") ?? null,
          correctionOwner: users.get(r.correctionOwnerId ?? "") ?? null,
        })),
      })),
      files: [...files.values()],
      permissions: { write: (await this.canWrite(actor, opp)), submit: can(actor, "opportunity.submit"), verifyLease: can(actor, "document.review") },
    };
  }

  private async canWrite(actor: Actor, opp: OppWithStage) {
    try {
      await this.access.writable(actor, opp.id);
      return true;
    } catch {
      return false;
    }
  }

  // --- Case details ------------------------------------------------------------------

  async saveCase(actor: Actor, opportunityId: string, input: WorkflowCaseInput) {
    const opp = await this.access.writable(actor, opportunityId);
    WorkflowsService.energy(opp);
    const existing = await this.prisma.workflowCase.findUnique({ where: { opportunityId } });
    const issues: string[] = [];

    let site: Prisma.SupplySiteGetPayload<{ include: { meterPoints: true; opportunity: { select: { ownerId: true } } } }> | null = null;
    if (input.siteId) {
      site = await this.prisma.supplySite.findUnique({ where: { id: input.siteId }, include: { meterPoints: true, opportunity: { select: { ownerId: true } } } });
      if (!site || !(await this.siteVisible(actor, site))) throw new NotFound("Supply point");
    }
    let outgoingCustomerId = input.outgoingCustomerId;
    // Matching a known supply point brings its current account holder in as the outgoing customer.
    if (site && input.siteId !== existing?.siteId && outgoingCustomerId === undefined && site.customerId) outgoingCustomerId = site.customerId;
    if (outgoingCustomerId) {
      if (!(await this.prisma.customer.findUnique({ where: { id: outgoingCustomerId } }))) issues.push("Choose the outgoing customer from the list.");
      if (outgoingCustomerId === opp.customerId) issues.push("The outgoing account holder can't also be the incoming customer. Link or create a separate incoming customer first.");
    }
    const supplyPath = input.supplyPath ?? (input.siteId ? "known_supply_point" : undefined);
    if (supplyPath === "new_supply_point" && (input.siteId ?? (input.siteId === undefined ? existing?.siteId : null))) {
      issues.push("A supply point new to us isn't matched from our records. Clear the matched supply point, or choose that it's already in our records.");
    }
    if (input.requestReceivedAt && input.requestReceivedAt > today()) issues.push("The request date can't be in the future.");
    assertRules(issues);

    const data = defined({
      customerPath: input.customerPath,
      requestChannel: input.requestChannel,
      requestReceivedAt: dateOnly(input.requestReceivedAt),
      requestNote: input.requestNote,
      supplyPath,
      siteId: input.siteId,
      outgoingCustomerId,
      outgoingAccountRef: input.outgoingAccountRef,
      outgoingContractRef: input.outgoingContractRef,
      occupancyDate: dateOnly(input.occupancyDate),
      supplySource: input.supplySource,
      noticeDeadline: dateOnly(input.noticeDeadline),
      targetSubmissionDate: dateOnly(input.targetSubmissionDate),
    });
    const before = (existing ?? {}) as Record<string, unknown>;
    const same = (a: unknown, b: unknown) => (a instanceof Date ? a.getTime() : (a ?? null)) === (b instanceof Date ? b.getTime() : (b ?? null));
    const changed = (Object.keys(data) as (keyof typeof data)[]).filter((k) => !same(before[k], data[k]));
    if (!changed.length && existing) return;
    const sourceChanged = changed.includes("supplySource");

    await this.prisma.$transaction(async (tx) => {
      const verified = sourceChanged ? { supplyVerifiedById: data.supplySource ? actorRef(actor) : null, supplyVerifiedAt: data.supplySource ? new Date() : null } : {};
      await tx.workflowCase.upsert({
        where: { opportunityId },
        create: { opportunityId, ...data, ...verified, createdById: actorRef(actor) } as Prisma.WorkflowCaseUncheckedCreateInput,
        update: { ...data, ...verified } as Prisma.WorkflowCaseUncheckedUpdateInput,
      });
      const labels = changed.map((k) => CASE_FIELD_LABELS[k as keyof WorkflowCaseInput]);
      const matched = site && changed.includes("siteId") ? ` Matched supply point ${site.label || site.line1}${site.meterPoints.map((m) => m.mprn ?? m.gprn).filter(Boolean).length ? ` (${site.meterPoints.map((m) => m.mprn ?? m.gprn).filter(Boolean).join(", ")})` : ""}; its history stays with the outgoing account.` : "";
      await this.audit.record(
        actor,
        { action: existing ? "case.update" : "case.create", entityType: "opportunity", entityId: opportunityId, summary: `Case details: ${labels.join(", ")}`, data: { fields: changed } },
        { opportunityId, customerId: opp.customerId, kind: "system", body: `${existing ? "Case details updated" : "Case opened"}: ${labels.join(", ")}.${matched}${sourceChanged && data.supplySource ? ` Supply details source recorded and verified by ${actor.name}.` : ""}` },
        tx,
      );
    });
  }

  /**
   * Finds supply points by MPRN/GPRN, address, Eircode or customer name. Sites the user can't see
   * are only counted; more than one match is flagged so the right record is chosen deliberately.
   */
  async searchSupplyPoints(actor: Actor, q: string) {
    if (!can(actor, "customer.read")) throw new Forbidden();
    const term = q.trim();
    const digits = term.replace(/\s+/g, "");
    const where: Prisma.SupplySiteWhereInput = /^\d{3,11}$/.test(digits)
      ? { meterPoints: { some: { OR: [{ mprn: { startsWith: digits } }, { gprn: { startsWith: digits } }] } } }
      : {
          OR: [
            { line1: { contains: term, mode: "insensitive" } },
            { label: { contains: term, mode: "insensitive" } },
            { postcode: { contains: term, mode: "insensitive" } },
            { customer: { legalName: { contains: term, mode: "insensitive" } } },
            { customer: { tradingName: { contains: term, mode: "insensitive" } } },
          ],
        };
    const sites = await this.prisma.supplySite.findMany({
      where,
      take: 50,
      orderBy: { createdAt: "desc" },
      include: { meterPoints: true, customer: { select: { id: true, legalName: true } }, opportunity: { select: { ownerId: true } } },
    });
    const visible: typeof sites = [];
    for (const s of sites) if (await this.siteVisible(actor, s)) visible.push(s);
    const ids = visible.map((s) => s.id);
    const open = ids.length
      ? await this.prisma.opportunity.findMany({
          where: { outcome: "open", OR: [{ sites: { some: { id: { in: ids } } } }, { contracts: { some: { siteId: { in: ids } } } }, { workflowCase: { siteId: { in: ids } } }] },
          select: { id: true, number: true, name: true, ownerId: true, serviceType: true, saleType: true, supplyChanges: true, sites: { select: { id: true } }, contracts: { select: { siteId: true } }, workflowCase: { select: { siteId: true } } },
        })
      : [];
    const matches = visible.slice(0, 20).map((s) => {
      const cases = open.filter((o) => o.sites.some((x) => x.id === s.id) || o.contracts.some((c) => c.siteId === s.id) || o.workflowCase?.siteId === s.id);
      const seen = cases.filter((o) => canReadOpportunity(actor, o));
      return {
        siteId: s.id,
        label: s.label,
        address: [s.line1, s.line2, s.city, s.county, s.postcode].filter(Boolean).join(", "),
        serviceType: s.serviceType,
        meters: s.meterPoints.map((m) => ({ fuel: m.fuel, mprn: m.mprn, gprn: m.gprn })),
        customer: s.customer,
        openCases: seen.map((o) => ({ id: o.id, number: o.number, name: o.name, kind: CASE_KIND_LABELS[caseKind(o)] })),
        hiddenOpenCases: cases.length - seen.length,
      };
    });
    return { matches, hiddenCount: sites.length - visible.length, ambiguous: matches.length > 1 };
  }

  // --- Lease and terms ---------------------------------------------------------------

  async checkLease(actor: Actor, opportunityId: string, input: LeaseCheckInput) {
    if (!can(actor, "document.review")) throw new Forbidden("Only reviewers can check a lease.");
    const opp = await this.access.readable(actor, opportunityId);
    WorkflowsService.energy(opp);
    const lease = await this.prisma.documentVersion.findFirst({ where: { item: { opportunityId, documentType: "lease_agreement" }, removedAt: null }, orderBy: { uploadedAt: "desc" } });
    if (!lease) throw new RuleViolation(["Upload the lease under Documents first."]);
    const passed = leaseCheckPassed(input);
    const check = await this.prisma.$transaction(async (tx) => {
      const created = await tx.leaseCheck.create({
        data: {
          opportunityId,
          documentVersionId: lease.id,
          status: input.status,
          landlordName: input.landlordName,
          tenantName: input.tenantName,
          tenancyStartDate: dateOnly(input.tenancyStartDate) ?? null,
          landlordMatches: input.landlordMatches,
          tenantMatches: input.tenantMatches,
          addressMatches: input.addressMatches,
          datesMatch: input.datesMatch,
          signedByLandlord: input.signedByLandlord,
          signedByTenant: input.signedByTenant,
          passed,
          notes: input.notes ?? null,
          verifiedById: actorRef(actor),
        },
      });
      const failed = [
        !input.landlordMatches && "landlord differs",
        !input.tenantMatches && "tenant differs",
        !input.addressMatches && "property address differs",
        !input.datesMatch && "dates differ",
        input.status === "signed" && !input.signedByLandlord && "not signed by the landlord",
        input.status === "signed" && !input.signedByTenant && "not signed by the tenant",
      ].filter(Boolean);
      const body =
        input.status === "draft"
          ? `Lease (version ${lease.version}) recorded as a draft: not signed yet, so it can't be submitted.`
          : passed
            ? `Signed lease (version ${lease.version}) checked: matches the case and is signed by both parties.`
            : `Signed lease (version ${lease.version}) failed its check: ${failed.join(", ")}.`;
      await this.audit.record(
        actor,
        { action: "lease_check.record", entityType: "opportunity", entityId: opportunityId, summary: `Lease ${input.status} ${passed ? "passed" : "not passed"}`, data: { leaseCheckId: created.id, documentVersionId: lease.id } },
        { opportunityId, customerId: opp.customerId, kind: "document", body },
        tx,
      );
      return created;
    });
    return { id: check.id, passed };
  }

  async verifyTerms(actor: Actor, opportunityId: string) {
    if (!can(actor, "opportunity.submit")) throw new Forbidden("Only Operations or a manager can verify terms.");
    const opp = await this.access.readable(actor, opportunityId);
    WorkflowsService.energy(opp);
    const contracts = await this.prisma.energyContract.findMany({ where: { opportunityId } });
    const snap = termsSnapshot(contracts, opp.selectedSupplierId);
    if (!snap.complete) throw new RuleViolation(["Enter the supplier, term, proposed start date and at least one rate on every contract first."]);
    const check = await this.prisma.$transaction(async (tx) => {
      const created = await tx.termsCheck.create({ data: { opportunityId, snapshotHash: snap.hash, terms: snap.terms as unknown as Prisma.InputJsonValue, verifiedById: actorRef(actor) } });
      await this.audit.record(
        actor,
        { action: "terms_check.record", entityType: "opportunity", entityId: opportunityId, summary: "Verified the proposed terms", data: { termsCheckId: created.id } },
        { opportunityId, customerId: opp.customerId, kind: "approval", body: `Terms verified: ${snap.terms.map((t) => `${t.fuel}, ${t.termMonths} months from ${t.startDate}`).join("; ")}.` },
        tx,
      );
      return created;
    });
    return { id: check.id };
  }

  // --- Submission and response -------------------------------------------------------

  /** Records exactly what was sent, to whom, how and with what proof. Moves the deal to Submitted. */
  async recordSubmission(actor: Actor, opportunityId: string, input: SubmissionInput) {
    if (!can(actor, "opportunity.submit")) throw new Forbidden("Only Operations or a manager can submit applications.");
    const opp = await this.access.writable(actor, opportunityId);
    WorkflowsService.energy(opp);
    if (opp.outcome !== "open") throw new RuleViolation(["Only open cases can be submitted."]);
    const facts = await this.opportunities.facts(opportunityId);
    const gate = stageGateIssues(facts, "submitted");
    if (gate.length) throw new RuleViolation(gate);

    const ids = [...new Set(input.documentVersionIds)];
    const versions = await this.prisma.documentVersion.findMany({ where: { id: { in: ids } }, include: { item: true } });
    const issues: string[] = [];
    if (versions.length !== ids.length || versions.some((v) => v.item.opportunityId !== opportunityId)) issues.push("Choose files from this opportunity.");
    for (const v of versions) if (v.scanStatus === "infected") issues.push(`${v.filename} failed its virus scan and can't be sent.`);
    for (const v of versions) if (v.removedAt) issues.push(`${v.filename} was removed from the documents and can't be sent.`);
    const sentAt = input.sentAt ?? today();
    if (sentAt > today()) issues.push("The sent date can't be in the future.");

    // The exact final versions must be in the file set.
    const sent = new Set(ids);
    const forms = await this.prisma.generatedForm.findMany({ where: { opportunityId, status: "approved" }, include: { template: { select: { name: true } } } });
    const mono = !!facts.workflow?.supplier?.monoCopyRequired;
    for (const f of forms) {
      if (mono) {
        if (!f.monoVersionId) issues.push(`This supplier needs black and white copies: create one for "${f.template.name}".`);
        else if (!sent.has(f.monoVersionId)) issues.push(`Include the black and white copy of "${f.template.name}".`);
      } else if (f.signedVersionId && !sent.has(f.signedVersionId) && !(f.monoVersionId && sent.has(f.monoVersionId))) {
        issues.push(`Include the signed "${f.template.name}".`);
      }
    }
    const kind = caseKind(opp);
    const latestOf = async (documentType: string) => this.prisma.documentVersion.findFirst({ where: { item: { opportunityId, documentType }, removedAt: null }, orderBy: { uploadedAt: "desc" }, select: { id: true } });
    if (kind === "change_of_entity") {
      const lease = await latestOf("lease_agreement");
      if (lease && !sent.has(lease.id)) issues.push("Include the signed lease agreement.");
    }
    if (kind === "renewal" && facts.workflow?.supplier?.renewalRoute === "rate_card_only") {
      const card = await latestOf("rate_card");
      if (card && !sent.has(card.id)) issues.push("Include the signed rate card.");
    }
    assertRules(issues);

    if (!opp.stageKey || !["submitted", "compliance_query", "awaiting_confirmation"].includes(opp.stageKey)) {
      await this.opportunities.moveStage(actor, opportunityId, "submitted");
    }
    const reminders = await workflowReminders(this.prisma);
    const submission = await this.prisma.$transaction(async (tx) => {
      const created = await tx.submission.create({
        data: {
          opportunityId,
          recipient: input.recipient,
          channel: input.channel,
          sentAt: dateOnly(sentAt),
          files: versions.map((v) => ({ documentVersionId: v.id, documentType: v.item.documentType, label: docLabel(v.item.documentType), filename: v.filename, version: v.version, sha256: v.sha256 })),
          deliveryEvidence: input.deliveryEvidence,
          note: input.note ?? null,
          recordedById: actorRef(actor),
        },
      });
      await this.audit.record(
        actor,
        { action: "submission.record", entityType: "opportunity", entityId: opportunityId, summary: `Sent to ${input.recipient}`, data: { submissionId: created.id, files: ids } },
        {
          opportunityId,
          customerId: opp.customerId,
          kind: "submission",
          body: `Sent to ${input.recipient} by ${SUBMISSION_CHANNEL_LABELS[input.channel].toLowerCase()} on ${sentAt}: ${versions.map((v) => `${v.filename} (v${v.version})`).join(", ")}. Proof of delivery: ${input.deliveryEvidence}. Pending until the external party responds.`,
        },
        tx,
      );
      await this.activities.completeAutomated(tx, opportunityId, "submission_follow_up");
      await this.activities.completeAutomated(tx, opportunityId, "submission_correction");
      await this.activities.completeAutomated(tx, opportunityId, "renewal_deadline");
      await this.activities.ensureAutomated(tx, {
        opportunityId,
        customerId: opp.customerId,
        type: "follow_up_supplier",
        summary: `No response yet from ${input.recipient}: chase the submission sent ${sentAt}`,
        dueDate: addDays(sentAt, reminders.submissionFollowUpDays),
        ownerId: actorRef(actor) ?? opp.ownerId,
        automationKey: "submission_follow_up",
      });
      return created;
    });
    return { id: submission.id };
  }

  /** The external party's answer. Rejections and queries create a correction task; acceptance moves the deal on. */
  async recordResponse(actor: Actor, submissionId: string, input: SubmissionResponseInput) {
    if (!can(actor, "opportunity.submit")) throw new Forbidden("Only Operations or a manager can record responses.");
    const sub = await this.prisma.submission.findUnique({ where: { id: submissionId }, include: { responses: true } });
    if (!sub) throw new NotFound("Submission");
    const opp = await this.access.writable(actor, sub.opportunityId);
    if (opp.outcome !== "open") throw new RuleViolation(["This case is closed."]);
    const latest = await this.prisma.submission.findFirst({ where: { opportunityId: opp.id }, orderBy: { recordedAt: "desc" }, select: { id: true } });
    const issues: string[] = [];
    if (latest?.id !== sub.id) issues.push("Record responses against the latest submission.");
    const receivedAt = input.receivedAt ?? today();
    if (receivedAt > today()) issues.push("The date received can't be in the future.");
    if (receivedAt < isoDay(sub.sentAt)!) issues.push("The response can't be dated before the submission was sent.");
    if (input.outcome === "change_confirmed" && !input.externalReference && !sub.responses.some((r) => r.outcome === "accepted" && r.externalReference)) {
      issues.push("Record the acceptance and its reference first, or enter the reference with the confirmation.");
    }
    const negative = input.outcome === "rejected" || input.outcome === "changes_required";
    let ownerId = opp.ownerId ?? actorRef(actor);
    if (negative && input.correctionOwnerId) {
      const u = await this.prisma.user.findUnique({ where: { id: input.correctionOwnerId } });
      if (!u?.active) issues.push("Choose an active user to make the correction.");
      ownerId = input.correctionOwnerId;
    }
    const due = input.correctionDueDate ?? addDays(today(), 1);
    if (negative && input.correctionDueDate && input.correctionDueDate < today()) issues.push("The correction due date can't be in the past.");
    assertRules(issues);

    const response = await this.prisma.$transaction(async (tx) => {
      const created = await tx.submissionResponse.create({
        data: {
          submissionId,
          opportunityId: opp.id,
          outcome: input.outcome,
          receivedVia: input.receivedVia,
          receivedAt: dateOnly(receivedAt),
          externalReference: input.externalReference ?? null,
          effectiveDate: dateOnly(input.effectiveDate) ?? null,
          reason: input.reason ?? null,
          correctionOwnerId: negative ? ownerId : null,
          correctionDueDate: negative ? dateOnly(due) : null,
          recordedById: actorRef(actor),
        },
      });
      await this.activities.completeAutomated(tx, opp.id, "submission_follow_up");
      let owner: string | null = null;
      if (negative) {
        await this.activities.completeAutomated(tx, opp.id, "submission_correction");
        await this.activities.ensureAutomated(tx, {
          opportunityId: opp.id,
          customerId: opp.customerId,
          type: "submit_application",
          summary: `${input.outcome === "rejected" ? "Rejected" : "Changes required"}: correct and resubmit`,
          note: input.reason ?? null,
          dueDate: due,
          priority: "high",
          ownerId,
          automationKey: "submission_correction",
        });
        owner = ownerId ? ((await tx.user.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name ?? null) : null;
      } else {
        await this.activities.completeAutomated(tx, opp.id, "submission_correction");
      }
      const detail =
        input.outcome === "accepted"
          ? `, reference ${input.externalReference}`
          : input.outcome === "change_confirmed"
            ? `: effective ${input.effectiveDate}${input.externalReference ? `, reference ${input.externalReference}` : ""}`
            : `: ${input.reason}. Correction assigned to ${owner ?? "nobody"}, due ${due}`;
      await this.audit.record(
        actor,
        { action: `submission.${input.outcome}`, entityType: "opportunity", entityId: opp.id, summary: RESPONSE_OUTCOME_LABELS[input.outcome], data: { submissionId, responseId: created.id } },
        { opportunityId: opp.id, customerId: opp.customerId, kind: "submission", body: `External response (${RESPONSE_SOURCE_LABELS[input.receivedVia].toLowerCase()}, ${receivedAt}): ${RESPONSE_OUTCOME_LABELS[input.outcome]}${detail}.` },
        tx,
      );
      return created;
    });

    // Acceptance moves the deal to Awaiting Confirmation; if a gate no longer passes, the response is still kept.
    let stageIssues: string[] = [];
    if (!negative && (opp.stageKey === "submitted" || opp.stageKey === "compliance_query")) {
      try {
        await this.opportunities.moveStage(actor, opp.id, "awaiting_confirmation");
      } catch (e) {
        if (!(e instanceof RuleViolation)) throw e;
        stageIssues = e.issues;
      }
    }
    return { id: response.id, stageIssues };
  }

  // --- Dashboard ---------------------------------------------------------------------

  /** Open cases (and those completed in the last 90 days) grouped by where they stand. */
  async dashboard(actor: Actor, q: { kind?: CaseKind; ownerId?: string; supplierId?: string; dueBefore?: string; scope?: "back_office" }) {
    const asOf = today();
    const and: Prisma.OpportunityWhereInput[] = [
      this.access.visibleWhere(actor),
      { serviceType: { in: [...ENERGY] } },
      { OR: [{ outcome: "open" }, { outcome: "won", wonAt: { gte: new Date(Date.now() - 90 * 86_400_000) } }] },
    ];
    if (q.kind === "change_of_entity") and.push({ supplyChanges: { has: "change_of_legal_entity" } });
    if (q.kind === "change_of_supplier") and.push({ supplyChanges: { has: "change_of_supplier" } }, { NOT: { supplyChanges: { has: "change_of_legal_entity" } } });
    if (q.kind === "renewal") and.push({ saleType: "renewal" }, { NOT: { supplyChanges: { hasSome: ["change_of_supplier", "change_of_legal_entity"] } } });
    if (q.kind === "new_supply") and.push({ saleType: "new_sale" }, { supplyChanges: { isEmpty: true } });
    if (q.ownerId) and.push({ ownerId: q.ownerId });
    if (q.supplierId) and.push({ selectedSupplierId: q.supplierId });
    // The back office's queue: deals handed over at Supplier selected, and those completed recently.
    if (q.scope === "back_office") and.push({ OR: [{ outcome: "won" }, { stage: { key: { in: STAGE_KEYS.filter((k) => isHandedOver(k)) } } }] });
    const opps = await this.prisma.opportunity.findMany({
      where: { AND: and },
      take: 200,
      orderBy: { updatedAt: "desc" },
      include: { owner: { select: { id: true, name: true } }, selectedSupplier: { select: { id: true, name: true } }, workflowCase: { select: { targetSubmissionDate: true } }, customer: { select: { legalName: true } } },
    });
    const rows = [];
    for (const o of opps) {
      const facts = await this.opportunities.facts(o.id);
      const { kind, status, exception, steps } = caseSteps(facts, o.outcome);
      const current = steps.find((s) => !s.done)?.key ?? null;
      const due = isoDay(o.workflowCase?.targetSubmissionDate) ?? isoDay(o.renewalDate) ?? isoDay(o.expectedCloseDate);
      if (q.dueBefore && (!due || due > q.dueBefore)) continue;
      const sent = facts.workflow?.submission.latest;
      const bucket =
        o.outcome === "won"
          ? "completed"
          : exception
            ? "rejected"
            : sent && !sent.accepted
              ? "sent_awaiting"
              : sent
                ? "accepted"
                : current === "sent"
                  ? "ready"
                  : current === "signatures" || current === "approvals"
                    ? "awaiting_approval"
                    : due && due < asOf
                      ? "overdue"
                      : "in_progress";
      rows.push({ id: o.id, number: o.number, name: o.name, customer: o.customer?.legalName ?? o.companyName, kind, kindLabel: CASE_KIND_LABELS[kind], status, bucket, due, owner: o.owner, supplier: o.selectedSupplier });
    }
    rows.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
    const counts: Record<string, number> = { in_progress: 0, overdue: 0, awaiting_approval: 0, ready: 0, sent_awaiting: 0, accepted: 0, rejected: 0, completed: 0 };
    for (const r of rows) counts[r.bucket]++;
    return { counts, rows, capped: opps.length === 200 };
  }
}

/** Records what the CRM's submission-pack email sent, as a submission (called by the integration worker). */
export async function recordSentPack(db: Db, audit: AuditService, opportunityId: string, destination: string, reference: string, versionIds: string[]) {
  const versions = await db.documentVersion.findMany({ where: { id: { in: versionIds } }, include: { item: true } });
  const created = await db.submission.create({
    data: {
      opportunityId,
      recipient: destination,
      channel: "email",
      sentAt: dateOnly(today()),
      files: versions.map((v) => ({ documentVersionId: v.id, documentType: v.item.documentType, label: docLabel(v.item.documentType), filename: v.filename, version: v.version, sha256: v.sha256 })),
      deliveryEvidence: `Emailed by the CRM, message ${reference}`,
    },
  });
  await audit.log(SYSTEM, { action: "submission.record", entityType: "opportunity", entityId: opportunityId, summary: `Submission pack emailed to ${destination}`, data: { submissionId: created.id } }, db);
  return created;
}
