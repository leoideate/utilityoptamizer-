/**
 * Which open deal an email or call from a customer belongs to: the only one; or, if there are
 * several, the one owned by the staff member involved (when exactly one is). Otherwise none, and
 * the caller links the customer only.
 */
export function pickDeal<T extends { ownerId: string | null }>(deals: T[], staffId: string | null): T | undefined {
  if (deals.length === 1) return deals[0];
  if (!staffId) return undefined;
  const owned = deals.filter((d) => d.ownerId === staffId);
  return owned.length === 1 ? owned[0] : undefined;
}

/** Open, active deals: the ones new contact should land on. */
export const OPEN_DEAL = { outcome: "open", active: true } as const;
