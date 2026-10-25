import {
  EMPTY_FLOGAS_ADDRESS,
  type FlogasElectricityData,
  durationAtPremises,
  flogasAnswersSchema,
  flogasDefaultRequirements,
  flogasElectricityApplies,
  flogasElectricityIssues,
  flogasEntityBox,
  flogasSaveSchema,
  flogasSigners,
  flogasStatus,
  isFlogasSupplier,
  ownsPremises,
} from "../src";

/** A complete, valid application. */
const complete = (over: Partial<FlogasElectricityData> = {}): FlogasElectricityData => ({
  legalName: "Murphy's Bakery Limited",
  tradingName: "Murphy's",
  supplyAddress: { line1: "Unit 4, Ballymount Ind Est", line2: null, city: "Dublin 12", county: "Dublin", postcode: "D12 AB34" },
  billingSameAsSupply: true,
  billingAddress: { ...EMPTY_FLOGAS_ADDRESS },
  legalEntity: "limited_company",
  vatExempt: false,
  vatExemptNumber: null,
  priorityCustomer: false,
  businessType: "Bakery",
  companyRegNumber: "654321",
  vatNumber: null,
  contactFirstName: "Aoife",
  contactLastName: "Murphy",
  telephone: "01 456 7890",
  mobile: "087 123 4567",
  email: "aoife@example.ie",
  occupancyType: "owner_occupied",
  occupiedSince: "2019-03-01",
  leaseTerms: null,
  landlordName: null,
  landlordContact: null,
  requirements: ["change_of_supplier"],
  meters: [{ id: null, mprn: "10012345678", mccCode: "01", formatException: false, day: 12345, night: null, wattless: null }],
  readingDate: "2026-10-01",
  existingFlogasCustomer: false,
  existingFlogasAccount: null,
  expectedChangeover: "2026-11-15",
  termMonths: 24,
  sector: "gp_24h",
  priceType: "fixed",
  dayRateCent: 21.45,
  nightRateCent: null,
  directDebit: true,
  debtorName: "Murphy's Bakery Limited",
  debtorAddressSameAsBilling: true,
  debtorAddress: { ...EMPTY_FLOGAS_ADDRESS },
  iban: "IE29AIBK93115212345678",
  bic: "AIBKIE2D",
  bankOnFile: true,
  ibanLast4: "5678",
  mandateReference: null,
  secondAccountHolder: null,
  signatoryName: "Aoife Murphy",
  signatoryPosition: "Director",
  agentSignature: false,
  agencyId: "UO-123",
  agencyName: "Utility Optimizer Limited",
  agentName: "Sam Seller",
  flogasRepName: null,
  flogasActivationDate: null,
  ...over,
});
const paths = (d: FlogasElectricityData) => flogasElectricityIssues(d).map((i) => i.path);

describe("Flogas electricity: when it applies", () => {
  it("needs Electricity in the product interest and Flogas as the supplier", () => {
    expect(flogasElectricityApplies({ productInterest: ["electricity"], serviceType: "electricity", supplierName: "Flogas" })).toBe(true);
    expect(flogasElectricityApplies({ productInterest: ["electricity", "gas"], serviceType: "dual_fuel", supplierName: "FloGas Natural Gas" })).toBe(true);
    expect(flogasElectricityApplies({ productInterest: ["gas"], serviceType: "gas", supplierName: "Flogas" })).toBe(false);
    expect(flogasElectricityApplies({ productInterest: ["electricity"], serviceType: "electricity", supplierName: "Energia" })).toBe(false);
    expect(flogasElectricityApplies({ productInterest: ["electricity"], serviceType: "electricity", supplierName: null })).toBe(false);
    expect(flogasElectricityApplies({ productInterest: ["electricity"], serviceType: "merchant_services", supplierName: "Flogas" })).toBe(false);
    expect(isFlogasSupplier("Flow Gas")).toBe(false);
  });
});

