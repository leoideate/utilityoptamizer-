import type { addressSchema } from "@uo/shared";
import type { z } from "zod";

type Address = z.infer<typeof addressSchema>;

const EIRCODE = /\b([AC-FHKNPRTV-Y]\d{2}|D6W)\s?([0-9AC-FHKNPRTV-Y]{4})\b/i;

/**
 * Splits a one-line Irish address ("157 Drimnagh Road Dublin 12 D12 CX84, Co. Dublin") into
 * address fields: the Eircode, the county ("Co. Dublin"), the Dublin postal district as the city
 * (or `area` when the file gives one), and the rest as the first and second lines.
 */
export function parseIrishAddress(text: string, area?: string): Address | null {
  let rest = text.replace(/\s+/g, " ").trim();
  if (!rest) return null;
  const eircode = EIRCODE.exec(rest);
  rest = rest.replace(EIRCODE, " ");
  const county = /\bCo\.?\s+([A-Za-z]+)/i.exec(rest);
  rest = rest.replace(/\bCo\.?\s+[A-Za-z]+/i, " ");
  const district = /\bDublin\s+(\d{1,2}w?)\b/i.exec(rest);
  rest = rest.replace(/\bDublin\s+\d{1,2}w?\b/i, " ");
  const city = area?.trim() || (district ? `Dublin ${district[1].toUpperCase()}` : undefined);
  // A part that only repeats the town ("…, Howth, …" with Area Howth) goes in the town field once.
  const parts = rest
    .split(",")
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((x, i) => i === 0 || !city || x.toLowerCase() !== city.toLowerCase());
  return {
    kind: "trading",
    line1: parts[0] ?? city ?? text.trim(),
    line2: parts.slice(1).join(", ") || undefined,
    city: parts[0] ? city : undefined,
    county: county ? `Co. ${county[1][0].toUpperCase()}${county[1].slice(1).toLowerCase()}` : undefined,
    postcode: eircode ? `${eircode[1]} ${eircode[2]}`.toUpperCase() : undefined,
    country: "IE",
  };
}

export interface KnownAddress {
  line1: string;
  line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
}

/** Customer addresses that say where the business trades, best first (never the home address). */
const KINDS = ["trading", "registered", "postal", "billing"] as const;

/** "Category: Cafe · Address: … · Area: Dublin 12 · Opening hours: …", as the first lead import wrote it. */
const field = (text: string, name: string) => new RegExp(`(?:^|·)\\s*${name}:\\s*([^·]+?)\\s*(?=·|$)`, "i").exec(text)?.[1]?.trim() || undefined;

/**
 * Where the business is, from what the CRM already knows: the customer's trading (or registered,
 * postal, billing) address, else the address an older lead import left in the deal's text. Used to
 * fill a new supply site and supplier forms, so nobody types the address twice.
 */
export function knownSupplyAddress(opp: { nextAction?: string | null; notes?: string | null }, addresses: (KnownAddress & { kind: string })[] = []): KnownAddress | null {
  for (const kind of KINDS) {
    const a = addresses.find((x) => x.kind === kind);
    if (a) return { line1: a.line1, line2: a.line2 ?? null, city: a.city ?? null, county: a.county ?? null, postcode: a.postcode ?? null };
  }
  for (const text of [opp.nextAction, opp.notes]) {
    const raw = text ? field(text, "Address") : undefined;
    const parsed = raw ? parseIrishAddress(raw, field(text!, "Area")) : null;
    if (parsed) return { line1: parsed.line1, line2: parsed.line2 ?? null, city: parsed.city ?? null, county: parsed.county ?? null, postcode: parsed.postcode ?? null };
  }
  return null;
}

/** A deal's business category as a form's "type of business" ("Other" says nothing, so it's left out). */
const CATEGORY_TYPE: Record<string, string> = { restaurant: "Restaurant", cafe: "Café", salon: "Salon", mobile_shop: "Mobile shop", takeaway: "Takeaway" };

/**
 * The business type: the customer's own, else the deal's business category, else the "Category:"
 * an older lead import left in the deal's text.
 */
export function knownBusinessType(opp: { nextAction?: string | null; notes?: string | null; businessCategory?: string | null }, customer?: { businessType: string | null } | null): string | null {
  if (customer?.businessType) return customer.businessType;
  if (opp.businessCategory && CATEGORY_TYPE[opp.businessCategory]) return CATEGORY_TYPE[opp.businessCategory];
  for (const text of [opp.nextAction, opp.notes]) {
    const category = text ? field(text, "Category") : undefined;
    if (category) return category;
  }
  return null;
}
