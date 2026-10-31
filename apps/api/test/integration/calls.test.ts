import request from "supertest";
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
    RINGCENTRAL_RECORDINGS: "true",
    RINGCENTRAL_WEBHOOK_TOKEN: "rc-webhook-token-0123456789",
    RINGCENTRAL_WEBHOOK_URL: "https://crm.example.ie/api/webhooks/ringcentral",
    RINGCENTRAL_BROWSER_CLIENT_ID: "browser-client-id-123",
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
    expect(info).toEqual({ provider: "ringcentral", bridged: true, myPhone: "+35315551234", browserPhone: { clientId: "browser-client-id-123", appServer: rc.url, callerId: "+35315550000" } });
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
    expect(call).toMatchObject({ direction: "inbound", userId: sales.user.id, toNumber: d.e164, agentNumber: "+35315550000", status: "completed", durationSec: 125, provider: "ringcentral", origin: "call_log" });
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

  it("credits a shared line's calls to the CRM user who pressed Call, not the line's owner", async () => {
    // Sean has no RingCentral extension of his own: his calls go out on Sarah's line (extension 101).
    const seanOpp = await fx.createOpportunity(other.client, "electricity", { phone: "087 600 1001", companyName: "Shared Line Ltd" });
    support.expectStatus(await other.client.put("/telephony/my-phone", { phone: "087 600 9999" }), 200);
    rc.script(["Success", "Success"], ["Success", "Finished", "Success"]);
    const started = support.expectStatus(await other.client.post(`/opportunities/${seanOpp}/calls`, { number: "087 600 1001" }), 201).body;
    await followCall(started.call.id);

    rc.logCall({ direction: "Outbound", from: "+35315551234", to: "+353876001001", extensionId: "101", duration: 64, startTime: new Date() });
    expect(await calls.syncCallLog()).toMatchObject({ matched: 1, imported: 0 });
    const call = await t.prisma.callLog.findUniqueOrThrow({ where: { id: started.call.id } });
    expect(call).toMatchObject({ userId: other.user.id, origin: "crm", durationSec: 64 });
    expect(await t.prisma.callLog.count({ where: { toNumber: "+353876001001" } })).toBe(1);
    expect(await callTimeline(seanOpp)).toHaveLength(1);
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

describe("headset calls from the phone panel", () => {
  const callTimeline = (opportunityId: string) => t.prisma.timelineEntry.findMany({ where: { opportunityId, kind: "call" }, orderBy: { createdAt: "asc" } });
  beforeAll(() => {
    rc.extensions = [{ id: "101", email: sales.user.email }];
  });

  it("dials from the panel without RingOut, logs the call once when it ends, and takes the length from the call log", async () => {
    const oppId = await opportunityWithContact();
    const ringOuts = rc.ringOuts.length;
    const started = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "087 123 4567", via: "browser" }), 201).body;
    expect(started).toMatchObject({ mode: "browser", call: { status: "ringing_customer", toNumber: "+353871234567", agentNumber: null } });
    expect(rc.ringOuts).toHaveLength(ringOuts); // the panel dials, not RingOut

    expect(support.expectStatus(await sales.client.post(`/calls/${started.call.id}/browser-status`, { status: "in_progress" }), 201).body.status).toBe("in_progress");
    const ended = support.expectStatus(await sales.client.post(`/calls/${started.call.id}/browser-status`, { status: "completed" }), 201).body;
    expect(ended).toMatchObject({ status: "completed" });
    expect(ended.answeredAt).not.toBeNull();
    // A repeated report changes nothing.
    support.expectStatus(await sales.client.post(`/calls/${started.call.id}/browser-status`, { status: "no_answer" }), 201);
    const timeline = await callTimeline(oppId);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].body).toMatch(/^Outbound call to \+353871234567 · Connected/);
    expect((await t.prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } })).firstContactAt).not.toBeNull();

    rc.logCall({ direction: "Outbound", from: "+35315551234", to: "+353871234567", extensionId: "101", duration: 75, startTime: new Date() });
    expect(await calls.syncCallLog()).toMatchObject({ matched: 1, imported: 0 });
    expect((await t.prisma.callLog.findUniqueOrThrow({ where: { id: started.call.id } })).durationSec).toBe(75);
    expect(await callTimeline(oppId)).toHaveLength(1);
  });

  it("counts hanging up before the customer answers as no answer", async () => {
    const oppId = await opportunityWithContact();
    const s = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "086 555 0101", via: "browser" }), 201).body;
    expect(support.expectStatus(await sales.client.post(`/calls/${s.call.id}/browser-status`, { status: "completed" }), 201).body.status).toBe("no_answer");
    expect((await t.prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } })).firstContactAt).toBeNull();
  });

  it("settles a panel call whose tab closed mid-call from the call log", async () => {
    const oppId = await opportunityWithContact();
    const s = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "086 555 0101", via: "browser" }), 201).body;
    rc.logCall({ direction: "Outbound", from: "+35315551234", to: "+353865550101", extensionId: "101", duration: 50, startTime: new Date() });
    await calls.syncCallLog();
    expect(await t.prisma.callLog.findUniqueOrThrow({ where: { id: s.call.id } })).toMatchObject({ status: "completed", durationSec: 50 });
    const timeline = await callTimeline(oppId);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].body).toBe("Outbound call to +353865550101 · Connected · 50 s.");
  });

  it("only takes reports for the user's own panel calls", async () => {
    const oppId = await opportunityWithContact();
    const s = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "086 555 0101", via: "browser" }), 201).body;
    support.expectStatus(await other.client.post(`/calls/${s.call.id}/browser-status`, { status: "completed" }), 403);
    support.expectStatus(await sales.client.post(`/calls/${s.call.id}/browser-status`, { status: "ringing_agent" }), 400);
    rc.script(["InProgress", "InProgress"]);
    const ringOut = support.expectStatus(await sales.client.post(`/opportunities/${oppId}/calls`, { number: "086 555 0101" }), 201).body;
    expect(support.expectStatus(await sales.client.post(`/calls/${ringOut.call.id}/browser-status`, { status: "completed" }), 422).body.message).toBe("This call wasn't dialled from the CRM phone panel.");
  });
});

