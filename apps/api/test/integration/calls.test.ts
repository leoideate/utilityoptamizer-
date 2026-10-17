import { MockRingCentral } from "../support/mock-ringcentral";

jest.setTimeout(60_000);

const rc = new MockRingCentral();

/* eslint-disable @typescript-eslint/no-require-imports */
type AppSupport = typeof import("../support/app");
type Fixtures = typeof import("../support/fixtures");
let support: AppSupport;
let fx: Fixtures;
let t: Awaited<ReturnType<AppSupport["createTestApp"]>>;
let sales: Awaited<ReturnType<AppSupport["userAndClient"]>>;
let other: Awaited<ReturnType<AppSupport["userAndClient"]>>;
let calls: import("../../src/calls/calls.service").CallsService;

beforeAll(async () => {
  await rc.start();
  Object.assign(process.env, {
    TELEPHONY_PROVIDER: "ringcentral",
    RINGCENTRAL_SERVER_URL: rc.url,
    RINGCENTRAL_CLIENT_ID: rc.clientId,
    RINGCENTRAL_CLIENT_SECRET: rc.clientSecret,
    RINGCENTRAL_JWT: rc.jwt,
    RINGCENTRAL_CALLER_ID: "+35315550000",
  });
  support = require("../support/app") as AppSupport;
  fx = require("../support/fixtures") as Fixtures;
  t = await support.createTestApp();
  sales = await support.userAndClient(t, ["salesperson"], "Sarah Sales");
  other = await support.userAndClient(t, ["salesperson"], "Sean Sales");
  const { CallsService } = require("../../src/calls/calls.service") as typeof import("../../src/calls/calls.service");
  calls = t.app.get(CallsService);
}, 120_000);
afterAll(async () => {
  await t?.close();
  await rc.stop();
});

