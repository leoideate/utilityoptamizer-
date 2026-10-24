/**
 * The Bord Gáis Energy electricity application: the Business Electricity Customer Agreement Form
 * with its SEPA direct debit mandate. As with Flogas, most of what it asks for lives on CRM records;
 * `bordGaisAnswersSchema` holds only what has no other home. See docs/bord-gais-electricity.md.
 */
import { z } from "zod";
import { addMonths, addDays } from "./dates";
import { LEGAL_ENTITIES, PRICE_TYPES, type LegalEntity, type PriceType, isEnergyService } from "./enums";
import type { FormSignerRole } from "./forms";
import { mprnFormatError, normalizeIdentifier } from "./identifiers";
import { type ApplicationAddress, type ApplicationDeal, supplierKey } from "./supplier-applications";

const labels = <T extends string>(m: Record<T, string>) => m;

export const BORD_GAIS_SUPPLIER_NAME = "Bord Gáis Energy";
/** Spellings found in older data. Only matched (and renamed by a migration); never offered. */
export const BORD_GAIS_ALIASES = ["Bord Gais", "Bord Gais Energy", "Board Gais", "Board Gais Energy", "Bord Gas", "Bord Gas Energy"] as const;
const BORD_GAIS_KEYS = ["bordgais", "boardgais", "bordgas"];

/** "Bord Gáis Energy", or an old spelling of it ("Bord Gais", "Board Gais", "Bord Gas"). */
export const isBordGaisSupplier = (name: string | null | undefined) => {
  const k = supplierKey(name);
  return BORD_GAIS_KEYS.some((alias) => k === alias || k === `${alias}energy`);
};

export function bordGaisElectricityApplies(o: ApplicationDeal): boolean {
  return isEnergyService(o.serviceType) && o.productInterest.includes("electricity") && isBordGaisSupplier(o.supplierName);
}

// --- What the form offers ------------------------------------------------------------

/** The organisation types the form ticks, in its order. "Other" isn't one of them. */
export const BORD_GAIS_ORG_TYPES = ["limited_company", "plc", "state_body", "co_operative", "charity_club", "sole_trader", "partnership"] as const satisfies readonly LegalEntity[];
export type BordGaisOrgType = (typeof BORD_GAIS_ORG_TYPES)[number];
export const BORD_GAIS_ORG_TYPE_LABELS = labels<BordGaisOrgType>({
  limited_company: "Limited Co.",
  plc: "Plc",
  state_body: "State Body",
  co_operative: "Co-operative",
  charity_club: "Association",
  sole_trader: "Sole Trader",
  partnership: "Partnership",
});
export const isBordGaisOrgType = (e: LegalEntity | null | undefined): e is BordGaisOrgType => !!e && (BORD_GAIS_ORG_TYPES as readonly string[]).includes(e);
/** A company needs its CRO number; a sole trader or partnership their home address. */
export const needsCroNumber = (e: LegalEntity | null | undefined) => e === "limited_company" || e === "plc";
export const needsHomeAddress = (e: LegalEntity | null | undefined) => e === "sole_trader" || e === "partnership";

export const BORD_GAIS_COMMITMENTS = [12, 18, 24, 36] as const;

export const BORD_GAIS_RATE_TYPE_LABELS = labels<PriceType>({ fixed: "Fixed Energy Rate", variable: "Variable Rate", fully_fixed: "Fully Fixed Rate" });

export const BORD_GAIS_RATE_COLUMNS = ["rate24h1", "rate24h2", "day1", "day2", "night", "nightStorage", "summerDay", "winterDay", "standingCharge"] as const;
export type BordGaisRateColumn = (typeof BORD_GAIS_RATE_COLUMNS)[number];
export const BORD_GAIS_RATE_COLUMN_LABELS = labels<BordGaisRateColumn>({
  rate24h1: "24hr rate, Block 1",
  rate24h2: "24hr rate, Block 2",
  day1: "Day rate, Block 1",
  day2: "Day rate, Block 2",
  night: "Night rate",
  nightStorage: "Night storage rate",
  summerDay: "Summer day rate",
  winterDay: "Winter day rate",
  standingCharge: "Standing charge",
});
/** Unit rates are cent per kWh; the standing charge is cent per day. */
export const rateUnit = (c: BordGaisRateColumn) => (c === "standingCharge" ? "c/day" : "c/kWh");
export const UNIT_RATE_COLUMNS: BordGaisRateColumn[] = ["rate24h1", "rate24h2", "day1", "day2", "night", "nightStorage", "summerDay", "winterDay"];

