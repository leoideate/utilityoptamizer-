import type { Prisma } from "@prisma/client";

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const pageArgs = (page: number, pageSize: number) => ({ skip: (page - 1) * pageSize, take: pageSize });

/** Prisma Decimal (or null) -> number, for responses and rules. */
export const num = (d: Prisma.Decimal | number | null | undefined): number | null => (d == null ? null : Number(d));

/** "YYYY-MM-DD" -> Date at UTC midnight (for @db.Date columns). Preserves undefined/null. */
export function dateOnly(iso: string): Date;
export function dateOnly(iso: string | null | undefined): Date | null | undefined;
export function dateOnly(iso: string | null | undefined): Date | null | undefined {
  if (iso === undefined) return undefined;
  if (iso === null) return null;
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Date column -> "YYYY-MM-DD". */
export const isoDay = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * National number without country code or trunk 0, for duplicate matching across formats:
 * "+353 87 123 4567", "00353871234567" and "087 123 4567" all become "871234567".
 */
export const phoneKey = (p: string | null | undefined): string | null => {
  let d = (p ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("353") || d.startsWith("44")) d = d.slice(d.startsWith("353") ? 3 : 2);
  d = d.replace(/^0+/, "");
  return d.length >= 7 ? d : null;
};

/** Drops keys whose value is undefined, so partial updates don't overwrite with undefined. */
export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
