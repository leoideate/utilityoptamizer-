import type Anthropic from "@anthropic-ai/sdk";
import { addDays, today } from "@uo/shared";
import { ASSISTANT_MODEL } from "../../src/assistant/assistant.service";
import { ENV, loadEnv } from "../../src/config/env";
import { type Client, type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";
import { createOpportunity } from "../support/fixtures";

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Reply = { stop_reason: Anthropic.StopReason; content: unknown[] };

/** Stands in for Claude: answers from a script, recording every request. */
class ScriptedModel {
  calls: Params[] = [];
  script: Reply[] = [];
  async create(params: Params) {
    this.calls.push({ ...params, messages: [...params.messages] });
    const next = this.script.shift() ?? { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
    return { ...next, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 } };
  }
}

const toolUse = (name: string, input: object): Reply => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu_${name}`, name, input }] });
const text = (t: string): Reply => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });
const lastToolResult = (m: ScriptedModel) => {
  const blocks = m.calls.at(-1)!.messages.at(-1)!.content as { type: string; content: string; is_error?: boolean }[];
  return blocks.find((b) => b.type === "tool_result")!;
};

const model = new ScriptedModel();
const env = { ...loadEnv(), ANTHROPIC_API_KEY: "test-key", AI_ASSISTANT_DAILY_LIMIT: 100 };
let t: TestApp;
let sales: Client;
let salesId: string;
let other: Client;
let deal: string;
let number: string;

interface Action {
  id: string;
  kind: string;
  summary: string;
  status: string;
  error: string | null;
  link: string | null;
}

/** Asks with one scripted propose_ call; returns the answer's actions and what the model was told. */
async function propose(c: Client, tool: string, input: object) {
  model.script = [toolUse(tool, input), text("I've prepared that; confirm it below.")];
  const body = expectStatus(await c.post("/assistant/messages", { message: `Please ${tool}` }), 200).body;
  return { actions: body.message.actions as Action[], result: lastToolResult(model), conversationId: body.conversationId as string };
}

beforeAll(async () => {
  t = await createTestApp([
    { provide: ASSISTANT_MODEL, useValue: model },
    { provide: ENV, useValue: env },
  ]);
  const s = await userAndClient(t, ["salesperson"], "Sarah Sales");
  sales = s.client;
  salesId = s.user.id;
  other = (await userAndClient(t, ["salesperson"])).client;
  deal = await createOpportunity(sales, "electricity");
  number = `UO-${(await t.prisma.opportunity.findUniqueOrThrow({ where: { id: deal } })).number}`;
});
afterAll(() => t.close());

describe("changes the assistant prepares", () => {
  it("offers every propose_ tool to the model, with today's date in the question", async () => {
    await propose(sales, "propose_set_follow_up", { deal: number, date: addDays(today(), 2) });
    const sent = model.calls.at(-2)!;
    expect(sent.tools!.map((x) => (x as { name: string }).name)).toEqual(
      expect.arrayContaining(["propose_create_task", "propose_complete_task", "propose_reschedule_task", "propose_set_follow_up", "propose_create_lead", "propose_update_deal", "propose_move_stage", "propose_log_note", "propose_send_email"]),
    );
    expect(JSON.stringify(sent.messages.at(-1))).toContain(`Today is`);
  });

  it("changes nothing until the user confirms, then makes the change once, as the user", async () => {
    const before = await t.prisma.activity.count({ where: { opportunityId: deal } });
    const { actions, result } = await propose(sales, "propose_create_task", { deal: number, summary: "Call Mary about the bill", type: "call", dueDate: addDays(today(), 1) });
    expect(result.is_error).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({ prepared: expect.stringContaining("Call Mary about the bill") });
    expect(actions).toEqual([expect.objectContaining({ kind: "create_task", status: "pending", link: `/opportunities/${deal}` })]);
    expect(await t.prisma.activity.count({ where: { opportunityId: deal } })).toBe(before);

    // Only the person it was prepared for can act on it.
    expectStatus(await other.post(`/assistant/actions/${actions[0].id}/confirm`), 404);

    const done = expectStatus(await sales.post(`/assistant/actions/${actions[0].id}/confirm`), 200).body;
    expect(done).toMatchObject({ status: "done" });
    const task = await t.prisma.activity.findFirstOrThrow({ where: { opportunityId: deal, summary: "Call Mary about the bill" } });
    expect(task).toMatchObject({ ownerId: salesId, type: "call", status: "open", createdById: salesId });
    expect(await t.prisma.timelineEntry.count({ where: { opportunityId: deal, body: { startsWith: "Scheduled: Call Mary" } } })).toBe(1);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "assistant.action", entityId: actions[0].id } });
    expect(audit).toMatchObject({ actorId: salesId, summary: "Confirmed an assistant suggestion: new task" });

    // A second click does nothing.
    expectStatus(await sales.post(`/assistant/actions/${actions[0].id}/confirm`), 409);
    expect(await t.prisma.activity.count({ where: { opportunityId: deal, summary: "Call Mary about the bill" } })).toBe(1);
  });

  it("completes and reschedules the user's tasks by id", async () => {
    const task = await t.prisma.activity.findFirstOrThrow({ where: { opportunityId: deal, summary: "Call Mary about the bill" } });
    const later = addDays(today(), 5);
    const moved = await propose(sales, "propose_reschedule_task", { task: task.id, dueDate: later });
    expectStatus(await sales.post(`/assistant/actions/${moved.actions[0].id}/confirm`), 200);
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: task.id } })).dueDate.toISOString().slice(0, 10)).toBe(later);

    // Someone else's task is "not found" to the model.
    const foreign = await propose(other, "propose_complete_task", { task: task.id });
    expect(foreign.result).toMatchObject({ is_error: true, content: "Task not found." });
    expect(foreign.actions).toEqual([]);

    const done = await propose(sales, "propose_complete_task", { task: task.id, note: "She'll send the bill" });
    expectStatus(await sales.post(`/assistant/actions/${done.actions[0].id}/confirm`), 200);
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("done");
  });

  it("sets follow-ups, changes deal details, logs notes and creates leads", async () => {
    const date = addDays(today(), 3);
    const steps: [string, object][] = [
      ["propose_set_follow_up", { deal: number, date, nextAction: "Chase the bill" }],
      ["propose_update_deal", { deal: number, fields: { contactName: "Mary O'Brien", phone: "087 765 4321" } }],
      ["propose_log_note", { deal: number, kind: "call", body: "Mary will email the bill tomorrow.", direction: "outbound" }],
      ["propose_create_lead", { name: "Quay Bakery electricity", serviceType: "electricity", companyName: "Quay Bakery Ltd" }],
    ];
    for (const [tool, input] of steps) {
      const { actions, result } = await propose(sales, tool, input);
      expect({ tool, error: result.is_error ?? false }).toEqual({ tool, error: false });
      expect(expectStatus(await sales.post(`/assistant/actions/${actions[0].id}/confirm`), 200).body.status).toBe("done");
    }
    const opp = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: deal } });
    expect(opp).toMatchObject({ contactName: "Mary O'Brien", phone: "087 765 4321", nextAction: "Chase the bill" });
    expect(opp.followUpDate?.toISOString().slice(0, 10)).toBe(date);
    expect(opp.lastContactAt).not.toBeNull();
    expect(await t.prisma.timelineEntry.count({ where: { opportunityId: deal, kind: "call", body: "Mary will email the bill tomorrow." } })).toBe(1);
    expect(await t.prisma.opportunity.findFirst({ where: { name: "Quay Bakery electricity", ownerId: salesId } })).not.toBeNull();
  });

  it("moves stages only through the stage gates, and never to Live / Won", async () => {
    const blocked = await propose(sales, "propose_move_stage", { deal: number, stage: "proposal_sent" });
    expect(blocked.result).toMatchObject({ is_error: true, content: expect.stringMatching(/^Can't prepare that: /) });
    expect(blocked.actions).toEqual([]);
    const won = await propose(sales, "propose_move_stage", { deal: number, stage: "live_won" });
    expect(won.result.content).toMatch(/Activate/);

    const { actions } = await propose(sales, "propose_move_stage", { deal: number, stage: "contacted" });
    expectStatus(await sales.post(`/assistant/actions/${actions[0].id}/confirm`), 200);
    expect((await t.prisma.opportunity.findUniqueOrThrow({ where: { id: deal }, include: { stage: true } })).stage.key).toBe("contacted");
  });

  it("won't prepare changes to deals the user can't see or change", async () => {
    const theirs = await createOpportunity(other, "gas");
    const { result, actions } = await propose(sales, "propose_log_note", { deal: theirs, body: "Hello" });
    expect(result).toMatchObject({ is_error: true, content: "Opportunity not found." });
    expect(actions).toEqual([]);
  });

  it("records a change that fails at Confirm on the card, with the reason", async () => {
    // No mailbox connected and no SMTP in tests: sending is refused.
    const { actions } = await propose(sales, "propose_send_email", { deal: number, to: "mary@testtrading.ie", subject: "Your bill", body: "Hi Mary, could you send the latest bill?" });
    const res = expectStatus(await sales.post(`/assistant/actions/${actions[0].id}/confirm`), 422).body;
    expect(res.issues).toEqual([expect.stringMatching(/Connect your mailbox/)]);
    const row = await t.prisma.assistantAction.findUniqueOrThrow({ where: { id: actions[0].id } });
    expect(row).toMatchObject({ status: "failed", error: expect.stringMatching(/Connect your mailbox/) });
    expect(await t.prisma.timelineEntry.count({ where: { opportunityId: deal, kind: "email" } })).toBe(0);
  });

  it("lets the user dismiss a suggestion, and shows each answer's suggestions when the conversation is reopened", async () => {
    const { actions, conversationId } = await propose(sales, "propose_log_note", { deal: number, body: "Not this one" });
    expect(expectStatus(await sales.post(`/assistant/actions/${actions[0].id}/dismiss`), 200).body.status).toBe("dismissed");
    expectStatus(await sales.post(`/assistant/actions/${actions[0].id}/confirm`), 409);
    expect(await t.prisma.timelineEntry.count({ where: { opportunityId: deal, body: "Not this one" } })).toBe(0);

    const messages = expectStatus(await sales.get(`/assistant/conversations/${conversationId}/messages`), 200).body;
    expect(messages[1].actions).toEqual([expect.objectContaining({ id: actions[0].id, status: "dismissed" })]);
  });

  it("refuses suggestions older than a day", async () => {
    const { actions } = await propose(sales, "propose_log_note", { deal: number, body: "Old idea" });
    const row = await t.prisma.assistantAction.findUniqueOrThrow({ where: { id: actions[0].id } });
    const old = await t.prisma.assistantAction.create({ data: { ...row, id: undefined, payload: row.payload as object, result: undefined, createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect(expectStatus(await sales.post(`/assistant/actions/${old.id}/confirm`), 422).body.issues).toEqual(["This suggestion has expired. Ask the assistant again."]);
  });

  it("keeps a proposal as it was offered: the database refuses edits, deletes and going back", async () => {
    const { actions } = await propose(sales, "propose_log_note", { deal: number, body: "Original" });
    const id = actions[0].id;
    await expect(t.prisma.assistantAction.update({ where: { id }, data: { payload: { opportunityId: deal, entry: { kind: "note", body: "Changed" } } } })).rejects.toThrow(/can't be changed/);
    await expect(t.prisma.assistantAction.delete({ where: { id } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.assistantAction.update({ where: { id }, data: { status: "done" } })).rejects.toThrow(/pending → done is not allowed/);
  });

  it("stops at five changes per answer", async () => {
    model.script = [
      { stop_reason: "tool_use", content: Array.from({ length: 6 }, (_, i) => ({ type: "tool_use", id: `tu_${i}`, name: "propose_log_note", input: { deal: number, body: `Note ${i}` } })) },
      text("Prepared."),
    ];
    const body = expectStatus(await sales.post("/assistant/messages", { message: "Add six notes" }), 200).body;
    expect(body.message.actions).toHaveLength(5);
  });
});
