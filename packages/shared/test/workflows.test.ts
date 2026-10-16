import {
  type GateFacts,
  type WorkflowFacts,
  caseChecklist,
  caseKind,
  caseSteps,
  leaseCheckPassed,
  stageGateIssues,
  submissionResponseSchema,
} from "../src";

function workflow(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    recorded: true,
    customerPath: "existing_client",
    renewalOfPrevious: false,
    requestLogged: true,
    supplyPath: "known_supply_point",
    hasSupplyPoint: true,
    occupancyDate: true,
    supplySourceVerified: false,
    incomingIsOutgoing: false,
    sharedIban: false,
    incoming: { contactName: true, contactReach: true, billingAddress: true, iban: true },
    landlord: { name: true, contact: true },
    lease: { hasCopy: true, status: "signed", passed: true },
    currentSupplier: true,
    contractEndDate: true,
    billVerified: false,
    terms: { complete: true, verified: true },
    supplier: { renewalRoute: "full_form", outgoingConsentRequired: false, monoCopyRequired: false },
    submission: { count: 0, latest: null },
    ...overrides,
  };
}

function facts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    serviceType: "electricity",
    saleType: "new_sale",
    customerId: "c1",
    selectedSupplierId: "s1",
    internalApproval: "approved",
    customer: { vatRegistered: "no", vatNumber: null, website: null },
    sites: [{ label: "Unit 4", occupancyType: "rented", hasLandlord: true, meterPoints: [{ fuel: "electricity", mprn: "10012345678", gprn: null }] }],
    contracts: [{ fuel: "electricity", status: "selected" }],
    merchantApps: [],
    documents: [],
    signatures: [{ status: "completed", hasCustomerSigner: true }],
    forms: [],
    workflow: workflow(),
    ...overrides,
  };
}

const entity = (w: Partial<WorkflowFacts> = {}, extra: Partial<GateFacts> = {}) =>
  facts({ supplyChanges: ["change_of_legal_entity"], workflow: workflow(w), forms: [{ name: "Change of tenancy", status: "approved", qcPassed: true, documentType: "change_of_tenancy" }], ...extra });
const renewal = (w: Partial<WorkflowFacts> = {}, extra: Partial<GateFacts> = {}) =>
  facts({ saleType: "renewal", workflow: workflow(w), forms: [{ name: "Renewal form", status: "approved", qcPassed: true, documentType: "application_form" }], ...extra });

describe("case kind", () => {
  it("change of entity takes precedence, then a switch, then a renewal", () => {
    expect(caseKind({ serviceType: "electricity", saleType: "renewal", supplyChanges: ["change_of_supplier", "change_of_legal_entity"] })).toBe("change_of_entity");
    expect(caseKind({ serviceType: "gas", saleType: "renewal", supplyChanges: ["change_of_supplier"] })).toBe("change_of_supplier");
    expect(caseKind({ serviceType: "dual_fuel", saleType: "renewal" })).toBe("renewal");
    expect(caseKind({ serviceType: "merchant_services", saleType: "renewal" })).toBe("merchant");
  });
});

