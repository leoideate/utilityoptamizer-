import {
  type ApprovalState,
  type ComplianceStatus,
  type DocumentApproval,
  type Fuel,
  type LegalEntity,
  type OccupancyType,
  type PrincipalRole,
  type ServiceType,
  type SignatureStatus,
  type VatStatus,
  DOCUMENT_TYPES,
  LEGAL_ENTITY_LABELS,
  needsElectricity,
  needsGas,
  occupancyNeedsLandlord,
} from "./enums";
import { type StageKey, isAtOrAfter } from "./stages";

/**
 * Plain facts about an opportunity that the stage gates need. The API builds this from
 * the database; personal values are reduced to presence flags so rules never see them.
 */
export interface GateFacts {
  serviceType: ServiceType;
  customerId: string | null;
  selectedSupplierId: string | null;
  internalApproval: ApprovalState;
  customer: {
    vatRegistered: VatStatus | null;
    vatNumber: string | null;
    website: string | null;
  } | null;
  sites: {
    label: string;
    occupancyType: OccupancyType | null;
    hasLandlord: boolean;
    meterPoints: { fuel: Fuel; mprn: string | null; gprn: string | null }[];
  }[];
  contracts: { fuel: Fuel; status: string }[];
  merchantApps: {
    legalEntity: LegalEntity | null;
    estimatedAnnualTurnover: number | null;
    cardTurnoverPct: number | null;
    averageTransactionValue: number | null;
    website: string | null;
    advertisingMethod: string | null;
    productCount: number;
    risk: {
      depositsAccepted: boolean;
      depositTxnPct: number | null;
      depositValuePct: number | null;
      depositLeadDays: number | null;
      balanceLeadDays: number | null;
      fullPrepaymentAccepted: boolean;
      fullPrepaymentPct: number | null;
      fullPaymentLeadDays: number | null;
      complianceStatus: ComplianceStatus;
    } | null;
    principals: {
      name: string;
      role: PrincipalRole;
      hasDateOfBirth: boolean;
      hasNationality: boolean;
      /** Years of residential address history recorded (spec: three years needed). */
      addressHistoryYears: number;
    }[];
  }[];
  documents: { documentType: string; required: boolean; received: boolean; approval: DocumentApproval }[];
  signatures: { status: SignatureStatus; hasCustomerSigner: boolean }[];
}

const docLabel = (t: string) => (DOCUMENT_TYPES as Record<string, { label: string }>)[t]?.label ?? t;

/** Minimum principals by legal entity, and which roles count toward it. */
export const PRINCIPAL_REQUIREMENTS: Record<LegalEntity, { min: number; roles: PrincipalRole[]; describe: string }> = {
  sole_trader: { min: 1, roles: ["owner"], describe: "the owner" },
  partnership: { min: 2, roles: ["partner"], describe: "at least two partners" },
  limited_company: { min: 1, roles: ["director"], describe: "at least one director" },
  plc: { min: 1, roles: ["director"], describe: "at least one director" },
  charity_club: { min: 1, roles: ["trustee", "signatory"], describe: "a trustee or authorised signatory" },
  other: { min: 1, roles: ["owner", "partner", "director", "shareholder", "trustee", "signatory"], describe: "at least one principal" },
};
export const ADDRESS_HISTORY_YEARS = 3;

// ---------------------------------------------------------------------------
// Field-level conditional rules (also used directly by forms)
// ---------------------------------------------------------------------------

export function vatIssues(c: { vatRegistered: VatStatus | null; vatNumber: string | null }): string[] {
  return c.vatRegistered === "yes" && !c.vatNumber?.trim() ? ["Enter the VAT number: the customer is VAT registered."] : [];
}

export function advertisingIssues(a: { website: string | null; advertisingMethod: string | null }): string[] {
  return !a.website?.trim() && !a.advertisingMethod?.trim()
    ? ["The business has no website: enter how it advertises (e.g. social media, shop front, directory)."]
    : [];
}

export function landlordIssues(site: { label: string; occupancyType: OccupancyType | null; hasLandlord: boolean }): string[] {
  return occupancyNeedsLandlord(site.occupancyType) && !site.hasLandlord
    ? [`${site.label} is rented: enter the landlord's details.`]
    : [];
}

export function depositIssues(risk: NonNullable<GateFacts["merchantApps"][number]["risk"]>): string[] {
  const issues: string[] = [];
  if (risk.depositsAccepted) {
    if (risk.depositTxnPct == null) issues.push("Deposits are accepted: enter the percentage of transactions that are deposits.");
    if (risk.depositValuePct == null) issues.push("Deposits are accepted: enter the deposit as a percentage of the full price.");
    if (risk.depositLeadDays == null) issues.push("Deposits are accepted: enter how many days before delivery the deposit is taken.");
    if (risk.balanceLeadDays == null) issues.push("Deposits are accepted: enter how many days before delivery the balance is taken.");
  }
  if (risk.fullPrepaymentAccepted) {
    if (risk.fullPrepaymentPct == null) issues.push("Full payment in advance is accepted: enter the percentage of turnover paid in advance.");
    if (risk.fullPaymentLeadDays == null) issues.push("Full payment in advance is accepted: enter how many days before delivery payment is taken.");
  }
  return issues;
}

