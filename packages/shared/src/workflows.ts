/**
 * Back-office workflows on an energy opportunity: change of legal entity, existing-supplier
 * renewal and change of supplier. Each opportunity is one case; its status is derived from the
 * evidence recorded against it (see `caseSteps` in rules.ts), so no state can be skipped.
 */
import { z } from "zod";
import type { SaleType, ServiceType, SupplyChange } from "./enums";

const labels = <T extends string>(m: Record<T, string>) => m;
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.").nullable().optional();
const id = z.string().uuid();

export const CASE_KINDS = ["change_of_entity", "change_of_supplier", "renewal", "new_supply", "merchant"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];
export const CASE_KIND_LABELS = labels<CaseKind>({
  change_of_entity: "Change of legal entity",
  change_of_supplier: "Change of supplier",
  renewal: "Renewal with the existing supplier",
  new_supply: "New supply",
  merchant: "Worldpay application",
});

/** Which workflow brief an opportunity follows. A change of entity takes precedence over a switch, and a switch over a renewal. */
export function caseKind(o: { serviceType: ServiceType; saleType?: SaleType; supplyChanges?: readonly SupplyChange[] }): CaseKind {
  if (o.serviceType === "merchant_services") return "merchant";
  if (o.supplyChanges?.includes("change_of_legal_entity")) return "change_of_entity";
  if (o.supplyChanges?.includes("change_of_supplier")) return "change_of_supplier";
  return o.saleType === "renewal" ? "renewal" : "new_supply";
}

export const CUSTOMER_PATHS = ["existing_client", "new_to_us"] as const;
export type CustomerPath = (typeof CUSTOMER_PATHS)[number];
export const CUSTOMER_PATH_LABELS = labels<CustomerPath>({ existing_client: "Existing client", new_to_us: "New to us" });

export const SUPPLY_PATHS = ["known_supply_point", "new_supply_point"] as const;
export type SupplyPath = (typeof SUPPLY_PATHS)[number];
export const SUPPLY_PATH_LABELS = labels<SupplyPath>({ known_supply_point: "Supply point already in our records", new_supply_point: "Supply point new to us" });

export const REQUEST_CHANNELS = ["whatsapp", "email", "phone", "in_person", "other"] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];
export const REQUEST_CHANNEL_LABELS = labels<RequestChannel>({ whatsapp: "WhatsApp", email: "Email", phone: "Phone", in_person: "In person", other: "Other" });

/** A lease prepared by us stays a draft until the parties sign it; only a signed copy can pass its check. */
export const LEASE_STATUSES = ["draft", "signed"] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];
export const LEASE_STATUS_LABELS = labels<LeaseStatus>({ draft: "Draft (not signed)", signed: "Signed by the parties" });

/** What a supplier needs for a renewal: its full renewal form, or the signed rate card alone (e.g. Flogas). */
export const RENEWAL_ROUTES = ["full_form", "rate_card_only"] as const;
export type RenewalRoute = (typeof RENEWAL_ROUTES)[number];
export const RENEWAL_ROUTE_LABELS = labels<RenewalRoute>({ full_form: "Full renewal form", rate_card_only: "Rate card only" });

export const SUBMISSION_CHANNELS = ["email", "supplier_portal", "post", "other"] as const;
export type SubmissionChannel = (typeof SUBMISSION_CHANNELS)[number];
export const SUBMISSION_CHANNEL_LABELS = labels<SubmissionChannel>({ email: "Email", supplier_portal: "Supplier portal", post: "Post", other: "Other" });

export const RESPONSE_SOURCES = ["email", "supplier_portal", "phone", "post"] as const;
export type ResponseSource = (typeof RESPONSE_SOURCES)[number];
export const RESPONSE_SOURCE_LABELS = labels<ResponseSource>({ email: "Email", supplier_portal: "Supplier portal", phone: "Phone call", post: "Letter" });

/** The external party's answer to a submission. A sent submission stays pending until one is recorded. */
export const RESPONSE_OUTCOMES = ["accepted", "changes_required", "rejected", "change_confirmed"] as const;
export type ResponseOutcome = (typeof RESPONSE_OUTCOMES)[number];
export const RESPONSE_OUTCOME_LABELS = labels<ResponseOutcome>({
  accepted: "Accepted",
  changes_required: "Changes or more information required",
  rejected: "Rejected",
  change_confirmed: "Change confirmed (effective date)",
});

/**
 * Facts about the case, reduced to presence flags so rules never see personal values.
 * Built by the API (opportunities/facts.ts).
 */
export interface WorkflowFacts {
  /** A case record (paths, request, supply point) has been saved. */
  recorded: boolean;
  customerPath: CustomerPath | null;
  /** Created by the renewal automation from a previous opportunity (an existing client). */
  renewalOfPrevious: boolean;
  requestLogged: boolean;
  supplyPath: SupplyPath | null;
  /** A supply site with an address is linked: matched from our records or added on this deal. */
  hasSupplyPoint: boolean;
  occupancyDate: boolean;
  /** For a supply point new to us: where the MPRN/GPRN and address came from, and who verified them. */
  supplySourceVerified: boolean;
  /** The linked customer is the outgoing account holder (it must be a separate incoming record). */
  incomingIsOutgoing: boolean;
  /** The incoming customer's IBAN is the same as the outgoing customer's. */
  sharedIban: boolean;
  incoming: { contactName: boolean; contactReach: boolean; billingAddress: boolean; iban: boolean };
  landlord: { name: boolean; contact: boolean };
  lease: { hasCopy: boolean; status: LeaseStatus | null; passed: boolean };
  currentSupplier: boolean;
  contractEndDate: boolean;
  /** Bill received and checked (renewal, new to us). Optional evidence: a checklist can stand in for it. */
  billVerified: boolean;
  terms: { complete: boolean; verified: boolean };
  supplier: { renewalRoute: RenewalRoute; outgoingConsentRequired: boolean; monoCopyRequired: boolean } | null;
  submission: {
    count: number;
    latest: { lastOutcome: ResponseOutcome | null; accepted: boolean; externalReference: boolean; effectiveDateConfirmed: boolean } | null;
  };
}

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  /** Shown as a stage-gate issue while not done. Optional items have none. */
  issue?: string;
}

