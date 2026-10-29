import {
  BORD_GAIS_ALIASES,
  type BordGaisElectricityData,
  EMPTY_ADDRESS,
  applicableSupplierApplication,
  bordGaisAnswersSchema,
  bordGaisBillingAddress,
  bordGaisConfirmationEnd,
  bordGaisMonthEnd,
  bordGaisMonthLabel,
  bordGaisElectricityApplies,
  bordGaisElectricityIssues,
  bordGaisSaveSchema,
  bordGaisSigners,
  emptyRates,
  isBordGaisSupplier,
  splitReading,
  supplierApplicationApplies,
} from "../src";

const noReadings = { "24h": null, day: null, night: null, night_storage: null, wattless: null };
const complete = (over: Partial<BordGaisElectricityData> = {}): BordGaisElectricityData => {
  const rates = emptyRates();
  rates.energy.rate24h1 = 21.45;
  rates.energy.standingCharge = 55.12;
  return {
    legalName: "Murphy's Bakery Limited",
    tradingName: null,
    accountHolderName: "Murphy's Bakery Limited",
    accountAddress: { line1: "1 Main Street", line2: null, city: "Naas", county: "Kildare", postcode: "W91 AB12" },
    mainActivity: "Bakery",
    dateEstablished: "2015-04-01",
    organisationType: "limited_company",
    croNumber: "654321",
    employees: 12,
    homeAddress: { ...EMPTY_ADDRESS },
    contactFirstName: "Aoife",
    contactLastName: "Murphy",
    position: "Director",
    email: "aoife@example.ie",
    telephone: "045 123 456",
    mobile: null,
    siteName: "Bakery",
    supplyAddress: { line1: "1 Main Street", line2: null, city: "Naas", county: "Kildare", postcode: "W91 AB12" },
    premisesContactName: "Aoife Murphy",
    premisesTelephone: null,
    premisesFax: null,
    premisesEmail: null,
    premisesMobile: null,
    priorityCustomer: false,
    billingContactName: "Aoife Murphy",
    billingSource: "account_holder",
    billingAddress: { ...EMPTY_ADDRESS },
    mprn: "10012345678",
    mprnFormatException: false,
    mic: 50,
    dgCode: "DG1",
    voltage: "LV",
    mcc: "01",
    profileClass: "1",
    existingSupplier: "Electric Ireland",
    annualConsumptionKwh: 45000,
    meters: [
      { serial: "001234567", readings: { ...noReadings, "24h": "01234" } },
      { serial: null, readings: { ...noReadings } },
    ],
    readingDate: "2026-10-01",
    pricePlan: "Business Fixed 24",
    startDate: "2026-11-01",
    confirmationEndDate: null,
    commitmentMonths: 24,
    rateType: "fixed",
    rates,
    discounts: { y1_12: null, y1_24: null, y1_36: null, y2_24: null, y2_36: null, y3_36: null },
    signatoryName: "Aoife Murphy",
    marketing: { email: true, post: false, phone: true, sms: false },
    broaderMarketing: false,
    agentName: "Sam Seller",
    directDebit: true,
    mandateReference: null,
    bankAccountName: "Murphy's Bakery Limited",
    iban: "IE29AIBK93115212345678",
    bic: "AIBKIE2D",
    bankOnFile: true,
    bicOnFile: true,
    ibanLast4: "5678",
    secondAccountHolder: null,
    ...over,
  };
};
const paths = (d: BordGaisElectricityData) => bordGaisElectricityIssues(d).map((i) => i.path);

describe("Bord Gáis electricity: when it applies", () => {
  it("matches Bord Gáis Energy and its old spellings, and nothing else", () => {
    for (const name of ["Bord Gáis Energy", "bord gáis energy", "BORD GAIS", ...BORD_GAIS_ALIASES]) expect({ name, ok: isBordGaisSupplier(name) }).toEqual({ name, ok: true });
    for (const name of ["Flogas", "Energia", "Bord na Móna", "Gas Networks Ireland", "", null]) expect({ name, ok: isBordGaisSupplier(name) }).toEqual({ name, ok: false });
  });

  it("needs Electricity and Bord Gáis, and picks the right application for the deal", () => {
    expect(bordGaisElectricityApplies({ productInterest: ["electricity"], serviceType: "electricity", supplierName: "Board Gais" })).toBe(true);
    expect(bordGaisElectricityApplies({ productInterest: ["gas"], serviceType: "gas", supplierName: "Bord Gáis Energy" })).toBe(false);
    expect(bordGaisElectricityApplies({ productInterest: ["electricity"], serviceType: "merchant_services", supplierName: "Bord Gáis Energy" })).toBe(false);
    expect(applicableSupplierApplication({ productInterest: ["electricity"], serviceType: "electricity", supplierName: "Bord Gáis Energy" })).toBe("bord_gais_electricity");
    expect(applicableSupplierApplication({ productInterest: ["electricity"], serviceType: "electricity", supplierName: "Flogas" })).toBe("flogas_electricity");
    expect(applicableSupplierApplication({ productInterest: ["electricity"], serviceType: "electricity", supplierName: "Energia" })).toBeNull();
    expect(supplierApplicationApplies("bord_gais_electricity", { productInterest: ["electricity"], serviceType: "electricity", supplierName: "Flogas" })).toBe(false);
  });
});

