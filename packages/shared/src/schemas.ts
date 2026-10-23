import { z } from "zod";
import {
  ACTIVITY_TYPES,
  APPROVAL_STATES,
  COMMISSION_STATUSES,
  COMPLIANCE_STATUSES,
  DOCUMENT_TYPES,
  FUELS,
  LEAD_SOURCES,
  LEGAL_ENTITIES,
  OCCUPANCY_TYPES,
  PRINCIPAL_ROLES,
  PRODUCT_INTERESTS,
  PRIORITIES,
  READING_TYPES,
  ROLES,
  SALE_TYPES,
  SERVICE_TYPES,
  SUPPLY_CHANGES,
  VAT_STATUSES,
  CONTRACT_STATUSES,
  MERCHANT_STATUSES,
  SIGNER_ROLES,
  PRICE_TYPES,
} from "./enums";
import { STAGE_KEYS } from "./stages";

/**
 * Request schemas shared by API validation and web forms. Every field that isn't needed
 * for quick capture is optional; completeness is enforced by stage gates (rules.ts).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.");
const text = (max = 500) => z.string().trim().max(max);
const optText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();
const optDate = isoDate.nullable().optional().or(z.literal("").transform(() => null));
const pct = (label: string) =>
  z.number({ invalid_type_error: `${label} must be a number.` }).min(0, `${label} must be between 0 and 100.`).max(100, `${label} must be between 0 and 100.`);
const optPct = (label: string) => pct(label).nullable().optional();
const money = (label: string) => z.number({ invalid_type_error: `${label} must be a number.` }).min(0, `${label} can't be negative.`);
const optMoney = (label: string) => money(label).nullable().optional();
const optEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null));
const id = z.string().uuid();

// --- Auth & users ----------------------------------------------------------

export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional() });
export const passwordSchema = z.string().min(12, "Use at least 12 characters.").max(200);
export const createUserSchema = z.object({
  name: text(120).min(1, "Enter a name."),
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
  roles: z.array(z.enum(ROLES)).min(1, "Choose at least one role."),
  teamId: id.nullable().optional(),
});
export const updateUserSchema = z.object({
  name: text(120).min(1).optional(),
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  active: z.boolean().optional(),
  teamId: id.nullable().optional(),
  /** false = the user can only sign in with single sign-on. */
  passwordLogin: z.boolean().optional(),
});

// --- Customers -------------------------------------------------------------

export const addressSchema = z.object({
  kind: z.enum(["registered", "trading", "billing", "postal", "home"]).default("trading"),
  line1: text(200).min(1, "Enter the first line of the address."),
  line2: optText(200),
  city: optText(100),
  county: optText(100),
  postcode: optText(20),
  country: text(2).default("IE"),
});

export const customerSchema = z.object({
  legalName: text(200).min(1, "Enter the customer's legal name."),
  tradingName: optText(200),
  businessType: optText(100),
  industry: optText(100),
  companyRegNumber: optText(30),
  vatRegistered: z.enum(VAT_STATUSES).nullable().optional(),
  vatNumber: optText(30),
  incorporationDate: optDate,
  countryOfIncorporation: optText(2),
  website: optText(200),
  phone: optText(40),
  email: optEmail,
  advertisingMethod: optText(200),
  addresses: z.array(addressSchema).optional(),
  // Details supplier application forms ask for.
  legalEntity: z.enum(LEGAL_ENTITIES).nullable().optional(),
  employees: z.number().int().min(0).max(1_000_000).nullable().optional(),
  vatExempt: z.boolean().nullable().optional(),
  vatExemptNumber: optText(40),
  carbonTaxExempt: z.boolean().nullable().optional(),
  charityNumber: optText(40),
  /** Someone at the premises relies on life-support or medical equipment, or has special needs. */
  priorityCustomer: z.boolean().nullable().optional(),
  /** Marketing preferences (null = not asked). */
  marketingEmail: z.boolean().nullable().optional(),
  marketingPost: z.boolean().nullable().optional(),
  marketingPhone: z.boolean().nullable().optional(),
  marketingSms: z.boolean().nullable().optional(),
  paperlessBilling: z.boolean().nullable().optional(),
});
export const customerUpdateSchema = customerSchema.partial().extend({ legalName: text(200).min(1).optional() });

