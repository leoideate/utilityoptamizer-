import { createHash } from "node:crypto";
import type { EnergyContract, Prisma } from "@prisma/client";
import type { GateFacts, WorkflowFacts } from "@uo/shared";
import { isoDay, num } from "../common/values";
import type { Db } from "../common/prisma.service";

/** Compares two encrypted IBANs without keeping either in memory longer than the comparison. */
export interface IbanComparer {
  decrypt(value: string | null | undefined): string | null;
}

/**
 * The renewal terms Admin verifies: supplier, term, dates and rates of every live-to-be contract.
 * A terms check only counts while this snapshot is unchanged.
 */
export function termsSnapshot(contracts: Pick<EnergyContract, "id" | "fuel" | "status" | "selectedSupplierId" | "termMonths" | "proposedActivationDate" | "pricingPlan" | "dayRate" | "nightRate" | "peakRate" | "otherRate" | "gasRate" | "standingCharge">[], fallbackSupplierId: string | null) {
  const terms = contracts
    .filter((c) => c.status !== "cancelled" && c.status !== "ended" && c.status !== "live")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      contractId: c.id,
      fuel: c.fuel,
      supplierId: c.selectedSupplierId ?? fallbackSupplierId,
      termMonths: c.termMonths,
      startDate: isoDay(c.proposedActivationDate),
      pricingPlan: c.pricingPlan,
      rates: { day: num(c.dayRate), night: num(c.nightRate), peak: num(c.peakRate), other: num(c.otherRate), gas: num(c.gasRate), standing: num(c.standingCharge) },
    }));
  const complete = terms.length > 0 && terms.every((t) => t.supplierId && t.termMonths && t.startDate && Object.values(t.rates).some((r) => r !== null));
  return { terms, complete, hash: createHash("sha256").update(JSON.stringify(terms)).digest("hex") };
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/** Total years covered by a principal's address history (overlaps counted once, open-ended = today). */
export function addressYears(ranges: { fromDate: Date; toDate: Date | null }[], now = new Date()): number {
  const sorted = ranges.map((r) => [r.fromDate.getTime(), (r.toDate ?? now).getTime()] as const).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total / YEAR_MS;
}

/**
 * Loads the facts the stage gates need. Restricted values are never decrypted here:
 * principals contribute only presence flags and address-history coverage.
 */