describe("Bord Gáis electricity: values", () => {
  it("splits readings into the boxes before and after the slash, keeping leading zeroes", () => {
    expect(splitReading("01234")).toEqual({ whole: "01234", tenth: "" });
    expect(splitReading("01234.5")).toEqual({ whole: "01234", tenth: "5" });
    expect(splitReading("123456")).toBeNull();
    expect(splitReading("12.34")).toBeNull();
    expect(splitReading(null)).toBeNull();
  });

  it("sends the bill to the chosen address", () => {
    const d = complete({ billingAddress: { ...EMPTY_ADDRESS, line1: "PO Box 9" }, supplyAddress: { ...EMPTY_ADDRESS, line1: "Unit 4" } });
    expect(bordGaisBillingAddress(d).line1).toBe("1 Main Street");
    expect(bordGaisBillingAddress({ ...d, billingSource: "supply" }).line1).toBe("Unit 4");
    expect(bordGaisBillingAddress({ ...d, billingSource: "separate" }).line1).toBe("PO Box 9");
  });

  it("works out the confirmation period end date unless one is given", () => {
    expect(bordGaisConfirmationEnd({ confirmationEndDate: null, startDate: "2026-11-01", commitmentMonths: 24 })).toBe("2028-10-31");
    expect(bordGaisConfirmationEnd({ confirmationEndDate: "2028-12-31", startDate: "2026-11-01", commitmentMonths: 24 })).toBe("2028-12-31");
    expect(bordGaisConfirmationEnd({ confirmationEndDate: null, startDate: null, commitmentMonths: 24 })).toBeNull();
  });

  it("shows the confirmation period end as month and year, and stores a chosen month as its last day", () => {
    expect(bordGaisMonthLabel("2028-10-31")).toBe("Oct-2028");
    expect(bordGaisMonthLabel("2026-01-05")).toBe("Jan-2026");
    expect(bordGaisMonthLabel(null)).toBeNull();
    expect(bordGaisMonthEnd("2028-10")).toBe("2028-10-31");
    expect(bordGaisMonthEnd("2028-02")).toBe("2028-02-29");
    expect(bordGaisMonthEnd("2027-12")).toBe("2027-12-31");
  });

  it("asks a second account holder to sign only with direct debit", () => {
    expect(bordGaisSigners(complete())).toEqual(["customer"]);
    expect(bordGaisSigners(complete({ secondAccountHolder: { name: "B", email: "b@x.ie" } }))).toEqual(["customer", "account_holder_2"]);
    expect(bordGaisSigners(complete({ directDebit: false, secondAccountHolder: { name: "B", email: "b@x.ie" } }))).toEqual(["customer"]);
  });
});

