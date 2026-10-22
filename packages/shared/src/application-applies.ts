import { bordGaisElectricityApplies } from "./bord-gais";
import { flogasElectricityApplies } from "./flogas";
import type { ApplicationDeal, SupplierApplicationKind } from "./supplier-applications";

/** Whether a supplier application applies to a deal right now: its tab shows, and it can be generated and sent. */
export function supplierApplicationApplies(kind: SupplierApplicationKind, deal: ApplicationDeal): boolean {
  return kind === "flogas_electricity" ? flogasElectricityApplies(deal) : bordGaisElectricityApplies(deal);
}

/** The supplier application a deal currently has, if any (at most one supplier is selected). */
export function applicableSupplierApplication(deal: ApplicationDeal): SupplierApplicationKind | null {
  if (flogasElectricityApplies(deal)) return "flogas_electricity";
  if (bordGaisElectricityApplies(deal)) return "bord_gais_electricity";
  return null;
}
