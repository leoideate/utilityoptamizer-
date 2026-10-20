/**
 * Supplier PDF forms: templates with positioned fields, the CRM values each field can be
 * filled from, uploaded signatures and the previous-supplier bill check for a switch.
 */
import { z } from "zod";

const labels = <T extends string>(m: Record<T, string>) => m;

export const FORM_FIELD_KINDS = ["text", "check", "signature", "signed_date"] as const;
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];
export const FORM_FIELD_KIND_LABELS = labels<FormFieldKind>({ text: "Text", check: "Tick box", signature: "Signature", signed_date: "Date signed" });

/** Who a signature or signed-date field belongs to. */
export const FORM_SIGNER_ROLES = ["customer", "broker"] as const;
export type FormSignerRole = (typeof FORM_SIGNER_ROLES)[number];
export const FORM_SIGNER_ROLE_LABELS = labels<FormSignerRole>({ customer: "Client", broker: "Broker" });

/** generated → (signatures uploaded) awaiting_review → approved | rejected. A new generation supersedes older forms for the same template. */
export const FORM_STATUSES = ["generated", "awaiting_review", "approved", "rejected", "superseded"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];
export const FORM_STATUS_LABELS = labels<FormStatus>({
  generated: "Awaiting signatures",
  awaiting_review: "Awaiting review",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
});

/** How the signer authorised use of the uploaded signature for this exact form. */
export const SIGNATURE_AUTHORISATIONS = ["signed_in_person", "signed_copy_by_email", "signed_copy_by_whatsapp", "broker_own_signature", "signed_online"] as const;
export type SignatureAuthorisation = (typeof SIGNATURE_AUTHORISATIONS)[number];
/** What staff can claim when uploading a signature; "signed_online" is only set by the signing page. */
export const STAFF_SIGNATURE_AUTHORISATIONS = ["signed_in_person", "signed_copy_by_email", "signed_copy_by_whatsapp", "broker_own_signature"] as const satisfies readonly SignatureAuthorisation[];
export const SIGNATURE_AUTHORISATION_LABELS = labels<SignatureAuthorisation>({
  signed_in_person: "Signed on paper in front of us",
  signed_copy_by_email: "Signer emailed their signature for this form",
  signed_copy_by_whatsapp: "Signer sent their signature for this form by WhatsApp",
  broker_own_signature: "Broker's own signature",
  signed_online: "Signed online through a CRM signing link",
});

/**
 * CRM values a field can be filled from. `restricted` values need `bank.read` and make the
 * generated document sensitive. `check` sources resolve to true/false.
 */
