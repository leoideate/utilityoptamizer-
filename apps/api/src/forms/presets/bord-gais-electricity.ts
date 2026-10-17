import type { FormField, FormSource } from "@uo/shared";
import { type FormPreset, preset } from "./builder";

const { text, tick, sign, signedDate } = preset("bge");
const U = { upper: true } as const;

/**
 * The rates grid: one row per price type, so each rate is written only in the row for the deal's
 * price type. Block 2 columns stay blank (Bord Gáis fills them for tiered plans).
 */
const RATE_COLUMNS: [string, number, FormSource][] = [
  ["24hr rate", 65, "contract.rate24hCent"],
  ["Day rate", 129, "contract.rateDayCent"],
  ["Night rate", 192, "contract.nightRateCent"],
  ["Night storage rate", 224, "contract.nightStorageRateCent"],
  ["Summer day rate", 256, "contract.summerDayRateCent"],
  ["Winter day rate", 288, "contract.winterDayRateCent"],
  ["Standing charge", 319, "contract.standingChargeCent"],
];
const RATE_ROWS: [string, number, string][] = [
  ["energy rate", 325, "fixed"],
  ["fully fixed rate", 291, "fully_fixed"],
  ["variable rate", 274, "variable"],
];
const rateGrid = (): FormField[] =>
  RATE_ROWS.flatMap(([row, y, priceType]) =>
    RATE_COLUMNS.map(([column, x, source]) => text(`${column}: ${row}`, 0, x, y, 30, 15, source, { onlyIf: { source: "contract.priceType", equals: priceType } })),
  );

