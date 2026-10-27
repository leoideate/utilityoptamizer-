/**
 * Reading the master sheet of existing customers (one tab per supplier, one row per signed contract)
 * for the one-off migration (`npm run migrate:customers -w @uo/api`). Pure: the API script does the writes.
 */
import { addDays, addMonths } from "./dates";
import { meterPointErrors, normalizeIdentifier } from "./identifiers";
import { isBordGaisSupplier, BORD_GAIS_SUPPLIER_NAME } from "./bord-gais";
import { supplierKey } from "./supplier-applications";

export const MIGRATION_FIELDS = [
  "signDate",
  "startDate",
  "contractStatus",
  "businessName",
  "tradingName",
  "contactPerson",
  "address",
  "phone",
  "email",
  "meter",
  "utilityType",
  "connectionType",
  "productType",
  "term",
  "salesAgent",
  "contractIssue",
  "expiryDate",
  "emailDate",
  "invoiceIssue",
  "postedBy",
  "reviewer",
  "reviewDate",
  "supplier",
  "phoneIntl",
  "country",
] as const;
export type MigrationField = (typeof MIGRATION_FIELDS)[number];

/** Header spellings, compared lowercase with everything but letters and digits removed. */
const ALIASES: Record<MigrationField, string[]> = {
  signDate: ["contractsigndate", "signdate", "datesigned", "signeddate"],
  startDate: ["contractstartdate", "contractstart", "startdate", "livedate"],
  contractStatus: ["contractstatus", "status"],
  businessName: ["businessname", "company", "companyname", "legalname", "customer", "customername"],
  tradingName: ["tradingname", "tradingas"],
  contactPerson: ["contactperson", "contact", "contactname"],
  address: ["address", "supplyaddress", "siteaddress"],
  phone: ["contactnumber", "phone", "phonenumber", "mobile", "telephone"],
  email: ["email", "emailaddress"],
  meter: ["mprngprn", "mprn", "gprn", "meter", "meternumber"],
  utilityType: ["utilitytype", "utility", "fuel", "service"],
  connectionType: ["connectiontype", "saletype"],
  productType: ["producttype", "product", "tariff", "ratecard"],
  term: ["termyrs", "term", "termyears", "termmonths", "contracttermyears", "contractterm"],
  salesAgent: ["salesagentname", "salesagent", "agent", "salesperson"],
  contractIssue: ["commentcontractissue", "contractissue"],
  expiryDate: ["expiredate", "expirydate", "enddate", "contractenddate"],
  emailDate: ["emaildate"],
  invoiceIssue: ["commentissuesforinvoices", "commentisuuesforinvoices", "invoiceissues", "commentsforinvoices"],
  postedBy: ["postedby"],
  reviewer: ["reviewer", "reviewedby"],
  reviewDate: ["reviewdate"],
  /** A per-row supplier; otherwise the tab's name is the supplier. */
  supplier: ["supplier", "suppliername", "currentsupplier"],
  /** The same number in international format ("Contact number (+353)"); preferred over the local one. */
  phoneIntl: ["contactnumber353", "phone353", "internationalnumber"],
  country: ["country"],
};
const BY_ALIAS = new Map(Object.entries(ALIASES).flatMap(([field, names]) => names.map((n) => [n, field as MigrationField] as const)));

/** The field a header belongs to, or null for columns the import ignores (Month, Year...). */
export function migrationColumn(header: unknown): MigrationField | null {
  return BY_ALIAS.get(String(header ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")) ?? null;
}

export type SheetCell = string | number | boolean | Date | null | undefined;

const text = (v: SheetCell): string | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};

/**
 * A calendar date from a cell: an Excel serial number, a Date, "dd/mm/yyyy" (Irish order) or "yyyy-mm-dd".
 * Returns null for blanks and anything unreadable (`ok: false`).
 */
export function sheetDate(v: SheetCell): { value: string | null; ok: boolean } {
  if (v == null || v === "") return { value: null, ok: true };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { value: null, ok: false } : { value: v.toISOString().slice(0, 10), ok: true };
  const s = String(v).trim();
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    // Excel serials count days from 1899-12-30 (allowing for its 1900 leap-year bug).
    const n = Math.floor(Number(s));
    if (n < 20000 || n > 80000) return { value: null, ok: false };
    return { value: addDays("1899-12-30", n), ok: true };
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  return { value: null, ok: false };
}

function valid(y: number, mo: number, d: number) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { value: null, ok: false };
  return { value: dt.toISOString().slice(0, 10), ok: true };
}