export const FORM_SOURCES = {
  "customer.legalName": { label: "Customer: legal name", group: "Customer" },
  "customer.tradingName": { label: "Customer: trading name", group: "Customer" },
  "customer.companyRegNumber": { label: "Customer: CRO number", group: "Customer" },
  "customer.vatNumber": { label: "Customer: VAT number", group: "Customer" },
  "customer.businessType": { label: "Customer: business type", group: "Customer" },
  "customer.phone": { label: "Customer: phone", group: "Customer" },
  "customer.email": { label: "Customer: email", group: "Customer" },
  "customer.legalEntity": { label: "Customer: legal entity (sole_trader, partnership, limited_company, plc, charity_club, other)", group: "Customer" },
  "customer.legalEntityName": { label: "Customer: legal entity, in words", group: "Customer" },
  "customer.dateEstablished": { label: "Customer: date established", group: "Customer" },
  "customer.employees": { label: "Customer: number of employees", group: "Customer" },
  "customer.vatExemptNumber": { label: "Customer: VAT exemption number", group: "Customer" },
  "customer.charityNumber": { label: "Customer: registered charity number", group: "Customer" },
  "customer.vatExempt": { label: "Customer: VAT exempt (yes/no)", group: "Customer", check: true },
  "customer.carbonTaxExempt": { label: "Customer: carbon tax exempt (yes/no)", group: "Customer", check: true },
  "customer.priorityCustomer": { label: "Customer: priority / special needs (yes/no)", group: "Customer", check: true },
  "customer.paperlessBilling": { label: "Customer: paperless billing (yes/no)", group: "Customer", check: true },
  "marketing.email": { label: "Marketing by email (yes/no)", group: "Marketing preferences", check: true },
  "marketing.post": { label: "Marketing by post (yes/no)", group: "Marketing preferences", check: true },
  "marketing.phone": { label: "Marketing by phone (yes/no)", group: "Marketing preferences", check: true },
  "marketing.sms": { label: "Marketing by SMS (yes/no)", group: "Marketing preferences", check: true },
  "home.full": { label: "Home address: full", group: "Home address (sole traders)" },
  "home.line1": { label: "Home address: line 1", group: "Home address (sole traders)" },
  "home.line2": { label: "Home address: line 2", group: "Home address (sole traders)" },
  "home.city": { label: "Home address: town", group: "Home address (sole traders)" },
  "home.county": { label: "Home address: county", group: "Home address (sole traders)" },
  "home.postcode": { label: "Home address: Eircode", group: "Home address (sole traders)" },
  "contact.fullName": { label: "Contact: full name", group: "Contact" },
  "contact.firstName": { label: "Contact: first name", group: "Contact" },
  "contact.lastName": { label: "Contact: surname", group: "Contact" },
  "contact.jobTitle": { label: "Contact: position", group: "Contact" },
  "contact.phone": { label: "Contact: phone", group: "Contact" },
  "contact.email": { label: "Contact: email", group: "Contact" },
  "contact.title": { label: "Contact: title (Mr, Mrs, Ms…)", group: "Contact" },
  "contact.mobile": { label: "Contact: mobile", group: "Contact" },
  "contact.landline": { label: "Contact: landline", group: "Contact" },
  "billing.full": { label: "Billing address: full", group: "Billing address" },
  "billing.line1": { label: "Billing address: line 1", group: "Billing address" },
  "billing.line2": { label: "Billing address: line 2", group: "Billing address" },
  "billing.city": { label: "Billing address: town", group: "Billing address" },
  "billing.county": { label: "Billing address: county", group: "Billing address" },
  "billing.postcode": { label: "Billing address: Eircode", group: "Billing address" },
  "site.full": { label: "Supply address: full", group: "Supply site" },
  "site.line1": { label: "Supply address: line 1", group: "Supply site" },
  "site.line2": { label: "Supply address: line 2", group: "Supply site" },
  "site.city": { label: "Supply address: town", group: "Supply site" },
  "site.county": { label: "Supply address: county", group: "Supply site" },
  "site.postcode": { label: "Supply address: Eircode", group: "Supply site" },
  "site.mprn": { label: "MPRN", group: "Supply site" },
  "site.gprn": { label: "GPRN", group: "Supply site" },
  "site.meterNumber": { label: "Meter number", group: "Supply site" },
  "site.mccCode": { label: "MCC / DUoS group", group: "Supply site" },
  "site.annualConsumptionKwh": { label: "Annual consumption (kWh)", group: "Supply site" },
  "site.name": { label: "Site name", group: "Supply site" },
  "site.street": { label: "Supply address: street (lines 1 and 2)", group: "Supply site" },
  "site.locality": { label: "Supply address: town, county and Eircode", group: "Supply site" },
  "billing.street": { label: "Billing address: street (lines 1 and 2)", group: "Billing address" },
  "billing.locality": { label: "Billing address: town, county and Eircode", group: "Billing address" },
  "site.occupancy": { label: "Occupancy (owner_occupied, rented, landlord_supply, other)", group: "Supply site" },
  "site.ownsPremises": { label: "Customer owns the premises (yes/no)", group: "Supply site", check: true },
  "site.yearsAtPremises": { label: "Years at the premises", group: "Supply site" },
  "site.monthsAtPremises": { label: "Months at the premises (after full years)", group: "Supply site" },
  "site.leaseTerms": { label: "Terms of lease", group: "Supply site" },
  "meter.mic": { label: "MIC (kVA)", group: "Meter" },
  "meter.dgCode": { label: "DG / DUoS group", group: "Meter" },
  "meter.voltage": { label: "Voltage", group: "Meter" },
  "meter.profileClass": { label: "Profile class", group: "Meter" },
  "meter.serial2": { label: "Meter serial no. 2", group: "Meter" },
  "meter.spc": { label: "Gas supply point capacity (kWh)", group: "Meter" },
  "meter.aq": { label: "Gas annual quantity (kWh)", group: "Meter" },
  "meter.gasSector": { label: "Gas sector (small, medium: from annual quantity)", group: "Meter" },
  "reading.24h": { label: "Meter reading: 24 hour", group: "Meter readings" },
  "reading.day": { label: "Meter reading: day", group: "Meter readings" },
  "reading.night": { label: "Meter reading: night", group: "Meter readings" },
  "reading.nightStorage": { label: "Meter reading: night storage", group: "Meter readings" },
  "reading.wattless": { label: "Meter reading: wattless", group: "Meter readings" },
  "reading.gas": { label: "Meter reading: gas", group: "Meter readings" },
  "reading.date": { label: "Date of the meter reading", group: "Meter readings" },
  "landlord.name": { label: "Landlord: name", group: "Property and tenancy" },
  "landlord.contact": { label: "Landlord: contact details", group: "Property and tenancy" },
  "tenancy.occupancyDate": { label: "Incoming occupancy date", group: "Property and tenancy" },
  "outgoing.legalName": { label: "Previous occupier: name", group: "Previous occupier" },
  "outgoing.accountRef": { label: "Previous occupier: account number", group: "Previous occupier" },
  "contract.existingSupplier": { label: "Current supplier", group: "Contract" },
  "contract.existingSupplierAccount": { label: "Current supplier account number", group: "Contract" },
  "contract.newSupplier": { label: "New supplier", group: "Contract" },
  "contract.proposedStartDate": { label: "Proposed start date", group: "Contract" },
  "contract.termMonths": { label: "Term (months)", group: "Contract" },
  "contract.pricingPlan": { label: "Pricing plan", group: "Contract" },
  "contract.dayRate": { label: "Day / 24h rate", group: "Contract" },
  "contract.nightRate": { label: "Night rate", group: "Contract" },
  "contract.peakRate": { label: "Peak rate", group: "Contract" },
  "contract.gasRate": { label: "Gas unit rate", group: "Contract" },
  "contract.standingCharge": { label: "Standing charge", group: "Contract" },
  "contract.endDate": { label: "New contract end date", group: "Contract" },
  "contract.priceType": { label: "Price type (fixed, variable, fully_fixed)", group: "Contract" },
  "contract.isFixed": { label: "Fixed price (yes for fixed or fully fixed, no for variable)", group: "Contract", check: true },
  "contract.termText": { label: "Term, in words (e.g. 24 months)", group: "Contract" },
  "contract.rate24hCent": { label: "24 hour rate (cent per kWh, 24 hour meters only)", group: "Contract" },
  "contract.rateDayCent": { label: "Day rate (cent per kWh, day/night meters only)", group: "Contract" },
  "contract.standingChargeCent": { label: "Standing charge (cent per day)", group: "Contract" },
  "contract.tariff": { label: "Tariff (24h, night_saver: from the night rate)", group: "Contract" },
  "contract.nightStorageRate": { label: "Night storage rate", group: "Contract" },
  "contract.summerDayRate": { label: "Summer day rate", group: "Contract" },
  "contract.winterDayRate": { label: "Winter day rate", group: "Contract" },
  "contract.dayRateCent": { label: "Day / 24h rate (cent per kWh)", group: "Contract" },
  "contract.nightRateCent": { label: "Night rate (cent per kWh)", group: "Contract" },
  "contract.gasRateCent": { label: "Gas unit rate (cent per kWh)", group: "Contract" },
  "contract.nightStorageRateCent": { label: "Night storage rate (cent per kWh)", group: "Contract" },
  "contract.summerDayRateCent": { label: "Summer day rate (cent per kWh)", group: "Contract" },
  "contract.winterDayRateCent": { label: "Winter day rate (cent per kWh)", group: "Contract" },
  "opportunity.saleType": { label: "Sale type (new_sale, renewal)", group: "Contract" },
  "bank.accountName": { label: "Bank: account name", group: "Bank (restricted)", restricted: true },
  "bank.iban": { label: "Bank: IBAN", group: "Bank (restricted)", restricted: true },
  "bank.bic": { label: "Bank: BIC", group: "Bank (restricted)", restricted: true },
  "broker.name": { label: "Broker: salesperson name", group: "Broker" },
  "broker.company": { label: "Broker: company name", group: "Broker" },
  "broker.agencyId": { label: "Broker: our agency ID with this supplier", group: "Broker" },
  "opportunity.number": { label: "Opportunity number", group: "Other" },
  "today": { label: "Today's date", group: "Other" },
  "is.electricity": { label: "Tick if electricity", group: "Tick boxes", check: true },
  "is.gas": { label: "Tick if gas", group: "Tick boxes", check: true },
  "is.changeOfSupplier": { label: "Tick if change of supplier", group: "Tick boxes", check: true },
  "is.changeOfLegalEntity": { label: "Tick if change of legal entity", group: "Tick boxes", check: true },
  "is.reenergise": { label: "Tick if re-energising a meter", group: "Tick boxes", check: true },
  "is.vatRegistered": { label: "Tick if VAT registered", group: "Tick boxes", check: true },
  "is.limitedCompany": { label: "Tick if limited company", group: "Tick boxes", check: true },
  "is.soleTrader": { label: "Tick if sole trader", group: "Tick boxes", check: true },
  "is.renewal": { label: "Tick if a renewal", group: "Tick boxes", check: true },
  "is.newBusiness": { label: "Tick if new business (not a renewal)", group: "Tick boxes", check: true },
  "is.existingCustomerOfSupplier": { label: "Tick if already a customer of the new supplier", group: "Tick boxes", check: true },
} as const satisfies Record<string, { label: string; group: string; restricted?: boolean; check?: boolean }>;
export type FormSource = keyof typeof FORM_SOURCES;
export const FORM_SOURCE_KEYS = Object.keys(FORM_SOURCES) as FormSource[];
export const isRestrictedSource = (s: string | null | undefined) => !!s && !!(FORM_SOURCES as Record<string, { restricted?: boolean }>)[s]?.restricted;

