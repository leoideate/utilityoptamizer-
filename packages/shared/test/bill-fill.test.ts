import { type BillReading, type BordGaisElectricityData, type FlogasElectricityData, bordGaisFillSave, bordGaisFillSuggestions, flogasFillSave, flogasFillSuggestions } from "../src";

const reading: BillReading = {
  readable: true,
  customerName: "Murphy's Bakery Ltd",
  supplyAddress: { line1: "Unit 4, Ballymount Ind Est", line2: null, city: "Dublin 12", county: "Dublin", postcode: "D12 AB34" },
  fuel: "electricity",
  mprn: "10012345678",
  gprn: null,
  meterNumber: "123456",
  supplierName: "Flogas",
  accountNumber: "FL-99887",
  billDate: "2026-10-03",
  periodStart: "2026-08-01",
  periodEnd: "2026-09-30",
  tariffName: null,
  dayRate: 0.28,
  nightRate: 0.15,
  gasRate: null,
  standingChargePerDay: 0.6,
  usageKwh: 2400,
  annualConsumptionKwh: 14500,
  mic: 30,
  readings: [
    { register: "Day", value: "045123", readingDate: "2026-09-30", readingType: "actual" },
    { register: "Night", value: "012890", readingDate: "2026-09-30", readingType: "actual" },
  ],
  notes: null,
};

const address = { line1: null, line2: null, city: null, county: null, postcode: null };
const flogas = (over: Partial<FlogasElectricityData> = {}) =>
  ({ legalName: null, supplyAddress: address, meters: [], readingDate: null, existingFlogasCustomer: null, existingFlogasAccount: null, ...over }) as FlogasElectricityData;

describe("fill from bill: Flogas", () => {
  it("suggests every field a bill can fill on an empty form, and saves the ticked ones", () => {
    const d = flogas();
    const keys = flogasFillSuggestions(reading, d).map((s) => s.key);
    expect(keys).toEqual(["legalName", "supplyAddress", "mprn", "reading:0", "reading:1", "readingDate", "existingFlogas", "existingFlogasAccount"]);
    const save = flogasFillSave(reading, d, new Set(keys));
    expect(save).toMatchObject({
      customer: { legalName: "Murphy's Bakery Ltd" },
      supplyAddress: { line1: "Unit 4, Ballymount Ind Est", postcode: "D12 AB34" },
      meters: [{ id: null, mprn: "10012345678", day: 45123, night: 12890, wattless: null }],
      readingDate: "2026-09-30",
      answers: { existingFlogasCustomer: true, existingFlogasAccount: "FL-99887" },
    });
    expect(JSON.stringify(save)).not.toMatch(/bank|iban/i);
  });

  it("puts readings on the row with the bill's MPRN, leaves other rows alone, and offers only what differs", () => {
    const d = flogas({
      legalName: "Murphy's Bakery Ltd",
      meters: [
        { id: "a", mprn: "10099999999", mccCode: null, formatException: false, day: 1, night: null, wattless: null },
        { id: "b", mprn: "10012345678", mccCode: "01", formatException: false, day: 45123, night: null, wattless: null },
      ],
    });
    const rows = flogasFillSuggestions({ ...reading, supplierName: "Electric Ireland" }, d);
    expect(rows.map((r) => r.key)).toEqual(["supplyAddress", "reading:1", "readingDate"]);
    expect(rows[1]).toMatchObject({ label: "Night reading (row 2)", current: null, proposed: "12890" });
    const save = flogasFillSave(reading, d, new Set(["reading:1"]));
    expect(save.meters).toEqual([
      { id: "a", mprn: "10099999999", mccCode: null, day: 1, night: null, wattless: null },
      { id: "b", mprn: "10012345678", mccCode: "01", day: 45123, night: 12890, wattless: null },
    ]);
    expect(save.readingDate).toBe("2026-09-30");
  });

  it("offers nothing from an unreadable bill", () => {
    expect(flogasFillSuggestions({ ...reading, readable: false }, flogas())).toEqual([]);
  });
});

describe("fill from bill: Bord Gáis", () => {
  const d = {
    legalName: "Murphy's Bakery Ltd",
    supplyAddress: address,
    mprn: null,
    mic: null,
    existingSupplier: "Flogas",
    annualConsumptionKwh: null,
    readingDate: null,
    meters: [
      { serial: null, readings: { "24h": null, day: null, night: null, night_storage: null, wattless: null } },
      { serial: null, readings: { "24h": null, day: null, night: null, night_storage: null, wattless: null } },
    ],
  } as unknown as BordGaisElectricityData;

  it("maps meter, readings, consumption and supplier into the form's sections", () => {
    const keys = bordGaisFillSuggestions(reading, d).map((s) => s.key);
    expect(keys).toEqual(["supplyAddress", "mprn", "mic", "serial", "reading:0", "reading:1", "readingDate", "annualConsumption"]);
    expect(bordGaisFillSave(reading, d, new Set(keys))).toEqual({
      supplyAddress: reading.supplyAddress,
      meter: { mprn: "10012345678", mic: 30, serial1: "123456" },
      readings: { meter1: { day: "45123", night: "12890" }, readingDate: "2026-09-30" },
      site: { annualConsumptionKwh: 14500 },
    });
  });

  it("skips readings that don't fit the form's boxes", () => {
    const long = { ...reading, readings: [{ register: "24hr", value: "1234567", readingDate: "2026-09-30", readingType: "actual" as const }] };
    expect(bordGaisFillSuggestions(long, d).map((s) => s.key)).not.toContain("reading:0");
  });
});