describe("Flogas electricity: CRM values", () => {
  it("maps CRM legal entities and occupancy to the form's boxes", () => {
    expect(flogasEntityBox("limited_company")).toBe("company");
    expect(flogasEntityBox("plc")).toBe("company");
    expect(flogasEntityBox("sole_trader")).toBe("sole_trader");
    expect(flogasEntityBox("partnership")).toBe("other");
    expect(flogasEntityBox(null)).toBeNull();
    expect(ownsPremises("owner_occupied")).toBe(true);
    expect(ownsPremises("rented")).toBe(false);
    expect(ownsPremises("landlord_supply")).toBe(false);
    expect(ownsPremises("other")).toBeNull();
  });

  it("suggests requirement ticks from the opportunity's supply changes", () => {
    expect(flogasDefaultRequirements({ supplyChanges: ["change_of_supplier"], saleType: "new_sale", newSupplyPoint: false })).toEqual(["change_of_supplier"]);
    expect(flogasDefaultRequirements({ supplyChanges: ["change_of_legal_entity", "reenergise_meter"], saleType: "renewal", newSupplyPoint: true })).toEqual([
      "new_connection",
      "change_of_legal_entity",
      "renewal",
      "reenergise_meter",
    ]);
  });

  it("works out years and months at the premises", () => {
    expect(durationAtPremises("2019-03-01", "2026-10-22")).toEqual({ years: 7, months: 7 });
    expect(durationAtPremises("2026-09-23", "2026-10-22")).toEqual({ years: 0, months: 0 });
    expect(durationAtPremises(null)).toBeNull();
  });
});

describe("Flogas electricity: validation", () => {
  it("accepts a complete application", () => {
    expect(flogasElectricityIssues(complete())).toEqual([]);
  });

  it("requires the fields the form needs, each on its own tab", () => {
    const issues = flogasElectricityIssues(
      complete({ legalName: " ", supplyAddress: { ...EMPTY_FLOGAS_ADDRESS }, legalEntity: null, businessType: null, contactFirstName: null, contactLastName: null, email: null, requirements: [], sector: null, signatoryName: null, signatoryPosition: "" }),
    );
    expect(issues.map((i) => [i.path, i.tab])).toEqual([
      ["legalName", "customer"],
      ["supplyAddress", "customer"],
      ["legalEntity", "customer"],
      ["businessType", "customer"],
      ["contactName", "customer"],
      ["email", "customer"],
      ["requirements", "supply"],
      ["signatoryName", "documents"],
      ["signatoryPosition", "documents"],
    ]);
  });

  it("asks for conditional details only when their answer needs them", () => {
    expect(paths(complete({ legalEntity: "limited_company", companyRegNumber: null, vatNumber: null }))).toEqual(["companyRegNumber"]);
    expect(paths(complete({ legalEntity: "limited_company", companyRegNumber: null, vatNumber: "IE1234567T" }))).toEqual([]);
    expect(paths(complete({ legalEntity: "sole_trader", companyRegNumber: null }))).toEqual([]);
    expect(paths(complete({ vatExempt: true }))).toEqual(["vatExemptNumber"]);
    expect(paths(complete({ occupancyType: "rented" }))).toEqual(["landlordName", "landlordContact"]);
    expect(paths(complete({ occupancyType: null }))).toEqual(["occupancyType"]);
    expect(paths(complete({ billingSameAsSupply: false }))).toEqual(["billingAddress"]);
    expect(paths(complete({ email: "not-an-email" }))).toEqual(["email"]);
  });

  it("doesn't require the sector, pricing or rates before signing", () => {
    expect(paths(complete({ sector: null, priceType: null, dayRateCent: null, nightRateCent: null }))).toEqual([]);
    expect(paths(complete({ sector: "gp_24h", dayRateCent: null }))).toEqual([]);
    expect(paths(complete({ sector: "gp_night_saver", dayRateCent: null, nightRateCent: null }))).toEqual([]);
  });

  it("checks every meter row", () => {
    const meters = [
      { id: null, mprn: "10012345678", mccCode: "01", formatException: false, day: 1, night: null, wattless: null },
      { id: null, mprn: "123", mccCode: null, formatException: false, day: null, night: null, wattless: null },
      { id: null, mprn: "100 1234 5678", mccCode: null, formatException: false, day: null, night: null, wattless: null },
      { id: null, mprn: null, mccCode: null, formatException: false, day: null, night: null, wattless: null },
      { id: null, mprn: "NI-123", mccCode: null, formatException: true, day: null, night: null, wattless: null },
    ];
    expect(paths(complete({ meters }))).toEqual(["meters.1.mprn", "meters.2.mprn", "meters.3.mprn"]);
    expect(paths(complete({ readingDate: null }))).toEqual(["readingDate"]);
    expect(paths(complete({ meters: [] }))).toEqual(["meters"]);
  });

  it("needs direct debit details only when paying by direct debit", () => {
    const noBank = complete({ debtorName: null, iban: null, bankOnFile: false });
    expect(paths(complete({ debtorName: null, iban: null }))).toEqual([]); // on file, hidden from this viewer
    expect(paths(noBank)).toEqual(["debtorName", "iban"]);
    expect(paths({ ...noBank, directDebit: false })).toEqual([]);
    expect(paths(complete({ iban: null }))).toEqual([]); // on file, but the viewer can't read it
    expect(paths(complete({ secondAccountHolder: { name: null, email: "bad" } }))).toEqual(["secondAccountHolder.name", "secondAccountHolder.email"]);
  });

  it("lists the signers the application needs", () => {
    expect(flogasSigners(complete())).toEqual(["customer"]);
    expect(flogasSigners(complete({ secondAccountHolder: { name: "B", email: "b@x.ie" }, agentSignature: true }))).toEqual(["customer", "account_holder_2", "broker"]);
    expect(flogasSigners(complete({ directDebit: false, secondAccountHolder: { name: "B", email: "b@x.ie" } }))).toEqual(["customer"]);
  });
});

