/**
 * The two working interfaces ("desks"). Sales (office salespeople and field agents) captures
 * leads, scans business cards, collects the customer's bill, meter readings and details and
 * closes the sale. Back office takes the deal from Supplier selected: supplier forms, checks,
 * signatures, submission and the external party's response. Desks only shape the interface;
 * the API enforces permissions from the capability matrix.
 */
import type { Role } from "./enums";
import { type StageKey, isAtOrAfter } from "./stages";

export const DESKS = ["sales", "back_office"] as const;
export type Desk = (typeof DESKS)[number];
export const DESK_LABELS: Record<Desk, string> = { sales: "Sales", back_office: "Back office" };

/** Desks a user can work at, the first being their default. Managers and administrators have both. */
export function desksFor(roles: readonly Role[]): Desk[] {
  const sales = roles.includes("salesperson");
  const back = roles.some((r) => r === "operations" || r === "compliance" || r === "finance");
  const both = roles.some((r) => r === "manager" || r === "administrator");
  if (both || (sales && back)) return ["sales", "back_office"];
  return back ? ["back_office"] : ["sales"];
}

/** Once the client has agreed and the supplier is chosen, the deal is the back office's to complete. */
export const HANDOVER_STAGE: StageKey = "supplier_selected";

/** Handed over to the back office. A scheduled renewal is back at the start of the sales cycle. */
export function isHandedOver(stage: StageKey | null | undefined): boolean {
  return !!stage && stage !== "renewal_scheduled" && isAtOrAfter(stage, HANDOVER_STAGE);
}
