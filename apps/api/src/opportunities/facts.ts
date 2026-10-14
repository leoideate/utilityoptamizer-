import type { GateFacts } from "@uo/shared";
import { num } from "../common/values";
import type { Db } from "../common/prisma.service";

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
export async function loadGateFacts(db: Db, opportunityId: string): Promise<GateFacts> {
  const opp = await db.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    include: {
      customer: true,
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
    },
  });

  // Sites referenced by contracts but owned by another opportunity (e.g. renewals) count too.
  const extraSiteIds = opp.contracts.map((c) => c.siteId).filter((id): id is string => !!id && !opp.sites.some((s) => s.id === id));
  const extraSites = extraSiteIds.length ? await db.supplySite.findMany({ where: { id: { in: extraSiteIds } }, include: { meterPoints: true } }) : [];

  return {
    serviceType: opp.serviceType,
    customerId: opp.customerId,
    selectedSupplierId: opp.selectedSupplierId,
    internalApproval: opp.internalApproval,
    customer: opp.customer ? { vatRegistered: opp.customer.vatRegistered, vatNumber: opp.customer.vatNumber, website: opp.customer.website } : null,
    sites: [...opp.sites, ...extraSites].map((s) => ({
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
    signatures: opp.signatures.map((s) => ({ status: s.status, hasCustomerSigner: s.signers.some((x) => x.role === "customer") })),
  };
}