export const contactSchema = z.object({
  title: optText(20),
  firstName: text(100).min(1, "Enter a first name."),
  lastName: optText(100),
  jobTitle: optText(100),
  email: optEmail,
  phone: optText(40),
  mobile: optText(40),
  isPrimary: z.boolean().optional(),
});

export const duplicateCheckSchema = z.object({
  email: optEmail,
  phone: optText(40),
  companyRegNumber: optText(30),
  vatNumber: optText(30),
  legalName: optText(200),
  postcode: optText(20),
});

export const bankDetailsSchema = z.object({
  accountName: text(200).min(1),
  iban: z.string().trim().toUpperCase().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, "Enter a valid IBAN."),
  bic: optText(11),
});

// --- Opportunities ---------------------------------------------------------

export const createOpportunitySchema = z.object({
  name: text(200).min(1, "Give the opportunity a name."),
  serviceType: z.enum(SERVICE_TYPES),
  saleType: z.enum(SALE_TYPES).default("new_sale"),
  customerId: id.nullable().optional(),
  contactName: optText(200),
  companyName: optText(200),
  email: optEmail,
  phone: optText(40),
  leadSource: z.enum(LEAD_SOURCES).default("manual"),
  leadSourceDetail: optText(500),
  campaign: optText(200),
  expectedRevenue: optMoney("Expected revenue"),
  nextAction: optText(300),
  followUpDate: optDate,
  expectedCloseDate: optDate,
  visitDate: optDate,
  contactRole: optText(100),
  productInterest: z.array(z.enum(PRODUCT_INTERESTS)).max(PRODUCT_INTERESTS.length).optional(),
  supplyChanges: z.array(z.enum(SUPPLY_CHANGES)).max(SUPPLY_CHANGES.length).optional(),
  ownerId: id.nullable().optional(),
  teamId: id.nullable().optional(),
});

export const updateOpportunitySchema = z.object({
  name: text(200).min(1).optional(),
  serviceType: z.enum(SERVICE_TYPES).optional(),
  saleType: z.enum(SALE_TYPES).optional(),
  contactName: optText(200),
  companyName: optText(200),
  email: optEmail,
  phone: optText(40),
  leadSource: z.enum(LEAD_SOURCES).optional(),
  leadSourceDetail: optText(500),
  campaign: optText(200),
  expectedRevenue: optMoney("Expected revenue"),
  nextAction: optText(300),
  followUpDate: optDate,
  expectedCloseDate: optDate,
  visitDate: optDate,
  contactRole: optText(100),
  productInterest: z.array(z.enum(PRODUCT_INTERESTS)).max(PRODUCT_INTERESTS.length).optional(),
  supplyChanges: z.array(z.enum(SUPPLY_CHANGES)).max(SUPPLY_CHANGES.length).optional(),
  selectedSupplierId: id.nullable().optional(),
  applicationStatus: optText(100),
  teamId: id.nullable().optional(),
});

export const moveStageSchema = z.object({ stage: z.enum(STAGE_KEYS) });
export const assignSchema = z.object({ ownerId: id.nullable() });
export const approvalSchema = z.object({ decision: z.enum(APPROVAL_STATES), note: optText(1000) });
export const markLostSchema = z.object({ reason: text(500).min(1, "Give a reason.") });
/**
 * Marks the imported leads of one campaign lost: those still open at New Lead, optionally only one
 * service. `expected` is the count the manager confirmed, so a batch that changed meanwhile isn't closed.
 */
export const closeLeadBatchSchema = z.object({
  campaign: text(200).min(1, "Choose the import batch."),
  serviceType: z.enum(SERVICE_TYPES).optional(),
  reason: text(500).min(1, "Give a reason."),
  expected: z.number().int().min(1),
});
export const activateSchema = z.object({ activationDate: isoDate, supplierReference: optText(100) });