describe("change of entity", () => {
  it("a complete case can be submitted", () => {
    expect(stageGateIssues(entity(), "submitted")).toEqual([]);
  });

  it("the checklist flags missing MPRN, contacts, IBAN and landlord details", () => {
    const f = entity(
      { incoming: { contactName: false, contactReach: false, billingAddress: true, iban: false }, landlord: { name: false, contact: false } },
      { sites: [{ label: "Unit 4", occupancyType: "rented", hasLandlord: false, meterPoints: [{ fuel: "electricity", mprn: null, gprn: null }] }] },
    );
    const missing = caseChecklist(f).filter((i) => !i.done).map((i) => i.key);
    expect(missing).toEqual(["meter_ids", "contact_name", "contact_reach", "iban", "landlord_name", "landlord_contact"]);
    const issues = stageGateIssues(f, "documents_prepared");
    expect(issues).toContain("Add the incoming customer's own bank account (IBAN).");
    expect(issues).toContain("Enter the MPRN/GPRN for every meter at the supply point.");
  });

  it("a new supply point needs the source of its details", () => {
    const f = entity({ supplyPath: "new_supply_point" });
    expect(stageGateIssues(f, "documents_prepared")).toContain("Record where the MPRN/GPRN and address came from (the lease alone doesn't prove the meter).");
    expect(stageGateIssues(entity({ supplyPath: "new_supply_point", supplySourceVerified: true }), "documents_prepared")).toEqual([]);
  });

  it("the outgoing customer, or their IBAN, can't stand in for the incoming customer", () => {
    expect(stageGateIssues(entity({ incomingIsOutgoing: true }), "documents_prepared")).toContain("Link the incoming customer: the outgoing account holder can't be the incoming customer.");
    expect(stageGateIssues(entity({ sharedIban: true }), "documents_prepared")).toContain(
      "The incoming customer's IBAN is the same as the outgoing customer's. Record the incoming customer's own bank account.",
    );
  });

  it("a missing, draft or failed lease keeps the case out of Ready to submit", () => {
    expect(stageGateIssues(entity({ lease: { hasCopy: false, status: null, passed: false } }), "submitted")).toContain(
      "Upload the lease agreement under Documents: a signed lease is needed before submission.",
    );
    expect(stageGateIssues(entity({ lease: { hasCopy: true, status: "draft", passed: false } }), "submitted")).toContain(
      "The lease is still a draft. Upload the copy signed by the landlord and tenant, then check it.",
    );
    expect(stageGateIssues(entity({ lease: { hasCopy: true, status: "signed", passed: false } }), "submitted")).toContain(
      "The signed lease failed its check. Get a lease that matches this case and is signed by both parties.",
    );
    expect(caseSteps(entity({ lease: { hasCopy: true, status: "draft", passed: false } })).status).toBe("Awaiting tenancy evidence");
  });

  it("only a signed lease that matches and is signed by both parties passes", () => {
    const ok = { status: "signed" as const, landlordMatches: true, tenantMatches: true, addressMatches: true, datesMatch: true, signedByLandlord: true, signedByTenant: true };
    expect(leaseCheckPassed(ok)).toBe(true);
    expect(leaseCheckPassed({ ...ok, status: "draft" })).toBe(false);
    expect(leaseCheckPassed({ ...ok, signedByLandlord: false })).toBe(false);
  });

  it("can require the outgoing account holder's consent per supplier", () => {
    const f = entity({ supplier: { renewalRoute: "full_form", outgoingConsentRequired: true, monoCopyRequired: false } });
    expect(stageGateIssues(f, "submitted")).toContain("This supplier needs the outgoing account holder's consent: upload and approve it under Documents.");
    f.documents.push({ documentType: "outgoing_consent", required: true, received: true, approval: "approved" });
    expect(stageGateIssues(f, "submitted")).toEqual([]);
  });

  it("Sent, Accepted, Entity change confirmed and Completed are distinct", () => {
    const at = (latest: WorkflowFacts["submission"]["latest"], outcome: "open" | "won" = "open") => caseSteps(entity({ submission: { count: latest ? 1 : 0, latest } }), outcome).status;
    expect(at(null)).toBe("Ready to submit");
    expect(at({ lastOutcome: null, accepted: false, externalReference: false, effectiveDateConfirmed: false })).toBe("Sent");
    expect(at({ lastOutcome: "accepted", accepted: true, externalReference: true, effectiveDateConfirmed: false })).toBe("Accepted");
    expect(at({ lastOutcome: "change_confirmed", accepted: true, externalReference: true, effectiveDateConfirmed: true })).toBe("Entity change confirmed");
    expect(at({ lastOutcome: "change_confirmed", accepted: true, externalReference: true, effectiveDateConfirmed: true }, "won")).toBe("Completed");
    expect(at({ lastOutcome: "rejected", accepted: false, externalReference: false, effectiveDateConfirmed: false })).toBe("Rejected");
  });

  it("activation needs acceptance and the confirmed effective date", () => {
    expect(stageGateIssues(entity(), "awaiting_confirmation")).toContain("Record what was sent to the external party (recipient, files and proof of delivery).");
    const sent = entity({ submission: { count: 1, latest: { lastOutcome: null, accepted: false, externalReference: false, effectiveDateConfirmed: false } } });
    expect(stageGateIssues(sent, "awaiting_confirmation")).toContain("Record the external party's acceptance and reference: a sent submission is not an accepted one.");
    const accepted = entity({ submission: { count: 1, latest: { lastOutcome: "accepted", accepted: true, externalReference: true, effectiveDateConfirmed: false } } });
    expect(stageGateIssues(accepted, "awaiting_confirmation")).toEqual([]);
    expect(stageGateIssues(accepted, "live_won")).toEqual(["Record the confirmed effective date of the change of entity."]);
  });
});