export const BORD_GAIS_RATE_ROWS = ["energy", "nonEnergy", "fullyFixed", "variable"] as const;
export type BordGaisRateRow = (typeof BORD_GAIS_RATE_ROWS)[number];
export const BORD_GAIS_RATE_ROW_LABELS = labels<BordGaisRateRow>({ energy: "Energy Rate", nonEnergy: "Non-energy Rate", fullyFixed: "Fully Fixed Rate", variable: "Variable Rate" });
/** The row whose rates the deal's contract holds, for each rate type. */
export const RATE_ROW_FOR: Record<PriceType, BordGaisRateRow> = { fixed: "energy", fully_fixed: "fullyFixed", variable: "variable" };

export type BordGaisRates = Record<BordGaisRateRow, Record<BordGaisRateColumn, number | null>>;
export const emptyRates = (): BordGaisRates =>
  Object.fromEntries(BORD_GAIS_RATE_ROWS.map((r) => [r, Object.fromEntries(BORD_GAIS_RATE_COLUMNS.map((c) => [c, null]))])) as BordGaisRates;

/** Discount cells the form leaves open (a 12-month plan has no year 2 or 3; 24 months no year 3). */
export const BORD_GAIS_DISCOUNT_CELLS = ["y1_12", "y1_24", "y1_36", "y2_24", "y2_36", "y3_36"] as const;
export type BordGaisDiscountCell = (typeof BORD_GAIS_DISCOUNT_CELLS)[number];
export const discountCell = (c: BordGaisDiscountCell) => {
  const [y, m] = c.slice(1).split("_");
  return { year: Number(y), months: Number(m) };
};

export const BORD_GAIS_REGISTERS = ["24h", "day", "night", "night_storage", "wattless"] as const;
export type BordGaisRegister = (typeof BORD_GAIS_REGISTERS)[number];
export const BORD_GAIS_REGISTER_LABELS = labels<BordGaisRegister>({ "24h": "24 hour", day: "Day", night: "Night", night_storage: "Night storage", wattless: "Wattless" });
/** A reading as the form takes it: up to 5 digits, then optionally one digit after the point (the box after "/"). */
export const BORD_GAIS_READING = /^\d{1,5}(\.\d)?$/;
export const METER_SERIAL_MAX = 9;

export const BORD_GAIS_BILLING_SOURCES = ["account_holder", "supply", "separate"] as const;
export type BordGaisBillingSource = (typeof BORD_GAIS_BILLING_SOURCES)[number];
export const BORD_GAIS_BILLING_SOURCE_LABELS = labels<BordGaisBillingSource>({ account_holder: "Same as account-holder address", supply: "Same as supply address", separate: "A different address" });

// --- Schemas --------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.");
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();
const optDate = isoDate.nullable().optional().or(z.literal("").transform(() => null));
const optEmail = z.string().trim().toLowerCase().email("Enter a valid email address.").nullable().optional().or(z.literal("").transform(() => null));
const twoDecimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const rate = z.number({ invalid_type_error: "Rates must be numbers." }).min(0, "Rates can't be negative.").max(1000, "That rate looks too high: enter cent.").refine(twoDecimals, "Use at most 2 decimal places.").nullable();
const percent = z.number({ invalid_type_error: "Discounts must be numbers." }).min(0, "Discounts can't be negative.").max(100, "Discounts are a percentage up to 100.").refine(twoDecimals, "Use at most 2 decimal places.").nullable();
/** Drafts may hold a half-typed reading; the format is checked before sending. */
const readingText = z
  .string()
  .trim()
  .max(8, "A reading has at most 5 digits and one after the point.")
  .regex(/^[0-9.]*$/, "Readings are digits only.")
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();
const readings = z.object(Object.fromEntries(BORD_GAIS_REGISTERS.map((r) => [r, readingText])) as Record<BordGaisRegister, typeof readingText>).partial();

