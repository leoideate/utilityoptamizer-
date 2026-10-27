import { FORMAT_EXCEPTION_REASON, migrationColumn, parseSheetAddress, parseSheetRow, sheetDate, sheetPhone, sheetTermMonths, supplierFromTab } from "../src";

const TODAY = "2026-10-24";
const base = {
  signDate: 46184,
  startDate: 46184,
  contractStatus: "Ready for Invoice",
  businessName: "Harbour Café Ltd",
  tradingName: "Harbour Café",
  contactPerson: "Aoife Byrne",
  address: "12 Quay St, Galway, Co. Galway, H91 X2Y3",
  phone: 871234567,
  email: "Aoife@Harbour.ie",
  meter: 10012345678,
  utilityType: "Electricity",
  connectionType: "New",
  productType: "GP (Rate card 3)",
  term: 2,
  salesAgent: "Sarah Sales",
  expiryDate: 46915,
};

describe("master sheet migration", () => {
  it("matches the sheet's headers, typos included", () => {
    expect(migrationColumn("MPRN/GPRN")).toBe("meter");
    expect(migrationColumn("Term (yrs)")).toBe("term");
    expect(migrationColumn("Comment - Isuues for Invoices")).toBe("invoiceIssue");
    expect(migrationColumn("Contact Number")).toBe("phone");
    expect(migrationColumn("Month")).toBeNull();
  });

  it("reads Excel serials and Irish-order dates", () => {
    expect(sheetDate(46184)).toEqual({ value: "2026-06-11", ok: true });
    expect(sheetDate("31/12/2025").value).toBe("2025-12-31");
    expect(sheetDate("2026-02-30").ok).toBe(false);
    expect(sheetDate("soon").ok).toBe(false);
    expect(sheetDate(null)).toEqual({ value: null, ok: true });
  });

  it("reads terms in years or months, and phones Excel stored as numbers", () => {
    expect(sheetTermMonths(2)).toBe(24);
    expect(sheetTermMonths("1.5 yrs")).toBe(18);
    expect(sheetTermMonths("18 months")).toBe(18);
    expect(sheetPhone(871234567)).toBe("0871234567");
    expect(sheetPhone("+353 87 123 4567")).toBe("+353 87 123 4567");
  });

  it("splits one-line addresses, finding the Eircode and county", () => {
    expect(parseSheetAddress("Unit 4, Main St, Naas, Co. Kildare, W91X2Y3")).toEqual({ line1: "Unit 4", line2: "Main St", city: "Naas", county: "Kildare", postcode: "W91 X2Y3" });
    expect(parseSheetAddress("The Square, Dublin")).toEqual({ line1: "The Square", line2: null, city: null, county: "Dublin", postcode: null });
    expect(parseSheetAddress("Old Mill Road")).toEqual({ line1: "Old Mill Road", line2: null, city: null, county: null, postcode: null });
  });

  it("names the supplier from the tab", () => {
    expect(supplierFromTab("Bord Gais")).toEqual({ name: "Bord Gáis Energy", kind: "energy" });
    expect(supplierFromTab("Worldpay ")).toEqual({ name: "Worldpay", kind: "merchant" });
    expect(supplierFromTab("Flogas")).toEqual({ name: "Flogas", kind: "energy" });
  });

  it("turns a row into a live contract with the extra columns kept as notes", () => {
    const { row, issues } = parseSheetRow("Flogas", 2, { ...base, reviewer: "Mary", contractIssue: "Awaiting COT form" }, { today: TODAY });
    expect(issues).toEqual([]);
    expect(row).toMatchObject({
      serviceType: "electricity",
      fuel: "electricity",
      mprn: "10012345678",
      legalName: "Harbour Café Ltd",
      phone: "0871234567",
      email: "aoife@harbour.ie",
      termMonths: 24,
      startDate: "2026-06-11",
      endDate: "2028-06-11",
      contractStatus: "live",
      saleType: "new_sale",
      importKey: "sheet:flogas:10012345678:2026-06-11",
    });
    expect(row!.notes).toEqual(expect.arrayContaining([{ label: "Contract status", value: "Ready for Invoice" }, { label: "Reviewer", value: "Mary" }, { label: "Contract issue", value: "Awaiting COT form" }]));
  });

  it("ends expired contracts and works out a missing expiry from the term", () => {
    expect(parseSheetRow("Flogas", 2, { ...base, expiryDate: "01/01/2026" }, { today: TODAY }).row!.contractStatus).toBe("ended");
    expect(parseSheetRow("Flogas", 2, { ...base, expiryDate: null }, { today: TODAY }).row!.endDate).toBe("2028-06-10");
  });

  it("keeps cancelled and rejected rows as lost deals, separate from a live row for the same meter", () => {
    const lost = parseSheetRow("Flogas", 2, { ...base, contractStatus: "Rejected" }, { today: TODAY });
    expect(lost.issues).toEqual([]);
    expect(lost.row).toMatchObject({ outcome: "lost", contractStatus: "cancelled", sheetStatus: "Rejected", meterCheck: null });
    expect(lost.row!.importKey).not.toBe(parseSheetRow("Flogas", 2, base, { today: TODAY }).row!.importKey);
    expect(parseSheetRow("Flogas", 2, base, { today: TODAY }).row!.outcome).toBe("won");
  });

  it("guesses the fuel from the meter's length when the sheet has no utility type, with a check", () => {
    expect(parseSheetRow("Flogas", 2, { ...base, utilityType: null, meter: "505059" }, { today: TODAY, allowFormatExceptions: true }).row).toMatchObject({ fuel: "gas", gprn: "505059", meterCheck: "format" });
    expect(parseSheetRow("Flogas", 2, { ...base, utilityType: null, meter: null }, { today: TODAY }).row).toMatchObject({ fuel: "electricity", meterCheck: "missing" });
    expect(parseSheetRow("Flogas", 2, { ...base, utilityType: "Water", meter: "100123456789" }, { today: TODAY, allowFormatExceptions: true }).row).toMatchObject({ fuel: "electricity", meterCheck: "format" });
  });

  it("skips dual fuel and badly formatted rows with reasons", () => {
    expect(parseSheetRow("Flogas", 2, { ...base, utilityType: "Dual Fuel" }, { today: TODAY }).issues[0]).toMatch(/one row per/);
    expect(parseSheetRow("Flogas", 2, { ...base, meter: "2012345678" }, { today: TODAY }).issues.join()).toMatch(/11 digits/);
    const allowed = parseSheetRow("Flogas", 2, { ...base, meter: "2012345678" }, { today: TODAY, allowFormatExceptions: true });
    expect(allowed.row!.formatExceptionReason).toBe(FORMAT_EXCEPTION_REASON);
  });

  it("infers gas from a 7-digit meter number, and needs no meter for Worldpay", () => {
    expect(parseSheetRow("Energia", 3, { ...base, utilityType: null, meter: "1234567" }, { today: TODAY }).row).toMatchObject({ fuel: "gas", gprn: "1234567", mprn: null });
    expect(parseSheetRow("Worldpay", 3, { ...base, meter: null, utilityType: null }, { today: TODAY }).row).toMatchObject({ serviceType: "merchant_services", fuel: null });
  });

  it("reads the aligned layout: a Supplier column, +353 numbers, Contract start and term in years", () => {
    expect(migrationColumn("Contract start")).toBe("startDate");
    expect(migrationColumn("Contract term (years)")).toBe("term");
    expect(migrationColumn("Contact number (+353)")).toBe("phoneIntl");
    expect(migrationColumn("Supplier")).toBe("supplier");
    expect(supplierFromTab("Flogas Customers").name).toBe("Flogas");
    const { row } = parseSheetRow("Customers", 2, { ...base, supplier: "Flogas", phone: "0871234567", phoneIntl: "+353871234567", country: "Ireland" }, { today: TODAY });
    expect(row).toMatchObject({ supplier: { name: "Flogas" }, phone: "+353871234567", country: "IE", sheetStatus: "Ready for Invoice", meterCheck: null });
  });

  it("ends clawed-back contracts, keeps duplicates and errors as lost deals, and keys rows by expiry when there's no start date", () => {
    expect(parseSheetRow("Flogas", 2, { ...base, contractStatus: "Clawback" }, { today: TODAY }).row).toMatchObject({ contractStatus: "ended", sheetStatus: "Clawback" });
    expect(parseSheetRow("Flogas", 2, { ...base, contractStatus: "Duplicate" }, { today: TODAY }).row).toMatchObject({ outcome: "lost" });
    expect(parseSheetRow("Flogas", 2, { ...base, contractStatus: "Error" }, { today: TODAY }).row).toMatchObject({ outcome: "lost" });
    expect(parseSheetRow("Flogas", 2, { ...base, contractStatus: "Under Investigation" }, { today: TODAY }).row!.contractStatus).toBe("live");
    expect(parseSheetRow("Flogas", 2, { ...base, startDate: null, signDate: null }, { today: TODAY }).row!.importKey).toBe("sheet:flogas:10012345678:2028-06-11");
  });

  it("imports rows with a missing or non-standard meter number, flagged for an administrator", () => {
    const missing = parseSheetRow("Flogas", 2, { ...base, utilityType: "Gas", meter: null }, { today: TODAY });
    expect(missing.row).toMatchObject({ fuel: "gas", gprn: null, meterCheck: "missing" });
    expect(missing.warnings.join()).toMatch(/No GPRN; imported with a task/);
    expect(parseSheetRow("Flogas", 2, { ...base, utilityType: null, meter: null }, { today: TODAY }).row).toMatchObject({ fuel: "electricity", meterCheck: "missing" });
    const short = parseSheetRow("Flogas", 2, { ...base, utilityType: "Gas", meter: "475303" }, { today: TODAY, allowFormatExceptions: true });
    expect(short.row).toMatchObject({ gprn: "475303", meterCheck: "format", formatExceptionReason: FORMAT_EXCEPTION_REASON });
  });
});