async function opportunityWithContact() {
  const oppId = await fx.createOpportunity(sales.client, "electricity", { phone: "087 123 4567", contactName: "Mary Murphy" });
  const { customerId } = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/customer/create`), 201).body;
  support.expectStatus(await sales.client.post(`/customers/${customerId}/contacts`, { firstName: "Tom", lastName: "Byrne", mobile: "086 555 0101" }), 201);
  return oppId as string;
}

/** Runs the polling job until the call ends (the job queue is recorded, not executed, in tests). */
async function followCall(callId: string) {
  for (let i = 0; i < 10; i++) {
    await calls.poll(callId, i);
    const c = await t.prisma.callLog.findUniqueOrThrow({ where: { id: callId } });
    if (["completed", "no_answer", "busy", "failed", "canceled"].includes(c.status)) return c;
  }
  throw new Error("call never finished");
}

describe("click-to-call with RingCentral", () => {
  it("offers only the customer's saved numbers, in international format", async () => {
    const oppId = await opportunityWithContact();
    const nums = support.expectStatus(await sales.client.get(`/opportunities/${oppId}/call-numbers`), 200).body;
    // The primary contact (created from the lead) comes first; duplicates of the same number are listed once.
    expect(nums.map((n: { number: string; label: string }) => [n.number, n.label])).toEqual([
      ["+353871234567", "Mary Murphy (phone)"],
      ["+353865550101", "Tom Byrne (mobile)"],
    ]);
    const res = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "+353 1 999 9999" }), 422);
    expect(res.body.message).toBe("Choose one of the numbers saved for this customer.");
  });

  it("needs the salesperson's own phone, which is validated and normalised", async () => {
    const oppId = await opportunityWithContact();
    const blocked = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "087 123 4567" }), 422);
    expect(blocked.body.message).toMatch(/Add your own phone number first/);
    support.expectStatus(await sales.client.put("/telephony/my-phone", { phone: "not a phone" }), 422);
    const ok = support.expectStatus(await sales.client.put("/telephony/my-phone", { phone: "01 555 1234" }), 200).body;
    expect(ok.phone).toBe("+35315551234");
    const info = support.expectStatus(await sales.client.get("/telephony"), 200).body;
    expect(info).toEqual({ provider: "ringcentral", bridged: true, myPhone: "+35315551234" });
  });

  it("rings the salesperson, connects the customer, and logs the call once", async () => {
    const oppId = await opportunityWithContact();
    rc.script(["InProgress", "InProgress"], ["Success", "InProgress"], ["Success", "Success"], ["Success", "Finished", "Success"]);
    const started = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "087 123 4567" }), 201).body;
    expect(started.mode).toBe("bridged");
    expect(rc.ringOuts.at(-1)).toEqual({ from: "+35315551234", to: "+353871234567", callerId: "+35315550000", playPrompt: false });
    expect(t.queue.jobs.some((j) => j.name === "call.poll" && j.data.callId === started.call.id)).toBe(true);

    const done = await followCall(started.call.id);
    expect(done.status).toBe("completed");
    expect(done.answeredAt).not.toBeNull();
    expect(done.durationSec).toBeGreaterThanOrEqual(1);
    await calls.poll(started.call.id, 99); // a late duplicate job changes nothing

    const timeline = await t.prisma.timelineEntry.findMany({ where: { opportunityId: oppId, kind: "call" } });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ direction: "outbound", actorId: sales.user.id });
    expect(timeline[0].body).toMatch(/^Outbound call to \+353871234567 · Connected · \d+ s \(approx\.\)\.$/);
    const opp = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } });
    expect(opp.firstContactAt).not.toBeNull();
    expect(await t.prisma.activity.count({ where: { opportunityId: oppId, automationKey: "first_contact", status: "open" } })).toBe(0);

    // Notes added afterwards become a new timeline entry (entries are never edited).
    support.expectStatus(await sales.client.post(`/calls/${started.call.id}/outcome`, { outcome: "call_back_requested", notes: "Call back Tuesday after 2pm" }), 201);
    const after = await t.prisma.timelineEntry.findMany({ where: { opportunityId: oppId, kind: "call" }, orderBy: { createdAt: "asc" } });
    expect(after).toHaveLength(2);
    expect(after[1].body).toBe("Call outcome: Asked us to call back.\nCall back Tuesday after 2pm");
  });

  it("explains when the salesperson's phone isn't answered or the customer is busy", async () => {
    const oppId = await opportunityWithContact();
    rc.script(["InProgress", "InProgress"], ["NoAnswer", "InProgress"]);
    const a = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "086 555 0101" }), 201).body;
    const missed = await followCall(a.call.id);
    expect(missed).toMatchObject({ status: "canceled", outcome: "Your phone wasn't answered, so the customer wasn't called.", durationSec: null });

    rc.script(["Success", "InProgress"], ["Success", "Busy"]);
    const b = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "086 555 0101" }), 201).body;
    expect((await followCall(b.call.id)).status).toBe("busy");
    const opp = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } });
    expect(opp.firstContactAt).toBeNull(); // unanswered calls aren't contact
    const list = support.expectStatus(await sales.client.get(`/opportunities/${oppId}/calls`), 200).body;
    expect(list.map((c: { status: string }) => c.status)).toEqual(["busy", "canceled"]);
  });

  it("can cancel while the salesperson's phone is ringing", async () => {
    const oppId = await opportunityWithContact();
    rc.script(["InProgress", "InProgress"]);
    const s = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "086 555 0101" }), 201).body;
    const c = support.expectStatus(await sales.client.post(`/calls/${s.call.id}/cancel`), 201).body;
    expect(c.status).toBe("canceled");
  });

  it("follows opportunity permissions", async () => {
    const oppId = await opportunityWithContact();
    support.expectStatus(await other.client.get(`/opportunities/${oppId}/call-numbers`), 404);
    support.expectStatus(await other.client.post(`/opportunities/${oppId}/calls`, { number: "087 123 4567" }), 404);
    const calls = support.expectStatus(await sales.client.get(`/opportunities/${oppId}/calls`), 200).body;
    expect(calls).toEqual([]);
  });
});

describe("RingCentral call-log sync", () => {
  let n = 0;
  /** A deal whose customer has a phone number no other test uses. */
  async function dealWithPhone() {
    const phone = `087 900 ${String(1000 + ++n)}`;
    const oppId = await fx.createOpportunity(sales.client, "electricity", { phone, companyName: `Caller ${n} Ltd` });
    support.expectStatus(await sales.client.post(`/opportunities/${oppId}/customer/create`), 201);
    return { oppId, e164: `+35387900${1000 + n}` };
  }
  const callTimeline = (opportunityId: string) => t.prisma.timelineEntry.findMany({ where: { opportunityId, kind: "call" }, orderBy: { createdAt: "asc" } });

  beforeAll(() => {
    rc.extensions = [{ id: "101", email: sales.user.email }];
  });

  it("maps extensions by email, imports an inbound call onto the deal, and logs it once", async () => {
    const d = await dealWithPhone();
    rc.logCall({ direction: "Inbound", from: d.e164, to: "+35315550000", extensionId: "101", duration: 125, startTime: new Date(Date.now() - 60_000) });
    expect(await calls.syncCallLog()).toMatchObject({ imported: 1, matched: 0 });
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: sales.user.id } })).ringcentralExtensionId).toBe("101");

    const call = await t.prisma.callLog.findFirstOrThrow({ where: { opportunityId: d.oppId } });
    expect(call).toMatchObject({ direction: "inbound", userId: sales.user.id, toNumber: d.e164, agentNumber: "+35315550000", status: "completed", durationSec: 125, provider: "ringcentral" });
    const entries = await callTimeline(d.oppId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ direction: "inbound", actorId: sales.user.id, body: `Inbound call from ${d.e164} · Connected · 2 min 5 s.` });
    expect((await t.prisma.opportunity.findUniqueOrThrow({ where: { id: d.oppId } })).lastContactAt).not.toBeNull();

    // The next run re-reads an overlapping window: nothing is imported twice.
    expect(await calls.syncCallLog()).toMatchObject({ imported: 0 });
    expect(await callTimeline(d.oppId)).toHaveLength(1);
    expect(rc.callLogRequests.at(-1)!.get("view")).toBe("Simple");
  });

  it("logs a missed call and gives the deal owner a call-back task", async () => {
    const d = await dealWithPhone();
    const id = rc.logCall({ direction: "Inbound", from: d.e164, to: "+35315550000", extensionId: "999", result: "Missed" });
    await calls.syncCallLog();
    const call = await t.prisma.callLog.findUniqueOrThrow({ where: { rcRecordId: id } });
    expect(call).toMatchObject({ userId: null, status: "no_answer", opportunityId: d.oppId });
    expect((await callTimeline(d.oppId))[0].body).toBe(`Missed call from ${d.e164}.`);
    const task = await t.prisma.activity.findFirstOrThrow({ where: { opportunityId: d.oppId, automationKey: `missed_call:${call.id}` } });
    expect(task).toMatchObject({ type: "call", status: "open", priority: "high", ownerId: sales.user.id, summary: `Call back ${d.e164}` });
  });

  it("attaches a click-to-call to its call-log record instead of logging it twice", async () => {
    const oppId = await opportunityWithContact();
    rc.script(["Success", "Success"], ["Success", "Finished", "Success"]);
    const started = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "087 123 4567" }), 201).body;
    await followCall(started.call.id);
    expect(await callTimeline(oppId)).toHaveLength(1);

    rc.logCall({ direction: "Outbound", from: "+35315551234", to: "+353871234567", extensionId: "101", duration: 42, startTime: new Date() });
    expect(await calls.syncCallLog()).toMatchObject({ imported: 0, matched: 1 });
    const call = await t.prisma.callLog.findUniqueOrThrow({ where: { id: started.call.id } });
    expect(call.rcRecordId).not.toBeNull();
    expect(call.durationSec).toBe(42);
    expect(await t.prisma.callLog.count({ where: { opportunityId: oppId } })).toBe(1);
    expect(await callTimeline(oppId)).toHaveLength(1);
  });

  it("links a lead's number to the lead, and keeps calls from unknown numbers off every timeline", async () => {
    const leadId = await fx.createOpportunity(sales.client, "gas", { phone: "087 911 2222", companyName: "Lead Only Ltd" });
    rc.logCall({ direction: "Inbound", from: "+353879112222", to: "+35315550000", extensionId: "101", duration: 30 });
    const unknown = rc.logCall({ direction: "Inbound", from: "+447700900123", to: "+35315550000", extensionId: "101", duration: 10 });
    await calls.syncCallLog();
    expect(await t.prisma.callLog.findFirstOrThrow({ where: { opportunityId: leadId } })).toMatchObject({ customerId: null, direction: "inbound" });
    const stranger = await t.prisma.callLog.findUniqueOrThrow({ where: { rcRecordId: unknown } });
    expect(stranger).toMatchObject({ opportunityId: null, customerId: null, toNumber: "+447700900123" });
    expect(await t.prisma.timelineEntry.count({ where: { data: { path: ["callId"], equals: stranger.id } } })).toBe(0);
  });
});