export const opportunityListQuerySchema = z.object({
  view: z
    .enum([
      "my_open",
      "all",
      "all_won",
      "energy",
      "worldpay",
      "renewals_due",
      "awaiting_customer",
      "awaiting_supplier",
      "awaiting_worldpay",
      "compliance_queries",
      "missing_documents",
      "unsigned",
      "unassigned",
      "lost",
    ])
    .default("all"),
  q: z.string().trim().max(200).optional(),
  ownerId: id.optional(),
  serviceType: z.enum(SERVICE_TYPES).optional(),
  stage: z.enum(STAGE_KEYS).optional(),
  supplierId: id.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

// --- Energy ----------------------------------------------------------------

export const supplySiteSchema = z.object({
  label: optText(120),
  address: addressSchema,
  serviceType: z.enum(SERVICE_TYPES).refine((s) => s !== "merchant_services", "Supply sites are for energy services."),
  occupancyType: z.enum(OCCUPANCY_TYPES).nullable().optional(),
  landlordName: optText(200),
  landlordContact: optText(200),
  customerSector: optText(100),
  annualConsumptionKwh: optMoney("Annual consumption"),
  /** When the customer moved in (forms ask how long they've been at the premises). */
  occupiedSince: optDate,
  leaseTerms: optText(200),
});

export const meterPointSchema = z.object({
  fuel: z.enum(FUELS),
  meterType: optText(60),
  mprn: optText(20),
  gprn: optText(20),
  meterNumber: optText(40),
  mccCode: optText(10),
  formatExceptionReason: optText(300),
  // Electricity
  mic: z.number().min(0).max(100_000).nullable().optional(),
  dgCode: optText(10),
  voltage: optText(20),
  profileClass: optText(10),
  meterSerial2: optText(40),
  // Gas
  supplyPointCapacityKwh: optMoney("Supply point capacity"),
  annualQuantityKwh: optMoney("Annual quantity"),
});

export const meterReadingSchema = z.object({
  readingType: z.enum(READING_TYPES),
  register: optText(30),
  value: money("Reading"),
  readingDate: isoDate,
  documentId: id.nullable().optional(),
});

const rate = (label: string) => z.number({ invalid_type_error: `${label} must be a number.` }).min(0, `${label} can't be negative.`).max(1000);
export const energyContractSchema = z.object({
  siteId: id.nullable().optional(),
  fuel: z.enum(FUELS),
  existingSupplierName: optText(120),
  existingSupplierAccount: optText(60),
  selectedSupplierId: id.nullable().optional(),
  currentContractStartDate: optDate,
  currentContractEndDate: optDate,
  proposedActivationDate: optDate,
  termMonths: z.number().int().min(1, "Term must be at least 1 month.").max(120).nullable().optional(),
  pricingPlan: optText(120),
  dayRate: rate("Day rate").nullable().optional(),
  nightRate: rate("Night rate").nullable().optional(),
  peakRate: rate("Peak rate").nullable().optional(),
  otherRate: rate("Other/wattless rate").nullable().optional(),
  gasRate: rate("Gas rate").nullable().optional(),
  standingCharge: rate("Standing charge").nullable().optional(),
  priceType: z.enum(PRICE_TYPES).nullable().optional(),
  nightStorageRate: rate("Night storage rate").nullable().optional(),
  summerDayRate: rate("Summer day rate").nullable().optional(),
  winterDayRate: rate("Winter day rate").nullable().optional(),
  supplierReference: optText(100),
  status: z.enum(CONTRACT_STATUSES).optional(),
});

export const comparisonQuoteSchema = z.object({
  supplierId: id,
  fuel: z.enum(FUELS),
  termMonths: z.number().int().min(1).max(120),
  dayRate: rate("Day rate").nullable().optional(),
  nightRate: rate("Night rate").nullable().optional(),
  gasRate: rate("Gas rate").nullable().optional(),
  standingCharge: rate("Standing charge").nullable().optional(),
  estimatedAnnualCost: optMoney("Estimated annual cost"),
  estimatedCommission: optMoney("Estimated commission"),
  notes: optText(1000),
});

// --- Worldpay --------------------------------------------------------------

export const merchantApplicationSchema = z.object({
  campaign: optText(120),
  legalEntity: z.enum(LEGAL_ENTITIES).nullable().optional(),
  natureOfBusiness: optText(300),
  estimatedAnnualTurnover: optMoney("Estimated annual turnover"),
  cardTurnoverPct: optPct("Card turnover percentage"),
  averageTransactionValue: optMoney("Average transaction value"),
  settlementPeriod: optText(60),
  dashboardRequested: z.boolean().optional(),
  website: optText(200),
  advertisingMethod: optText(200),
  applicationReference: optText(100),
  status: z.enum(MERCHANT_STATUSES).optional(),
  termMonths: z.number().int().min(1).max(120).nullable().optional(),
});

const cardRate = (label: string) => optPct(label);
export const merchantPricingSchema = z.object({
  product: text(120).min(1, "Choose the product or terminal."),
  quantity: z.number().int().min(1).default(1),
  minimumMonthlyCharge: optMoney("Minimum monthly charge"),
  productMonthlyFee: optMoney("Product monthly fee"),
  debitRate: cardRate("Debit-card rate"),
  creditRate: cardRate("Credit-card rate"),
  commercialRate: cardRate("Commercial-card rate"),
  amexRate: cardRate("Amex rate"),
  authorisationFee: optMoney("Authorisation fee"),
  offerType: optText(120),
});

export const principalAddressSchema = z.object({
  line1: text(200).min(1),
  line2: optText(200),
  city: optText(100),
  postcode: optText(20),
  country: text(2).default("IE"),
  fromDate: isoDate,
  toDate: optDate,
});

export const principalSchema = z.object({
  role: z.enum(PRINCIPAL_ROLES),
  title: optText(20),
  firstName: text(100).min(1, "Enter the first name."),
  middleName: optText(100),
  lastName: text(100).min(1, "Enter the last name."),
  dateOfBirth: optDate,
  nationality: optText(60),
  ownershipPct: optPct("Ownership percentage"),
  email: optEmail,
  phone: optText(40),
  addressHistory: z.array(principalAddressSchema).max(10).optional(),
});

export const riskSchema = z.object({
  thirdPartyFulfilment: z.boolean().optional(),
  stockStoredElsewhere: z.boolean().optional(),
  depositsAccepted: z.boolean().optional(),
  depositTxnPct: optPct("Deposit transaction percentage"),
  depositValuePct: optPct("Deposit value percentage"),
  depositLeadDays: z.number().int().min(0, "Days can't be negative.").max(3650).nullable().optional(),
  balanceLeadDays: z.number().int().min(0, "Days can't be negative.").max(3650).nullable().optional(),
  fullPrepaymentAccepted: z.boolean().optional(),
  fullPrepaymentPct: optPct("Prepayment percentage"),
  fullPaymentLeadDays: z.number().int().min(0, "Days can't be negative.").max(3650).nullable().optional(),
});

export const complianceReviewSchema = z.object({
  status: z.enum(COMPLIANCE_STATUSES),
  restrictedNotes: optText(5000),
});

// --- Documents, signatures, activities --------------------------------------

export const documentItemSchema = z.object({
  documentType: z.enum(Object.keys(DOCUMENT_TYPES) as [keyof typeof DOCUMENT_TYPES, ...(keyof typeof DOCUMENT_TYPES)[]]),
  required: z.boolean().default(true),
  merchantApplicationId: id.nullable().optional(),
  energyContractId: id.nullable().optional(),
  expiryDate: optDate,
});

export const documentReviewSchema = z.object({
  approval: z.enum(["approved", "rejected"]),
  reviewNotes: optText(2000),
  expiryDate: optDate,
});

export const signatureRequestSchema = z.object({
  templateId: id.nullable().optional(),
  documentItemId: id.nullable().optional(),
  title: text(200).min(1),
  signers: z
    .array(z.object({ role: z.enum(SIGNER_ROLES), name: text(200).min(1), email: z.string().trim().toLowerCase().email() }))
    .min(1, "Add at least one signer.")
    .refine((s) => s.some((x) => x.role === "customer"), "Add the customer as a signer."),
});

export const activitySchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  summary: text(300).min(1, "Describe the activity."),
  note: optText(5000),
  dueDate: isoDate,
  priority: z.enum(PRIORITIES).default("normal"),
  reminderAt: z.string().datetime().nullable().optional(),
  ownerId: id.nullable().optional(),
  opportunityId: id.nullable().optional(),
  customerId: id.nullable().optional(),
});