describe("call recordings", () => {
  it("fetches a recording into storage, plays it only for people who can see the call, and deletes it after the retention period", async () => {
    rc.extensions = [{ id: "101", email: sales.user.email }];
    const oppId = await fx.createOpportunity(sales.client, "electricity", { phone: "087 955 1234", companyName: "Recorded Ltd" });
    support.expectStatus(await sales.client.post(`/opportunities/${oppId}/customer/create`), 201);
    const recordId = rc.logCall({ direction: "Inbound", from: "+353879551234", to: "+35315550000", extensionId: "101", duration: 61, recording: rc.recording("rec-1") });
    await calls.syncCallLog();

    const call = await t.prisma.callLog.findUniqueOrThrow({ where: { rcRecordId: recordId } });
    expect(call).toMatchObject({ rcRecordingId: "rec-1", recordingScan: "pending", recordingKey: null });
    const job = t.queue.jobs.find((j) => j.name === "call.recording" && j.data.callId === call.id)!;
    expect(job).toBeDefined();
    // Not fetched yet: the person is told so.
    expect((await sales.client.get(`/calls/${call.id}/recording`)).body.issues).toEqual(["The recording is still being fetched. Try again in a minute."]);

    await calls.fetchRecording(call.id, job.data.contentUri as string);
    await calls.fetchRecording(call.id, job.data.contentUri as string); // a retried job does nothing more
    expect(rc.recordingDownloads).toBe(1);
    const stored = await t.prisma.callLog.findUniqueOrThrow({ where: { id: call.id } });
    expect(stored).toMatchObject({ recordingKey: `recordings/${call.id}.mp3`, recordingMime: "audio/mpeg", recordingScan: "skipped" });

    const timeline = support.expectStatus(await sales.client.get(`/opportunities/${oppId}/timeline`), 200).body as { data: { callId?: string }; recording?: boolean }[];
    expect(timeline.find((e) => e.data?.callId === call.id)?.recording).toBe(true);

    const play = support.expectStatus(await sales.client.get(`/calls/${call.id}/recording`), 200).body;
    expect(play).toMatchObject({ url: expect.stringContaining("/api/files/local"), mimeType: "audio/mpeg" });
    expect(await t.prisma.auditLog.count({ where: { action: "sensitive.read", entityType: "call", entityId: call.id } })).toBe(1);
    await t.prisma.opportunity.update({ where: { id: oppId }, data: { ownerId: sales.user.id } });
    expect((await other.client.get(`/calls/${call.id}/recording`)).status).toBe(404);

    // Older than the retention period: the file goes, the call stays.
    const { RetentionService } = require("../../src/admin/retention.service") as typeof import("../../src/admin/retention.service");
    await t.prisma.callLog.update({ where: { id: call.id }, data: { startedAt: new Date(Date.now() - 400 * 86_400_000) } });
    const summary = await t.app.get(RetentionService).run();
    expect(summary.recordings).toBe(1);
    expect(await t.prisma.callLog.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ recordingKey: null, recordingDeletedAt: expect.any(Date) });
    expect((await sales.client.get(`/calls/${call.id}/recording`)).body.issues).toEqual(["This recording was deleted under the retention policy."]);
  });

  it("refuses to fetch recordings from hosts other than RingCentral", async () => {
    const { RingCentralTelephony } = require("../../src/calls/telephony") as typeof import("../../src/calls/telephony");
    const provider = new RingCentralTelephony({ serverUrl: rc.url, clientId: rc.clientId, clientSecret: rc.clientSecret, jwt: rc.jwt, playPrompt: false });
    await expect(provider.recording("https://evilringcentral.com/x")).rejects.toThrow(/Refusing/);
    await expect(provider.recording("http://media.ringcentral.com/x")).rejects.toThrow(/Refusing/);
  });
});

