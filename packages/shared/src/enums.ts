/**
 * Enumerations shared by the API (Prisma enums use the same values) and the web app.
 * Each has a label map for display so the UI never shows raw codes.
 */

const labels = <T extends string>(m: Record<T, string>) => m;

export const ROLES = ["administrator", "manager", "salesperson", "operations", "compliance", "finance"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS = labels<Role>({
  administrator: "Administrator",
  manager: "Manager",
  salesperson: "Salesperson",
  operations: "Operations",
  compliance: "Compliance",
  finance: "Finance",
});

export const SERVICE_TYPES = ["electricity", "gas", "dual_fuel", "merchant_services"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
export const SERVICE_TYPE_LABELS = labels<ServiceType>({
  electricity: "Electricity",
  gas: "Gas",
  dual_fuel: "Dual Fuel",
  merchant_services: "Merchant Services / Worldpay",
});
export const isEnergyService = (s: ServiceType) => s !== "merchant_services";
export const needsElectricity = (s: ServiceType) => s === "electricity" || s === "dual_fuel";
export const needsGas = (s: ServiceType) => s === "gas" || s === "dual_fuel";

export const SALE_TYPES = ["new_sale", "renewal"] as const;
export type SaleType = (typeof SALE_TYPES)[number];
export const SALE_TYPE_LABELS = labels<SaleType>({ new_sale: "New Sale", renewal: "Renewal" });

/** What is changing at the supply point when onboarding an energy customer. Several can apply. */
export const SUPPLY_CHANGES = ["change_of_supplier", "change_of_legal_entity", "reenergise_meter"] as const;
export type SupplyChange = (typeof SUPPLY_CHANGES)[number];
export const SUPPLY_CHANGE_LABELS = labels<SupplyChange>({
  change_of_supplier: "Change of supplier",
  change_of_legal_entity: "Change of legal entity",
  reenergise_meter: "Re-energise / reactivate meter",
});

/** Products the customer is interested in (cross-sell), separate from the opportunity's own service. */
export const PRODUCT_INTERESTS = ["electricity", "gas", "payment_services"] as const;
export type ProductInterest = (typeof PRODUCT_INTERESTS)[number];
export const PRODUCT_INTEREST_LABELS = labels<ProductInterest>({ electricity: "Electricity", gas: "Gas", payment_services: "Payment Services" });

export const OUTCOMES = ["open", "won", "lost"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const LEAD_SOURCES = [
  "manual",
  "telephone",
  "email",
  "website",
  "whatsapp",
  "referral",
  "existing_customer",
  "business_card",
  "csv_import",
  "api",
  "renewal",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export const LEAD_SOURCE_LABELS = labels<LeadSource>({
  manual: "Manual entry",
  telephone: "Telephone",
  email: "Email",
  website: "Website",
  whatsapp: "WhatsApp",
  referral: "Referral",
  existing_customer: "Existing customer",
  business_card: "Business card",
  csv_import: "CSV import",
  api: "API",
  renewal: "Renewal",
});

export const APPROVAL_STATES = ["not_requested", "pending", "approved", "rejected"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const APPROVAL_LABELS = labels<ApprovalState>({
  not_requested: "Not requested",
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
});

export const VAT_STATUSES = ["yes", "no", "pending"] as const;
export type VatStatus = (typeof VAT_STATUSES)[number];

export const OCCUPANCY_TYPES = ["owner_occupied", "rented", "landlord_supply", "other"] as const;
export type OccupancyType = (typeof OCCUPANCY_TYPES)[number];
export const OCCUPANCY_LABELS = labels<OccupancyType>({
  owner_occupied: "Owner occupied",
  rented: "Rented premises",
  landlord_supply: "Landlord supply",
  other: "Other",
});
export const occupancyNeedsLandlord = (o: OccupancyType | null | undefined) => o === "rented" || o === "landlord_supply";

export const FUELS = ["electricity", "gas"] as const;
export type Fuel = (typeof FUELS)[number];

export const READING_TYPES = ["actual", "estimated", "customer", "smart"] as const;
export type ReadingType = (typeof READING_TYPES)[number];

export const CONTRACT_STATUSES = ["draft", "quoted", "selected", "signed", "submitted", "live", "ended", "cancelled"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const LEGAL_ENTITIES = ["sole_trader", "partnership", "limited_company", "plc", "charity_club", "other"] as const;
export type LegalEntity = (typeof LEGAL_ENTITIES)[number];
export const LEGAL_ENTITY_LABELS = labels<LegalEntity>({
  sole_trader: "Sole trader",
  partnership: "Partnership",
  limited_company: "Limited company",
  plc: "PLC",
  charity_club: "Charity / club / association",
  other: "Other",
});

export const PRINCIPAL_ROLES = ["owner", "partner", "director", "shareholder", "trustee", "signatory"] as const;
export type PrincipalRole = (typeof PRINCIPAL_ROLES)[number];

export const MERCHANT_STATUSES = [
  "draft",
  "ready",
  "submitted",
  "compliance_query",
  "approved",
  "declined",
  "live",
  "cancelled",
] as const;
export type MerchantStatus = (typeof MERCHANT_STATUSES)[number];
export const MERCHANT_STATUS_LABELS = labels<MerchantStatus>({
  draft: "Draft",
  ready: "Ready to submit",
  submitted: "Submitted to Worldpay",
  compliance_query: "Compliance query",
  approved: "Approved",
  declined: "Declined",
  live: "Live",
  cancelled: "Cancelled",
});

export const COMPLIANCE_STATUSES = ["not_started", "in_review", "query_raised", "approved", "rejected"] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export const DOCUMENT_APPROVAL = ["pending", "approved", "rejected"] as const;
export type DocumentApproval = (typeof DOCUMENT_APPROVAL)[number];

export const SCAN_STATUSES = ["pending", "clean", "infected", "error", "skipped"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const ACTIVITY_TYPES = [
  "call",
  "email",
  "whatsapp",
  "meeting",
  "request_documents",
  "review_documents",
  "prepare_comparison",
  "prepare_proposal",
  "obtain_signature",
  "internal_review",
  "submit_application",
  "follow_up_supplier",
  "follow_up_worldpay",
  "renewal_review",
  "compliance_review",
  "todo",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const ACTIVITY_TYPE_LABELS = labels<ActivityType>({
  call: "Call",
  email: "Email",
  whatsapp: "WhatsApp",
  meeting: "Meeting",
  request_documents: "Request documents",
  review_documents: "Review documents",
  prepare_comparison: "Prepare comparison",
  prepare_proposal: "Prepare proposal",
  obtain_signature: "Obtain signature",
  internal_review: "Internal review",
  submit_application: "Submit application",
  follow_up_supplier: "Follow up with supplier",
  follow_up_worldpay: "Follow up with Worldpay",
  renewal_review: "Renewal review",
  compliance_review: "Compliance review",
  todo: "To-do",
});

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ACTIVITY_STATUSES = ["open", "done", "cancelled"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const TIMELINE_KINDS = [
  "call",
  "note",
  "email",
  "whatsapp",
  "stage_change",
  "assignment",
  "activity",
  "document",
  "approval",
  "signature",
  "submission",
  "compliance",
  "activation",
  "outcome",
  "system",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const SIGNATURE_STATUSES = ["draft", "sent", "partially_signed", "completed", "declined", "expired", "cancelled"] as const;
export type SignatureStatus = (typeof SIGNATURE_STATUSES)[number];
export const SIGNER_ROLES = ["customer", "broker"] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

export const OCR_STATUSES = ["uploaded", "processing", "processed", "failed", "confirmed", "discarded"] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];

export const COMMISSION_STATUSES = ["expected", "confirmed", "paid", "clawed_back"] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

/** Document types. `sensitive` ones (identity, bank) are restricted to Compliance/Finance/Admin. */
export const DOCUMENT_TYPES = {
  energy_bill: { label: "Recent energy bill", sensitive: false },
  letter_of_authority: { label: "Letter of authority", sensitive: false },
  supplier_contract: { label: "Signed supplier contract", sensitive: false },
  change_of_tenancy: { label: "Change of tenancy form", sensitive: false },
  lease_agreement: { label: "Signed lease agreement", sensitive: false },
  meter_reading_photo: { label: "Time-stamped meter reading photo", sensitive: false },
  comparison: { label: "Price comparison", sensitive: false },
  proposal: { label: "Proposal", sensitive: false },
  worldpay_application: { label: "Signed Worldpay application", sensitive: false },
  photo_id: { label: "Photo ID", sensitive: true },
  proof_of_address: { label: "Proof of residential address", sensitive: true },
  bank_statement: { label: "Bank statement", sensitive: true },
  bank_letter: { label: "Bank letter / void cheque", sensitive: true },
  proof_of_trading: { label: "Proof of trading address", sensitive: false },
  certificate_of_incorporation: { label: "Certificate of incorporation", sensitive: false },
  other: { label: "Other", sensitive: false },
} as const;
export type DocumentType = keyof typeof DOCUMENT_TYPES;
export const isSensitiveDocument = (t: string) => (DOCUMENT_TYPES as Record<string, { sensitive: boolean }>)[t]?.sensitive ?? false;

/** Standard checklist added when an opportunity reaches "Details Requested". */
export const STANDARD_CHECKLIST: Record<"energy" | "merchant", { type: DocumentType; required: boolean }[]> = {
  energy: [
    { type: "energy_bill", required: true },
    { type: "letter_of_authority", required: true },
    { type: "supplier_contract", required: true },
    { type: "change_of_tenancy", required: false },
  ],
  merchant: [
    { type: "worldpay_application", required: true },
    { type: "photo_id", required: true },
    { type: "proof_of_address", required: true },
    { type: "bank_statement", required: true },
    { type: "proof_of_trading", required: true },
  ],
};

/** Documents each supply change makes required on an energy opportunity. */
export const SUPPLY_CHANGE_DOCUMENTS: Record<SupplyChange, DocumentType[]> = {
  change_of_supplier: ["energy_bill", "letter_of_authority"],
  change_of_legal_entity: ["change_of_tenancy", "lease_agreement"],
  reenergise_meter: ["meter_reading_photo"],
};

/** Checklist for an opportunity: the standard list plus whatever its supply changes require. */
export function checklistFor(kind: "energy" | "merchant", supplyChanges: readonly SupplyChange[] = []): { type: DocumentType; required: boolean }[] {
  const items = new Map(STANDARD_CHECKLIST[kind].map((d) => [d.type, d.required]));
  if (kind === "energy") for (const c of supplyChanges) for (const t of SUPPLY_CHANGE_DOCUMENTS[c]) items.set(t, true);
  return [...items].map(([type, required]) => ({ type, required }));
}