// --- Schemas ---------------------------------------------------------------------

export const workflowCaseSchema = z.object({
  customerPath: z.enum(CUSTOMER_PATHS).nullable().optional(),
  requestChannel: z.enum(REQUEST_CHANNELS).nullable().optional(),
  requestReceivedAt: optDate,
  requestNote: optText(1000),
  supplyPath: z.enum(SUPPLY_PATHS).nullable().optional(),
  /** An existing supply site from our records (known supply point). */
  siteId: id.nullable().optional(),
  outgoingCustomerId: id.nullable().optional(),
  outgoingAccountRef: optText(60),
  outgoingContractRef: optText(60),
  occupancyDate: optDate,
  /** Where the MPRN/GPRN and address of a new supply point came from (e.g. "ESB Networks letter", "meter photo"). */
  supplySource: optText(300),
  noticeDeadline: optDate,
  targetSubmissionDate: optDate,
});
export type WorkflowCaseInput = z.infer<typeof workflowCaseSchema>;

export const supplyPointSearchSchema = z.object({ q: z.string().trim().min(3, "Type at least 3 characters.").max(100) });

export const leaseCheckSchema = z.object({
  status: z.enum(LEASE_STATUSES),
  landlordName: z.string().trim().min(1, "Enter the landlord named on the lease.").max(200),
  tenantName: z.string().trim().min(1, "Enter the tenant named on the lease.").max(200),
  tenancyStartDate: optDate,
  landlordMatches: z.boolean(),
  tenantMatches: z.boolean(),
  addressMatches: z.boolean(),
  datesMatch: z.boolean(),
  signedByLandlord: z.boolean(),
  signedByTenant: z.boolean(),
  notes: optText(1000),
});
export type LeaseCheckInput = z.infer<typeof leaseCheckSchema>;

/** Only a signed lease that matches the case, and is signed by both parties, passes. */
export const leaseCheckPassed = (c: Pick<LeaseCheckInput, "status" | "landlordMatches" | "tenantMatches" | "addressMatches" | "datesMatch" | "signedByLandlord" | "signedByTenant">) =>
  c.status === "signed" && c.landlordMatches && c.tenantMatches && c.addressMatches && c.datesMatch && c.signedByLandlord && c.signedByTenant;

export const submissionSchema = z.object({
  recipient: z.string().trim().min(1, "Enter who it was sent to.").max(200),
  channel: z.enum(SUBMISSION_CHANNELS),
  sentAt: optDate,
  /** The exact file versions sent. */
  documentVersionIds: z.array(id).min(1, "Choose the files that were sent.").max(30),
  deliveryEvidence: z.string().trim().min(1, "Describe the proof of delivery (e.g. the email it was sent from, a portal receipt number).").max(1000),
  note: optText(1000),
});
export type SubmissionInput = z.infer<typeof submissionSchema>;

export const submissionResponseSchema = z
  .object({
    outcome: z.enum(RESPONSE_OUTCOMES),
    receivedVia: z.enum(RESPONSE_SOURCES),
    receivedAt: optDate,
    externalReference: optText(100),
    effectiveDate: optDate,
    reason: optText(1000),
    /** Who corrects a rejected or queried case, and by when. Defaults to the opportunity owner, tomorrow. */
    correctionOwnerId: id.nullable().optional(),
    correctionDueDate: optDate,
  })
  .superRefine((r, ctx) => {
    if (r.outcome === "accepted" && !r.externalReference) ctx.addIssue({ code: "custom", path: ["externalReference"], message: "Enter the external party's reference for the acceptance." });
    if (r.outcome === "change_confirmed" && !r.effectiveDate) ctx.addIssue({ code: "custom", path: ["effectiveDate"], message: "Enter the confirmed effective date." });
    if ((r.outcome === "rejected" || r.outcome === "changes_required") && !r.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Enter the reason the external party gave." });
  });
export type SubmissionResponseInput = z.infer<typeof submissionResponseSchema>;

/** Reminder intervals for the workflows (Settings → workflow.reminders). */
export const workflowRemindersSchema = z.object({
  /** Days after sending before a follow-up task is due if nothing has come back. */
  submissionFollowUpDays: z.number().int().min(1).max(60),
  /** Days before the current contract ends at which an open renewal gets a deadline task. */
  renewalReminderDays: z.array(z.number().int().min(1).max(365)).min(1).max(6),
  /** Days an automated workflow task may be overdue before a manager is asked to step in. */
  escalateAfterDays: z.number().int().min(1).max(60),
});
export type WorkflowReminders = z.infer<typeof workflowRemindersSchema>;
export const DEFAULT_WORKFLOW_REMINDERS: WorkflowReminders = { submissionFollowUpDays: 5, renewalReminderDays: [90, 60, 30, 14], escalateAfterDays: 2 };