export const bordGaisAnswersSchema = z
  .object({
    accountHolderName: optText(200),
    premisesContact: z.object({ name: optText(200), telephone: optText(40), fax: optText(40), email: optEmail, mobile: optText(40) }).partial(),
    billingContactName: optText(200),
    billingSource: z.enum(BORD_GAIS_BILLING_SOURCES),
    confirmationEndDate: optDate,
    /** Rate cells the contract has no column for: row → column → cent. */
    rates: z.record(z.enum(BORD_GAIS_RATE_ROWS), z.record(z.enum(BORD_GAIS_RATE_COLUMNS), rate)),
    discounts: z.record(z.enum(BORD_GAIS_DISCOUNT_CELLS), percent),
    /** "I would like to receive this": broader marketing is opt-in on the form. */
    broaderMarketing: z.boolean().nullable(),
    signatoryName: optText(200),
    directDebit: z.boolean(),
    /** "To be completed by Bord Gáis Energy": normally blank. */
    mandateReference: optText(35),
    secondAccountHolder: z.object({ name: optText(120), email: optEmail }).nullable(),
  })
  .partial();
export type BordGaisAnswers = z.infer<typeof bordGaisAnswersSchema>;

const address = z.object({ line1: optText(200), line2: optText(200), city: optText(100), county: optText(100), postcode: optText(20) });

/** Saving a draft: each section is optional and only the keys given are written. */
export const bordGaisSaveSchema = z.object({
  customer: z
    .object({
      legalName: z.string().trim().min(1, "Enter the legal name.").max(200),
      tradingName: optText(200),
      legalEntity: z.enum(LEGAL_ENTITIES).nullable(),
      businessType: optText(100),
      incorporationDate: optDate,
      companyRegNumber: optText(30),
      employees: z.number().int().min(0).max(1_000_000).nullable(),
      telephone: optText(40),
      priorityCustomer: z.boolean().nullable(),
      /** True: happy to receive offers that way. The form ticks a box when this is false. */
      marketingEmail: z.boolean().nullable(),
      marketingPost: z.boolean().nullable(),
      marketingPhone: z.boolean().nullable(),
      marketingSms: z.boolean().nullable(),
    })
    .partial()
    .optional(),
  contact: z.object({ firstName: z.string().trim().min(1, "Enter the contact's first name.").max(100), lastName: optText(100), jobTitle: optText(100), email: optEmail, phone: optText(40), mobile: optText(40) }).partial().optional(),
  accountAddress: address.optional(),
  homeAddress: address.optional(),
  billingAddress: address.optional(),
  supplyAddress: address.optional(),
  site: z.object({ siteName: optText(120), annualConsumptionKwh: z.number().min(0, "Consumption can't be negative.").max(1_000_000_000).nullable() }).partial().optional(),
  meter: z
    .object({
      mprn: optText(20),
      mic: z.number().min(0, "MIC can't be negative.").max(100_000).nullable(),
      dgCode: optText(10),
      voltage: optText(20),
      mcc: optText(10),
      profileClass: optText(10),
      serial1: optText(METER_SERIAL_MAX),
      serial2: optText(METER_SERIAL_MAX),
    })
    .partial()
    .optional(),
  readings: z.object({ meter1: readings, meter2: readings, readingDate: optDate }).partial().optional(),
  contract: z
    .object({
      existingSupplier: optText(120),
      pricePlan: optText(120),
      commitmentMonths: z.number().int().min(1).max(120).nullable(),
      rateType: z.enum(PRICE_TYPES).nullable(),
    })
    .partial()
    .optional(),
  /** The whole rate table as shown: the server writes the contract's row to the contract and the rest to the application. */
  rates: z.record(z.enum(BORD_GAIS_RATE_ROWS), z.record(z.enum(BORD_GAIS_RATE_COLUMNS), rate)).optional(),
  bank: z
    .object({
      accountName: z.string().trim().min(1, "Enter the account holder's name.").max(200),
      iban: z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, "Enter a valid IBAN.")),
      bic: z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .pipe(z.string().regex(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/, "Enter a valid BIC (8 or 11 characters).")),
    })
    .optional(),
  confirmIbanChange: z.boolean().optional(),
  answers: bordGaisAnswersSchema.optional(),
});
export type BordGaisSaveInput = z.infer<typeof bordGaisSaveSchema>;