describe("Flogas electricity: input schemas", () => {
  it("rejects negative or over-precise rates and readings", () => {
    expect(flogasSaveSchema.safeParse({ contract: { dayRateCent: -1 } }).success).toBe(false);
    expect(flogasSaveSchema.safeParse({ contract: { dayRateCent: 21.456 } }).success).toBe(false);
    expect(flogasSaveSchema.safeParse({ contract: { dayRateCent: 21.45 } }).success).toBe(true);
    expect(flogasSaveSchema.safeParse({ meters: [{ mprn: "10012345678", day: -5 }] }).success).toBe(false);
  });

  it("keeps at least one and at most twelve meter rows", () => {
    expect(flogasSaveSchema.safeParse({ meters: [] }).success).toBe(false);
    expect(flogasSaveSchema.safeParse({ meters: Array.from({ length: 13 }, () => ({ mprn: null })) }).success).toBe(false);
  });

  it("normalises an IBAN and rejects a malformed one", () => {
    const ok = flogasSaveSchema.parse({ bank: { accountName: "A", iban: "ie29 aibk 9311 5212 3456 78" } });
    expect(ok.bank?.iban).toBe("IE29AIBK93115212345678");
    expect(flogasSaveSchema.safeParse({ bank: { accountName: "A", iban: "12345" } }).success).toBe(false);
  });

  it("stores only known answers", () => {
    expect(flogasAnswersSchema.safeParse({ sector: "lvmd", requirements: ["renewal"] }).success).toBe(true);
    expect(flogasAnswersSchema.safeParse({ sector: "solar" }).success).toBe(false);
    expect(flogasAnswersSchema.parse({ sector: "lvmd", nonsense: 1 })).toEqual({ sector: "lvmd" });
  });
});

describe("Flogas electricity: status", () => {
  const form = (status: "generated" | "awaiting_review" | "approved" | "rejected" | "superseded") => ({ status });
  it("follows the version through signing and review", () => {
    expect(flogasStatus({ form: null, stale: false, links: [] })).toBe("draft");
    expect(flogasStatus({ form: form("generated"), stale: false, links: [] })).toBe("ready");
    expect(flogasStatus({ form: form("generated"), stale: true, links: [] })).toBe("draft");
    expect(flogasStatus({ form: form("generated"), stale: true, links: [{ role: "customer", status: "sent" }] })).toBe("sent");
    expect(flogasStatus({ form: form("generated"), stale: false, links: [{ role: "customer", status: "opened" }] })).toBe("viewed");
    expect(flogasStatus({ form: form("generated"), stale: false, links: [{ role: "customer", status: "declined" }] })).toBe("declined");
    expect(flogasStatus({ form: form("generated"), stale: false, links: [{ role: "customer", status: "expired" }] })).toBe("expired");
    // A newer link replaces an expired one; cancelled links don't count.
    expect(flogasStatus({ form: form("generated"), stale: false, links: [{ role: "customer", status: "sent" }, { role: "customer", status: "expired" }] })).toBe("sent");
    expect(flogasStatus({ form: form("generated"), stale: false, links: [{ role: "customer", status: "revoked" }] })).toBe("ready");
    expect(flogasStatus({ form: form("generated"), stale: false, links: [{ role: "customer", status: "signed" }, { role: "account_holder_2", status: "sent" }] })).toBe("sent");
    expect(flogasStatus({ form: form("awaiting_review"), stale: false, links: [] })).toBe("signed");
    expect(flogasStatus({ form: form("approved"), stale: true, links: [] })).toBe("completed");
    expect(flogasStatus({ form: form("rejected"), stale: false, links: [] })).toBe("rejected");
    expect(flogasStatus({ form: form("superseded"), stale: false, links: [] })).toBe("draft");
  });
});
