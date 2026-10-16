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
export const SIGNATURE_AUTHORISATIONS = ["signed_in_person", "signed_copy_by_email", "signed_copy_by_whatsapp", "broker_own_signature"] as const;
export type SignatureAuthorisation = (typeof SIGNATURE_AUTHORISATIONS)[number];
export const SIGNATURE_AUTHORISATION_LABELS = labels<SignatureAuthorisation>({
  signed_in_person: "Signed on paper in front of us",
  signed_copy_by_email: "Signer emailed their signature for this form",
  signed_copy_by_whatsapp: "Signer sent their signature for this form by WhatsApp",
  broker_own_signature: "Broker's own signature",
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
  "contact.fullName": { label: "Contact: full name", group: "Contact" },
  "contact.firstName": { label: "Contact: first name", group: "Contact" },
  "contact.lastName": { label: "Contact: surname", group: "Contact" },
  "contact.jobTitle": { label: "Contact: position", group: "Contact" },
  "contact.phone": { label: "Contact: phone", group: "Contact" },
  "contact.email": { label: "Contact: email", group: "Contact" },
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
  "bank.accountName": { label: "Bank: account name", group: "Bank (restricted)", restricted: true },
  "bank.iban": { label: "Bank: IBAN", group: "Bank (restricted)", restricted: true },
  "bank.bic": { label: "Bank: BIC", group: "Bank (restricted)", restricted: true },
  "broker.name": { label: "Broker: salesperson name", group: "Broker" },
  "broker.company": { label: "Broker: company name", group: "Broker" },
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
} as const satisfies Record<string, { label: string; group: string; restricted?: boolean; check?: boolean }>;
export type FormSource = keyof typeof FORM_SOURCES;
export const FORM_SOURCE_KEYS = Object.keys(FORM_SOURCES) as FormSource[];
export const isRestrictedSource = (s: string | null | undefined) => !!s && !!(FORM_SOURCES as Record<string, { restricted?: boolean }>)[s]?.restricted;

/** Document types a template can produce. */
export const FORM_DOCUMENT_TYPES = ["application_form", "rate_card", "direct_debit_mandate", "commercial_agreement", "letter_of_authority", "supplier_contract"] as const;
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
  })
  .superRefine((f, ctx) => {
    if ((f.kind === "signature" || f.kind === "signed_date") && !f.signer) ctx.addIssue({ code: "custom", path: ["signer"], message: `Choose whose signature "${f.label}" is.` });
  });
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
});

export const formSignatureSchema = z.object({
  role: z.enum(FORM_SIGNER_ROLES),
  signerName: z.string().trim().min(1, "Enter the signer's name.").max(200),
  signerCapacity: optText(100),
  authorisation: z.enum(SIGNATURE_AUTHORISATIONS),
  note: optText(500),
  attest: z.literal(true, { errorMap: () => ({ message: "Confirm the signer authorised this signature for this form." }) }),
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
