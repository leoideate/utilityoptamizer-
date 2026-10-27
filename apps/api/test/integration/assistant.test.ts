import type Anthropic from "@anthropic-ai/sdk";
import type { BillReading } from "@uo/shared";
import { DOCUMENT_READER, type DocumentReader } from "../../src/ai/document-reader";
import { ASSISTANT_MODEL } from "../../src/assistant/assistant.service";
import { ENV, loadEnv } from "../../src/config/env";
import { type Client, type TestApp, createTestApp, expectStatus, pdf, userAndClient } from "../support/app";
import { createOpportunity } from "../support/fixtures";

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Reply = { stop_reason: Anthropic.StopReason; content: unknown[] };

/** Stands in for Claude: answers from a script (or a default text), recording every request. */
class ScriptedModel {
  calls: Params[] = [];
  script: Reply[] = [];
  async create(params: Params) {
    // The loop appends to the same array; keep a copy as it was sent.
    this.calls.push({ ...params, messages: [...params.messages] });
    const next = this.script.shift() ?? { stop_reason: "end_turn", content: [{ type: "text", text: "Here you go." }] };
    return { ...next, usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900 } };
  }
}

const toolUse = (name: string, input: object, id = "tu_1"): Reply => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });
const text = (t: string): Reply => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });
/** The tool result Claude was sent on the latest call. */
const lastToolResult = (m: ScriptedModel) => {
  const msgs = m.calls.at(-1)!.messages;
  const blocks = msgs.at(-1)!.content as { type: string; content: string; is_error?: boolean }[];
  return blocks.find((b) => b.type === "tool_result")!;
};

/** Stands in for the AI reader of attached bills and cards. */
class FakeReader implements DocumentReader {
  readonly model = "claude-haiku-5-5";
  configured = true;
  reads: string[] = [];
  async readBill(_file: Buffer, mimeType: string): Promise<BillReading> {
    this.reads.push(`bill ${mimeType}`);
    return {
      readable: true,
      customerName: "Harbour Café Ltd",
      supplyAddress: { line1: "12 Quay St", line2: null, city: "Galway", county: "Galway", postcode: "H91 X2Y3" },
      fuel: "electricity",
      mprn: "10012345678",
      gprn: null,
      meterNumber: null,
      supplierName: "Electric Ireland",
      accountNumber: "900123",
      billDate: "2026-09-02",
      periodStart: "2026-07-01",
      periodEnd: "2026-08-31",
      tariffName: "Business Standard",
      dayRate: 0.2814,
      nightRate: null,
      gasRate: null,
      standingChargePerDay: 0.65,
      usageKwh: 2410,
      annualConsumptionKwh: null,
      mic: null,
      readings: [{ register: "Day", value: "045123", readingDate: "2026-08-31", readingType: "actual" }],
      notes: null,
    };
  }
  async readCard(_image: Buffer, mimeType: string) {
    this.reads.push(`card ${mimeType}`);
    return { firstName: "Aoife", lastName: "Byrne", company: "Harbour Café", jobTitle: "Owner", email: "aoife@harbour.ie", phone: null, mobile: "0871234567", website: null, address: null };
  }
}

const model = new ScriptedModel();
const reader = new FakeReader();
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const env = { ...loadEnv(), ANTHROPIC_API_KEY: "test-key", AI_ASSISTANT_DAILY_LIMIT: 20 };
let t: TestApp;
let sales: Client;
let other: Client;
let manager: Client;
let deal: string;

beforeAll(async () => {
  t = await createTestApp([
    { provide: ASSISTANT_MODEL, useValue: model },
    { provide: DOCUMENT_READER, useValue: reader },
    { provide: ENV, useValue: env },
  ]);
  sales = (await userAndClient(t, ["salesperson"])).client;
  other = (await userAndClient(t, ["salesperson"])).client;
  manager = (await userAndClient(t, ["manager"])).client;
  deal = await createOpportunity(sales, "electricity");
});
afterAll(() => t.close());