/** Term in months from "2", "2 yrs", "1.5" (years) or "18 months". */
export function sheetTermMonths(v: SheetCell): number | null {
  const s = text(v);
  if (!s) return null;
  const n = Number(/(\d+(?:\.\d+)?)/.exec(s)?.[1]);
  if (!n) return null;
  return Math.round(/m(on)?th|mo\b|mths?/i.test(s) ? n : n * 12);
}

export const IRISH_COUNTIES = [
  "Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick",
  "Longford", "Louth", "Mayo", "Meath", "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow",
] as const;

const EIRCODE = /\b([AC-FHKNPRTV-Y]\d{2}|D6W)\s?([0-9AC-FHKNPRTV-Y]{4})\b/i;

export interface SheetAddress {
  line1: string;
  line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
}

/** Splits a one-line address ("Unit 4, Main St, Naas, Co. Kildare, W91 X2Y3") into its parts. */
export function parseSheetAddress(raw: SheetCell): SheetAddress | null {
  let s = text(raw);
  if (!s) return null;
  let postcode: string | null = null;
  const e = EIRCODE.exec(s);
  if (e) {
    postcode = `${e[1]} ${e[2]}`.toUpperCase();
    s = s.replace(e[0], "");
  }
  const parts = s.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
  let county: string | null = null;
  const last = parts.at(-1);
  if (last) {
    const c = /^(?:co\.?|county)\s+(.+)$/i.exec(last)?.[1] ?? last;
    const hit = IRISH_COUNTIES.find((x) => x.toLowerCase() === c.toLowerCase());
    if (hit && (parts.length > 1 || c !== last)) {
      county = hit;
      parts.pop();
    }
  }
  if (!parts.length) return { line1: county ?? postcode ?? "", line2: null, city: null, county, postcode };
  if (parts.length === 1) return { line1: parts[0], line2: null, city: null, county, postcode };
  const city = parts.length > 2 || county ? parts.pop()! : null;
  return { line1: parts[0], line2: parts.slice(1).join(", ") || null, city, county, postcode };
}

/** A phone number as text. Excel keeps numbers as numbers and drops the leading 0 ("871234567"). */
export function sheetPhone(v: SheetCell): string | null {
  if (typeof v === "number") {
    const d = String(Math.round(v));
    return d.length === 9 ? `0${d}` : d;
  }
  return text(v);
}

export interface SheetSupplier {
  /** The CRM supplier name to look up ("Bord Gáis Energy" for "Bord Gais"). */
  name: string;
  kind: "energy" | "merchant";
}

/**
 * The supplier a tab (or a row's Supplier cell) names, with the known Bord Gáis spellings normalised
 * and list words dropped ("Flogas Customers" is Flogas).
 */
export function supplierFromTab(tab: string): SheetSupplier {
  const name = tab.replace(/\b(customers?|list|sheet|accounts?|contracts?)\b/gi, "").replace(/\s+/g, " ").trim() || tab.trim();
  if (/worldpay/i.test(name)) return { name: "Worldpay", kind: "merchant" };
  if (isBordGaisSupplier(name)) return { name: BORD_GAIS_SUPPLIER_NAME, kind: "energy" };
  return { name, kind: "energy" };
}

/** Same supplier, ignoring case, accents, spaces and punctuation. */
export const sameSupplier = (a: string, b: string) => supplierKey(a) === supplierKey(b) || (isBordGaisSupplier(a) && isBordGaisSupplier(b));

/** Statuses that mean the contract never went ahead; those rows are imported as lost deals, so the history is kept. */
const NOT_LIVE = /cancel|reject|declin|withdraw|lost|void|terminat|not proceed|duplicate|error/i;
/** Statuses for a contract that went live but has since ended (commission clawed back). */
const ENDED = /clawback|claw back|clawed/i;

