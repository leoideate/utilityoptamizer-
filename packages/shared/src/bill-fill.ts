/**
 * "Fill from bill": which fields of a supplier application a bill reading can fill, and the
 * partial save that writes the ones a person ticked. Bank details are never part of it.
 */
import type { BillReading } from "./bill-reading";
import { BORD_GAIS_READING, type BordGaisElectricityData, type BordGaisRegister, type BordGaisSaveInput, METER_SERIAL_MAX } from "./bord-gais";
import { FLOGAS_MAX_METERS, type FlogasElectricityData, type FlogasSaveInput, isFlogasSupplier } from "./flogas";
import { normalizeIdentifier } from "./identifiers";
import { type ApplicationAddress, addressText } from "./supplier-applications";

export interface FillSuggestion {
  key: string;
  label: string;
  /** What the form has now (null: empty). */
  current: string | null;
  proposed: string;
}

const blank = (s: string | null | undefined) => !s || !s.trim();
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").replace(/\s/g, "").toLowerCase() === (b ?? "").replace(/\s/g, "").toLowerCase();
const billAddress = (r: BillReading): ApplicationAddress | null =>
  r.supplyAddress ? { line1: r.supplyAddress.line1, line2: r.supplyAddress.line2, city: r.supplyAddress.city, county: r.supplyAddress.county, postcode: r.supplyAddress.postcode } : null;
/** The date the bill's readings were taken (the first one that has a date). */
const readingDate = (r: BillReading) => r.readings.find((x) => x.readingDate)?.readingDate ?? null;
const push = (out: FillSuggestion[], key: string, label: string, current: string | null | undefined, proposed: string | null | undefined) => {
  if (!blank(proposed) && !same(current, proposed)) out.push({ key, label, current: blank(current) ? null : current!, proposed: proposed! });
};

// --- Flogas electricity ---------------------------------------------------------------------

type FlogasRegister = "day" | "night" | "wattless";
const flogasRegister = (register: string | null): FlogasRegister => (/wattless|reactive/i.test(register ?? "") ? "wattless" : /night/i.test(register ?? "") ? "night" : "day");

/** The meter row the bill's MPRN belongs on: the row that has it, else the first empty row, else a new row. */
function flogasRow(r: BillReading, d: FlogasElectricityData): number | null {
  const mprn = normalizeIdentifier(r.mprn);
  const same = d.meters.findIndex((m) => mprn && normalizeIdentifier(m.mprn) === mprn);
  if (same >= 0) return same;
  const empty = d.meters.findIndex((m) => !normalizeIdentifier(m.mprn));
  if (empty >= 0) return empty;
  return d.meters.length < FLOGAS_MAX_METERS ? d.meters.length : null;
}

export function flogasFillSuggestions(r: BillReading, d: FlogasElectricityData): FillSuggestion[] {
  const out: FillSuggestion[] = [];
  if (!r.readable) return out;
  if (blank(d.legalName)) push(out, "legalName", "Legal name", d.legalName, r.customerName);
  push(out, "supplyAddress", "Supply address", addressText(d.supplyAddress), addressText(billAddress(r)));
  const row = flogasRow(r, d);
  if (row !== null && r.fuel !== "gas") {
    const m = d.meters[row];
    push(out, "mprn", `MPRN (meter row ${row + 1})`, m?.mprn, normalizeIdentifier(r.mprn));
    r.readings.forEach((x, i) => {
      const reg = flogasRegister(x.register);
      push(out, `reading:${i}`, `${reg === "day" ? "Day / 24-hour" : reg === "night" ? "Night" : "Wattless"} reading (row ${row + 1})`, m?.[reg] == null ? null : String(m[reg]), String(Number(x.value)));
    });
    push(out, "readingDate", "Reading date (saved with any reading you tick)", d.readingDate, readingDate(r));
  }
  if (isFlogasSupplier(r.supplierName)) {
    if (d.existingFlogasCustomer !== true) push(out, "existingFlogas", "Existing Flogas customer", d.existingFlogasCustomer === false ? "No" : null, "Yes");
    push(out, "existingFlogasAccount", "Existing Flogas account number", d.existingFlogasAccount, r.accountNumber);
  }
  return out;
}

