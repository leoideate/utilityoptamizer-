/**
 * The Flogas electricity application: the Commercial Agreement Form and its SEPA direct debit
 * mandate. Most of what the form asks for lives on CRM records (customer, contact, supply site,
 * meters, contract, bank account); `flogasAnswersSchema` holds only what has no other home.
 * See docs/flogas-electricity.md.
 */
import { z } from "zod";
import { today } from "./dates";
import { LEGAL_ENTITIES, OCCUPANCY_TYPES, PRICE_TYPES, type LegalEntity, type OccupancyType, type PriceType, type ProductInterest, type SaleType, type ServiceType, type SupplyChange, isEnergyService } from "./enums";
import type { FormSignerRole } from "./forms";
import { mprnFormatError, normalizeIdentifier } from "./identifiers";
import { APPLICATION_STATUSES, applicationGenerateSchema, APPLICATION_STATUS_LABELS, type ApplicationAddress, type ApplicationStatus, EMPTY_ADDRESS, applicationStatus } from "./supplier-applications";

const labels = <T extends string>(m: Record<T, string>) => m;


/** "Flogas" however it's spaced or capitalised ("FloGas", "Flogas Natural Gas"). */
export const isFlogasSupplier = (name: string | null | undefined) => !!name && name.toLowerCase().replace(/[^a-z]/g, "").startsWith("flogas");

/** The Flogas electricity application applies: Electricity is a product of interest and Flogas is the selected supplier. */
export function flogasElectricityApplies(o: { productInterest: readonly ProductInterest[]; serviceType: ServiceType; supplierName: string | null | undefined }): boolean {
  return isEnergyService(o.serviceType) && o.productInterest.includes("electricity") && isFlogasSupplier(o.supplierName);
}

export const FLOGAS_REQUIREMENTS = ["new_connection", "change_of_legal_entity", "renewal", "reenergise_meter", "change_of_supplier"] as const;
export type FlogasRequirement = (typeof FLOGAS_REQUIREMENTS)[number];
export const FLOGAS_REQUIREMENT_LABELS = labels<FlogasRequirement>({
  new_connection: "New connection",
  change_of_legal_entity: "Change of legal entity (C.O.L.E.)",
  renewal: "Renewal",
  reenergise_meter: "Re-energise meter",
  change_of_supplier: "Change of supplier",
});

export const FLOGAS_SECTORS = ["gp_24h", "gp_night_saver", "lvmd"] as const;
export type FlogasSector = (typeof FLOGAS_SECTORS)[number];
export const FLOGAS_SECTOR_LABELS = labels<FlogasSector>({ gp_24h: "GP 24HR", gp_night_saver: "GP Night Saver", lvmd: "LVMD" });

/** Rows in the MPRN/MCC table on page 2 of the form. */
export const FLOGAS_MAX_METERS = 12;

/** The legal entity box the form ticks for each CRM legal entity. */
export type FlogasEntityBox = "company" | "sole_trader" | "other";
export const FLOGAS_ENTITY_BOX_LABELS = labels<FlogasEntityBox>({ company: "Company", sole_trader: "Sole trader", other: "Other" });
export function flogasEntityBox(e: LegalEntity | null | undefined): FlogasEntityBox | null {
  if (!e) return null;
  if (e === "limited_company" || e === "plc") return "company";
  return e === "sole_trader" ? "sole_trader" : "other";
}

/** "Do you own the supply premises": owner-occupied is yes, rented or a landlord's supply is no. */
export function ownsPremises(o: OccupancyType | null | undefined): boolean | null {
  if (o === "owner_occupied") return true;
  return o === "rented" || o === "landlord_supply" ? false : null;
}

/** Fixed or fully fixed prints as Fixed. */
export const isFixedPrice = (p: PriceType | null | undefined) => (p ? p !== "variable" : null);

/** Whole years and remaining months at the premises, from the moved-in date. */
export function durationAtPremises(occupiedSince: string | null | undefined, asOf = today()): { years: number; months: number } | null {
  if (!occupiedSince) return null;
  const [y0, m0, d0] = occupiedSince.split("-").map(Number);
  const [y1, m1, d1] = asOf.split("-").map(Number);
  const months = Math.max(0, (y1 - y0) * 12 + (m1 - m0) - (d1 < d0 ? 1 : 0));
  return { years: Math.floor(months / 12), months: months % 12 };
}

