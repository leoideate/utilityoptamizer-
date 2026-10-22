import {
  type ApprovalState,
  type ComplianceStatus,
  type DocumentApproval,
  type Fuel,
  type LegalEntity,
  type OccupancyType,
  type PrincipalRole,
  type SaleType,
  type ServiceType,
  type SignatureStatus,
  type SupplyChange,
  type VatStatus,
  DOCUMENT_TYPES,
  LEGAL_ENTITY_LABELS,
  needsElectricity,
  needsGas,
  occupancyNeedsLandlord,
} from "./enums";
import type { FormStatus } from "./forms";
import { type StageKey, isAtOrAfter } from "./stages";
import { type CaseKind, type ChecklistItem, type WorkflowFacts, caseKind } from "./workflows";

/**
 * Plain facts about an opportunity that the stage gates need. The API builds this from
 * the database; personal values are reduced to presence flags so rules never see them.
 */
export interface GateFacts {
  serviceType: ServiceType;
  saleType?: SaleType;
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
  supplyChanges?: SupplyChange[];
  /** Result of checking the latest previous-supplier bill; null when no check covers it. */
  billCheck?: { passed: boolean } | null;
  /** Current (not superseded) generated supplier forms. */
  forms?: { name: string; status: FormStatus; qcPassed: boolean; documentType?: string }[];
  /** Workflow case evidence (change of entity, renewal, submission and response). Absent: those rules are skipped. */
  workflow?: WorkflowFacts;
}

const docLabel = (t: string) => (DOCUMENT_TYPES as Record<string, { label: string }>)[t]?.label ?? t;

/** Minimum principals by legal entity, and which roles count toward it. */
export const PRINCIPAL_REQUIREMENTS: Record<LegalEntity, { min: number; roles: PrincipalRole[]; describe: string }> = {
  sole_trader: { min: 1, roles: ["owner"], describe: "the owner" },
  partnership: { min: 2, roles: ["partner"], describe: "at least two partners" },
  limited_company: { min: 1, roles: ["director"], describe: "at least one director" },
  plc: { min: 1, roles: ["director"], describe: "at least one director" },
  charity_club: { min: 1, roles: ["trustee", "signatory"], describe: "a trustee or authorised signatory" },
  state_body: { min: 1, roles: ["signatory"], describe: "an authorised signatory" },
  co_operative: { min: 1, roles: ["director", "signatory"], describe: "a director or authorised signatory" },
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
    if (!merchant && f.supplyChanges?.includes("change_of_supplier")) {
      if (!f.billCheck) issues.push("Check the previous supplier's bill (readable, and the customer, MPRN/GPRN and supplier match).");
      else if (!f.billCheck.passed) issues.push("The previous supplier's bill failed its check. Get a clear bill that matches this customer and supply point.");
    }
    for (const form of f.forms ?? []) {
      if (!form.qcPassed) issues.push(`"${form.name}" failed its quality check. Generate it again.`);
      else if (form.status === "awaiting_review") issues.push(`Review the signatures on "${form.name}".`);
      else if (form.status === "generated") issues.push(`"${form.name}" still needs its signatures.`);
      else if (form.status === "rejected") issues.push(`"${form.name}" was rejected at review. Generate it again.`);
    }
    if (f.internalApproval !== "approved") issues.push("Internal approval must be granted before submission.");
    if (merchant && !f.merchantApps.every((a) => a.risk?.complianceStatus === "approved")) {
      issues.push("Compliance must approve the Worldpay risk review before submission.");
    }
  }

  const w = f.workflow;
  if (w && !merchant) {
    const kind = caseKind({ serviceType: f.serviceType, saleType: f.saleType, supplyChanges: f.supplyChanges });
    if (at("documents_prepared")) {
      for (const item of caseChecklist(f)) if (!item.done && item.issue) issues.push(item.issue);
      if (kind === "change_of_entity" && w.sharedIban) issues.push("The incoming customer's IBAN is the same as the outgoing customer's. Record the incoming customer's own bank account.");
      if (kind === "renewal" && !w.terms.verified) issues.push(w.terms.complete ? "Verify the renewal terms (rates, term, start date and supplier)." : "Enter the renewal terms (rates, term, start date and supplier), then verify them.");
    }
    if (at("submitted")) {
      if (kind === "change_of_entity") {
        if (!w.lease.hasCopy) issues.push("Upload the lease agreement under Documents: a signed lease is needed before submission.");
        else if (w.lease.status === null) issues.push("Check the lease agreement (draft or signed, names, address, dates and signatures).");
        else if (w.lease.status === "draft") issues.push("The lease is still a draft. Upload the copy signed by the landlord and tenant, then check it.");
        else if (!w.lease.passed) issues.push("The signed lease failed its check. Get a lease that matches this case and is signed by both parties.");
        if (w.supplier?.outgoingConsentRequired && !f.documents.some((d) => d.documentType === "outgoing_consent" && d.received && d.approval === "approved")) {
          issues.push("This supplier needs the outgoing account holder's consent: upload and approve it under Documents.");
        }
      }
      if (kind === "renewal") {
        const route = w.supplier?.renewalRoute ?? "full_form";
        if (route === "rate_card_only") {
          if (!f.documents.some((d) => d.documentType === "rate_card" && d.received && d.approval === "approved")) issues.push("This supplier renews on the rate card alone: upload and approve the signed rate card.");
        } else if (!(f.forms ?? []).some((x) => x.documentType === "application_form" && x.status === "approved" && x.qcPassed)) {
          issues.push("This supplier needs its full renewal form: generate it, add the signatures and have it reviewed.");
        }
      }
    }
    if (at("awaiting_confirmation")) {
      const latest = w.submission.latest;
      if (!latest) issues.push("Record what was sent to the external party (recipient, files and proof of delivery).");
      else if (!latest.accepted) issues.push("Record the external party's acceptance and reference: a sent submission is not an accepted one.");
    }
    if (at("live_won") && kind === "change_of_entity" && !w.submission.latest?.effectiveDateConfirmed) {
      issues.push("Record the confirmed effective date of the change of entity.");
    }
  }

  return [...new Set(issues)];
}