export const bordGaisSendSchema = z.object({
  role: z.enum(["customer", "account_holder_2"]),
  signerName: z.string().trim().min(1, "Enter the signer's name.").max(200),
  email: z.string().trim().toLowerCase().email("Enter the signer's email address."),
});

// --- The assembled application -------------------------------------------------------

export interface BordGaisMeter {
  serial: string | null;
  /** As read, so leading zeroes survive: "01234" or "01234.5". */
  readings: Record<BordGaisRegister, string | null>;
}

export interface BordGaisElectricityData {
  // Account holder
  legalName: string | null;
  tradingName: string | null;
  accountHolderName: string | null;
  accountAddress: ApplicationAddress;
  mainActivity: string | null;
  dateEstablished: string | null;
  organisationType: LegalEntity | null;
  croNumber: string | null;
  employees: number | null;
  homeAddress: ApplicationAddress;
  contactFirstName: string | null;
  contactLastName: string | null;
  position: string | null;
  email: string | null;
  telephone: string | null;
  mobile: string | null;
  // Premises and billing
  siteName: string | null;
  supplyAddress: ApplicationAddress;
  premisesContactName: string | null;
  premisesTelephone: string | null;
  premisesFax: string | null;
  premisesEmail: string | null;
  premisesMobile: string | null;
  priorityCustomer: boolean | null;
  billingContactName: string | null;
  billingSource: BordGaisBillingSource;
  billingAddress: ApplicationAddress;
  // Supply and meters
  mprn: string | null;
  mprnFormatException: boolean;
  mic: number | null;
  dgCode: string | null;
  voltage: string | null;
  mcc: string | null;
  profileClass: string | null;
  existingSupplier: string | null;
  annualConsumptionKwh: number | null;
  meters: [BordGaisMeter, BordGaisMeter];
  readingDate: string | null;
  // Agreement and rates
  pricePlan: string | null;
  /** The contract's expected start, for the calculated confirmation period end date. */
  startDate: string | null;
  confirmationEndDate: string | null;
  commitmentMonths: number | null;
  rateType: PriceType | null;
  rates: BordGaisRates;
  discounts: Record<BordGaisDiscountCell, number | null>;
  // Declaration and marketing
  signatoryName: string | null;
  /** True: happy to receive offers that way; false: the form's "do not want" box is ticked. */
  marketing: { email: boolean | null; post: boolean | null; phone: boolean | null; sms: boolean | null };
  broaderMarketing: boolean | null;
  agentName: string | null;
  // Direct debit (restricted values are null when the viewer can't read bank details)
  directDebit: boolean;
  mandateReference: string | null;
  bankAccountName: string | null;
  iban: string | null;
  bic: string | null;
  bankOnFile: boolean;
  bicOnFile: boolean;
  ibanLast4: string | null;
  secondAccountHolder: { name: string | null; email: string | null } | null;
}

export const bordGaisContactName = (d: Pick<BordGaisElectricityData, "contactFirstName" | "contactLastName">) =>
  [d.contactFirstName, d.contactLastName].filter((x) => x && x.trim()).join(" ") || null;

/** Where the bill goes, as the form prints it. */
export function bordGaisBillingAddress(d: Pick<BordGaisElectricityData, "billingSource" | "accountAddress" | "supplyAddress" | "billingAddress">): ApplicationAddress {
  return d.billingSource === "account_holder" ? d.accountAddress : d.billingSource === "supply" ? d.supplyAddress : d.billingAddress;
}

