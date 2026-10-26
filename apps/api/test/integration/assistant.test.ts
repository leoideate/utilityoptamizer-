import type Anthropic from "@anthropic-ai/sdk";
import { ASSISTANT_MODEL } from "../../src/assistant/assistant.service";
import { ENV, loadEnv } from "../../src/config/env";
import { type Client, type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";
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

const model = new ScriptedModel();
const env = { ...loadEnv(), ANTHROPIC_API_KEY: "test-key", AI_ASSISTANT_DAILY_LIMIT: 20 };
let t: TestApp;
let sales: Client;
let other: Client;
let manager: Client;
let deal: string;

beforeAll(async () => {
  t = await createTestApp([
    { provide: ASSISTANT_MODEL, useValue: model },
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

  it("stops at the daily limit", async () => {
    const { client } = await userAndClient(t, ["operations"]);
    for (let i = 0; i < env.AI_ASSISTANT_DAILY_LIMIT; i++) expectStatus(await client.post("/assistant/messages", { message: `Question ${i}` }), 200);
    const res = expectStatus(await client.post("/assistant/messages", { message: "One more" }), 429);
    expect(res.body.message).toMatch(/today's assistant limit/);
  });
});
