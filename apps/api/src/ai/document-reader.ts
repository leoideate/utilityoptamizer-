import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { type BillReading, normalizeIdentifier } from "@uo/shared";
import { z } from "zod";
import { NotConfigured } from "../integrations/adapters";
import type { CardFields } from "../ocr/card-parser";

/**
 * Reads documents with an AI model and returns suggested values. Nothing here saves anything:
 * callers show the values to a person, who chooses what to use.
 */
export interface DocumentReader {
  /** The model's name, recorded in the audit log; "none" when unconfigured. */
  readonly model: string;
  readonly configured: boolean;
  readBill(file: Buffer, mimeType: string): Promise<BillReading>;
  readCard(image: Buffer, mimeType: string): Promise<CardFields>;
}

export const DOCUMENT_READER = Symbol("DOCUMENT_READER");

/** A read that didn't produce a result; the message is shown to the user. */
export class ReadFailed extends Error {}

export class UnconfiguredDocumentReader implements DocumentReader {
  readonly model = "none";
  readonly configured = false;
  async readBill(): Promise<BillReading> {
    throw new NotConfigured("AI document reading (ANTHROPIC_API_KEY)");
  }
  async readCard(): Promise<CardFields> {
    throw new NotConfigured("AI document reading (ANTHROPIC_API_KEY)");
  }
}

/**
 * What the model is asked to return. Structured outputs allow only a few nullable (union-typed)
 * fields per schema, so nothing here is nullable: an empty string means "not shown", numbers come
 * back as text, and the readers turn the result into the CRM's own shapes.
 */
export const cardWireSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  company: z.string(),
  jobTitle: z.string(),
  email: z.string(),
  phone: z.string(),
  mobile: z.string(),
  website: z.string(),
  address: z.string(),
});

export const billWireSchema = z.object({
  readable: z.boolean(),
  customerName: z.string(),
  supplyAddress: z.object({ line1: z.string(), line2: z.string(), city: z.string(), county: z.string(), postcode: z.string() }),
  fuel: z.enum(["electricity", "gas", "unknown"]),
  mprn: z.string(),
  gprn: z.string(),
  meterNumber: z.string(),
  supplierName: z.string(),
  accountNumber: z.string(),
  billDate: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  tariffName: z.string(),
  dayRate: z.string(),
  nightRate: z.string(),
  gasRate: z.string(),
  standingChargePerDay: z.string(),
  usageKwh: z.string(),
  annualConsumptionKwh: z.string(),
  mic: z.string(),
  readings: z.array(z.object({ register: z.string(), value: z.string(), readingDate: z.string(), readingType: z.enum(["actual", "estimated", "customer", "smart"]) })),
  notes: z.string(),
});
type BillWire = z.infer<typeof billWireSchema>;

const orNull = (s: string) => s.trim() || null;
const numberOrNull = (s: string) => {
  const t = s.replace(/[€,\s]/g, "");
  return t && Number.isFinite(Number(t)) ? Number(t) : null;
};

/** The model's answer in the CRM's BillReading shape (empty strings become null, text numbers numbers). */
export function fromWire(w: BillWire): BillReading {
  const a = w.supplyAddress;
  return {
    readable: w.readable,
    customerName: orNull(w.customerName),
    supplyAddress: a.line1.trim() ? { line1: a.line1.trim(), line2: orNull(a.line2), city: orNull(a.city), county: orNull(a.county), postcode: orNull(a.postcode) } : null,
    fuel: w.fuel === "unknown" ? null : w.fuel,
    mprn: orNull(w.mprn),
    gprn: orNull(w.gprn),
    meterNumber: orNull(w.meterNumber),
    supplierName: orNull(w.supplierName),
    accountNumber: orNull(w.accountNumber),
    billDate: orNull(w.billDate),
    periodStart: orNull(w.periodStart),
    periodEnd: orNull(w.periodEnd),
    tariffName: orNull(w.tariffName),
    dayRate: numberOrNull(w.dayRate),
    nightRate: numberOrNull(w.nightRate),
    gasRate: numberOrNull(w.gasRate),
    standingChargePerDay: numberOrNull(w.standingChargePerDay),
    usageKwh: numberOrNull(w.usageKwh),
    annualConsumptionKwh: numberOrNull(w.annualConsumptionKwh),
    mic: numberOrNull(w.mic),
    readings: w.readings.map((r) => ({ register: orNull(r.register), value: r.value, readingDate: orNull(r.readingDate), readingType: r.readingType })),
    notes: orNull(w.notes),
  };
}

const SYSTEM =
  "You read documents for the CRM of an Irish energy and card-payments broker. A person checks everything you return before it is saved, so copy what is printed and use an empty string for anything that isn't shown; never guess or fill in typical values.";

