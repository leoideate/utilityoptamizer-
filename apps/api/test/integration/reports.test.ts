import { addDays, today } from "@uo/shared";
import { type Client, type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";
import { createOpportunity } from "../support/fixtures";
import { dublinDayStart } from "../../src/reports/reports.service";

let t: TestApp;
let sales: Client;
let salesId: string;
let other: Client;
let manager: Client;

beforeAll(async () => {
  t = await createTestApp();
  const s = await userAndClient(t, ["salesperson"], "Pat Team");
  sales = s.client;
  salesId = s.user.id;
  other = (await userAndClient(t, ["salesperson"])).client;
  manager = (await userAndClient(t, ["manager"])).client;

  // Pat: three leads this period, one won and one lost.
  const [won, lost] = [await createOpportunity(sales, "electricity"), await createOpportunity(sales, "gas")];
  await createOpportunity(sales, "electricity");
  await t.prisma.opportunity.update({ where: { id: won }, data: { outcome: "won", wonAt: new Date(), expectedRevenue: 1200 } });
  await t.prisma.opportunity.update({ where: { id: lost }, data: { outcome: "lost", lostAt: new Date(), lostReason: "Price" } });
});
afterAll(() => t.close());

const period = { from: addDays(today(), -30), to: today() };
const list = async (c: Client, q: Record<string, string>) => expectStatus(await c.get(`/opportunities?${new URLSearchParams({ view: "all", ...q })}`), 200).body as { total: number };

describe("dashboard figures and the deals behind them", () => {
  it("gives each salesperson's leads, wins and losses in the period", async () => {
    const d = expectStatus(await manager.get(`/reports/dashboard?${new URLSearchParams(period)}`), 200).body;
    expect(d.opportunitiesBySalesperson.find((r: { ownerId: string }) => r.ownerId === salesId)).toMatchObject({
      name: "Pat Team",
      leadsInPeriod: 3,
      wonInPeriod: 1,
      wonValueInPeriod: 1200,
      lostInPeriod: 1,
      winRate: 50,
      open: 1,
    });
  });

  it("lists the same deals each figure counts", async () => {
    expect(await list(manager, { ownerId: salesId, dated: "created", ...period })).toMatchObject({ total: 3 });
    expect(await list(manager, { ownerId: salesId, outcome: "won", dated: "won", ...period })).toMatchObject({ total: 1 });
    expect(await list(manager, { ownerId: salesId, outcome: "lost", dated: "lost", ...period })).toMatchObject({ total: 1 });
    expect(await list(manager, { ownerId: salesId, outcome: "open" })).toMatchObject({ total: 1 });
    expect(await list(manager, { leadSource: "manual", dated: "created", ...period })).toMatchObject({ total: 3 });
    // A period before the deals existed is empty.
    expect(await list(manager, { dated: "created", from: addDays(today(), -400), to: addDays(today(), -300) })).toMatchObject({ total: 0 });
  });

  it("keeps salespeople to their own deals", async () => {
    expect(await list(other, { ownerId: salesId, dated: "created", ...period })).toMatchObject({ total: 0 });
    expectStatus(await manager.get("/opportunities?dated=won&from=yesterday"), 400);
  });
});

describe("calls made per salesperson", () => {
  it("counts outbound calls today, this week and this month, and which connected", async () => {
    const call = (userId: string, startedAt: Date, extra: Record<string, unknown> = {}) =>
      t.prisma.callLog.create({ data: { userId, startedAt, toNumber: "+353871234567", provider: "ringcentral", status: "completed", ...extra } });
    const now = new Date();
    await call(salesId, now);
    await call(salesId, now, { status: "no_answer" });
    await call(salesId, now, { direction: "inbound" }); // received, not made
    await call(salesId, new Date(now.getTime() - 40 * 86_400_000)); // before this month and week
    await call(salesId, now, { origin: "call_log" }); // made outside the CRM (RingCentral app or desk phone)

    const mine = expectStatus(await sales.get("/reports/calls"), 200).body;
    expect(mine.periods.today).toBe(today());
    expect(mine.mine).toMatchObject({ userId: salesId, today: { made: 2, connected: 1 } });
    expect(mine.rows).toEqual([expect.objectContaining({ userId: salesId, name: "Pat Team", today: { made: 2, connected: 1 }, week: { made: 2, connected: 1 }, month: { made: 2, connected: 1 } })]);

    // A salesperson sees only their own row, even with no calls; a manager sees everyone who called.
    const theirs = expectStatus(await other.get("/reports/calls"), 200).body;
    expect(theirs.rows).toHaveLength(1);
    expect(theirs.rows[0]).toMatchObject({ today: { made: 0, connected: 0 } });
    expect(theirs.mine).toEqual(theirs.rows[0]);
    const all = expectStatus(await manager.get("/reports/calls"), 200).body;
    expect(all.rows.map((r: { userId: string }) => r.userId)).toEqual([salesId]);
    expect(all.totals.today).toEqual({ made: 2, connected: 1 });
    // The manager's own figures are there too, even with no calls.
    expect(all.mine).toMatchObject({ today: { made: 0, connected: 0 }, month: { made: 0, connected: 0 } });
  });

  it("starts each day at midnight Irish time", () => {
    expect(dublinDayStart("2026-07-01").toISOString()).toBe("2026-06-30T23:00:00.000Z"); // summer time
    expect(dublinDayStart("2026-12-01").toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });
});