describe("incoming-call pop-ups", () => {
  const TOKEN = "rc-webhook-token-0123456789";
  type Events = import("../../src/calls/ringcentral-events").RingCentralEventsService;
  let events: Events;
  let bus: import("../../src/realtime/realtime").LocalRealtimeBus;
  const post = (body: object, headers: Record<string, string> = { "Verification-Token": TOKEN }) => {
    let r = request(t.app.getHttpServer()).post("/api/webhooks/ringcentral");
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
  };
  const ringing = (uuid: string, sessionId: string, code = "Proceeding", from = "+353879551234") => ({
    uuid,
    event: "/restapi/v1.0/account/1/telephony/sessions",
    body: { telephonySessionId: sessionId, sequence: 1, parties: [{ extensionId: "101", direction: "Inbound", status: { code }, from: { phoneNumber: from } }] },
  });

  beforeAll(async () => {
    const mod = require("../../src/calls/ringcentral-events") as typeof import("../../src/calls/ringcentral-events");
    const { REALTIME_BUS } = require("../../src/realtime/realtime") as typeof import("../../src/realtime/realtime");
    events = t.app.get(mod.RingCentralEventsService);
    bus = t.app.get(REALTIME_BUS);
    await t.prisma.user.update({ where: { id: sales.user.id }, data: { ringcentralExtensionId: "101" } });
  });

  it("creates the webhook subscription once, keeps it, and renews it before it lapses", async () => {
    expect(await events.ensureSubscription()).toMatchObject({ action: "created" });
    const [id, sub] = [...rc.subscriptions.entries()][0];
    expect(sub).toMatchObject({ address: "https://crm.example.ie/api/webhooks/ringcentral", verificationToken: TOKEN, eventFilters: ["/restapi/v1.0/account/~/telephony/sessions"] });
    expect(await events.ensureSubscription()).toEqual({ id, action: "kept" });
    sub.expirationTime = new Date(Date.now() + 86_400_000);
    expect(await events.ensureSubscription()).toEqual({ id, action: "renewed" });
    expect(sub.renewals).toBe(1);
    expect(rc.subscriptions.size).toBe(1);
  });

  it("answers RingCentral's validation handshake and refuses events without the right token", async () => {
    const hello = await post({}, { "Validation-Token": "abc-123" });
    expect(hello.status).toBe(200);
    expect(hello.headers["validation-token"]).toBe("abc-123");
    expect((await post(ringing("u-0", "s-0"), {})).status).toBe(403);
    expect((await post(ringing("u-0", "s-0"), { "Verification-Token": "wrong-token-wrong-token" })).status).toBe(403);
    expect(bus.published.some((e) => e.event.type === "call.incoming")).toBe(false);
  });

  it("tells the person whose extension is ringing, once per event, and again when it's answered", async () => {
    support.expectStatus(await post(ringing("u-1", "s-1")), 200);
    support.expectStatus(await post(ringing("u-1", "s-1")), 200); // redelivered
    const sent = bus.published.filter((e) => e.event.type === "call.incoming");
    expect(sent).toEqual([{ userIds: [sales.user.id], event: { type: "call.incoming", data: { sessionId: "s-1", state: "ringing", from: "+353879551234" } } }]);
    support.expectStatus(await post(ringing("u-2", "s-1", "Answered")), 200);
    expect(bus.published.filter((e) => e.event.type === "call.incoming").at(-1)!.event.data).toMatchObject({ sessionId: "s-1", state: "answered" });
    // Outbound legs and unknown extensions don't notify anyone.
    support.expectStatus(await post({ uuid: "u-3", body: { telephonySessionId: "s-3", parties: [{ extensionId: "999", direction: "Inbound", status: { code: "Proceeding" } }, { extensionId: "101", direction: "Outbound", status: { code: "Proceeding" } }] } }), 200);
    expect(bus.published.filter((e) => e.event.type === "call.incoming")).toHaveLength(2);
  });

  it("looks the caller up within what the person may see", async () => {
    const oppId = await fx.createOpportunity(sales.client, "gas", { phone: "087 977 4455", companyName: "Popup Pub Ltd" });
    support.expectStatus(await sales.client.post(`/opportunities/${oppId}/customer/create`), 201);
    const mine = support.expectStatus(await sales.client.get("/telephony/caller?number=%2B353879774455"), 200).body;
    expect(mine).toMatchObject({ number: "+353879774455", customers: [{ name: "Popup Pub Ltd" }], deals: [{ id: oppId, stage: expect.any(String) }] });
    const theirs = support.expectStatus(await other.client.get("/telephony/caller?number=087%20977%204455"), 200).body;
    expect(theirs).toEqual({ number: "+353879774455", customers: [], deals: [] });
  });
});
