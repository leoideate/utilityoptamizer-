import { addDays, today } from "@uo/shared";
import { AttentionService } from "../../src/attention/attention.service";
import { dateOnly } from "../../src/common/values";
import { createOpportunity } from "../support/fixtures";
import { type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";

let t: TestApp;
let a: Awaited<ReturnType<typeof userAndClient>>;
let b: Awaited<ReturnType<typeof userAndClient>>;
let idle: Awaited<ReturnType<typeof userAndClient>>;
let optedOut: Awaited<ReturnType<typeof userAndClient>>;
let manager: Awaited<ReturnType<typeof userAndClient>>;
const ids: Record<string, string> = {};
const DAY = 86_400_000;
const TITLE = "Needs your attention today";

/** A deal owned by the creating salesperson, with its first-contact task done unless told otherwise. */
async function deal(c: Awaited<ReturnType<typeof userAndClient>>, name: string, data: object = {}, keepTask = false) {
  const id = await createOpportunity(c.client, "electricity", { name });
  if (!keepTask) await t.prisma.activity.updateMany({ where: { opportunityId: id }, data: { status: "done", completedAt: new Date() } });
  await t.prisma.opportunity.update({ where: { id }, data });
  ids[name] = id;
  return id;
}

const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeAll(async () => {
  t = await createTestApp();
  a = await userAndClient(t, ["salesperson"], "Aoife Sales");
  b = await userAndClient(t, ["salesperson"], "Brian Sales");
  idle = await userAndClient(t, ["salesperson"], "Idle Sales");
  optedOut = await userAndClient(t, ["salesperson"], "Quiet Sales");
  manager = await userAndClient(t, ["manager"]);

  const asOf = today();
  await deal(a, "A stuck", { stageEnteredAt: ago(20) });
  await deal(a, "A fresh", { stageEnteredAt: ago(3) });
  // An open (overdue) task means someone is on it: an overdue task, not a stuck deal.
  const busy = await deal(a, "A busy", { stageEnteredAt: ago(20) }, true);
  await t.prisma.activity.updateMany({ where: { opportunityId: busy }, data: { dueDate: dateOnly(addDays(asOf, -3)) } });
  await deal(a, "A follow-up", { followUpDate: dateOnly(asOf) });
  await deal(a, "A renewal", { saleType: "renewal", renewalDate: dateOnly(addDays(asOf, 30)) });
  await deal(a, "A lost", { stageEnteredAt: ago(60), outcome: "lost" });
  await deal(b, "B stuck", { stageEnteredAt: ago(30) });
  await deal(optedOut, "Quiet stuck", { stageEnteredAt: ago(30) });
  await t.prisma.user.update({ where: { id: optedOut.user.id }, data: { morningSummary: false } });
});
afterAll(() => t.close());

describe("needs your attention", () => {
  it("lists each salesperson's own deals and tasks only", async () => {
    const res = expectStatus(await a.client.get("/attention"), 200).body;
    expect(res.stuck).toEqual({ total: 1, items: [{ id: ids["A stuck"], number: expect.any(Number), name: "A stuck", stage: "New Lead", days: 20, link: `/opportunities/${ids["A stuck"]}` }] });
    expect(res.overdueTasks.total).toBe(1);
    expect(res.overdueTasks.items[0]).toMatchObject({ id: ids["A busy"], days: 3, summary: "Make first contact", link: `/opportunities/${ids["A busy"]}` });
    expect(res.followUps).toMatchObject({ total: 1, items: [{ id: ids["A follow-up"], days: 0 }] });
    expect(res.renewals).toMatchObject({ total: 1, items: [{ id: ids["A renewal"], days: 30 }] });

    const other = expectStatus(await b.client.get("/attention"), 200).body;
    expect(other.stuck.items.map((i: { id: string }) => i.id)).toEqual([ids["B stuck"]]);
    expect([other.overdueTasks.total, other.followUps.total, other.renewals.total]).toEqual([0, 0, 0]);
  });

  it("shows managers every deal, oldest first, but only their own tasks", async () => {
    const res = expectStatus(await manager.client.get("/attention"), 200).body;
    expect(res.stuck.items.map((i: { name: string }) => i.name)).toEqual(["B stuck", "Quiet stuck", "A stuck"]);
    expect(res.overdueTasks.total).toBe(0);
    expect(res.renewals.total).toBe(1);
  });

  it("lets each user switch the morning summary off and on", async () => {
    expect(expectStatus(await idle.client.get("/attention/morning-summary"), 200).body).toEqual({ enabled: true });
    expectStatus(await idle.client.put("/attention/morning-summary", { enabled: "no" }), 400);
    expect(expectStatus(await idle.client.put("/attention/morning-summary", { enabled: false }), 200).body).toEqual({ enabled: false });
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: idle.user.id } })).morningSummary).toBe(false);
    expectStatus(await idle.client.put("/attention/morning-summary", { enabled: true }), 200);
  });
});

describe("morning summary", () => {
  it("notifies each user with something once a day, and skips the opted-out and those with nothing", async () => {
    const service = t.app.get(AttentionService);
    const now = new Date();
    await service.morningSummary(now);

    const sent = await t.prisma.notification.findMany({ where: { title: TITLE } });
    const to = (u: { user: { id: string } }) => sent.filter((n) => n.userId === u.user.id);
    expect(to(a)).toEqual([expect.objectContaining({ body: "1 deal stuck, 1 overdue task, 1 follow-up due, 1 renewal due", link: "/" })]);
    expect(to(b).map((n) => n.body)).toEqual(["1 deal stuck"]);
    expect(to(manager).map((n) => n.body)).toEqual(["3 deals stuck, 1 follow-up due, 1 renewal due"]);
    expect(to(idle)).toEqual([]);
    expect(to(optedOut)).toEqual([]);
    expect(await t.prisma.attentionDigest.count({ where: { day: dateOnly(today(now)) } })).toBe(3);

    // A second run the same day (a retry, or a second worker) sends nothing more.
    expect(await service.morningSummary(now)).toEqual({ sent: 0 });
    expect(await t.prisma.notification.count({ where: { title: TITLE } })).toBe(3);

    // The next day it goes out again.
    expect(await service.morningSummary(new Date(now.getTime() + DAY))).toMatchObject({ sent: 3 });
  });
});