describe("existing-supplier renewal", () => {
  it("a complete renewal can be submitted", () => {
    expect(stageGateIssues(renewal(), "submitted")).toEqual([]);
  });

  it("a renewal created from a previous deal is an existing client; a manual one needs the customer path", () => {
    expect(stageGateIssues(renewal({ customerPath: null, renewalOfPrevious: true }), "documents_prepared")).toEqual([]);
    expect(stageGateIssues(renewal({ customerPath: null }), "documents_prepared")).toContain("Choose whether the customer is an existing client or new to us.");
  });

  it("a customer new to us can proceed on the checklist without a bill", () => {
    const f = renewal({ customerPath: "new_to_us", billVerified: false });
    expect(caseChecklist(f).find((i) => i.key === "bill")).toMatchObject({ done: false, issue: undefined });
    expect(stageGateIssues(f, "documents_prepared")).toEqual([]);
    const gaps = renewal({ customerPath: "new_to_us", currentSupplier: false, contractEndDate: false, incoming: { contactName: false, contactReach: true, billingAddress: true, iban: false } });
    expect(stageGateIssues(gaps, "documents_prepared")).toEqual(["Add the customer's contact name.", "Enter the current supplier on the contract.", "Enter the current contract end date."]);
  });

  it("terms must be verified before documents", () => {
    expect(stageGateIssues(renewal({ terms: { complete: true, verified: false } }), "documents_prepared")).toContain("Verify the renewal terms (rates, term, start date and supplier).");
    expect(caseSteps(renewal({ terms: { complete: false, verified: false } })).status).toBe("Awaiting terms confirmation");
  });

  it("the supplier's rule decides between the full form and the rate card", () => {
    const full = renewal({}, { forms: [] });
    expect(stageGateIssues(full, "submitted")).toContain("This supplier needs its full renewal form: generate it, add the signatures and have it reviewed.");
    const rateCard = renewal({ supplier: { renewalRoute: "rate_card_only", outgoingConsentRequired: false, monoCopyRequired: false } }, { forms: [] });
    expect(stageGateIssues(rateCard, "submitted")).toEqual(["This supplier renews on the rate card alone: upload and approve the signed rate card."]);
    rateCard.documents.push({ documentType: "rate_card", required: true, received: true, approval: "approved" });
    expect(stageGateIssues(rateCard, "submitted")).toEqual([]);
  });

  it("can't be completed until accepted", () => {
    const sent = renewal({ submission: { count: 1, latest: { lastOutcome: null, accepted: false, externalReference: false, effectiveDateConfirmed: false } } });
    expect(caseSteps(sent).status).toBe("Sent to external party");
    expect(stageGateIssues(sent, "live_won")).toContain("Record the external party's acceptance and reference: a sent submission is not an accepted one.");
    const accepted = renewal({ submission: { count: 1, latest: { lastOutcome: "accepted", accepted: true, externalReference: true, effectiveDateConfirmed: false } } });
    expect(stageGateIssues(accepted, "live_won")).toEqual([]);
    expect(caseSteps(accepted).status).toBe("Accepted");
  });
});

describe("responses", () => {
  it("need a reference to accept, a date to confirm and a reason to reject", () => {
    const issues = (r: object) => submissionResponseSchema.safeParse({ receivedVia: "email", ...r }).error?.issues.map((i) => i.message) ?? [];
    expect(issues({ outcome: "accepted" })).toEqual(["Enter the external party's reference for the acceptance."]);
    expect(issues({ outcome: "change_confirmed" })).toEqual(["Enter the confirmed effective date."]);
    expect(issues({ outcome: "rejected" })).toEqual(["Enter the reason the external party gave."]);
    expect(issues({ outcome: "accepted", externalReference: "BG-123" })).toEqual([]);
  });
});