export interface MigrationRow {
  tab: string;
  line: number;
  supplier: SheetSupplier;
  serviceType: "electricity" | "gas" | "merchant_services";
  fuel: "electricity" | "gas" | null;
  legalName: string;
  tradingName: string | null;
  contactName: string | null;
  address: SheetAddress | null;
  phone: string | null;
  email: string | null;
  mprn: string | null;
  gprn: string | null;
  formatExceptionReason: string | null;
  saleType: "new_sale" | "renewal";
  product: string | null;
  termMonths: number | null;
  signDate: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Won for a contract that went live; lost when the sheet says it never went ahead (Rejected, Cancel...). */
  outcome: "won" | "lost";
  /** Ended when the expiry date has passed, or the status says it ended (clawback); cancelled for a lost deal. */
  contractStatus: "live" | "ended" | "cancelled";
  /** The sheet's own status ("Accepted", "Clawback"...), shown on the deal as its application status. */
  sheetStatus: string | null;
  /** ISO country code of the supply site. */
  country: string;
  /** The meter number is missing, not in the standard format, or its fuel was guessed: an administrator gets a task to fix it. Never set on lost deals. */
  meterCheck: "missing" | "format" | "fuel" | null;
  salesAgent: string | null;
  /** The sheet's columns the CRM has no field for, as label/value pairs for the timeline. */
  notes: { label: string; value: string }[];
  /** Identifies the row across runs, so importing twice creates nothing new. */
  importKey: string;
}

export interface ParsedSheetRow {
  row: MigrationRow | null;
  /** Why the row can't be imported. */
  issues: string[];
  /** Imported, but worth a look. */
  warnings: string[];
}

export const FORMAT_EXCEPTION_REASON = "Imported from the master sheet; format not verified.";

const NOTE_LABELS: [MigrationField, string][] = [
  ["contractStatus", "Contract status"],
  ["signDate", "Contract sign date"],
  ["connectionType", "Connection type"],
  ["contractIssue", "Contract issue"],
  ["emailDate", "Email date"],
  ["invoiceIssue", "Issues for invoices"],
  ["postedBy", "Posted by"],
  ["reviewer", "Reviewer"],
  ["reviewDate", "Review date"],
];
const DATE_FIELDS = new Set<MigrationField>(["signDate", "startDate", "expiryDate", "emailDate", "reviewDate"]);

/**
 * Checks and converts one sheet row. `today` is the business date (Europe/Dublin);
 * `allowFormatExceptions` imports meter numbers in a non-standard format with a recorded reason.
 */