/** Requirement ticks suggested by the opportunity before anyone answers them. */
export function flogasDefaultRequirements(o: { supplyChanges: readonly SupplyChange[]; saleType: SaleType; newSupplyPoint: boolean }): FlogasRequirement[] {
  const out: FlogasRequirement[] = [];
  if (o.newSupplyPoint) out.push("new_connection");
  if (o.supplyChanges.includes("change_of_legal_entity")) out.push("change_of_legal_entity");
  if (o.saleType === "renewal") out.push("renewal");
  if (o.supplyChanges.includes("reenergise_meter")) out.push("reenergise_meter");
  if (o.supplyChanges.includes("change_of_supplier")) out.push("change_of_supplier");
  return out;
}

// --- Schemas ------------------------------------------------------------------------

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
/** Cent per kWh, as printed on the form; stored in euro to four decimals. */
const centRate = (label: string) =>
  z
    .number({ invalid_type_error: `${label} must be a number.` })
    .min(0, `${label} can't be negative.`)
    .max(1000, `${label} looks too high: enter cent per kWh.`)
    .refine(twoDecimals, `${label}: use at most 2 decimal places.`)
    .nullable()
    .optional();
const reading = (label: string) =>
  z
    .number({ invalid_type_error: `${label} must be a number.` })
    .min(0, `${label} can't be negative.`)
    .max(999_999_999, `${label} is too large.`)
    .refine(twoDecimals, `${label}: use at most 2 decimal places.`)
    .nullable()
    .optional();

/** Answers that only the Flogas form asks for. Every key is optional: a missing key means "not answered yet". */
export const flogasAnswersSchema = z
  .object({
    requirements: z.array(z.enum(FLOGAS_REQUIREMENTS)).max(FLOGAS_REQUIREMENTS.length),
    billingSameAsSupply: z.boolean(),
    existingFlogasCustomer: z.boolean().nullable(),
    existingFlogasAccount: optText(40),
    sector: z.enum(FLOGAS_SECTORS).nullable(),
    directDebit: z.boolean(),
    debtorAddressSameAsBilling: z.boolean(),
    /** Normally left for Flogas to fill ("for office use only"). */
    mandateReference: optText(35),
    /** A joint bank account's second holder, who also signs the mandate. */
    secondAccountHolder: z.object({ name: optText(120), email: optEmail }).nullable(),
    signatoryName: optText(120),
    signatoryPosition: optText(80),
    /** The current process wants the agent to sign in the agency box too. */
    agentSignature: z.boolean(),
    /** Completed by Flogas; normally blank. */
    flogasRepName: optText(120),
    flogasActivationDate: optDate,
    /** The deal's meter points left off this application (kept on the deal). */
    excludedMeterPointIds: z.array(z.string().uuid()).max(50),
    /** The order of the meter rows (meter point ids); the first is the main supply. */
    meterOrder: z.array(z.string().uuid()).max(50),
  })
  .partial();
export type FlogasAnswers = z.infer<typeof flogasAnswersSchema>;

const addressInput = z.object({ line1: optText(200), line2: optText(200), city: optText(100), county: optText(100), postcode: optText(20) });

export const flogasMeterRowSchema = z.object({
  /** An existing meter point on the deal; omitted for a new row. */
  id: z.string().uuid().nullable().optional(),
  mprn: optText(20),
  mccCode: optText(10),
  /** The 24-hour reading for a GP 24HR meter, otherwise the day reading. */
  day: reading("Day / 24-hour reading"),
  night: reading("Night reading"),
  wattless: reading("Wattless reading"),
});

/**
 * Saving a draft. Each section is optional and only the keys given are written, so a save never
 * overwrites what the user didn't change. `meters`, when given, is the full list of rows.
 */
