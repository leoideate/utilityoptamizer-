import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { type BillReading, billReadingSchema, normalizeIdentifier } from "@uo/shared";
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

const cardSchema = z.object({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
  website: z.string().nullable(),
  address: z.string().nullable(),
});

const SYSTEM =
  "You read documents for the CRM of an Irish energy and card-payments broker. A person checks everything you return before it is saved, so copy what is printed and use null for anything that isn't shown; never guess or fill in typical values.";

const BILL_INSTRUCTIONS = `This is a customer's energy bill (electricity or gas), usually from an Irish supplier. Extract its details.
- mprn: the 11-digit MPRN (starts with 10), digits only. gprn: the 7-digit GPRN, digits only.
- supplierName: the company that issued the bill. accountNumber: the customer's account number with that supplier.
- customerName: the account holder or business name as printed. supplyAddress: the supply (premises) address, not a billing or PO box address if they differ.
- Dates as YYYY-MM-DD. periodStart and periodEnd: the billing period.
- dayRate, nightRate, gasRate: unit rates in euro per kWh excluding VAT (14.52 cent is 0.1452). standingChargePerDay: euro per day excluding VAT; if the bill only shows it for the period, divide by the days in the period and say so in notes.
- usageKwh: kWh used in this billing period. annualConsumptionKwh: only if the bill states an annual figure.
- readings: each meter reading printed, with its register (Day, Night, 24hr...) and whether it is actual, estimated, customer or smart.
- Never include bank account numbers, IBANs, BICs, card numbers or direct debit references anywhere, including notes.
- readable: false if this isn't an energy bill or you can't read it.
- notes: one or two short sentences on anything a person should double-check (unclear digits, more than one meter, missing pages); otherwise null.`;

const CARD_INSTRUCTIONS = `This is a photo of a business card. Extract the contact's details as printed.
- phone is a landline or office number, mobile a mobile number (Irish mobiles start 08 or +353 8; UK mobiles 07 or +44 7).
- address on one line, as printed.
- Use null for anything not on the card.`;

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
    readings: r.readings.filter((x) => /^\d+(\.\d+)?$/.test(x.value.trim())).map((x) => ({ ...x, value: x.value.trim(), readingDate: day(x.readingDate) })),
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
    return cleanBill(await this.extract(billReadingSchema, file, mimeType, BILL_INSTRUCTIONS));
  }

  async readCard(image: Buffer, mimeType: string) {
    const c = await this.extract(cardSchema, image, mimeType, CARD_INSTRUCTIONS);
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
