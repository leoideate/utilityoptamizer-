import { readFileSync } from "node:fs";
import path from "node:path";
import { createTestApp, expectStatus, userAndClient, type TestApp } from "../support/app";

let t: TestApp;
let sales: Awaited<ReturnType<typeof userAndClient>>;
let other: Awaited<ReturnType<typeof userAndClient>>;
let ops: Awaited<ReturnType<typeof userAndClient>>;
beforeAll(async () => {
  t = await createTestApp();
  sales = await userAndClient(t, ["salesperson"]);
  other = await userAndClient(t, ["salesperson"]);
  ops = await userAndClient(t, ["operations"]);
});
afterAll(async () => { if (t) await t.close(); });

it("creates, edits and clears a category without a customer; invalid categories are refused", async () => {
  const id = expectStatus(await sales.client.post("/opportunities", { name: "Independent cafe", serviceType: "electricity", businessCategory: "cafe" }), 201).body.id;
  expect(expectStatus(await sales.client.get(`/opportunities/${id}`), 200).body).toMatchObject({ businessCategory: "cafe", customerId: null });
  expectStatus(await sales.client.patch(`/opportunities/${id}`, { businessCategory: "salon" }), 204);
  expect(expectStatus(await sales.client.get(`/opportunities/${id}`), 200).body.businessCategory).toBe("salon");
  expectStatus(await sales.client.patch(`/opportunities/${id}`, { businessCategory: null }), 204);
  expect(expectStatus(await sales.client.get(`/opportunities/${id}`), 200).body.businessCategory).toBeNull();
  expectStatus(await sales.client.patch(`/opportunities/${id}`, { businessCategory: "invalid" }), 400);
  expectStatus(await other.client.patch(`/opportunities/${id}`, { businessCategory: "salon" }), 404);
});

it("filters before the 50-card limit and uses the same predicate for totals and lists", async () => {
  const stage = await t.prisma.stage.findUniqueOrThrow({ where: { key: "new_lead" } });
  const make = (name: string, businessCategory: string | null, serviceType: "electricity" | "gas" = "electricity", ownerId = sales.user.id) => ({ name, businessCategory, serviceType, ownerId, stageId: stage.id, expectedRevenue: 2 });
  await t.prisma.opportunity.createMany({ data: [
    ...Array.from({ length: 60 }, (_, i) => make(`Restaurant ${i}`, "restaurant")),
    ...Array.from({ length: 55 }, (_, i) => make(`Cafe ${i}`, "cafe")),
    make("Gas cafe", "cafe", "gas"), make("Other owner's cafe", "cafe", "electricity", other.user.id), make("Uncategorized", null),
  ] });
  const query = "view=my_open&serviceType=electricity&businessCategory=cafe";
  const board = expectStatus(await sales.client.get(`/opportunities/board?${query}`), 200).body;
  const column = board.columns.find((c: { stage: { key: string } }) => c.stage.key === "new_lead");
  expect(column).toMatchObject({ count: 55, value: 110 });
  expect(column.cards).toHaveLength(50);
  expect(column.cards.every((c: { businessCategory: string; owner: { id: string }; serviceType: string }) => c.businessCategory === "cafe" && c.owner.id === sales.user.id && c.serviceType === "electricity")).toBe(true);
  const list = expectStatus(await sales.client.get(`/opportunities?${query}&pageSize=200`), 200).body;
  expect(list.total).toBe(55);
  expect(list.items).toHaveLength(55);
  const empty = expectStatus(await sales.client.get("/opportunities/board?view=my_open&businessCategory=takeaway"), 200).body;
  expect(empty.columns.every((c: { count: number; value: number; cards: unknown[] }) => c.count === 0 && c.value === 0 && c.cards.length === 0)).toBe(true);
  const uncategorized = expectStatus(await sales.client.get("/opportunities?view=my_open&businessCategory=uncategorized"), 200).body;
  expect(uncategorized.items.length).toBeGreaterThan(0);
  expect(uncategorized.items.every((c: { businessCategory: string | null }) => c.businessCategory === null)).toBe(true);
  expectStatus(await sales.client.get("/opportunities/board?businessCategory=invalid"), 400);
});

it("imports explicit and legacy categories, without guessing unknown or conflicting text", async () => {
  const csv = [
    "Name,Service,Business Category,Category,Industry",
    "Explicit cafe,Electricity,Cafés,,",
    "Legacy mobile,Gas,,Mobile Shops,Retail",
    "Legacy industry,Gas,,Hospitality,Restaurants",
    "Unknown category,Electricity,,Book shop,Retail",
    "Conflict,Gas,,Cafe,Restaurant",
    "Bad explicit,Gas,Book shop,,",
  ].join("\n");
  const result = expectStatus(await ops.client.upload("/opportunities/import", Buffer.from(csv), "categories.csv", "text/csv"), 201).body;
  expect(result.created).toBe(5);
  expect(result.errors).toHaveLength(1);
  const leads = await t.prisma.opportunity.findMany({ where: { name: { in: ["Explicit cafe", "Legacy mobile", "Legacy industry", "Unknown category", "Conflict"] } } });
  expect(Object.fromEntries(leads.map((l) => [l.name, l.businessCategory]))).toEqual({ "Explicit cafe": "cafe", "Legacy mobile": "mobile_shop", "Legacy industry": "restaurant", "Unknown category": null, Conflict: null });
});

it("backfills only exact unambiguous customer categories and preserves existing lead classifications", async () => {
  const stage = await t.prisma.stage.findUniqueOrThrow({ where: { key: "new_lead" } });
  const inputs = [
    { businessType: "CAFÉS", industry: "Hospitality", expected: "cafe", existing: null },
    { businessType: "Restaurant", industry: "Cafe", expected: null, existing: null },
    { businessType: "Book shop", industry: "Retail", expected: null, existing: null },
    { businessType: "Restaurant", industry: null, expected: "salon", existing: "salon" },
  ];
  const ids: string[] = [];
  for (const [i, input] of inputs.entries()) {
    const customer = await t.prisma.customer.create({ data: { legalName: `Backfill ${i}`, businessType: input.businessType, industry: input.industry } });
    const lead = await t.prisma.opportunity.create({ data: { name: `Backfill ${i}`, serviceType: "gas", stageId: stage.id, customerId: customer.id, businessCategory: input.existing } });
    ids.push(lead.id);
  }
  const migration = readFileSync(path.resolve(__dirname, "../../prisma/migrations/20261030090000_lead_business_category/migration.sql"), "utf8");
  await t.prisma.$executeRawUnsafe(migration.slice(migration.indexOf("WITH aliases")));
  for (const [i, id] of ids.entries()) {
    expect((await t.prisma.opportunity.findUniqueOrThrow({ where: { id } })).businessCategory).toBe(inputs[i].expected);
  }
});
