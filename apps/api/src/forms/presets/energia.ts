import { type FormPreset, preset } from "./builder";

const { text, tick, sign, signedDate } = preset("en");
const U = { upper: true } as const;
const electricity = { onlyIf: { source: "is.electricity", equals: "true" } } as const;
const gasOnly = { onlyIf: { source: "is.electricity", equals: "false" } } as const;

/** Energia "Energy Supply Contract: Customer Registration Form" (Supply Contract T&Cs May22). 648 × 895 pt; page 1 is the form, pages 2–3 the terms. */
export const ENERGIA_CUSTOMER_REGISTRATION: FormPreset = {
  key: "energia-customer-registration",
  name: "Energia: Customer Registration Form (Supply Contract May22)",
  supplier: "Energia",
  documentType: "application_form",
  sha256: "a42b211ee41fa9e25b693a518403d927c85f38f07b4173f7765ce7983a649c19",
  fields: [
    // Account details
    text("MPRN", 0, 172, 766, 150, 14, "site.mprn", electricity),
    text("GPRN", 0, 172, 766, 150, 14, "site.gprn", gasOnly),
    tick("Existing Energia customer: yes", 0, 183, 744, 19, 19, "is.existingCustomerOfSupplier", "true"),
    tick("Existing Energia customer: no", 0, 218, 748, 19, 16, "is.existingCustomerOfSupplier", "false"),
    // Contact details
    text("Your position", 0, 425, 764, 171, 19, "contact.jobTitle"),
    text("Title", 0, 393, 748, 28, 12, "contact.title"),
    text("First name", 0, 472, 747, 125, 17, "contact.firstName"),
    text("Surname", 0, 425, 728, 172, 20, "contact.lastName"),
    text("Landline", 0, 425, 711, 172, 18, "contact.landline"),
    text("Mobile", 0, 425, 693, 171, 20, "contact.mobile"),
    text("Email address", 0, 426, 676, 170, 19, "contact.email"),
    // Company details
    text("Company name", 0, 165, 655, 152, 18, "customer.legalName"),
    text("Trading as", 0, 166, 639, 149, 19, "customer.tradingName"),
    text("Company registration no.", 0, 165, 621, 69, 19, "customer.companyRegNumber"),
    tick("VAT exempt: yes", 0, 281, 624, 17, 14, "customer.vatExempt", "true"),
    tick("VAT exempt: no", 0, 309, 625, 16, 14, "customer.vatExempt", "false"),
    text("Registered charity no.", 0, 166, 606, 150, 17, "customer.charityNumber"),
    text("Business type", 0, 167, 590, 145, 18, "customer.businessType"),
    tick("Own the supplied premises: yes", 0, 251, 569, 18, 18, "site.ownsPremises", "true"),
    tick("Own the supplied premises: no", 0, 286, 570, 18, 18, "site.ownsPremises", "false"),
    text("Time at this address: years", 0, 172, 554, 61, 19, "site.yearsAtPremises"),
    text("Time at this address: months", 0, 259.5, 556, 20, 10, "site.monthsAtPremises"),
    tick("Priority customer: yes", 0, 127, 534, 18, 18, "customer.priorityCustomer", "true"),
    tick("Priority customer: no", 0, 160, 533, 18, 19, "customer.priorityCustomer", "false"),
    tick("Paperless billing: yes", 0, 527, 543, 18, 18, "customer.paperlessBilling", "true"),
    tick("Paperless billing: no", 0, 567, 542, 18, 18, "customer.paperlessBilling", "false"),
    text("Email address for bills", 0, 361, 513, 229, 21, "contact.email", { onlyIf: { source: "customer.paperlessBilling", equals: "true" } }),
    // Supply and billing addresses
    text("Supply address, line 1", 0, 51, 469, 275, 19, "site.line1", U),
    text("Supply address, line 2", 0, 52, 454, 273, 17, "site.line2", U),
    text("Supply city / town", 0, 132, 436, 193, 19, "site.city", U),
    text("Supply county", 0, 132, 419, 192, 19, "site.county", U),
    text("Billing address, line 1", 0, 342, 468, 257, 18, "billing.line1", U),
    text("Billing address, line 2", 0, 345, 453, 254, 17, "billing.line2", U),
    text("Billing city / town", 0, 428, 436, 170, 17, "billing.city", U),
    text("Billing county", 0, 428, 421, 170, 16, "billing.county", U),
    // Meter readings (first row)
    text("Meter readings: MPRN", 0, 44, 368, 293, 20, "site.mprn", electricity),
    text("Meter readings: GPRN", 0, 44, 368, 293, 20, "site.gprn", gasOnly),
    text("Meter read: 24 hour", 0, 347, 368, 256, 20, "reading.24h"),
    text("Meter read: day", 0, 347, 368, 256, 20, "reading.day"),
    text("Meter read: night", 0, 347, 351, 256, 20, "reading.night"),
    text("Meter read: gas", 0, 347, 368, 256, 20, "reading.gas", gasOnly),
    // SEPA direct debit mandate
    text("IBAN", 0, 300, 276, 282, 18, "bank.iban"),
    text("BIC", 0, 300, 258, 139, 18, "bank.bic"),
    text("Bank account holder's name", 0, 352, 240, 247, 17, "bank.accountName"),
    // Signatures
    sign("Signed by or on behalf of the customer", 0, 163, 148, 169, 22),
    signedDate("Date signed by the customer", 0, 348, 150, 55, 12),
    text("Print name", 0, 162, 129, 169, 17, "contact.fullName", U),
    text("Sales agent", 0, 89, 110, 233, 15, "broker.name"),
    text("Sales agent: date", 0, 350, 110, 55, 12, "today"),
    // Marketing: these boxes are ticked when the customer would NOT like offers that way
    tick("No offers by SMS", 0, 212, 71, 7, 7, "marketing.sms", "false"),
    tick("No offers by telephone", 0, 254, 71, 7, 7, "marketing.phone", "false"),
    tick("No offers by email", 0, 285, 71, 7, 7, "marketing.email", "false"),
  ],
};
