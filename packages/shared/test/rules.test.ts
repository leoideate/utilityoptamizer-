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

  it("requires MPRN for electricity and dual fuel, GPRN for gas and dual fuel", () => {
    const noMprn = readyEnergy("electricity");
    noMprn.sites[0].meterPoints[0].mprn = null;
    expect(stageGateIssues(noMprn, "submitted")).toContain("Enter an MPRN for every electricity meter.");

    const dualNoGas = readyEnergy("dual_fuel");
    dualNoGas.sites[0].meterPoints = dualNoGas.sites[0].meterPoints.filter((m) => m.fuel === "electricity");
    expect(stageGateIssues(dualNoGas, "submitted")).toContain("Enter a GPRN for every gas meter.");

    const gas = readyEnergy("gas");
    expect(stageGateIssues(gas, "submitted").some((i) => i.includes("MPRN"))).toBe(false);
    gas.sites[0].meterPoints[0].gprn = null;
    expect(stageGateIssues(gas, "submitted")).toContain("Enter a GPRN for every gas meter.");
  });

  it("MPRN/GPRN are only enforced at submission", () => {
    const f = readyEnergy("electricity");
    f.sites[0].meterPoints = [];
    f.internalApproval = "pending";
    expect(stageGateIssues(f, "documents_prepared")).toEqual([]);
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

  it("requires the supplier from Supplier Selected onwards", () => {
    const f = readyEnergy("gas");
    f.selectedSupplierId = null;
    expect(stageGateIssues(f, "client_reviewing")).toEqual([]);
    expect(stageGateIssues(f, "supplier_selected")).toEqual(["Select the supplier."]);
  });

  it("requires landlord details for rented premises", () => {
    const f = readyEnergy("electricity");
    f.sites[0].occupancyType = "rented";
    expect(stageGateIssues(f, "documents_prepared")).toContain("Main St is rented: enter the landlord's details.");
    f.sites[0].hasLandlord = true;
    expect(stageGateIssues(f, "documents_prepared")).toEqual([]);
  });

  it("requires a VAT number when VAT registered", () => {
    const f = readyEnergy("electricity");
    f.customer = { vatRegistered: "yes", vatNumber: null, website: null };
    expect(stageGateIssues(f, "documents_prepared")).toContain("Enter the VAT number: the customer is VAT registered.");
  });

  it("requires Worldpay turnover details before a proposal", () => {
    const f = readyMerchant();
    f.merchantApps[0].cardTurnoverPct = null;
    expect(stageGateIssues(f, "client_reviewing")).toContain("Enter the percentage of turnover taken by card.");
    expect(stageGateIssues(f, "comparison_prepared")).toEqual([]);
  });

  it("requires deposit and prepayment details only when accepted", () => {
    const f = readyMerchant();
    const risk = f.merchantApps[0].risk!;
    risk.depositsAccepted = true;
    risk.fullPrepaymentAccepted = true;
    const issues = stageGateIssues(f, "documents_prepared");
    expect(issues.filter((i) => i.startsWith("Deposits are accepted"))).toHaveLength(4);
    expect(issues.filter((i) => i.startsWith("Full payment in advance"))).toHaveLength(2);
    Object.assign(risk, { depositTxnPct: 20, depositValuePct: 25, depositLeadDays: 30, balanceLeadDays: 0, fullPrepaymentPct: 5, fullPaymentLeadDays: 14 });
    expect(stageGateIssues(f, "documents_prepared")).toEqual([]);
  });

  it("requires principals according to legal entity", () => {
    const f = readyMerchant();
    f.merchantApps[0].legalEntity = "partnership";
    f.merchantApps[0].principals = [{ name: "A", role: "partner", hasDateOfBirth: true, hasNationality: true, addressHistoryYears: 3 }];
    expect(stageGateIssues(f, "documents_prepared")).toContain("A partnership needs principal details for at least two partners.");
    f.merchantApps[0].principals.push({ name: "B", role: "partner", hasDateOfBirth: false, hasNationality: true, addressHistoryYears: 1 });
    expect(stageGateIssues(f, "documents_prepared")).toEqual(["Principal B is missing date of birth, 3 years of address history."]);
  });

  it("requires an advertising method when there is no website", () => {
    const f = readyMerchant();
    f.merchantApps[0].website = null;
    expect(stageGateIssues(f, "documents_prepared")[0]).toMatch(/no website/);
    f.merchantApps[0].advertisingMethod = "Facebook page";
    expect(stageGateIssues(f, "documents_prepared")).toEqual([]);
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
      ["Main St is rented: enter the landlord's details.", { area: "supply" }],
      ["Enter an MPRN for every electricity meter.", { area: "supply" }],
      ["Enter a GPRN for every gas meter.", { area: "supply" }],
      ["Add the energy contract details.", { area: "supply" }],
      [expect.stringMatching(/^These required documents/), { area: "documents" }],
      ["The customer must sign before submission.", { area: "signatures" }],
      ["Check the previous supplier's bill (readable, and the customer, MPRN/GPRN and supplier match).", { area: "case" }],
      ['Review the signatures on "Flogas electricity".', { area: "form", form: "Flogas electricity" }],
      ["Internal approval must be granted before submission.", { area: "approval" }],
    ]);
  });

  it("sends Worldpay, customer and case issues to their places", () => {
    expect(gateIssueArea("Compliance must approve the Worldpay risk review before submission.")).toEqual({ area: "worldpay" });
    expect(gateIssueArea("Principal Aoife Byrne is missing date of birth.")).toEqual({ area: "worldpay" });
    expect(gateIssueArea("Link or create the customer.")).toEqual({ area: "details" });
    expect(gateIssueArea("Upload the lease agreement under Documents: a signed lease is needed before submission.")).toEqual({ area: "documents" });
    expect(gateIssueArea("Record the external party's acceptance and reference: a sent submission is not an accepted one.")).toEqual({ area: "case" });
  });
});