/** The confirmation period end date: as given, else the day before the commitment period runs out. */
export function bordGaisConfirmationEnd(d: Pick<BordGaisElectricityData, "confirmationEndDate" | "startDate" | "commitmentMonths">): string | null {
  if (d.confirmationEndDate) return d.confirmationEndDate;
  return d.startDate && d.commitmentMonths ? addDays(addMonths(d.startDate, d.commitmentMonths), -1) : null;
}

/** Splits a reading into the five boxes before the slash and the one after it. */
export function splitReading(v: string | null | undefined): { whole: string; tenth: string } | null {
  if (!v || !BORD_GAIS_READING.test(v)) return null;
  const [whole, tenth = ""] = v.split(".");
  return { whole, tenth };
}

export function bordGaisSigners(d: Pick<BordGaisElectricityData, "directDebit" | "secondAccountHolder">): FormSignerRole[] {
  return d.directDebit && d.secondAccountHolder ? ["customer", "account_holder_2"] : ["customer"];
}

// --- Validation ---------------------------------------------------------------------

export const BORD_GAIS_TABS = ["account", "premises", "supply", "agreement", "declaration", "debit", "documents"] as const;
export type BordGaisTab = (typeof BORD_GAIS_TABS)[number];
export const BORD_GAIS_TAB_LABELS = labels<BordGaisTab>({
  account: "Account Holder",
  premises: "Premises and Billing",
  supply: "Supply and Meters",
  agreement: "Agreement and Rates",
  declaration: "Declaration and Marketing",
  debit: "SEPA Direct Debit",
  documents: "Signatures and Documents",
});

export interface BordGaisIssue {
  path: string;
  tab: BordGaisTab;
  message: string;
}

const TAB_OF: Record<string, BordGaisTab> = {
  legalName: "account",
  accountAddress: "account",
  organisationType: "account",
  croNumber: "account",
  homeAddress: "account",
  contactName: "account",
  email: "account",
  supplyAddress: "premises",
  billingAddress: "premises",
  mprn: "supply",
  meters: "supply",
  readingDate: "supply",
  existingSupplier: "supply",
  annualConsumptionKwh: "supply",
  pricePlan: "agreement",
  commitmentMonths: "agreement",
  rateType: "agreement",
  rates: "agreement",
  signatoryName: "declaration",
  marketing: "declaration",
  iban: "debit",
  bic: "debit",
  bankAccountName: "debit",
  secondAccountHolder: "debit",
};
export const bordGaisTabOf = (path: string): BordGaisTab => TAB_OF[path.split(".")[0]] ?? "account";

const blank = (v: string | null | undefined) => !v || !v.trim();
const validEmail = (v: string) => z.string().email().safeParse(v).success;