describe("the CRM assistant", () => {
  it("is switched on for people with the capability", async () => {
    expect(expectStatus(await sales.get("/auth/me"), 200).body.user.features).toMatchObject({ assistant: true });
  });

  it("looks up the deal on screen with the asker's access, answers, and stores the conversation", async () => {
    const opp = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: deal } });
    model.script = [toolUse("what_blocks", { deal: `UO-${opp.number}`, stage: "proposal_sent" }), text("It needs a comparison first. [Open it](/opportunities/x?tab=energy)")];
    const res = expectStatus(await sales.post("/assistant/messages", { opportunityId: deal, message: "What's blocking this deal?" }), 200).body;

    expect(res.message).toMatchObject({ role: "assistant", body: expect.stringContaining("comparison"), toolsUsed: ["what_blocks"] });
    // The deal on screen is named in the question; the instructions and tools are sent, cached.
    const first = model.calls.at(-2)!;
    expect(JSON.stringify(first.messages.at(-1))).toContain(deal);
    expect((first.system as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect(first.tools!.map((x) => (x as { name: string }).name)).toEqual(expect.arrayContaining(["get_deal", "what_blocks", "find_deals"]));
    const result = JSON.parse(lastToolResult(model).content);
    expect(result).toMatchObject({ stage: "Proposal Sent" });

    const stored = expectStatus(await sales.get(`/assistant/conversations/${res.conversationId}/messages`), 200).body;
    expect(stored.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "assistant.message", entityId: res.conversationId } });
    expect(JSON.stringify(audit.data)).not.toContain("blocking");
    expect(audit.data).toMatchObject({ tools: ["what_blocks"], inputTokens: 2400, cachedTokens: 1800 });
  });

  it("can't see other people's deals, and says so to the model the same way as a missing one", async () => {
    model.script = [toolUse("get_deal", { deal }), text("I can't see that deal.")];
    expectStatus(await other.post("/assistant/messages", { message: `Tell me about ${deal}` }), 200);
    expect(lastToolResult(model)).toMatchObject({ is_error: true, content: "Opportunity not found." });
  });

  it("runs every tool on real data without errors or restricted fields", async () => {
    const calls: [string, object][] = [
      ["get_deal", { deal }],
      ["list_documents", { deal }],
      ["list_tasks", {}],
      ["list_tasks", { deal, due: "week" }],
      ["find_deals", { view: "my_open" }],
      ["find_deals", { view: "all", search: "Test" }],
      ["energy_details", { deal }],
      ["application_issues", { deal }],
    ];
    for (const [name, input] of calls) {
      model.script = [toolUse(name, input), text("Done.")];
      expectStatus(await sales.post("/assistant/messages", { message: `Run ${name}` }), 200);
      const result = lastToolResult(model);
      expect({ name, error: result.is_error ?? false }).toEqual({ name, error: false });
      expect(result.content).not.toMatch(/Enc"|iban|dateOfBirth|nationality/i);
    }
    model.script = [toolUse("find_deals", { view: "my_open" }), text("Done.")];
    expectStatus(await sales.post("/assistant/messages", { message: "My deals" }), 200);
    expect(JSON.parse(lastToolResult(model).content).deals[0]).toMatchObject({ link: `/opportunities/${deal}`, daysAtStage: 0 });
  });

  it("keeps conversations and feedback to their owner, and lets managers review unhelpful answers", async () => {
    model.script = [text("Use the Documents tab.")];
    const res = expectStatus(await sales.post("/assistant/messages", { message: "Where do I upload a bill?" }), 200).body;
    expectStatus(await other.get(`/assistant/conversations/${res.conversationId}/messages`), 404);
    expectStatus(await other.post(`/assistant/messages/${res.message.id}/feedback`, { helpful: false }), 404);
    expectStatus(await sales.post(`/assistant/messages/${res.message.id}/feedback`, { helpful: false, comment: "It should say which button." }), 204);

    expectStatus(await sales.get("/assistant/feedback"), 403);
    const review = expectStatus(await manager.get("/assistant/feedback"), 200).body;
    expect(review[0]).toMatchObject({ question: "Where do I upload a bill?", answer: "Use the Documents tab.", comment: "It should say which button." });
  });

  it("returns a short apology instead of an error when the model fails or refuses", async () => {
    model.script = [{ stop_reason: "refusal", content: [] }];
    expect(expectStatus(await manager.post("/assistant/messages", { message: "Hi" }), 200).body.message.body).toBe("I can't help with that one.");
  });

  it("reads an attached bill or card and gives the details to the model with the question", async () => {
    model.script = [toolUse("find_deals", { view: "all", search: "10012345678" }), text("No deal has that MPRN. Shall I add Harbour Café Ltd as a lead?")];
    const res = expectStatus(await sales.upload("/assistant/messages/upload", pdf("bill"), "bill.pdf", "application/pdf").field("kind", "bill"), 200).body;
    expect(reader.reads.at(-1)).toBe("bill application/pdf");
    expect(res.question.body).toMatch(/^Here's a customer's energy bill/);
    expect(res.question.body).toContain("- MPRN: 10012345678");
    expect(res.question.body).toContain("- Day rate: 28.14 c/kWh");
    expect(res.message.body).toContain("Harbour Café Ltd");
    // The model gets the reading with the question, and the MPRN search runs.
    expect(JSON.stringify(model.calls.at(-2)!.messages.at(-1))).toContain("Electric Ireland");
    expect(JSON.parse(lastToolResult(model).content)).toMatchObject({ deals: [] });

    // A later question in the same conversation still has the reading.
    model.script = [text("Done.")];
    expectStatus(await sales.post("/assistant/messages", { conversationId: res.conversationId, message: "Yes please" }), 200);
    expect(JSON.stringify(model.calls.at(-1)!.messages)).toContain("10012345678");

    // The audit entry says a bill was attached, without its details.
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "assistant.message", entityId: res.conversationId }, orderBy: { createdAt: "asc" } });
    expect(audit.data).toMatchObject({ attachment: "bill", reader: "claude-haiku-5-5" });
    expect(JSON.stringify(audit.data)).not.toContain("10012345678");

    model.script = [text("Shall I add Aoife as a lead?")];
    const card = expectStatus(await sales.upload("/assistant/messages/upload", png, "card.png", "image/png").field("kind", "card").field("message", "Add her"), 200).body;
    expect(card.question.body).toMatch(/^Add her\n\n📎 Business card/);
    expect(card.question.body).toContain("- Email: aoife@harbour.ie");
  });

  it("refuses a missing or wrong file without reading it", async () => {
    const before = reader.reads.length;
    expect(expectStatus(await sales.upload("/assistant/messages/upload", pdf("card"), "card.pdf", "application/pdf").field("kind", "card"), 422).body.issues[0]).toMatch(/photo of the card/);
    expectStatus(await sales.upload("/assistant/messages/upload", Buffer.from("MZ not a pdf"), "bill.pdf", "application/pdf").field("kind", "bill"), 422);
    expectStatus(await sales.upload("/assistant/messages/upload", pdf(), "bill.pdf", "application/pdf").field("kind", "contract"), 400);
    expect(reader.reads.length).toBe(before);
  });

  it("stops at the daily limit", async () => {
    const { client } = await userAndClient(t, ["operations"]);
    for (let i = 0; i < env.AI_ASSISTANT_DAILY_LIMIT; i++) expectStatus(await client.post("/assistant/messages", { message: `Question ${i}` }), 200);
    const res = expectStatus(await client.post("/assistant/messages", { message: "One more" }), 429);
    expect(res.body.message).toMatch(/today's assistant limit/);
  });
});