/** Document types a template can produce. */
export const FORM_DOCUMENT_TYPES = ["application_form", "rate_card", "direct_debit_mandate", "commercial_agreement", "letter_of_authority", "supplier_contract", "change_of_tenancy", "lease_agreement"] as const;
export type FormDocumentType = (typeof FORM_DOCUMENT_TYPES)[number];

// --- Schemas ---------------------------------------------------------------------

const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const id = z.string().uuid();
const coord = z.number().finite().min(0).max(5000);

export const formFieldSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    label: z.string().trim().min(1, "Give each field a label.").max(120),
    kind: z.enum(FORM_FIELD_KINDS),
    page: z.number().int().min(0).max(200),
    /** PDF points, origin at the page's bottom-left corner. */
    x: coord,
    y: coord,
    w: z.number().finite().min(4).max(5000),
    h: z.number().finite().min(4).max(5000),
    source: z.enum(FORM_SOURCE_KEYS as [FormSource, ...FormSource[]]).nullable().optional(),
    signer: z.enum(FORM_SIGNER_ROLES).nullable().optional(),
    fontSize: z.number().min(5).max(24).optional(),
    /** Number of character boxes for comb fields (e.g. an MPRN written one digit per box). */
    comb: z.number().int().min(2).max(60).optional(),
    required: z.boolean().optional(),
    /** Tick (or print) only when the source's value equals this, e.g. "24" for a 24-month box, "false" for "do not contact". */
    match: z.string().trim().min(1).max(60).optional(),
    /** Fill only when another value matches, e.g. rates in the row for the deal's price type. */
    onlyIf: z.object({ source: z.enum(FORM_SOURCE_KEYS as [FormSource, ...FormSource[]]), equals: z.string().trim().min(1).max(60) }).optional(),
    /** Cover what the template already shows here with a white box (for scanned forms). */
    mask: z.boolean().optional(),
    /** Write in block capitals. */
    upper: z.boolean().optional(),
  })
  .superRefine((f, ctx) => {
    if ((f.kind === "signature" || f.kind === "signed_date") && !f.signer) ctx.addIssue({ code: "custom", path: ["signer"], message: `Choose whose signature "${f.label}" is.` });
    if (f.kind === "check" && f.source && !(FORM_SOURCES as Record<string, { check?: boolean }>)[f.source]?.check && !f.match) {
      ctx.addIssue({ code: "custom", path: ["match"], message: `Say which value ticks "${f.label}".` });
    }
  });