/** Bord Gáis Energy "Business Electricity Customer Agreement Form", fixed and variable product, single site (BGE/BE/CAF/FVS/0618). 595 × 842 pt, 1 page. */
export const BORD_GAIS_ELECTRICITY_CAF: FormPreset = {
  key: "bord-gais-electricity-caf",
  name: "Bord Gáis electricity: Customer Agreement Form",
  supplier: "Bord Gáis Energy",
  documentType: "application_form",
  sha256: "7ae07d501d0413ab6c9474aa0549bac2dafff7c0ab8149e7f4619863443a404c",
  fields: [
    // Step 1: account holder
    text("Legal name", 0, 72, 756, 216, 13, "customer.legalName"),
    text("Trading as", 0, 117, 743, 171, 13, "customer.tradingName"),
    text("Account holder's name", 0, 119, 729, 169, 13, "customer.legalName"),
    text("Account holder's address", 0, 72, 717, 216, 13, "billing.full"),
    text("Main activity", 0, 82, 704, 81, 13, "customer.businessType"),
    text("Date established", 0, 232, 705, 56, 10, "customer.dateEstablished"),
    tick("Limited Co.", 0, 86, 688, 14, 13, "customer.legalEntity", "limited_company"),
    tick("Plc", 0, 164, 688, 14, 13, "customer.legalEntity", "plc"),
    tick("Association", 0, 164, 671, 14, 13, "customer.legalEntity", "charity_club"),
    tick("Sole trader", 0, 86, 652, 14, 13, "customer.legalEntity", "sole_trader"),
    tick("Partnership", 0, 164, 652, 14, 13, "customer.legalEntity", "partnership"),
    text("CRO", 0, 225, 668, 63, 13, "customer.companyRegNumber"),
    text("No. of employees", 0, 255, 652, 33, 13, "customer.employees"),
    text("Home address", 0, 94, 637, 196, 13, "home.full"),
    text("Contact name", 0, 86, 623, 205, 13, "contact.fullName"),
    text("Position", 0, 59, 610, 102, 11, "contact.jobTitle"),
    text("Email", 0, 186, 610, 105, 12, "contact.email"),
    text("Telephone", 0, 66, 597, 94, 12, "contact.phone"),
    text("Mobile", 0, 192, 596, 99, 13, "contact.mobile"),
    // Premises to be supplied
    text("Site name", 0, 355, 749, 216, 13, "site.name"),
    text("Site address", 0, 355, 735, 216, 13, "site.street"),
    text("Site address, line 2", 0, 305, 721, 267, 13, "site.locality"),
    text("Site contact name", 0, 366, 707, 205, 13, "contact.fullName"),
    text("Site telephone", 0, 351, 693, 93, 13, "customer.phone"),
    text("Site email", 0, 330, 680, 115, 13, "contact.email"),
    text("Site mobile", 0, 474, 679, 97, 13, "contact.mobile"),
    // Address to send the bill to
    text("Billing contact name", 0, 362, 653, 209, 13, "contact.fullName"),
    text("Billing address", 0, 355, 639, 216, 13, "billing.street"),
    text("Billing address, line 2", 0, 304, 625, 267, 14, "billing.locality"),
    tick("Priority customer", 0, 381, 592, 18, 18, "customer.priorityCustomer", "true"),
    // Step 2: supply details
    text("MPRN", 0, 45, 533, 240, 20, "site.mprn", { fontSize: 12 }),
    text("MIC", 0, 24, 492, 50, 17, "meter.mic"),
    text("DG code", 0, 77, 492, 50, 17, "meter.dgCode", U),
    text("Voltage", 0, 129, 492, 50, 17, "meter.voltage", U),
    text("MCC", 0, 181, 492, 50, 17, "site.mccCode", U),
    text("Profile class", 0, 234, 492, 50, 17, "meter.profileClass"),
    text("Existing supplier", 0, 91, 477, 195, 13, "contract.existingSupplier"),
    text("Estimated annual consumption (kWh)", 0, 149, 463, 137, 13, "site.annualConsumptionKwh"),
    // Step 3: meter details (meter 1 readings)
    text("Meter serial no. 1", 0, 363, 543, 100, 13, "site.meterNumber", U),
    text("Meter serial no. 2", 0, 470, 543, 100, 13, "meter.serial2", U),
    text("Reading: 24 hour", 0, 363, 527, 72, 13, "reading.24h"),
    text("Reading: day", 0, 363, 511, 72, 13, "reading.day"),
    text("Reading: night", 0, 363, 495, 72, 13, "reading.night"),
    text("Reading: night storage", 0, 363, 479, 72, 13, "reading.nightStorage"),
    text("Reading: wattless", 0, 363, 463, 72, 13, "reading.wattless"),
    // Step 4: agreement period and rates
    text("Price plan name", 0, 100, 430, 125, 12, "contract.pricingPlan"),
    text("Confirmation period end date", 0, 366, 430, 68, 12, "contract.endDate"),
    tick("Fixed energy rate", 0, 526, 433, 9, 9, "contract.priceType", "fixed"),
    tick("Variable rate", 0, 527, 422, 8, 8, "contract.priceType", "variable"),
    tick("Fully fixed rate", 0, 527, 410, 8, 8, "contract.priceType", "fully_fixed"),
    tick("Commitment: 12 months", 0, 173, 409, 18, 18, "contract.termMonths", "12"),
    tick("Commitment: 18 months", 0, 246, 408, 18, 18, "contract.termMonths", "18"),
    tick("Commitment: 24 months", 0, 321, 408, 18, 18, "contract.termMonths", "24"),
    tick("Commitment: 36 months", 0, 396, 408, 18, 18, "contract.termMonths", "36"),
    ...rateGrid(),
    // Customer declaration
    text("Declaration: name", 0, 50, 208, 210, 14, "contact.fullName"),
    sign("Declaration: signature", 0, 290, 208, 163, 14),
    signedDate("Declaration: date", 0, 478, 208, 91, 14),
    // Marketing: these boxes are ticked when the customer does NOT want offers that way
    tick("No marketing by email", 0, 81, 185, 9, 9, "marketing.email", "false"),
    tick("No marketing by post", 0, 151, 185, 9, 9, "marketing.post", "false"),
    tick("No marketing by phone", 0, 285, 185, 9, 9, "marketing.phone", "false"),
    tick("No marketing by SMS", 0, 363, 185, 9, 9, "marketing.sms", "false"),
    text("Agent's name", 0, 463, 168, 108, 18, "broker.name"),
    // SEPA direct debit mandate
    text("IBAN", 0, 55, 63, 315, 14, "bank.iban"),
    text("BIC", 0, 55, 46, 95, 13, "bank.bic"),
    signedDate("Mandate: date", 0, 318, 28, 51, 14),
    text("Bank account holder name", 0, 24, 10, 346, 14, "bank.accountName"),
    sign("Mandate: signature", 0, 423, 66, 150, 17),
    signedDate("Mandate date of signature", 0, 469, 29, 104, 17),
  ],
};
