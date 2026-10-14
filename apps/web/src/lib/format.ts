import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const eur0 = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const compact = new Intl.NumberFormat("en-IE", { notation: "compact", maximumFractionDigits: 1 });

export const money = (n: number | null | undefined, exact = false) => (n == null ? "—" : (exact ? eur2 : eur0).format(n));
export const moneyCompact = (n: number | null | undefined) => (n == null ? "—" : `€${compact.format(n)}`);
export const num = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-IE").format(n));
export const pct = (n: number | null | undefined) => (n == null ? "—" : `${n}%`);

/** Calendar dates arrive as "YYYY-MM-DD" or midnight UTC; they're shown in UTC so they never shift a day. */
export function date(value: string | Date | null | undefined) {
  if (!value) return "—";
  const s = typeof value === "string" ? value : value.toISOString();
  const calendar = s.length === 10 || s.endsWith("T00:00:00.000Z");
  return new Date(s.length === 10 ? `${s}T00:00:00Z` : s).toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric", timeZone: calendar ? "UTC" : undefined });
}

export function dateTime(value: string | Date | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function relative(value: string | Date) {
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`;
  return date(value);
}

export const isoDay = (v: string | null | undefined) => (v ? v.slice(0, 10) : "");
export const ref = (n: number) => `UO-${String(n).padStart(6, "0")}`;
export const todayIso = () => new Date().toISOString().slice(0, 10);