/** Whether a CRM value equals what a field is waiting for (case-insensitive; yes/no values as true/false). */
export function sourceMatches(value: string | boolean | null | undefined, want: string): boolean {
  if (value === null || value === undefined) return false;
  const w = want.trim().toLowerCase();
  if (typeof value === "boolean") return w === String(value) || (value ? w === "yes" : w === "no");
  return value.trim().toLowerCase() === w;
}
export type FormField = z.infer<typeof formFieldSchema>;

export const formTemplateMetaSchema = z.object({
  name: z.string().trim().min(1, "Give the template a name.").max(200),
  supplierId: id.nullable().optional(),
  documentType: z.enum(FORM_DOCUMENT_TYPES),
});

export const formTemplateUpdateSchema = formTemplateMetaSchema.partial().extend({
  active: z.boolean().optional(),
  fields: z.array(formFieldSchema).max(400).optional(),
});

export const generateFormSchema = z.object({
  templateId: id,
  /** Values typed or changed by the user, keyed by field id. Anything not given is filled from the CRM. */
  values: z.record(z.string(), z.union([z.string().max(500), z.boolean()])).default({}),
  /** Required when an IBAN differs from the one on file. */
  confirmIbanChange: z.boolean().optional(),
  /** Why values changed since the customer's previous form (renewals); kept with the form. */
  changeReason: z.string().trim().max(500).nullable().optional(),
});