export const flogasSaveSchema = z.object({
  customer: z
    .object({
      legalName: z.string().trim().min(1, "Enter the legal entity's name.").max(200),
      tradingName: optText(200),
      legalEntity: z.enum(LEGAL_ENTITIES).nullable(),
      vatExempt: z.boolean().nullable(),
      vatExemptNumber: optText(40),
      priorityCustomer: z.boolean().nullable(),
      businessType: optText(100),
      companyRegNumber: optText(30),
      vatNumber: optText(30),
      telephone: optText(40),
    })
    .partial()
    .optional(),
  contact: z.object({ firstName: z.string().trim().min(1, "Enter the contact's first name.").max(100), lastName: optText(100), mobile: optText(40), email: optEmail }).partial().optional(),
  supplyAddress: addressInput.optional(),
  billingAddress: addressInput.optional(),
  premises: z
    .object({ occupancyType: z.enum(OCCUPANCY_TYPES).nullable(), occupiedSince: optDate, leaseTerms: optText(200), landlordName: optText(200), landlordContact: optText(200) })
    .partial()
    .optional(),
  meters: z.array(flogasMeterRowSchema).min(1, "Keep at least one meter row.").max(FLOGAS_MAX_METERS, `The form has room for ${FLOGAS_MAX_METERS} meters.`).optional(),
  readingDate: optDate,
  contract: z
    .object({
      expectedChangeover: optDate,
      termMonths: z.number().int().min(1, "The commitment period must be at least 1 month.").max(120).nullable(),
      priceType: z.enum(PRICE_TYPES).nullable(),
      dayRateCent: centRate("Day rate"),
      nightRateCent: centRate("Night rate"),
    })
    .partial()
    .optional(),
  /** New bank details: stored as a new bank account (the old one is kept). */
  bank: z
    .object({
      accountName: z.string().trim().min(1, "Enter the account holder's name.").max(200),
      iban: z
        .string()
        .transform((v) => v.replace(/\s+/g, "").toUpperCase())
        .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, "Enter a valid IBAN.")),
      bic: optText(11),
    })
    .optional(),
  confirmIbanChange: z.boolean().optional(),
  /** A debtor address different from the billing address (restricted). */
  debtorAddress: addressInput.optional(),
  answers: flogasAnswersSchema.optional(),
});
export type FlogasSaveInput = z.infer<typeof flogasSaveSchema>;

export const flogasGenerateSchema = applicationGenerateSchema;

export const flogasSendSchema = z.object({
  role: z.enum(["customer", "account_holder_2", "broker"]),
  signerName: z.string().trim().min(1, "Enter the signer's name.").max(200),
  email: z.string().trim().toLowerCase().email("Enter the signer's email address."),
});

// --- The assembled application -------------------------------------------------------

export type FlogasAddress = ApplicationAddress;
export const EMPTY_FLOGAS_ADDRESS = EMPTY_ADDRESS;

export interface FlogasMeterRow {
  id: string | null;
  mprn: string | null;
  mccCode: string | null;
  /** The meter point records why its MPRN doesn't follow the standard format. */
  formatException: boolean;
  day: number | null;
  night: number | null;
  wattless: number | null;
}

/** Everything the form shows and prints, assembled from the CRM and the application's answers. */
export interface FlogasElectricityData {
  // Customer & business
  legalName: string | null;
  tradingName: string | null;
  supplyAddress: FlogasAddress;
  billingSameAsSupply: boolean;
  billingAddress: FlogasAddress;
  legalEntity: LegalEntity | null;
  vatExempt: boolean | null;
  vatExemptNumber: string | null;
  priorityCustomer: boolean | null;
  businessType: string | null;
  companyRegNumber: string | null;
  vatNumber: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  telephone: string | null;
  mobile: string | null;
  email: string | null;
  occupancyType: OccupancyType | null;
  occupiedSince: string | null;
  leaseTerms: string | null;
  landlordName: string | null;
  landlordContact: string | null;
  // Supply & meter
  requirements: FlogasRequirement[];
  meters: FlogasMeterRow[];
  readingDate: string | null;
  existingFlogasCustomer: boolean | null;
  existingFlogasAccount: string | null;
  expectedChangeover: string | null;
  termMonths: number | null;
  // Pricing
  sector: FlogasSector | null;
  priceType: PriceType | null;
  dayRateCent: number | null;
  nightRateCent: number | null;
  // Direct debit (iban and bic are null when the viewer can't read bank details)
  directDebit: boolean;
  debtorName: string | null;
  debtorAddressSameAsBilling: boolean;
  debtorAddress: FlogasAddress;
  iban: string | null;
  bic: string | null;
  bankOnFile: boolean;
  ibanLast4: string | null;
  mandateReference: string | null;
  secondAccountHolder: { name: string | null; email: string | null } | null;
  // Signatures
  signatoryName: string | null;
  signatoryPosition: string | null;
  agentSignature: boolean;
  agencyId: string | null;
  agencyName: string | null;
  agentName: string | null;
  flogasRepName: string | null;
  flogasActivationDate: string | null;
}

