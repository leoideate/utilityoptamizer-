import { type FormPreset, preset } from "./builder";

const { text, tick, sign, signedDate, mask } = preset("bgg");
/** The scan was filled in by hand: every value area is covered before writing, so old entries never show through. */
const M = { mask: true, upper: true } as const;
const MN = { mask: true } as const;

/**
 * A tick box on the scan: a white square inside the printed box (so an old tick disappears but the
 * box outline stays), then our tick on top.
 */
const box = (label: string, x: number, y: number, size: number, source: Parameters<typeof tick>[6], match?: string, extra: Parameters<typeof tick>[8] = {}) => [
  mask(`${label} (cover)`, 0, x + 1.2, y + 1.2, size - 2.4, size - 2.4),
  tick(label, 0, x, y, size, size, source, match, extra),
];

/**
 * Bord Gáis Energy "Business Gas Customer Agreement Form", fixed and variable product, single site.
 * The supplied PDF is a 512 × 722 pt scan of a completed form; positions come from its OCR text layer
 * and ruled lines, and every handwritten area is masked.
 */
export const BORD_GAIS_GAS_CAF: FormPreset = {
  key: "bord-gais-gas-caf",
  name: "Bord Gáis gas: Customer Agreement Form (scan)",
  supplier: "Bord Gáis Energy",
  documentType: "application_form",
  sha256: "f7dfb7ee38d4c4fa58cbd531cd23c9d68fe8d795bd385d75f0a1a74daf26deb8",
  fields: [
    // Step 1: account holder
    text("Legal name", 0, 63, 637.5, 186, 9, "customer.legalName", M),
    text("Trading as", 0, 101, 627, 148, 9, "customer.tradingName", M),
    text("Account holder's name", 0, 102, 617.2, 147, 9.3, "customer.legalName", M),
    text("Address", 0, 50, 607, 199, 9.5, "billing.full", M),
    text("Main activity", 0, 66, 596.5, 74, 9.5, "customer.businessType", M),
    text("Date established", 0, 199, 596.5, 50, 9.5, "customer.dateEstablished", MN),
    ...box("Limited Co.", 74, 582.5, 11, "customer.legalEntity", "limited_company"),
    ...box("Plc", 139, 582.5, 11, "customer.legalEntity", "plc"),
    ...box("Association", 139, 569, 11, "customer.legalEntity", "charity_club"),
    ...box("Sole trader", 74, 552, 11, "customer.legalEntity", "sole_trader"),
    ...box("Partnership", 139, 552, 11, "customer.legalEntity", "partnership"),
    text("CRO", 0, 171, 568.5, 78, 10, "customer.companyRegNumber", M),
    text("No. of employees", 0, 215, 547.3, 33, 9.5, "customer.employees", MN),
    text("Home address", 0, 72, 538.5, 177, 9.5, "home.full", M),
    text("Contact name", 0, 71, 527.2, 178, 10, "contact.fullName", M),
    text("Position", 0, 50, 516.6, 199, 9.5, "contact.jobTitle", M),
    text("Telephone", 0, 57, 506.3, 82, 9.3, "contact.phone", MN),
    text("Mobile", 0, 165, 506.3, 84, 9.3, "contact.mobile", MN),
    text("Email", 0, 39, 496.3, 100, 9.5, "contact.email", MN),
    mask("Fax (cover)", 0, 155, 496.3, 94, 9.5),
    // Premises to be supplied
    text("Site name", 0, 300, 628.3, 191, 9.5, "site.name", M),
    text("Site address", 0, 292, 618.3, 199, 9.5, "site.street", M),
    text("Site address, line 2", 0, 264, 608, 227, 9.8, "site.locality", M),
    text("Site contact name", 0, 314, 597.7, 177, 9.5, "contact.fullName", M),
    text("Site telephone", 0, 300, 587, 82, 9.6, "customer.phone", MN),
    text("Site mobile", 0, 408, 587, 83, 9.6, "contact.mobile", MN),
    text("Site email", 0, 283, 576.7, 99, 9.5, "contact.email", MN),
    mask("Site fax (cover)", 0, 397, 576.7, 94, 9.5),
    // Address to send the bill to
    text("Billing contact name", 0, 314, 547.3, 177, 9.5, "contact.fullName", M),
    text("Billing address", 0, 292, 536.3, 199, 10, "billing.street", M),
    text("Billing address, line 2", 0, 264, 524.8, 227, 10, "billing.locality", M),
    mask("Billing address, line 3 (cover)", 0, 264, 513.8, 227, 10),
    ...box("Priority customer", 330, 493.5, 20, "customer.priorityCustomer", "true"),
    // Step 2: supply details
    text("GPRN", 0, 54, 457.2, 265, 10, "site.gprn", MN),
    text("Supply point capacity (kWh)", 0, 148, 441.6, 52, 10, "meter.spc", MN),
    text("Annual quantity (kWh)", 0, 279, 441.6, 29, 10, "meter.aq", MN),
    text("Existing Bord Gáis account number(s)", 0, 157, 404, 162, 10, "contract.existingSupplierAccount", { mask: true, onlyIf: { source: "is.existingCustomerOfSupplier", equals: "true" } }),
    text("Existing supplier", 0, 78, 392.7, 241, 9.5, "contract.existingSupplier", M),
    // Step 3: meter details
    text("Meter number", 0, 380, 461.9, 111, 10, "site.meterNumber", M),
    text("Meter reading", 0, 379, 443.1, 112, 10, "reading.gas", MN),
    text("Date of reading", 0, 385, 424.5, 106, 10, "reading.date", MN),
    // Step 4: details of agreement
    text("Price plan name", 0, 21.5, 359.6, 105, 9.5, "contract.pricingPlan", M),
    text("Commitment period end date", 0, 129.5, 359.6, 117, 9.5, "contract.endDate", MN),
    ...box("Variable: 12 months", 61, 334.5, 11, "contract.termMonths", "12", { onlyIf: { source: "contract.priceType", equals: "variable" } }),
    ...box("Variable: 24 months", 116, 334.5, 11, "contract.termMonths", "24", { onlyIf: { source: "contract.priceType", equals: "variable" } }),
    ...box("Variable: 36 months", 190, 334.5, 11, "contract.termMonths", "36", { onlyIf: { source: "contract.priceType", equals: "variable" } }),
    ...box("Fixed: 12 months", 373, 334.5, 11, "contract.termMonths", "12", { onlyIf: { source: "contract.isFixed", equals: "true" } }),
    ...box("Fixed: 24 months", 424, 334.5, 11, "contract.termMonths", "24", { onlyIf: { source: "contract.isFixed", equals: "true" } }),
    // Customer declaration
    text("Declaration: name", 0, 42, 202.8, 178, 10, "contact.fullName", M),
    mask("Declaration: signature (cover)", 0, 249, 202.8, 138, 12),
    sign("Declaration: signature", 0, 249, 202.8, 138, 12),
    mask("Declaration: date (cover)", 0, 408, 202.8, 78, 10),
    signedDate("Declaration: date", 0, 408, 202.8, 78, 10),
    // Marketing: ticked when the customer does NOT want offers that way
    ...box("No marketing by email", 69.4, 183.5, 8.5, "marketing.email", "false"),
    ...box("No marketing by post", 127.7, 183.5, 9, "marketing.post", "false"),
    ...box("No marketing by phone", 241.7, 183.5, 9, "marketing.phone", "false"),
    ...box("No marketing by SMS", 310.1, 183.5, 8.8, "marketing.sms", "false"),
    text("Agent's name", 0, 376, 168.8, 127, 9, "broker.name", M),
    // SEPA direct debit mandate
    mask("Unique mandate reference (cover)", 0, 206, 109, 110, 10),
    text("IBAN", 0, 44, 59, 275, 12, "bank.iban", MN),
    text("BIC", 0, 38, 43, 90, 10, "bank.bic", MN),
    text("Bank account holder name", 0, 20, 11, 215, 14, "bank.accountName", M),
    mask("Mandate: date (cover)", 0, 262, 28, 55, 10),
    signedDate("Mandate: date", 0, 262, 28, 55, 10),
    mask("Mandate: signature (cover)", 0, 358, 67.6, 129, 12),
    sign("Mandate: signature", 0, 358, 67.6, 129, 12),
    mask("Mandate: 2nd signature (cover)", 0, 368, 50.4, 119, 12),
    mask("Mandate date of signature (cover)", 0, 406, 40, 81, 10),
    signedDate("Mandate date of signature", 0, 406, 40, 81, 10),
  ],
};