export const formSignatureSchema = z.object({
  role: z.enum(FORM_SIGNER_ROLES),
  signerName: z.string().trim().min(1, "Enter the signer's name.").max(200),
  signerCapacity: optText(100),
  authorisation: z.enum(STAFF_SIGNATURE_AUTHORISATIONS),
  note: optText(500),
  attest: z.literal(true, { errorMap: () => ({ message: "Confirm the signer authorised this signature for this form." }) }),
});

// --- Online signing ------------------------------------------------------------------

/** Days a signing link stays valid. */
export const SIGNING_LINK_DAYS = 14;
/** Shown next to the tick box on the signing page; the version and wording are stored with each signature. */
export const SIGNING_CONSENT_VERSION = "2026-10-1";
export const SIGNING_CONSENT_TEXT =
  "I have read this document. I agree to sign it electronically, and I intend my drawn signature and typed name to have the same effect as my handwritten signature on it.";

export const SIGNING_LINK_STATUSES = ["sent", "opened", "signed", "expired", "revoked"] as const;
export type SigningLinkStatus = (typeof SIGNING_LINK_STATUSES)[number];
export const SIGNING_LINK_STATUS_LABELS = labels<SigningLinkStatus>({ sent: "Sent", opened: "Opened", signed: "Signed", expired: "Expired", revoked: "Cancelled" });

export const signingLinkSchema = z.object({
  role: z.enum(FORM_SIGNER_ROLES),
  signerName: z.string().trim().min(1, "Enter the signer's name.").max(200),
  email: z.string().trim().toLowerCase().email("Enter the signer's email address."),
});

/** The signature image is a small PNG data URL drawn on the signing page (requests are limited to 100 KB). */
export const publicSignSchema = z.object({
  typedName: z.string().trim().min(1, "Type your full name.").max(200),
  consent: z.literal(true, { errorMap: () => ({ message: "Tick the box to agree to sign electronically." }) }),
  signaturePng: z
    .string()
    .max(95_000, "The signature is too large. Clear it and sign again.")
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, "Draw your signature in the box."),
});

export const formReviewSchema = z.object({ decision: z.enum(["approved", "rejected"]), note: optText(1000) });

export const billCheckSchema = z.object({
  previousSupplier: z.string().trim().min(1, "Name the previous supplier on the bill.").max(200),
  billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  readable: z.boolean(),
  customerNameMatches: z.boolean(),
  supplyPointMatches: z.boolean(),
  supplierMatches: z.boolean(),
  notes: optText(1000),
});
export type BillCheckInput = z.infer<typeof billCheckSchema>;

export const billCheckPassed = (c: Pick<BillCheckInput, "readable" | "customerNameMatches" | "supplyPointMatches" | "supplierMatches">) =>
  c.readable && c.customerNameMatches && c.supplyPointMatches && c.supplierMatches;