export const contactFullName = (d: Pick<FlogasElectricityData, "contactFirstName" | "contactLastName">) => [d.contactFirstName, d.contactLastName].filter((x) => x && x.trim()).join(" ") || null;
/** The billing address the bills go to: the supply address when they're the same. */
export const effectiveBillingAddress = (d: Pick<FlogasElectricityData, "billingSameAsSupply" | "billingAddress" | "supplyAddress">) => (d.billingSameAsSupply ? d.supplyAddress : d.billingAddress);
export const effectiveDebtorAddress = (d: Pick<FlogasElectricityData, "debtorAddressSameAsBilling" | "debtorAddress" | "billingSameAsSupply" | "billingAddress" | "supplyAddress">) =>
  d.debtorAddressSameAsBilling ? effectiveBillingAddress(d) : d.debtorAddress;

/** Signers this application needs, in the order they usually sign. */
export function flogasSigners(d: Pick<FlogasElectricityData, "directDebit" | "secondAccountHolder" | "agentSignature">): FormSignerRole[] {
  const out: FormSignerRole[] = ["customer"];
  if (d.directDebit && d.secondAccountHolder) out.push("account_holder_2");
  if (d.agentSignature) out.push("broker");
  return out;
}

// --- Validation ---------------------------------------------------------------------

export const FLOGAS_TABS = ["customer", "supply", "pricing", "debit", "documents"] as const;
export type FlogasTab = (typeof FLOGAS_TABS)[number];
export const FLOGAS_TAB_LABELS = labels<FlogasTab>({ customer: "Customer & Business", supply: "Supply & Meter", pricing: "Pricing & Contract", debit: "Direct Debit", documents: "Signatures & Documents" });

export interface FlogasIssue {
  /** The field the issue belongs to, e.g. "legalName" or "meters.1.mprn". */
  path: string;
  tab: FlogasTab;
  message: string;
}

const TAB_OF: Record<string, FlogasTab> = {
  legalName: "customer",
  supplyAddress: "customer",
  billingAddress: "customer",
  legalEntity: "customer",
  vatExemptNumber: "customer",
  businessType: "customer",
  companyRegNumber: "customer",
  contactName: "customer",
  email: "customer",
  occupancyType: "customer",
  landlordName: "customer",
  landlordContact: "customer",
  requirements: "supply",
  meters: "supply",
  readingDate: "supply",
  sector: "pricing",
  priceType: "pricing",
  dayRateCent: "pricing",
  nightRateCent: "pricing",
  termMonths: "pricing",
  debtorName: "debit",
  debtorAddress: "debit",
  iban: "debit",
  secondAccountHolder: "debit",
  signatoryName: "documents",
  signatoryPosition: "documents",
};
export const flogasTabOf = (path: string): FlogasTab => TAB_OF[path.split(".")[0]] ?? "customer";

const blank = (v: string | null | undefined) => !v || !v.trim();
const validEmail = (v: string) => z.string().email().safeParse(v).success;

/**
 * What still stops this application being sent for signature. The same rules run in the browser
 * (next to each field) and on the server (before generating and before sending).
 */