/** The partial save for the ticked suggestions (keys from flogasFillSuggestions). */
export function flogasFillSave(r: BillReading, d: FlogasElectricityData, keys: ReadonlySet<string>): FlogasSaveInput {
  const save: FlogasSaveInput = {};
  if (keys.has("legalName") && r.customerName) save.customer = { legalName: r.customerName };
  const address = billAddress(r);
  if (keys.has("supplyAddress") && address) save.supplyAddress = address;
  const row = flogasRow(r, d);
  const readingKeys = r.readings.map((_, i) => `reading:${i}`).filter((k) => keys.has(k));
  if (row !== null && (keys.has("mprn") || readingKeys.length)) {
    const meters = d.meters.map((m) => ({ id: m.id, mprn: m.mprn, mccCode: m.mccCode, day: m.day, night: m.night, wattless: m.wattless }));
    if (row === meters.length) meters.push({ id: null, mprn: null, mccCode: null, day: null, night: null, wattless: null });
    if (keys.has("mprn")) meters[row].mprn = normalizeIdentifier(r.mprn);
    r.readings.forEach((x, i) => {
      if (keys.has(`reading:${i}`)) meters[row][flogasRegister(x.register)] = Number(x.value);
    });
    save.meters = meters;
  }
  // Readings belong to the bill's reading date, so ticking one brings the date with it.
  if (keys.has("readingDate") || readingKeys.length) save.readingDate = readingDate(r);
  if (keys.has("existingFlogas") || keys.has("existingFlogasAccount")) {
    save.answers = {
      ...(keys.has("existingFlogas") ? { existingFlogasCustomer: true } : {}),
      ...(keys.has("existingFlogasAccount") ? { existingFlogasAccount: r.accountNumber } : {}),
    };
  }
  return save;
}

// --- Bord Gáis electricity -----------------------------------------------------------------

const bordGaisRegister = (register: string | null): BordGaisRegister => {
  const r = register ?? "";
  if (/storage/i.test(r)) return "night_storage";
  if (/night/i.test(r)) return "night";
  if (/wattless|reactive/i.test(r)) return "wattless";
  if (/day/i.test(r)) return "day";
  return "24h";
};
/** The reading as the form's boxes take it (up to 5 digits and one decimal), or null when it doesn't fit. */
const bordGaisReading = (value: string) => {
  // Bills print more leading zeroes than the form has boxes for ("045123" → "45123").
  const v = value.trim().replace(/^0+(?=\d{5})/, "");
  return BORD_GAIS_READING.test(v) ? v : null;
};

export function bordGaisFillSuggestions(r: BillReading, d: BordGaisElectricityData): FillSuggestion[] {
  const out: FillSuggestion[] = [];
  if (!r.readable) return out;
  if (blank(d.legalName)) push(out, "legalName", "Legal name", d.legalName, r.customerName);
  push(out, "supplyAddress", "Supply address", addressText(d.supplyAddress), addressText(billAddress(r)));
  if (r.fuel !== "gas") {
    push(out, "mprn", "MPRN", d.mprn, normalizeIdentifier(r.mprn));
    push(out, "mic", "MIC (kVA)", d.mic == null ? null : String(d.mic), r.mic == null ? null : String(r.mic));
    if (r.meterNumber && r.meterNumber.length <= METER_SERIAL_MAX) push(out, "serial", "Meter serial number", d.meters[0].serial, r.meterNumber);
    r.readings.forEach((x, i) => {
      const reg = bordGaisRegister(x.register);
      push(out, `reading:${i}`, `${x.register ?? "Meter"} reading (meter 1)`, d.meters[0].readings[reg], bordGaisReading(x.value));
    });
    push(out, "readingDate", "Reading date (saved with any reading you tick)", d.readingDate, readingDate(r));
  }
  push(out, "existingSupplier", "Current supplier", d.existingSupplier, r.supplierName);
  push(out, "annualConsumption", "Annual consumption (kWh)", d.annualConsumptionKwh == null ? null : String(d.annualConsumptionKwh), r.annualConsumptionKwh == null ? null : String(r.annualConsumptionKwh));
  return out;
}

export function bordGaisFillSave(r: BillReading, d: BordGaisElectricityData, keys: ReadonlySet<string>): BordGaisSaveInput {
  const save: BordGaisSaveInput = {};
  if (keys.has("legalName") && r.customerName) save.customer = { legalName: r.customerName };
  const address = billAddress(r);
  if (keys.has("supplyAddress") && address) save.supplyAddress = address;
  const meter: NonNullable<BordGaisSaveInput["meter"]> = {};
  if (keys.has("mprn")) meter.mprn = normalizeIdentifier(r.mprn);
  if (keys.has("mic")) meter.mic = r.mic;
  if (keys.has("serial")) meter.serial1 = r.meterNumber;
  if (Object.keys(meter).length) save.meter = meter;
  const meter1: Partial<Record<BordGaisRegister, string | null>> = {};
  r.readings.forEach((x, i) => {
    const value = bordGaisReading(x.value);
    if (keys.has(`reading:${i}`) && value) meter1[bordGaisRegister(x.register)] = value;
  });
  // Readings belong to the bill's reading date, so ticking one brings the date with it.
  const withDate = keys.has("readingDate") || Object.keys(meter1).length > 0;
  if (Object.keys(meter1).length || withDate) save.readings = { ...(Object.keys(meter1).length ? { meter1 } : {}), ...(withDate ? { readingDate: readingDate(r) } : {}) };
  if (keys.has("existingSupplier")) save.contract = { existingSupplier: r.supplierName };
  if (keys.has("annualConsumption")) save.site = { annualConsumptionKwh: r.annualConsumptionKwh };
  return save;
}
