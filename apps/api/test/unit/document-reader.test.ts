import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { BillReading } from "@uo/shared";
import { ClaudeDocumentReader, ReadFailed, billWireSchema, cardWireSchema, cleanBill } from "../../src/ai/document-reader";

const blank: BillReading = {
  readable: true,
  customerName: null,
  supplyAddress: null,
  fuel: null,
  mprn: null,
  gprn: null,
  meterNumber: null,
  supplierName: null,
  accountNumber: null,
  billDate: null,
  periodStart: null,
  periodEnd: null,
  tariffName: null,
  dayRate: null,
  nightRate: null,
  gasRate: null,
  standingChargePerDay: null,
  usageKwh: null,
  annualConsumptionKwh: null,
  mic: null,
  readings: [],
  notes: null,
};

/** What the model returns for a bill: every field present, empty strings for "not shown". */
const blankWire = {
  readable: true,
  customerName: "",
  supplyAddress: { line1: "", line2: "", city: "", county: "", postcode: "" },
  fuel: "unknown",
  mprn: "",
  gprn: "",
  meterNumber: "",
  supplierName: "",
  accountNumber: "",
  billDate: "",
  periodStart: "",
  periodEnd: "",
  tariffName: "",
  dayRate: "",
  nightRate: "",
  gasRate: "",
  standingChargePerDay: "",
  usageKwh: "",
  annualConsumptionKwh: "",
  mic: "",
  readings: [] as { register: string; value: string; readingDate: string; readingType: string }[],
  notes: "",
};

/** Counts the fields with union types (anyOf or a list of types) in a JSON schema. */
function unions(schema: unknown): number {
  if (!schema || typeof schema !== "object") return 0;
  const node = schema as Record<string, unknown>;
  const own = Array.isArray(node.anyOf) || Array.isArray(node.type) ? 1 : 0;
  return own + Object.values(node).reduce<number>((n, v) => n + (Array.isArray(v) ? v.reduce<number>((m, x) => m + unions(x), 0) : unions(v)), 0);
}

/** A stand-in for client.messages that records the request and answers like messages.parse. */
function fakeMessages(answer: { stop_reason?: string; parsed_output: unknown } | Error) {
  const calls: Record<string, unknown>[] = [];
  const messages = {
    parse: async (params: Record<string, unknown>) => {
      calls.push(params);
      if (answer instanceof Error) throw answer;
      return { stop_reason: "end_turn", usage: { input_tokens: 1500, output_tokens: 300 }, ...answer };
    },
  };
  return { calls, messages: messages as unknown as ConstructorParameters<typeof ClaudeDocumentReader>[0] };
}

describe("the Claude document reader", () => {
  it("asks for answer formats within the API's limit on union-typed fields", () => {
    // The API refuses schemas with more than 16 nullable or union-typed fields; ours use none.
    expect(unions(zodOutputFormat(billWireSchema).schema)).toBe(0);
    expect(unions(zodOutputFormat(cardWireSchema).schema)).toBe(0);
  });

  it("sends a PDF bill as a document with a structured-output schema to the configured model", async () => {
    const { calls, messages } = fakeMessages({
      parsed_output: {
        ...blankWire,
        fuel: "electricity",
        mprn: "10 012 345 678",
        supplierName: "Flogas",
        dayRate: "0.2814",
        annualConsumptionKwh: "14,500",
        supplyAddress: { line1: "Unit 4, Harbour Road", line2: "", city: "Howth", county: "Dublin", postcode: "D13 X2Y4" },
        readings: [{ register: "Day", value: "045123", readingDate: "2026-09-30", readingType: "actual" }],
      },
    });
    const reading = await new ClaudeDocumentReader(messages, "claude-haiku-5-5").readBill(Buffer.from("%PDF-1.4"), "application/pdf");
    expect(reading).toMatchObject({
      fuel: "electricity",
      mprn: "10012345678",
      supplierName: "Flogas",
      dayRate: 0.2814,
      nightRate: null,
      annualConsumptionKwh: 14500,
      customerName: null,
      supplyAddress: { line1: "Unit 4, Harbour Road", line2: null, city: "Howth", postcode: "D13 X2Y4" },
      readings: [{ register: "Day", value: "045123", readingDate: "2026-09-30", readingType: "actual" }],
      notes: null,
    });
    const req = calls[0] as { model: string; messages: { content: { type: string; source?: { media_type: string } }[] }[]; output_config: { format: { type: string } } };
    expect(req.model).toBe("claude-haiku-5-5");
    expect(req.messages[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
    expect(req.output_config.format.type).toBe("json_schema");
  });

  it("sends a photo as an image and refuses formats the model can't read", async () => {
    const { calls, messages } = fakeMessages({ parsed_output: blankWire });
    const reader = new ClaudeDocumentReader(messages, "claude-haiku-5-5");
    await reader.readBill(Buffer.from("x"), "image/png");
    expect((calls[0] as { messages: { content: { type: string }[] }[] }).messages[0].content[0].type).toBe("image");
    await expect(reader.readBill(Buffer.from("x"), "image/heic")).rejects.toThrow(ReadFailed);
  });

  it("turns refusals, cut-off answers and API errors into messages for the user", async () => {
    await expect(new ClaudeDocumentReader(fakeMessages({ stop_reason: "refusal", parsed_output: null }).messages, "m").readBill(Buffer.from("x"), "application/pdf")).rejects.toThrow(/declined/);
    await expect(new ClaudeDocumentReader(fakeMessages({ stop_reason: "max_tokens", parsed_output: null }).messages, "m").readBill(Buffer.from("x"), "application/pdf")).rejects.toThrow(/couldn't finish/);
    const rejected = new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key", new Headers());
    await expect(new ClaudeDocumentReader(fakeMessages(rejected).messages, "m").readBill(Buffer.from("x"), "application/pdf")).rejects.toThrow(/API key was rejected/);
  });

  it("reads business cards into the card fields", async () => {
    const { messages } = fakeMessages({ parsed_output: { firstName: "Mary", lastName: "Murphy", company: "Test Trading Ltd", jobTitle: " ", email: "mary@testtrading.ie", phone: "", mobile: "087 123 4567", website: "", address: "" } });
    expect(await new ClaudeDocumentReader(messages, "m").readCard(Buffer.from("x"), "image/jpeg")).toMatchObject({ firstName: "Mary", company: "Test Trading Ltd", jobTitle: null, phone: null, mobile: "087 123 4567" });
  });
});

describe("cleaning a bill reading", () => {
  it("drops values that aren't well formed rather than passing them on", () => {
    const r = cleanBill({
      ...blank,
      gprn: "123 4567",
      billDate: "03/09/2026",
      periodEnd: "2026-09-01",
      dayRate: 28.14, // cent, not euro: out of range
      standingChargePerDay: 0.65,
      readings: [
        { register: "Day", value: " 012345 ", readingDate: "2026-09-01", readingType: "actual" },
        { register: "Night", value: "unclear", readingDate: null, readingType: "estimated" },
      ],
      notes: "  ",
    });
    expect(r).toMatchObject({ gprn: "1234567", billDate: null, periodEnd: "2026-09-01", dayRate: null, standingChargePerDay: 0.65, notes: null });
    expect(r.readings).toEqual([{ register: "Day", value: "012345", readingDate: "2026-09-01", readingType: "actual" }]);
  });
});