const BILL_INSTRUCTIONS = `This is a customer's energy bill (electricity or gas), usually from an Irish supplier. Extract its details.
- mprn: the 11-digit MPRN (starts with 10), digits only. gprn: the 7-digit GPRN, digits only.
- supplierName: the company that issued the bill. accountNumber: the customer's account number with that supplier.
- customerName: the account holder or business name as printed. supplyAddress: the supply (premises) address, not a billing or PO box address if they differ.
- Dates as YYYY-MM-DD. periodStart and periodEnd: the billing period.
- dayRate, nightRate, gasRate: unit rates in euro per kWh excluding VAT (14.52 cent is 0.1452). standingChargePerDay: euro per day excluding VAT; if the bill only shows it for the period, divide by the days in the period and say so in notes.
- usageKwh: kWh used in this billing period. annualConsumptionKwh: only if the bill states an annual figure.
- readings: each meter reading printed, with its register (Day, Night, 24hr...; an empty string for a single gas register), its date if printed (otherwise an empty string), and whether it is actual, estimated, customer or smart.
- Never include bank account numbers, IBANs, BICs, card numbers or direct debit references anywhere, including notes.
- Numbers (rates, standing charge, kWh, MIC) as plain numbers without units or currency, e.g. "0.1452" or "14500"; an empty string when not shown. fuel: "unknown" if it isn't clear.
- readable: false if this isn't an energy bill or you can't read it.
- notes: one or two short sentences, in plain words for the CRM user, on anything they should double-check on the bill (unclear digits, more than one meter, missing pages, a charge you couldn't place); otherwise an empty string. Don't mention fields, schemas, formats or these instructions.`;

const CARD_INSTRUCTIONS = `This is a photo of a business card. Extract the contact's details as printed.
- phone is a landline or office number, mobile a mobile number (Irish mobiles start 08 or +353 8; UK mobiles 07 or +44 7).
- address on one line, as printed.
- Use an empty string for anything not on the card.`;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (s: string | null) => (s && ISO_DAY.test(s) ? s : null);
const amount = (n: number | null, max: number) => (n !== null && Number.isFinite(n) && n >= 0 && n <= max ? n : null);
const text = (s: string | null) => s?.trim() || null;

/** Keeps only well-formed values, so a misread never reaches the review screen as a date or rate it isn't. */
export function cleanBill(r: BillReading): BillReading {
  return {
    ...r,
    customerName: text(r.customerName),
    mprn: normalizeIdentifier(r.mprn),
    gprn: normalizeIdentifier(r.gprn),
    meterNumber: text(r.meterNumber),
    supplierName: text(r.supplierName),
    accountNumber: text(r.accountNumber),
    billDate: day(r.billDate),
    periodStart: day(r.periodStart),
    periodEnd: day(r.periodEnd),
    tariffName: text(r.tariffName),
    dayRate: amount(r.dayRate, 5),
    nightRate: amount(r.nightRate, 5),
    gasRate: amount(r.gasRate, 5),
    standingChargePerDay: amount(r.standingChargePerDay, 100),
    usageKwh: amount(r.usageKwh, 1e9),
    annualConsumptionKwh: amount(r.annualConsumptionKwh, 1e9),
    mic: amount(r.mic, 100_000),
    // Bills often print readings without their own date; they were taken at the end of the billing period.
    readings: r.readings.filter((x) => /^\d+(\.\d+)?$/.test(x.value.trim())).map((x) => ({ ...x, value: x.value.trim(), readingDate: day(x.readingDate) ?? day(r.periodEnd) })),
    notes: text(r.notes),
  };
}

type Messages = Pick<Anthropic["messages"], "parse">;

/** Claude, through the Messages API with a structured-output schema. */
export class ClaudeDocumentReader implements DocumentReader {
  private readonly log = new Logger(ClaudeDocumentReader.name);
  readonly configured = true;

  constructor(
    private readonly messages: Messages,
    readonly model: string,
  ) {}

  static create(apiKey: string, model: string) {
    return new ClaudeDocumentReader(new Anthropic({ apiKey, timeout: 90_000, maxRetries: 2 }).messages, model);
  }

  async readBill(file: Buffer, mimeType: string) {
    return cleanBill(fromWire(await this.extract(billWireSchema, file, mimeType, BILL_INSTRUCTIONS)));
  }

  async readCard(image: Buffer, mimeType: string) {
    const c = await this.extract(cardWireSchema, image, mimeType, CARD_INSTRUCTIONS);
    return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, text(v)])) as unknown as CardFields;
  }

  private async extract<S extends z.ZodType>(schema: S, file: Buffer, mimeType: string, instructions: string): Promise<z.infer<S>> {
    const data = file.toString("base64");
    const source =
      mimeType === "application/pdf"
        ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data } } as const)
        : ({ type: "image", source: { type: "base64", media_type: imageType(mimeType), data } } as const);
    let res;
    try {
      res = await this.messages.parse({
        model: this.model,
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{ role: "user", content: [source, { type: "text", text: instructions }] }],
        output_config: { format: zodOutputFormat(schema) },
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        this.log.error({ status: e.status }, "The Anthropic API key was rejected");
        throw new ReadFailed("AI reading isn't working: the API key was rejected. An administrator needs to check it.");
      }
      if (e instanceof Anthropic.APIError) {
        this.log.warn({ status: e.status, err: e.message }, "AI read failed");
        throw new ReadFailed("The file couldn't be read right now. Try again in a minute.");
      }
      throw e;
    }
    this.log.log({ model: this.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }, "AI read");
    if (res.stop_reason === "refusal") throw new ReadFailed("The AI declined to read this file. Enter the details by hand.");
    if (res.stop_reason === "max_tokens" || !res.parsed_output) throw new ReadFailed("The AI couldn't finish reading this file. Enter the details by hand.");
    return res.parsed_output as z.infer<S>;
  }
}

function imageType(mimeType: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (mimeType === "image/png" || mimeType === "image/gif" || mimeType === "image/webp") return mimeType;
  if (mimeType === "image/jpeg") return mimeType;
  throw new ReadFailed("The AI can read PDFs and JPG, PNG or WEBP photos. Upload the file in one of those formats.");
}
