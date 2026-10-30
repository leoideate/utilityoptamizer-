import type { ApprovalState, LeadSource, Outcome, ProductInterest, SaleType, ServiceType, StageKey, SupplyChange } from "@uo/shared";

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OpportunityRow {
  id: string;
  number: number;
  name: string;
  serviceType: ServiceType;
  saleType: SaleType;
  outcome: Outcome;
  probability: number;
  expectedRevenue: number | null;
  followUpDate: string | null;
  renewalDate: string | null;
  updatedAt: string;
  companyName: string | null;
  businessCategory: import("@uo/shared").BusinessCategory | null;
  contactName: string | null;
  stage: { key: StageKey; name: string };
  owner: { id: string; name: string } | null;
  customer: { id: string; legalName: string } | null;
  selectedSupplier: { id: string; name: string } | null;
}

export interface Workspace extends Omit<OpportunityRow, "stage"> {
  notes: string | null;
  stage: { id: string; key: StageKey; name: string };
  customerId: string | null;
  ownerId: string | null;
  email: string | null;
  phone: string | null;
  leadSource: LeadSource;
  leadSourceDetail: string | null;
  campaign: string | null;
  nextAction: string | null;
  expectedCloseDate: string | null;
  visitDate: string | null;
  contactRole: string | null;
  productInterest: ProductInterest[];
  supplyChanges: SupplyChange[];
  internalApproval: ApprovalState;
  selectedSupplierId: string | null;
  applicationStatus: string | null;
  activationDate: string | null;
  wonAt: string | null;
  lostAt: string | null;
  lostReason: string | null;
  createdAt: string;
  firstContactAt: string | null;
  lastContactAt: string | null;
  stageEnteredAt: string;
  active: boolean;
  customer: { id: string; legalName: string; tradingName: string | null; vatRegistered: string | null; vatNumber: string | null; website: string | null; contacts: { id: string; firstName: string; lastName: string | null; email: string | null; phone: string | null; mobile: string | null }[] } | null;
  previousOpportunity: { id: string; number: number; name: string } | null;
  renewals: { id: string; number: number; name: string; outcome: Outcome }[];
  /** Supplier applications on the deal and how many documents each has generated. */
  supplierApps: { kind: string; _count: { versions: number } }[];
  _count: { sites: number; contracts: number; merchantApps: number; documents: number; activities: number };
  gates: Record<"proposal_sent" | "supplier_selected" | "documents_prepared" | "submitted" | "live_won", string[]>;
  permissions: { write: boolean; assign: boolean; approve: boolean; submit: boolean; activate: boolean; reopenCompleted: boolean };
}