describe("Bord Gáis electricity: validation", () => {
  it("accepts a complete application", () => {
    expect(bordGaisElectricityIssues(complete())).toEqual([]);
  });

  it("requires the core details, each on its tab", () => {
    const issues = bordGaisElectricityIssues(
      complete({ legalName: null, accountAddress: { ...EMPTY_ADDRESS }, organisationType: null, contactFirstName: null, contactLastName: null, email: null, telephone: null, supplyAddress: { ...EMPTY_ADDRESS }, mprn: null, existingSupplier: null, annualConsumptionKwh: null, pricePlan: null, commitmentMonths: null, rateType: null, signatoryName: null }),
    );
    expect(issues.map((i) => `${i.tab}:${i.path}`)).toEqual([
      "account:legalName",
      "account:accountAddress",
      "account:organisationType",
      "account:contactName",
      "account:email",
      "premises:supplyAddress",
      "supply:mprn",
      "supply:existingSupplier",
      "supply:annualConsumptionKwh",
      "agreement:pricePlan",
      "agreement:commitmentMonths",
      "agreement:rateType",
      "declaration:signatoryName",
    ]);
  });

  it("asks for organisation details only where the type needs them", () => {
    expect(paths(complete({ organisationType: "plc", croNumber: null }))).toEqual(["croNumber"]);
    expect(paths(complete({ organisationType: "state_body", croNumber: null }))).toEqual([]);
    expect(paths(complete({ organisationType: "sole_trader", croNumber: null }))).toEqual(["homeAddress"]);
    expect(paths(complete({ organisationType: "partnership", croNumber: null, homeAddress: { ...EMPTY_ADDRESS, line1: "4 Oak Park" } }))).toEqual([]);
    expect(bordGaisElectricityIssues(complete({ organisationType: "other" }))[0].message).toBe("Bord Gáis needs one of the organisation types on its form.");
  });

  it("accepts either email or telephone for the contact", () => {
    expect(paths(complete({ email: null }))).toEqual([]);
    expect(paths(complete({ telephone: null }))).toEqual([]);
    expect(paths(complete({ email: "nope" }))).toEqual(["email"]);
  });

  it("checks both meters and their readings", () => {
    const meters = complete().meters;
    expect(paths(complete({ meters: [{ ...meters[0], serial: null }, meters[1]] }))).toEqual(["meters.0.serial"]);
    expect(paths(complete({ meters: [meters[0], { serial: null, readings: { ...noReadings, night: "00999.1" } }] }))).toEqual(["meters.1.serial"]);
    expect(paths(complete({ meters: [{ ...meters[0], serial: "1234567890" }, meters[1]] }))).toEqual(["meters.0.serial"]);
    expect(paths(complete({ meters: [{ serial: "1", readings: { ...noReadings, day: "123456" } }, meters[1]] }))).toEqual(["meters.0.readings.day"]);
    expect(paths(complete({ readingDate: null }))).toEqual(["readingDate"]);
    expect(paths(complete({ mprn: "999" }))).toEqual(["mprn"]);
  });

  it("needs a commitment period the form offers and a rate in the row for the rate type", () => {
    expect(paths(complete({ commitmentMonths: 30 }))).toEqual(["commitmentMonths"]);
    expect(paths(complete({ rateType: "variable" }))).toEqual(["rates"]);
    const nonEnergyOnly = emptyRates();
    nonEnergyOnly.nonEnergy.day1 = 3.2;
    expect(paths(complete({ rates: nonEnergyOnly }))).toEqual([]); // a fixed energy rate uses the energy and non-energy rows
    const standingOnly = emptyRates();
    standingOnly.energy.standingCharge = 50;
    expect(paths(complete({ rates: standingOnly }))).toEqual(["rates"]);
  });

  it("needs every marketing preference recorded, so an unasked customer isn't taken as consenting", () => {
    expect(paths(complete({ marketing: { email: true, post: null, phone: true, sms: true } }))).toEqual(["marketing"]);
  });

  it("needs SEPA details only with direct debit", () => {
    const noBank = complete({ bankOnFile: false, bicOnFile: false, iban: null, bic: null, bankAccountName: null });
    expect(paths(noBank)).toEqual(["iban", "bic", "bankAccountName"]);
    expect(paths({ ...noBank, directDebit: false })).toEqual([]);
    expect(paths(complete({ iban: null, bic: null, bankAccountName: null }))).toEqual([]); // on file, hidden from this viewer
    expect(paths(complete({ secondAccountHolder: { name: null, email: "x" } }))).toEqual(["secondAccountHolder.name", "secondAccountHolder.email"]);
  });
});

describe("Bord Gáis electricity: input schemas", () => {
  it("rejects negative or over-precise rates and discounts", () => {
    expect(bordGaisSaveSchema.safeParse({ rates: { energy: { day1: -1 } } }).success).toBe(false);
    expect(bordGaisSaveSchema.safeParse({ rates: { energy: { day1: 21.456 } } }).success).toBe(false);
    expect(bordGaisSaveSchema.safeParse({ rates: { energy: { day1: 21.45, standingCharge: null } } }).success).toBe(true);
    expect(bordGaisAnswersSchema.safeParse({ discounts: { y1_12: 101 } }).success).toBe(false);
    expect(bordGaisAnswersSchema.safeParse({ discounts: { y2_12: 5 } }).success).toBe(false); // greyed out on the form
  });

  it("keeps readings as text, digits only", () => {
    const ok = bordGaisSaveSchema.parse({ readings: { meter1: { day: "00123.4" } } });
    expect(ok.readings?.meter1?.day).toBe("00123.4");
    expect(bordGaisSaveSchema.safeParse({ readings: { meter1: { day: "12a" } } }).success).toBe(false);
  });

  it("normalises bank details and rejects malformed ones", () => {
    const ok = bordGaisSaveSchema.parse({ bank: { accountName: "A", iban: "ie29 aibk 9311 5212 3456 78", bic: "aibk ie2d" } });
    expect(ok.bank).toEqual({ accountName: "A", iban: "IE29AIBK93115212345678", bic: "AIBKIE2D" });
    expect(bordGaisSaveSchema.safeParse({ bank: { accountName: "A", iban: "IE29AIBK93115212345678", bic: "AIB" } }).success).toBe(false);
  });
});
