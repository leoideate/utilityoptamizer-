export const STAGE_KEYS = [
  "new_lead",
  "call_scheduled",
  "contacted",
  "interested",
  "details_requested",
  "details_received",
  "comparison_prepared",
  "proposal_sent",
  "client_reviewing",
  "supplier_selected",
  "documents_prepared",
  "awaiting_signature",
  "internal_review",
  "submitted",
  "compliance_query",
  "awaiting_confirmation",
  "live_won",
  "renewal_scheduled",
] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export interface StageDef {
  key: StageKey;
  name: string;
  probability: number;
  /** Who the deal is waiting on, used by the "Awaiting …" saved views. */
  waitingOn?: "customer" | "supplier" | "worldpay" | "internal";
  /** Names an existing stage may have; matched after normalisation when migrating. */
  aliases?: string[];
}

/** Canonical pipeline in order. "Lost" is an outcome, not a stage. */
export const STAGES: readonly StageDef[] = [
  { key: "new_lead", name: "New Lead", probability: 5, aliases: ["New"] },
  { key: "call_scheduled", name: "Call Scheduled", probability: 10 },
  { key: "contacted", name: "Contacted", probability: 15 },
  { key: "interested", name: "Interested", probability: 20, aliases: ["Qualified"] },
  { key: "details_requested", name: "Details Requested", probability: 25, waitingOn: "customer" },
  { key: "details_received", name: "Details Received", probability: 30 },
  { key: "comparison_prepared", name: "Comparison or Pricing Prepared", probability: 40, aliases: ["Comparison/Pricing Prepared"] },
  { key: "proposal_sent", name: "Proposal Sent", probability: 50, waitingOn: "customer", aliases: ["Proposition", "Proposal"] },
  { key: "client_reviewing", name: "Client Reviewing", probability: 55, waitingOn: "customer" },
  { key: "supplier_selected", name: "Supplier or Product Selected", probability: 60 },
  { key: "documents_prepared", name: "Documents Prepared", probability: 65 },
  { key: "awaiting_signature", name: "Awaiting Signature", probability: 70, waitingOn: "customer" },
  { key: "internal_review", name: "Internal Review", probability: 75, waitingOn: "internal" },
  { key: "submitted", name: "Submitted", probability: 80, waitingOn: "supplier" },
  { key: "compliance_query", name: "Compliance Query", probability: 80, waitingOn: "supplier" },
  { key: "awaiting_confirmation", name: "Awaiting Confirmation", probability: 90, waitingOn: "supplier" },
  { key: "live_won", name: "Live / Won", probability: 100, aliases: ["Won", "Live"] },
  { key: "renewal_scheduled", name: "Renewal Scheduled", probability: 20, aliases: ["Renewal"] },
];

export function stageDef(key: StageKey): StageDef {
  const d = STAGES.find((s) => s.key === key);
  if (!d) throw new Error(`Unknown stage ${key}`);
  return d;
}

/** 1-based position in the pipeline. */
export function stageIndex(key: StageKey): number {
  return STAGE_KEYS.indexOf(key) + 1;
}

export function isAtOrAfter(stage: StageKey, gate: StageKey): boolean {
  return stageIndex(stage) >= stageIndex(gate);
}

export function stagesBetween(from: StageKey, to: StageKey): StageKey[] {
  return STAGE_KEYS.filter((k) => stageIndex(k) >= stageIndex(from) && stageIndex(k) <= stageIndex(to));
}

export function normalizeStageName(name: string): string {
  return name.toLowerCase().replace(/&/g, "and").replace(/\bor\b/g, "").replace(/[^a-z0-9]/g, "");
}