/** What still stops this application being generated and sent for signature. */
export function bordGaisElectricityIssues(d: BordGaisElectricityData): BordGaisIssue[] {
  const out: BordGaisIssue[] = [];
  const add = (path: string, message: string) => out.push({ path, tab: bordGaisTabOf(path), message });

  // Account holder
  if (blank(d.legalName)) add("legalName", "Enter the legal name.");
  if (blank(d.accountAddress.line1)) add("accountAddress", "Enter the account holder's address.");
  if (!d.organisationType) add("organisationType", "Choose the organisation type.");
  else if (!isBordGaisOrgType(d.organisationType)) add("organisationType", "Bord Gáis needs one of the organisation types on its form.");
  if (needsCroNumber(d.organisationType) && blank(d.croNumber)) add("croNumber", "Enter the CRO number.");
  if (needsHomeAddress(d.organisationType) && blank(d.homeAddress.line1)) add("homeAddress", "Enter the home address (needed for a sole trader or partnership).");
  if (!bordGaisContactName(d)) add("contactName", "Enter the contact name.");
  if (blank(d.email) && blank(d.telephone)) add("email", "Enter the contact's email or telephone.");
  else if (!blank(d.email) && !validEmail(d.email!)) add("email", "Enter a valid email address.");

  // Premises and billing
  if (blank(d.supplyAddress.line1) || (blank(d.supplyAddress.city) && blank(d.supplyAddress.county))) add("supplyAddress", "Enter the supply address, with at least the first line and the town or county.");
  if (d.billingSource === "separate" && blank(d.billingAddress.line1)) add("billingAddress", "Enter the address to send the bill to, or choose one of the other addresses.");

  // Supply and meters
  const mprn = normalizeIdentifier(d.mprn);
  if (!mprn) add("mprn", "Enter the MPRN.");
  else if (!d.mprnFormatException && mprnFormatError(mprn)) add("mprn", mprnFormatError(mprn)!);
  else if (mprn.length > 11) add("mprn", "The form has room for 11 MPRN digits.");
  d.meters.forEach((m, i) => {
    const hasReading = BORD_GAIS_REGISTERS.some((r) => m.readings[r]);
    if (i === 0 && blank(m.serial)) add("meters.0.serial", "Enter meter serial number 1.");
    if (i === 1 && hasReading && blank(m.serial)) add("meters.1.serial", "Enter meter serial number 2, or remove its readings.");
    if (m.serial && m.serial.length > METER_SERIAL_MAX) add(`meters.${i}.serial`, `The form has room for ${METER_SERIAL_MAX} characters in a meter serial number.`);
    for (const r of BORD_GAIS_REGISTERS) {
      const v = m.readings[r];
      if (v && !BORD_GAIS_READING.test(v)) add(`meters.${i}.readings.${r}`, `${BORD_GAIS_REGISTER_LABELS[r]} reading: up to 5 digits, then optionally one digit after the point.`);
    }
  });
  if (!d.readingDate && d.meters.some((m) => BORD_GAIS_REGISTERS.some((r) => m.readings[r]))) add("readingDate", "Enter the date of the meter readings.");
  if (blank(d.existingSupplier)) add("existingSupplier", "Enter the existing supplier.");
  if (d.annualConsumptionKwh === null) add("annualConsumptionKwh", "Enter the estimated annual consumption.");

  // Agreement and rates
  if (blank(d.pricePlan)) add("pricePlan", "Enter the price plan name.");
  if (!d.commitmentMonths) add("commitmentMonths", "Choose the commitment period.");
  else if (!(BORD_GAIS_COMMITMENTS as readonly number[]).includes(d.commitmentMonths)) add("commitmentMonths", "Bord Gáis offers a commitment period of 12, 18, 24 or 36 months.");
  if (!d.rateType) add("rateType", "Choose the rate type.");
  else {
    const rows: BordGaisRateRow[] = d.rateType === "fixed" ? ["energy", "nonEnergy"] : [RATE_ROW_FOR[d.rateType]];
    if (!rows.some((r) => UNIT_RATE_COLUMNS.some((c) => d.rates[r][c] !== null))) add("rates", `Enter at least one unit rate in the ${rows.map((r) => BORD_GAIS_RATE_ROW_LABELS[r]).join(" or ")} row.`);
  }

  // Declaration and marketing
  if (blank(d.signatoryName)) add("signatoryName", "Enter the name of the person signing for the customer.");
  if (Object.values(d.marketing).some((v) => v === null)) add("marketing", "Record the customer's marketing preferences for email, post, phone and SMS.");

  // Direct debit
  if (d.directDebit) {
    if (!d.bankOnFile && blank(d.iban)) add("iban", "Enter the IBAN.");
    if (!d.bicOnFile && blank(d.bic)) add("bic", "Enter the BIC.");
    if (!d.bankOnFile && blank(d.bankAccountName)) add("bankAccountName", "Enter the bank account holder's name.");
    if (d.secondAccountHolder) {
      if (blank(d.secondAccountHolder.name)) add("secondAccountHolder.name", "Enter the second account holder's name, or remove them.");
      if (blank(d.secondAccountHolder.email)) add("secondAccountHolder.email", "Enter the second account holder's email, so they can sign.");
      else if (!validEmail(d.secondAccountHolder.email!)) add("secondAccountHolder.email", "Enter a valid email address.");
    }
  }
  return out;
}