export async function loadGateFacts(db: Db, opportunityId: string, crypto?: IbanComparer): Promise<GateFacts> {
  const opp = await db.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    include: {
      customer: { include: { contacts: true, addresses: { select: { id: true } }, bankAccounts: { select: { ibanEnc: true, ibanLast4: true } } } },
      selectedSupplier: true,
      workflowCase: true,
      submissions: { orderBy: { recordedAt: "desc" }, take: 1, include: { responses: { orderBy: { recordedAt: "asc" } } } },
      sites: { include: { meterPoints: true } },
      contracts: true,
      merchantApps: {
        include: {
          pricing: { select: { id: true } },
          risk: true,
          principals: { include: { addresses: { select: { fromDate: true, toDate: true } } } },
        },
      },
      documents: true,
      signatures: { include: { signers: true } },
      generatedForms: { where: { status: { not: "superseded" } }, include: { template: { select: { name: true, documentType: true } } } },
    },
  });
  const [bill, billCheck, lease, termsCheck] = await Promise.all([
    db.documentVersion.findFirst({ where: { item: { opportunityId, documentType: "energy_bill" } }, orderBy: { uploadedAt: "desc" }, select: { id: true } }),
    db.billCheck.findFirst({ where: { opportunityId }, orderBy: { verifiedAt: "desc" } }),
    db.documentVersion.findFirst({ where: { item: { opportunityId, documentType: "lease_agreement" } }, orderBy: { uploadedAt: "desc" }, select: { id: true } }),
    db.termsCheck.findFirst({ where: { opportunityId }, orderBy: { verifiedAt: "desc" }, select: { snapshotHash: true } }),
  ]);
  // An approved, reviewed form with a client signature counts as the customer's signature.
  const signedForms = opp.generatedForms.filter((f) => f.status === "approved" && (f.fields as { kind: string; signer?: string | null }[]).some((x) => x.kind === "signature" && x.signer === "customer"));

  // Sites referenced by contracts or matched by the case but owned by another opportunity (renewals, a known supply point) count too.
  const extraSiteIds = [...new Set([...opp.contracts.map((c) => c.siteId), opp.workflowCase?.siteId])].filter((id): id is string => !!id && !opp.sites.some((s) => s.id === id));
  const extraSites = extraSiteIds.length ? await db.supplySite.findMany({ where: { id: { in: extraSiteIds } }, include: { meterPoints: true } }) : [];
  const allSites = [...opp.sites, ...extraSites];
  const workflow = opp.serviceType === "merchant_services" ? undefined : await workflowFacts(db, opp, allSites, { bill: !!(billCheck && bill && billCheck.documentVersionId === bill.id && billCheck.passed), lease: lease?.id ?? null, termsHash: termsCheck?.snapshotHash ?? null }, crypto);

  return {
    serviceType: opp.serviceType,
    saleType: opp.saleType,
    customerId: opp.customerId,
    selectedSupplierId: opp.selectedSupplierId,
    internalApproval: opp.internalApproval,
    customer: opp.customer ? { vatRegistered: opp.customer.vatRegistered, vatNumber: opp.customer.vatNumber, website: opp.customer.website } : null,
    sites: allSites.map((s) => ({
      label: s.label || s.line1,
      occupancyType: s.occupancyType,
      hasLandlord: !!s.landlordName?.trim(),
      meterPoints: s.meterPoints.map((m) => ({ fuel: m.fuel, mprn: m.mprn, gprn: m.gprn })),
    })),
    contracts: opp.contracts.map((c) => ({ fuel: c.fuel, status: c.status })),
    merchantApps: opp.merchantApps.map((a) => ({
      legalEntity: a.legalEntity,
      estimatedAnnualTurnover: num(a.estimatedAnnualTurnover),
      cardTurnoverPct: num(a.cardTurnoverPct),
      averageTransactionValue: num(a.averageTransactionValue),
      website: a.website ?? opp.customer?.website ?? null,
      advertisingMethod: a.advertisingMethod ?? opp.customer?.advertisingMethod ?? null,
      productCount: a.pricing.length,
      risk: a.risk
        ? {
            depositsAccepted: a.risk.depositsAccepted,
            depositTxnPct: num(a.risk.depositTxnPct),
            depositValuePct: num(a.risk.depositValuePct),
            depositLeadDays: a.risk.depositLeadDays,
            balanceLeadDays: a.risk.balanceLeadDays,
            fullPrepaymentAccepted: a.risk.fullPrepaymentAccepted,
            fullPrepaymentPct: num(a.risk.fullPrepaymentPct),
            fullPaymentLeadDays: a.risk.fullPaymentLeadDays,
            complianceStatus: a.risk.complianceStatus,
          }
        : null,
      principals: a.principals.map((p) => ({
        name: `${p.firstName} ${p.lastName}`,
        role: p.role,
        hasDateOfBirth: p.hasDob,
        hasNationality: p.hasNationality,
        addressHistoryYears: addressYears(p.addresses),
      })),
    })),
    documents: opp.documents.map((d) => ({ documentType: d.documentType, required: d.required, received: d.received, approval: d.approval })),
    signatures: [
      ...opp.signatures.map((s) => ({ status: s.status, hasCustomerSigner: s.signers.some((x) => x.role === "customer") })),
      ...signedForms.map(() => ({ status: "completed" as const, hasCustomerSigner: true })),
    ],
    supplyChanges: opp.supplyChanges,
    // A check only counts for the bill version it looked at.
    billCheck: billCheck && bill && billCheck.documentVersionId === bill.id ? { passed: billCheck.passed } : null,
    forms: opp.generatedForms.map((f) => ({ name: f.template.name, status: f.status, qcPassed: f.qcPassed, documentType: f.template.documentType })),
    workflow,
  };
}

type FactsOpp = Prisma.OpportunityGetPayload<{
  include: {
    customer: { include: { contacts: true; addresses: { select: { id: true } }; bankAccounts: { select: { ibanEnc: true; ibanLast4: true } } } };
    selectedSupplier: true;
    workflowCase: true;
    submissions: { include: { responses: true } };
    contracts: true;
    generatedForms: true;
  };
}>;