export function parseSheetRow(
  tab: string,
  line: number,
  cells: Partial<Record<MigrationField, SheetCell>>,
  opts: { today: string; allowFormatExceptions?: boolean },
): ParsedSheetRow {
  const issues: string[] = [];
  const warnings: string[] = [];
  const supplier = supplierFromTab(text(cells.supplier) ?? tab);
  const dates: Partial<Record<MigrationField, string | null>> = {};
  for (const f of DATE_FIELDS) {
    const d = sheetDate(cells[f]);
    if (!d.ok) warnings.push(`Couldn't read the ${f === "expiryDate" ? "expiry" : f.replace(/Date$/, "")} date "${text(cells[f])}"; left blank.`);
    dates[f] = d.value;
  }

  const legalName = text(cells.businessName) ?? text(cells.tradingName) ?? text(cells.contactPerson);
  if (!legalName) issues.push("No business name, trading name or contact person.");
  const statusText = text(cells.contractStatus);
  const lost = !!statusText && NOT_LIVE.test(statusText);
  if (lost) warnings.push(`Status is "${statusText}", so it's imported as a lost deal, not a live contract.`);

  // Fuel from the utility type, or else from the meter number's shape.
  const meter = normalizeIdentifier(text(cells.meter)?.replace(/\.0+$/, "") ?? null);
  const utility = (text(cells.utilityType) ?? "").toLowerCase();
  let fuel: MigrationRow["fuel"] = null;
  let fuelGuessed = false;
  if (supplier.kind === "energy") {
    if (/dual/.test(utility)) issues.push("Dual fuel rows need splitting: one row per MPRN or GPRN.");
    else if (/gas/.test(utility)) fuel = "gas";
    else if (/elec|power/.test(utility)) fuel = "electricity";
    else if (meter && /^\d{11}$/.test(meter)) fuel = "electricity";
    else if (meter && /^\d{7}$/.test(meter)) fuel = "gas";
    else {
      // Nothing says which fuel: take the nearer meter shape (a GPRN is 7 digits, an MPRN 11) and have it checked.
      fuel = meter && meter.replace(/\D/g, "").length <= 8 ? "gas" : "electricity";
      fuelGuessed = true;
      warnings.push(`${utility ? `Utility type "${text(cells.utilityType)}" isn't Gas or Electricity` : "No utility type"}; imported as ${fuel}${meter ? " from the meter number's length" : ""}, with a task for an administrator to check it.`);
    }
    if (!meter) warnings.push(`No ${fuel === "gas" ? "GPRN" : "MPRN"}; imported with a task for an administrator to add it.`);
  }
  let mprn: string | null = null;
  let gprn: string | null = null;
  let formatExceptionReason: string | null = null;
  if (fuel && meter) {
    if (fuel === "electricity") mprn = meter;
    else gprn = meter;
    const errors = meterPointErrors({ fuel, mprn, gprn });
    if (errors.length && opts.allowFormatExceptions) {
      formatExceptionReason = FORMAT_EXCEPTION_REASON;
      warnings.push(`${errors.join(" ")} Imported with a format exception and a task for an administrator to check it.`);
    } else issues.push(...errors);
  }

  const termMonths = sheetTermMonths(cells.term);
  if (text(cells.term) && !termMonths) warnings.push(`Couldn't read the term "${text(cells.term)}".`);
  const startDate = dates.startDate ?? null;
  const endDate = dates.expiryDate ?? (startDate && termMonths ? addDays(addMonths(startDate, termMonths), -1) : null);
  if (supplier.kind === "energy" && !endDate) warnings.push("No expiry date (or start date and term), so no renewal will be scheduled.");

  const notes = NOTE_LABELS.flatMap(([f, label]) => {
    const value = DATE_FIELDS.has(f) ? (dates[f] ?? null) : text(cells[f]);
    return value ? [{ label, value }] : [];
  });

  if (issues.length || !legalName) return { row: null, issues, warnings };
  const connection = (text(cells.connectionType) ?? "").toLowerCase();
  const who = (mprn ?? gprn ?? legalName.toLowerCase().replace(/[^a-z0-9]/g, "")) || "row";
  return {
    issues,
    warnings,
    row: {
      tab,
      line,
      supplier,
      serviceType: supplier.kind === "merchant" ? "merchant_services" : fuel!,
      fuel: supplier.kind === "merchant" ? null : fuel,
      legalName,
      tradingName: text(cells.tradingName),
      contactName: text(cells.contactPerson),
      address: parseSheetAddress(cells.address),
      phone: sheetPhone(cells.phoneIntl) ?? sheetPhone(cells.phone),
      email: text(cells.email)?.toLowerCase() ?? null,
      mprn,
      gprn,
      formatExceptionReason,
      saleType: /renew/.test(connection) ? "renewal" : "new_sale",
      product: text(cells.productType),
      termMonths,
      signDate: dates.signDate ?? null,
      startDate,
      endDate,
      outcome: lost ? "lost" : "won",
      contractStatus: lost ? "cancelled" : (endDate && endDate < opts.today) || (statusText && ENDED.test(statusText)) ? "ended" : "live",
      sheetStatus: statusText,
      meterCheck: supplier.kind !== "energy" || lost ? null : !meter ? "missing" : formatExceptionReason ? "format" : fuelGuessed ? "fuel" : null,
      // The sites are Irish; only a sheet that says Northern Ireland or the UK changes that.
      country: /^(northern ireland|ni|uk|united kingdom|gb)$/i.test(text(cells.country) ?? "") ? "GB" : "IE",
      salesAgent: text(cells.salesAgent),
      notes,
      // A lost row is a separate record from a live row for the same meter and dates.
      importKey: `sheet:${supplierKey(supplier.name)}:${who}:${startDate ?? dates.signDate ?? endDate ?? ""}${lost ? `:lost:${statusText!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}`,
    },
  };
}