// ---------------------------------------------------------------------------
// Workflow cases: what's still needed, and where the case stands
// ---------------------------------------------------------------------------

const kindOf = (f: GateFacts): CaseKind => caseKind({ serviceType: f.serviceType, saleType: f.saleType, supplyChanges: f.supplyChanges });

function meterIdsDone(f: GateFacts) {
  const pts = f.sites.flatMap((s) => s.meterPoints);
  const elec = !needsElectricity(f.serviceType) || (pts.some((m) => m.fuel === "electricity") && pts.filter((m) => m.fuel === "electricity").every((m) => m.mprn));
  const gas = !needsGas(f.serviceType) || (pts.some((m) => m.fuel === "gas") && pts.filter((m) => m.fuel === "gas").every((m) => m.gprn));
  return elec && gas;
}

/**
 * The guided checklist of details a case needs before documents are prepared. For a customer
 * new to us it doubles as the missing-information list when there is no bill.
 */
export function caseChecklist(f: GateFacts): ChecklistItem[] {
  const w = f.workflow;
  if (!w || f.serviceType === "merchant_services") return [];
  const kind = kindOf(f);
  const ids = meterIdsDone(f);
  const items: ChecklistItem[] = [];
  const add = (key: string, label: string, done: boolean, issue?: string) => items.push({ key, label, done, issue });

  if (kind === "change_of_entity") {
    add("supply_point", "Supply point matched from our records or added", w.hasSupplyPoint, "Match the supply point from our records, or add it if it's new to us.");
    if (w.supplyPath === "new_supply_point") add("supply_source", "Source of the supply details recorded and verified", w.supplySourceVerified, "Record where the MPRN/GPRN and address came from (the lease alone doesn't prove the meter).");
    add("meter_ids", "MPRN/GPRN for every meter", ids, "Enter the MPRN/GPRN for every meter at the supply point.");
    add("incoming_customer", "Incoming customer linked as a separate record", !!f.customerId && !w.incomingIsOutgoing, w.incomingIsOutgoing ? "Link the incoming customer: the outgoing account holder can't be the incoming customer." : "Create or link the incoming customer.");
    add("occupancy_date", "Proposed occupancy date", w.occupancyDate, "Enter the incoming customer's proposed occupancy date.");
    add("contact_name", "Incoming contact name", w.incoming.contactName, "Add the incoming customer's contact name.");
    add("contact_reach", "Incoming contact email or phone", w.incoming.contactReach, "Add the incoming customer's email or phone.");
    add("billing_address", "Incoming billing address", w.incoming.billingAddress, "Add the incoming customer's billing address.");
    add("iban", "Incoming customer's IBAN on file", w.incoming.iban, "Add the incoming customer's own bank account (IBAN).");
    add("landlord_name", "Landlord name", w.landlord.name, "Enter the landlord's name on the supply site.");
    add("landlord_contact", "Landlord contact details", w.landlord.contact, "Enter the landlord's contact details on the supply site.");
  } else if (kind === "renewal") {
    add("customer_path", "Existing client or new to us", w.customerPath !== null || w.renewalOfPrevious, "Choose whether the customer is an existing client or new to us.");
    add("customer", "Customer record linked", !!f.customerId);
    add("contact_name", "Contact name", w.incoming.contactName, "Add the customer's contact name.");
    add("contact_reach", "Contact email or phone", w.incoming.contactReach, "Add the customer's email or phone.");
    add("billing_address", "Billing address", w.incoming.billingAddress, "Add the customer's billing address.");
    add("supply_point", "Supply site", f.sites.length > 0, "Add the supply site.");
    add("meter_ids", "MPRN/GPRN for every meter", ids, "Enter the MPRN/GPRN for every meter.");
    add("current_supplier", "Current supplier", w.currentSupplier, "Enter the current supplier on the contract.");
    add("contract_end", "Current contract end date", w.contractEndDate, "Enter the current contract end date.");
    if (w.customerPath === "new_to_us") add("bill", "Current bill received and checked (optional when the checklist is complete)", w.billVerified);
  }
  return items;
}

