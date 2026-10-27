import { type AssistantAttachmentKind, BILL_READING_TYPES, type BillReading } from "@uo/shared";
import type { CardFields } from "../ocr/card-parser";

/** File types the reader takes for each kind: bills as PDFs or photos, cards as photos. */
export const ATTACHMENT_TYPES: Record<AssistantAttachmentKind, readonly string[]> = {
  bill: BILL_READING_TYPES,
  card: ["image/jpeg", "image/png", "image/webp"],
};

/** What the user is taken to be asking when they attach a file without a question. */
export const DEFAULT_QUESTION: Record<AssistantAttachmentKind, string> = {
  bill: "Here's a customer's energy bill. Check whether we already have them, and suggest the next steps.",
  card: "Here's a business card. Check whether we already have this contact, and suggest the next steps.",
};

const cent = (euro: number | null) => (euro === null ? null : `${(euro * 100).toFixed(2)} c/kWh`);
const lines = (title: string, rows: [string, string | number | null | undefined][]) =>
  [title, ...rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `- ${k}: ${v}`)].join("\n");

/**
 * The details read from a bill or card, as the text stored with the question. The user sees it in
 * the chat and the model gets it with each later turn; the file itself isn't kept. Bank details
 * never get here: the reader is told to leave them out.
 */
export function attachmentText(kind: AssistantAttachmentKind, read: BillReading | CardFields): string {
  if (kind === "card") {
    const c = read as CardFields;
    return lines("📎 Business card, read by AI (check before using):", [
      ["Name", [c.firstName, c.lastName].filter(Boolean).join(" ")],
      ["Job title", c.jobTitle],
      ["Company", c.company],
      ["Email", c.email],
      ["Phone", c.phone],
      ["Mobile", c.mobile],
      ["Website", c.website],
      ["Address", c.address],
    ]);
  }
  const b = read as BillReading;
  if (!b.readable) return "📎 Energy bill: the AI couldn't read this as an energy bill.";
  const a = b.supplyAddress;
  return lines("📎 Energy bill, read by AI (check before using):", [
    ["Customer", b.customerName],
    ["Supply address", a ? [a.line1, a.line2, a.city, a.county, a.postcode].filter(Boolean).join(", ") : null],
    ["Fuel", b.fuel],
    ["MPRN", b.mprn],
    ["GPRN", b.gprn],
    ["Meter number", b.meterNumber],
    ["Supplier", b.supplierName],
    ["Account number", b.accountNumber],
    ["Bill date", b.billDate],
    ["Billing period", b.periodStart && b.periodEnd ? `${b.periodStart} to ${b.periodEnd}` : null],
    ["Tariff", b.tariffName],
    ["Day rate", cent(b.dayRate)],
    ["Night rate", cent(b.nightRate)],
    ["Gas rate", cent(b.gasRate)],
    ["Standing charge", b.standingChargePerDay === null ? null : `€${b.standingChargePerDay} a day`],
    ["Usage this period", b.usageKwh === null ? null : `${b.usageKwh} kWh`],
    ["Annual consumption", b.annualConsumptionKwh === null ? null : `${b.annualConsumptionKwh} kWh`],
    ["MIC", b.mic === null ? null : `${b.mic} kVA`],
    ["Readings", b.readings.map((r) => `${r.register ?? "Meter"} ${r.value} (${r.readingType}${r.readingDate ? `, ${r.readingDate}` : ""})`).join("; ") || null],
    ["To check", b.notes],
  ]);
}