export const timelineEntrySchema = z.object({
  kind: z.enum(["call", "note", "email", "whatsapp"]),
  body: text(10000).min(1, "Write something."),
  direction: z.enum(["inbound", "outbound"]).nullable().optional(),
  occurredAt: z.string().datetime().optional(),
});

export const commissionSchema = z.object({
  opportunityId: id,
  amount: money("Amount"),
  status: z.enum(COMMISSION_STATUSES),
  note: optText(500),
});

// --- OCR -------------------------------------------------------------------

export const ocrConfirmSchema = z.object({
  firstName: optText(100),
  lastName: optText(100),
  company: optText(200),
  jobTitle: optText(100),
  email: optEmail,
  phone: optText(40),
  mobile: optText(40),
  website: optText(200),
  address: optText(500),
  /** Link to an existing customer instead of creating one. */
  existingCustomerId: id.nullable().optional(),
  serviceType: z.enum(SERVICE_TYPES),
  opportunityName: optText(200),
});

// --- Internal chat & calls ----------------------------------------------------

export const chatMessageSchema = z.object({
  body: z.string().trim().max(4000, "Messages can be up to 4,000 characters.").default(""),
  /** User ids mentioned with @. The server keeps only people who can see the conversation. */
  mentions: z.array(id).max(20).default([]),
});
export const chatChannelSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "Use 2–40 lowercase letters, numbers or dashes, e.g. sales-team."),
  description: optText(300),
  isPrivate: z.boolean().default(false),
  memberIds: z.array(id).max(200).default([]),
});
export const startCallSchema = z.object({
  /** One of the numbers listed for the opportunity (customer, contacts or captured phone). */
  number: z.string().trim().min(6).max(40),
  contactId: id.nullable().optional(),
});
export const CALL_OUTCOMES = ["answered", "no_answer", "busy", "voicemail", "wrong_number", "call_back_requested"] as const;
export const callOutcomeSchema = z.object({
  outcome: z.enum(CALL_OUTCOMES),
  durationMinutes: z.number().int().min(0).max(600).nullable().optional(),
  notes: optText(5000),
});
export const callbackPhoneSchema = z.object({ phone: z.string().trim().max(40).nullable() });

export type CreateOpportunityInput = z.infer<typeof createOpportunitySchema>;
export type UpdateOpportunityInput = z.infer<typeof updateOpportunitySchema>;
export type CustomerInput = z.infer<typeof customerSchema>;
export type CloseLeadBatchInput = z.infer<typeof closeLeadBatchSchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type SupplySiteInput = z.infer<typeof supplySiteSchema>;
export type MeterPointInput = z.infer<typeof meterPointSchema>;
export type EnergyContractInput = z.infer<typeof energyContractSchema>;
export type MerchantApplicationInput = z.infer<typeof merchantApplicationSchema>;
export type MerchantPricingInput = z.infer<typeof merchantPricingSchema>;
export type PrincipalInput = z.infer<typeof principalSchema>;
export type RiskInput = z.infer<typeof riskSchema>;
export type ActivityInput = z.infer<typeof activitySchema>;
export type OpportunityListQuery = z.infer<typeof opportunityListQuerySchema>;
export type OcrConfirmInput = z.infer<typeof ocrConfirmSchema>;