export function principalIssues(app: GateFacts["merchantApps"][number]): string[] {
  if (!app.legalEntity) return ["Select the business's legal entity on the Worldpay application."];
  const rule = PRINCIPAL_REQUIREMENTS[app.legalEntity];
  const issues: string[] = [];
  const qualifying = app.principals.filter((p) => rule.roles.includes(p.role));
  if (qualifying.length < rule.min) issues.push(`A ${LEGAL_ENTITY_LABELS[app.legalEntity].toLowerCase()} needs principal details for ${rule.describe}.`);
  for (const p of app.principals) {
    const missing: string[] = [];
    if (!p.hasDateOfBirth) missing.push("date of birth");
    if (!p.hasNationality) missing.push("nationality");
    if (p.addressHistoryYears < ADDRESS_HISTORY_YEARS) missing.push(`${ADDRESS_HISTORY_YEARS} years of address history`);
    if (missing.length) issues.push(`Principal ${p.name} is missing ${missing.join(", ")}.`);
  }
  return issues;
}

export function tradingIssues(app: GateFacts["merchantApps"][number]): string[] {
  const issues: string[] = [];
  if (app.estimatedAnnualTurnover == null) issues.push("Enter the estimated annual turnover.");
  if (app.cardTurnoverPct == null) issues.push("Enter the percentage of turnover taken by card.");
  if (app.averageTransactionValue == null) issues.push("Enter the average transaction value.");
  return issues;
}

// ---------------------------------------------------------------------------
// Stage gates
// ---------------------------------------------------------------------------

/**
 * Everything that must be true before an opportunity can enter `target`. Gates are
 * cumulative, and the first ten stages have none, so capturing a lead stays quick.
 */
export function stageGateIssues(f: GateFacts, target: StageKey): string[] {
  const issues: string[] = [];
  const merchant = f.serviceType === "merchant_services";
  const at = (gate: StageKey) => isAtOrAfter(target, gate);

  if (at("proposal_sent")) {
    if (merchant) {
      if (f.merchantApps.length === 0) issues.push("Create the Worldpay application before sending a proposal.");
      for (const app of f.merchantApps) issues.push(...tradingIssues(app));
    } else if (f.sites.length === 0) {
      issues.push("Add at least one supply site before sending a proposal.");
    }
  }

  if (at("supplier_selected")) {
    if (merchant) {
      if (!f.merchantApps.some((a) => a.productCount > 0)) issues.push("Select the Worldpay product or terminal (add a pricing line).");
    } else if (!f.selectedSupplierId) {
      issues.push("Select the supplier.");
    }
  }

  if (at("documents_prepared")) {
    if (!f.customerId) issues.push("Link or create the customer.");
    if (f.customer) issues.push(...vatIssues(f.customer));
    if (merchant) {
      for (const app of f.merchantApps) {
        issues.push(...advertisingIssues(app));
        issues.push(...principalIssues(app));
        if (!app.risk) issues.push("Answer the underwriting and risk questions.");
        else issues.push(...depositIssues(app.risk));
      }
    } else {
      for (const s of f.sites) issues.push(...landlordIssues(s));
    }
  }

  if (at("submitted")) {
    if (needsElectricity(f.serviceType)) {
      const pts = f.sites.flatMap((s) => s.meterPoints).filter((m) => m.fuel === "electricity");
      if (pts.length === 0 || pts.some((m) => !m.mprn)) issues.push("Enter an MPRN for every electricity meter.");
    }
    if (needsGas(f.serviceType)) {
      const pts = f.sites.flatMap((s) => s.meterPoints).filter((m) => m.fuel === "gas");
      if (pts.length === 0 || pts.some((m) => !m.gprn)) issues.push("Enter a GPRN for every gas meter.");
    }
    if (!merchant && f.contracts.filter((c) => c.status !== "cancelled").length === 0) issues.push("Add the energy contract details.");
    const outstanding = f.documents.filter((d) => d.required && !(d.received && d.approval === "approved"));
    if (outstanding.length) issues.push(`These required documents must be received and approved: ${outstanding.map((d) => docLabel(d.documentType)).join(", ")}.`);
    if (!f.signatures.some((s) => s.status === "completed" && s.hasCustomerSigner)) issues.push("The customer must sign before submission.");
    if (f.internalApproval !== "approved") issues.push("Internal approval must be granted before submission.");
    if (merchant && !f.merchantApps.every((a) => a.risk?.complianceStatus === "approved")) {
      issues.push("Compliance must approve the Worldpay risk review before submission.");
    }
  }

  return [...new Set(issues)];
}

/** Required documents not yet received (drives reminders and the Missing Documents view). */
export function outstandingDocuments(f: Pick<GateFacts, "documents">) {
  return f.documents.filter((d) => d.required && !d.received);
}

/** What's still needed to quote (drives missing-information reminders). */
export function missingInformation(f: GateFacts): string[] {
  const missing: string[] = [];
  if (f.serviceType === "merchant_services") {
    if (f.merchantApps.length === 0) missing.push("Worldpay application");
    if (f.merchantApps.some((a) => tradingIssues(a).length)) missing.push("turnover and transaction details");
  } else {
    if (f.sites.length === 0) missing.push("supply site");
    const pts = f.sites.flatMap((s) => s.meterPoints);
    if (needsElectricity(f.serviceType) && !pts.some((m) => m.fuel === "electricity" && m.mprn)) missing.push("MPRN");
    if (needsGas(f.serviceType) && !pts.some((m) => m.fuel === "gas" && m.gprn)) missing.push("GPRN");
  }
  return missing;
}