export interface CaseStep {
  key: string;
  label: string;
  done: boolean;
}

/** Ordered steps of the case's workflow and whether each is evidenced. */
export function caseSteps(f: GateFacts, outcome: "open" | "won" | "lost" = "open"): { kind: CaseKind; steps: CaseStep[]; status: string; exception: "changes_required" | "rejected" | "cancelled" | null } {
  const kind = kindOf(f);
  const w = f.workflow;
  const forms = f.forms ?? [];
  const checklistDone = caseChecklist(f).every((i) => i.done || !i.issue);
  // Supplier forms generated here, or prepared outside the CRM and uploaded.
  const formsDrafted = forms.some((x) => x.qcPassed) || f.documents.some((d) => ["application_form", "change_of_tenancy", "supplier_contract"].includes(d.documentType) && d.received);
  const signed = f.signatures.some((s) => s.status === "completed" && s.hasCustomerSigner) && !forms.some((x) => x.status !== "approved");
  const ready = stageGateIssues(f, "submitted").length === 0;
  const latest = w?.submission.latest ?? null;
  const steps: (CaseStep & { waiting: string })[] = [];
  const step = (key: string, label: string, done: boolean, waiting: string) => steps.push({ key, label, done, waiting });

  if (kind === "change_of_entity") {
    step("request", "Request received", !!w?.recorded, "New request");
    step("supply_point", "Supply point matched or created", !!w?.hasSupplyPoint, "Request received");
    step("incoming_details", "Incoming details complete", checklistDone, "Awaiting incoming details");
    step("tenancy", "Signed lease checked", !!w?.lease.passed, "Awaiting tenancy evidence");
    step("documents", "Documents drafted", formsDrafted, "Documents to prepare");
    step("signatures", "Signatures and approvals", signed, "Awaiting signed lease and approvals");
  } else if (kind === "renewal") {
    step("request", "Request received", !!w && (w.requestLogged || w.renewalOfPrevious), "Renewal due");
    step("data_review", "Details verified", checklistDone, "Data review");
    step("terms", "Terms confirmed", !!w?.terms.verified, "Awaiting terms confirmation");
    const route = w?.supplier?.renewalRoute ?? "full_form";
    step(
      "documents",
      route === "rate_card_only" ? "Rate card received" : "Documents generated",
      route === "rate_card_only" ? f.documents.some((d) => d.documentType === "rate_card" && d.received) : forms.some((x) => x.documentType === "application_form" && x.qcPassed),
      "Terms confirmed",
    );
    step("approvals", "Client and broker approvals", signed, "Awaiting approvals");
  } else {
    step("documents", "Documents prepared", formsDrafted || f.documents.some((d) => d.received), "Preparing documents");
    step("approvals", "Signatures and approvals", signed, "Awaiting signatures");
  }
  step("ready", "Ready to submit", ready, "Final checks");
  step("sent", kind === "renewal" ? "Sent to external party" : "Sent", !!latest, "Ready to submit");
  step("accepted", "Accepted", !!latest?.accepted, kind === "renewal" ? "Sent to external party" : "Sent");
  if (kind === "change_of_entity") step("confirmed", "Entity change confirmed", !!latest?.effectiveDateConfirmed, "Accepted");
  step("completed", "Completed", outcome === "won", kind === "change_of_entity" ? "Entity change confirmed" : "Accepted");

  // Later evidence implies the earlier steps once the case is won (e.g. records from before these workflows).
  if (outcome === "won") for (const s of steps) s.done = true;
  const exception = outcome === "lost" ? "cancelled" : outcome === "open" && latest?.lastOutcome === "rejected" ? "rejected" : outcome === "open" && latest?.lastOutcome === "changes_required" ? "changes_required" : null;
  const current = steps.find((s) => !s.done);
  const status = exception === "cancelled" ? "Cancelled" : exception === "rejected" ? "Rejected" : exception === "changes_required" ? "Changes required" : current ? current.waiting : "Completed";
  return { kind, steps: steps.map(({ waiting: _w, ...s }) => s), status, exception };
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