/** Workflow evidence as presence flags. The IBAN comparison decrypts only accounts with the same last four digits. */
async function workflowFacts(
  db: Db,
  opp: FactsOpp,
  sites: { line1: string; landlordName: string | null; landlordContact: string | null }[],
  extra: { bill: boolean; lease: string | null; termsHash: string | null },
  crypto?: IbanComparer,
): Promise<WorkflowFacts> {
  const c = opp.workflowCase;
  const customer = opp.customer;
  let sharedIban = false;
  if (crypto && customer?.bankAccounts.length && c?.outgoingCustomerId && c.outgoingCustomerId !== customer.id) {
    const outgoing = await db.bankAccount.findMany({ where: { customerId: c.outgoingCustomerId, ibanLast4: { in: customer.bankAccounts.map((b) => b.ibanLast4) } }, select: { ibanEnc: true } });
    const norm = (v: string | null) => (v ?? "").replace(/\s+/g, "").toUpperCase();
    const mine = new Set(customer.bankAccounts.map((b) => norm(crypto.decrypt(b.ibanEnc))));
    sharedIban = outgoing.some((o) => mine.has(norm(crypto.decrypt(o.ibanEnc))));
  }
  // A lease we generated and nobody has signed yet is a draft, even before anyone checks it.
  const leaseCheck = extra.lease ? await db.leaseCheck.findFirst({ where: { opportunityId: opp.id, documentVersionId: extra.lease }, orderBy: { verifiedAt: "desc" } }) : null;
  const generatedDraft = !!extra.lease && opp.generatedForms.some((f) => f.versionId === extra.lease);
  const latest = opp.submissions[0];
  const lastOutcome = latest?.responses.at(-1)?.outcome ?? null;
  const terms = termsSnapshot(opp.contracts, opp.selectedSupplierId);

  return {
    recorded: !!c,
    customerPath: c?.customerPath ?? null,
    renewalOfPrevious: !!opp.previousOpportunityId,
    requestLogged: !!c?.requestChannel,
    supplyPath: c?.supplyPath ?? null,
    hasSupplyPoint: sites.some((s) => !!s.line1.trim()),
    occupancyDate: !!c?.occupancyDate,
    supplySourceVerified: !!c?.supplySource && !!c.supplyVerifiedAt,
    incomingIsOutgoing: !!opp.customerId && opp.customerId === c?.outgoingCustomerId,
    sharedIban,
    incoming: {
      contactName: !!customer?.contacts.some((x) => x.firstName.trim()) || !!opp.contactName?.trim(),
      contactReach: !!(customer?.email || customer?.phone || customer?.contacts.some((x) => x.email || x.phone || x.mobile) || opp.email || opp.phone),
      billingAddress: !!customer?.addresses.length,
      iban: !!customer?.bankAccounts.length,
    },
    landlord: { name: sites.some((s) => !!s.landlordName?.trim()), contact: sites.some((s) => !!s.landlordContact?.trim()) },
    lease: {
      hasCopy: !!extra.lease,
      status: leaseCheck?.status ?? (generatedDraft ? "draft" : null),
      passed: !!leaseCheck?.passed,
    },
    currentSupplier: opp.contracts.some((k) => !!k.existingSupplierName?.trim()),
    contractEndDate: opp.contracts.some((k) => !!k.currentContractEndDate),
    billVerified: extra.bill,
    terms: { complete: terms.complete, verified: terms.complete && extra.termsHash === terms.hash },
    supplier: opp.selectedSupplier
      ? { renewalRoute: opp.selectedSupplier.renewalRoute, outgoingConsentRequired: opp.selectedSupplier.outgoingConsentRequired, monoCopyRequired: opp.selectedSupplier.monoCopyRequired }
      : null,
    submission: {
      count: await db.submission.count({ where: { opportunityId: opp.id } }),
      latest: latest
        ? {
            lastOutcome,
            accepted: lastOutcome === "accepted" || lastOutcome === "change_confirmed",
            externalReference: latest.responses.some((r) => !!r.externalReference),
            effectiveDateConfirmed: lastOutcome === "change_confirmed",
          }
        : null,
    },
  };
}