export function flogasElectricityIssues(d: FlogasElectricityData): FlogasIssue[] {
  const out: FlogasIssue[] = [];
  const add = (path: string, message: string) => out.push({ path, tab: flogasTabOf(path), message });

  // Customer & business
  if (blank(d.legalName)) add("legalName", "Enter the legal entity's name.");
  if (blank(d.supplyAddress.line1) || (blank(d.supplyAddress.city) && blank(d.supplyAddress.county))) add("supplyAddress", "Enter the supply address, with at least the first line and the town or county.");
  if (!d.billingSameAsSupply && blank(d.billingAddress.line1)) add("billingAddress", "Enter the billing address, or tick that it's the same as the supply address.");
  if (!d.legalEntity) add("legalEntity", "Choose the legal entity type.");
  if (d.vatExempt && blank(d.vatExemptNumber)) add("vatExemptNumber", "Enter the VAT exemption number.");
  if (blank(d.businessType)) add("businessType", "Enter the type of business.");
  if (flogasEntityBox(d.legalEntity) === "company" && blank(d.companyRegNumber) && blank(d.vatNumber)) add("companyRegNumber", "Enter the company registration (CRO) or VAT number.");
  if (!contactFullName(d)) add("contactName", "Enter the account contact's name.");
  if (blank(d.email)) add("email", "Enter the account contact's email address.");
  else if (!validEmail(d.email!)) add("email", "Enter a valid email address.");
  const owns = ownsPremises(d.occupancyType);
  if (owns === null) add("occupancyType", "Say whether the customer owns the supply premises.");
  if (owns === false) {
    if (blank(d.landlordName)) add("landlordName", "Enter the landlord or agent's name.");
    if (blank(d.landlordContact)) add("landlordContact", "Enter the landlord or agent's contact number.");
  }

  // Supply & meter
  if (!d.requirements.length) add("requirements", "Tick the actual requirement.");
  if (!d.meters.length) add("meters", "Add the meter point (MPRN).");
  if (d.meters.length > FLOGAS_MAX_METERS) add("meters", `The form has room for ${FLOGAS_MAX_METERS} meters.`);
  const seen = new Set<string>();
  d.meters.forEach((m, i) => {
    const mprn = normalizeIdentifier(m.mprn);
    if (!mprn) add(`meters.${i}.mprn`, i === 0 ? "Enter the MPRN." : `Enter the MPRN for meter row ${i + 1}, or remove the row.`);
    else {
      const e = m.formatException ? null : mprnFormatError(mprn);
      if (e) add(`meters.${i}.mprn`, e);
      if (seen.has(mprn)) add(`meters.${i}.mprn`, `MPRN ${mprn} is already on the form.`);
      seen.add(mprn);
    }
  });
  if (!d.readingDate && d.meters.some((m) => m.day !== null || m.night !== null || m.wattless !== null)) add("readingDate", "Enter the date of the meter reading.");

  // Pricing & contract
  if (!d.sector) add("sector", "Choose the sector.");
  if (d.sector && d.sector !== "lvmd" && !d.priceType) add("priceType", "Choose fixed or variable pricing.");
  if ((d.sector === "gp_24h" || d.sector === "gp_night_saver") && d.dayRateCent === null) add("dayRateCent", d.sector === "gp_24h" ? "Enter the GP 24HR unit day rate." : "Enter the GP Night Saver unit day rate.");
  if (d.sector === "gp_night_saver" && d.nightRateCent === null) add("nightRateCent", "Enter the GP Night Saver unit night rate.");

  // Direct debit
  if (d.directDebit) {
    // The account name and IBAN are hidden from viewers without bank.read; on file counts.
    if (blank(d.debtorName) && !d.bankOnFile) add("debtorName", "Enter the debtor (account holder) name.");
    // When it's the billing address, a missing one is already reported there.
    if (!d.debtorAddressSameAsBilling && blank(d.debtorAddress.line1)) add("debtorAddress", "Enter the debtor's address, or tick that it's the billing address.");
    if (!d.bankOnFile && blank(d.iban)) add("iban", "Enter the IBAN.");
    if (d.secondAccountHolder) {
      if (blank(d.secondAccountHolder.name)) add("secondAccountHolder.name", "Enter the second account holder's name, or remove them.");
      if (blank(d.secondAccountHolder.email)) add("secondAccountHolder.email", "Enter the second account holder's email, so they can sign.");
      else if (!validEmail(d.secondAccountHolder.email!)) add("secondAccountHolder.email", "Enter a valid email address.");
    }
  }

  // Signatures
  if (blank(d.signatoryName)) add("signatoryName", "Enter the name of the person signing for the customer.");
  if (blank(d.signatoryPosition)) add("signatoryPosition", "Enter the signatory's position in the company.");
  return out;
}

// --- Status ---------------------------------------------------------------------------

/** Statuses are shared by every supplier application (see supplier-applications.ts). */
export const FLOGAS_STATUSES = APPLICATION_STATUSES;
export type FlogasStatus = ApplicationStatus;
export const FLOGAS_STATUS_LABELS = APPLICATION_STATUS_LABELS;
export const flogasStatus = applicationStatus;
