/**
 * Hand-over to the back office. Sales (office salespeople and field agents) captures leads and
 * closes the sale; from Supplier selected the back office completes the deal: supplier forms,
 * checks, signatures, submission and the external party's response. Everyone works in one
 * interface; the API enforces permissions from the capability matrix.
 */
import { type StageKey, isAtOrAfter } from "./stages";

/** Once the client has agreed and the supplier is chosen, the deal is the back office's to complete. */
export const HANDOVER_STAGE: StageKey = "supplier_selected";

/** Handed over to the back office. A scheduled renewal is back at the start of the sales cycle. */
export function isHandedOver(stage: StageKey | null | undefined): boolean {
  return !!stage && stage !== "renewal_scheduled" && isAtOrAfter(stage, HANDOVER_STAGE);
}
