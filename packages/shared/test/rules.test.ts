import { type GateFacts, STAGE_KEYS, gateIssueArea, stageGateIssues, missingInformation } from "../src";

function facts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    serviceType: "electricity",
    customerId: null,
    selectedSupplierId: null,
    internalApproval: "not_requested",
    customer: null,
    sites: [],
    contracts: [],
    merchantApps: [],
    documents: [],
    signatures: [],
    ...overrides,
  };
}

const readyEnergy = (serviceType: GateFacts["serviceType"]): GateFacts =>
  facts({
    serviceType,
    customerId: "c1",
    selectedSupplierId: "s1",
    internalApproval: "approved",
    customer: { vatRegistered: "no", vatNumber: null, website: null },
    sites: [
      {
        label: "Main St",
        occupancyType: "owner_occupied",
        hasLandlord: false,
        meterPoints: [
          ...(serviceType !== "gas" ? [{ fuel: "electricity" as const, mprn: "10012345678", gprn: null }] : []),
          ...(serviceType !== "electricity" ? [{ fuel: "gas" as const, mprn: null, gprn: "1234567" }] : []),
        ],
      },
    ],
    contracts: [{ fuel: "electricity", status: "selected" }],
    documents: [{ documentType: "energy_bill", required: true, received: true, approval: "approved" }],
    signatures: [{ status: "completed", hasCustomerSigner: true }],
  });

const readyMerchant = (): GateFacts =>
  facts({
    serviceType: "merchant_services",
    customerId: "c1",
    internalApproval: "approved",
    customer: { vatRegistered: "yes", vatNumber: "IE1234567T", website: "https://x.ie" },
    merchantApps: [
      {
        legalEntity: "limited_company",
        estimatedAnnualTurnover: 250000,
        cardTurnoverPct: 60,
        averageTransactionValue: 35,
        website: "https://x.ie",
        advertisingMethod: null,
        productCount: 1,
        risk: {
          depositsAccepted: false,
          depositTxnPct: null,
          depositValuePct: null,
          depositLeadDays: null,
          balanceLeadDays: null,
          fullPrepaymentAccepted: false,
          fullPrepaymentPct: null,
          fullPaymentLeadDays: null,
          complianceStatus: "approved",
        },
        principals: [{ name: "Aoife Byrne", role: "director", hasDateOfBirth: true, hasNationality: true, addressHistoryYears: 5 }],
      },
    ],
    documents: [{ documentType: "photo_id", required: true, received: true, approval: "approved" }],
    signatures: [{ status: "completed", hasCustomerSigner: true }],
  });

describe("stage gates", () => {
  it("lets a bare lead move through the early stages", () => {
    for (const k of ["new_lead", "call_scheduled", "contacted", "interested", "details_requested", "details_received", "comparison_prepared"] as const) {
      expect(stageGateIssues(facts(), k)).toEqual([]);
    }
  });

  it.each(["electricity", "gas", "dual_fuel"] as const)("a complete %s opportunity can be submitted", (s) => {
    expect(stageGateIssues(readyEnergy(s), "submitted")).toEqual([]);
  });

  it("a complete Worldpay opportunity can be submitted", () => {
    expect(stageGateIssues(readyMerchant(), "submitted")).toEqual([]);
  });

  it("never blocks a move for missing details", () => {
    const bareEnergy = facts({ serviceType: "dual_fuel", internalApproval: "approved", signatures: [{ status: "completed", hasCustomerSigner: true }], customer: { vatRegistered: "yes", vatNumber: null, website: null }, sites: [{ label: "Main St", occupancyType: "rented", hasLandlord: false, meterPoints: [{ fuel: "electricity", mprn: null, gprn: null }] }] });
    expect(stageGateIssues(bareEnergy, "submitted")).toEqual([]);
    const m = readyMerchant();
    Object.assign(m.merchantApps[0], { cardTurnoverPct: null, website: null, productCount: 0, legalEntity: "partnership" });
    Object.assign(m.merchantApps[0].risk!, { depositsAccepted: true });
    m.customerId = null;
    expect(stageGateIssues(m, "submitted")).toEqual([]);
  });

  it("blocks submission without internal approval, signature or approved documents", () => {
    const f = readyEnergy("electricity");
    f.internalApproval = "pending";
    f.signatures = [{ status: "sent", hasCustomerSigner: true }];
    f.documents = [
      { documentType: "energy_bill", required: true, received: true, approval: "pending" },
      { documentType: "change_of_tenancy", required: false, received: false, approval: "pending" },
    ];
    const issues = stageGateIssues(f, "submitted");
    expect(issues).toContain("Internal approval must be granted before submission.");
    expect(issues).toContain("The customer must sign before submission.");
    expect(issues).toContain("These required documents must be received and approved: Recent energy bill.");
  });

  it("requires compliance approval for Worldpay submission", () => {
    const f = readyMerchant();
    f.merchantApps[0].risk!.complianceStatus = "query_raised";
    expect(stageGateIssues(f, "submitted")).toContain("Compliance must approve the Worldpay risk review before submission.");
  });

  it("gates are cumulative: later stages include earlier requirements", () => {
    const f = facts();
    const counts = STAGE_KEYS.map((k) => stageGateIssues(f, k).length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
  });

  it("reports missing information for reminders", () => {
    expect(missingInformation(facts({ serviceType: "dual_fuel" }))).toEqual(["supply site", "MPRN", "GPRN"]);
    expect(missingInformation(facts({ serviceType: "merchant_services" }))).toEqual(["Worldpay application"]);
  });
});

describe("where each gate issue is fixed", () => {
  it("points every Submitted issue for an energy deal at its tab", () => {
    const f = readyEnergy("dual_fuel");
    const issues = stageGateIssues(
      {
        ...f,
        internalApproval: "pending",
        sites: [{ label: "Main St", occupancyType: "rented", hasLandlord: false, meterPoints: [{ fuel: "electricity", mprn: null, gprn: null }] }],
        contracts: [],
        documents: [{ documentType: "letter_of_authority", required: true, received: false, approval: "pending" }],
        signatures: [],
        supplyChanges: ["change_of_supplier"],
        forms: [{ name: "Flogas electricity", status: "awaiting_review", qcPassed: true, documentType: "application_form" }],
      },
      "submitted",
    );
    expect(issues.map((i) => [i, gateIssueArea(i)])).toEqual([
      [expect.stringMatching(/^These required documents/), { area: "documents" }],
      ["The customer must sign before submission.", { area: "signatures" }],
      ["Check the previous supplier's bill (readable, and the customer, MPRN/GPRN and supplier match).", { area: "case" }],
      ['Review the signatures on "Flogas electricity".', { area: "form", form: "Flogas electricity" }],
      ["Internal approval must be granted before submission.", { area: "approval" }],
    ]);
  });

  it("sends Worldpay and case issues to their places", () => {
    expect(gateIssueArea("Compliance must approve the Worldpay risk review before submission.")).toEqual({ area: "worldpay" });
    expect(gateIssueArea("Upload the lease agreement under Documents: a signed lease is needed before submission.")).toEqual({ area: "documents" });
    expect(gateIssueArea("Record the external party's acceptance and reference: a sent submission is not an accepted one.")).toEqual({ area: "case" });
  });
});
