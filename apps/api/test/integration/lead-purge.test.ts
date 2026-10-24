import { type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";

let t: TestApp;
let admin: Awaited<ReturnType<typeof userAndClient>>;
let manager: Awaited<ReturnType<typeof userAndClient>>;
let ops: Awaited<ReturnType<typeof userAndClient>>;
let sales: Awaited<ReturnType<typeof userAndClient>>;

beforeAll(async () => {
  t = await createTestApp();
  admin = await userAndClient(t, ["administrator"]);
  manager = await userAndClient(t, ["manager"]);
  ops = await userAndClient(t, ["operations"]);
  sales = await userAndClient(t, ["salesperson"], "Sarah Sales");
});
afterAll(() => t.close());

const leadId = async (companyName: string) => (await t.prisma.opportunity.findFirstOrThrow({ where: { companyName } })).id;

describe("assigning several opportunities at once", () => {
  it("assigns the ticked leads like Assign does, and lists the ones it couldn't", async () => {
    const csv = "Company,Service,Campaign\nAssign One,Gas,Assign list\nAssign Two,Electricity,Assign list\n";
    expectStatus(await ops.client.upload("/opportunities/import", Buffer.from(csv), "leads.csv", "text/csv"), 201);
    const ids = [await leadId("Assign One"), await leadId("Assign Two")];
    const missing = "00000000-0000-4000-8000-000000000000";

    expectStatus(await sales.client.post("/opportunities/bulk-assign", { ids, ownerId: sales.user.id }), 403);
    expectStatus(await ops.client.post("/opportunities/bulk-assign", { ids, ownerId: sales.user.id }), 403);

    const res = expectStatus(await manager.client.post("/opportunities/bulk-assign", { ids: [...ids, missing], ownerId: sales.user.id }), 200).body;
    expect(res.assigned).toBe(2);
    expect(res.skipped).toEqual([{ id: missing, reason: expect.stringMatching(/not found/) }]);
    for (const id of ids) {
      expect(expectStatus(await sales.client.get(`/opportunities/${id}`), 200).body.ownerId).toBe(sales.user.id);
      expect(await t.prisma.timelineEntry.count({ where: { opportunityId: id, kind: "assignment", body: "Assigned to Sarah Sales." } })).toBe(1);
    }

    // Unassigning in bulk works the same way.
    expect(expectStatus(await manager.client.post("/opportunities/bulk-assign", { ids, ownerId: null }), 200).body).toEqual({ assigned: 2, skipped: [] });
    expect(await t.prisma.opportunity.count({ where: { id: { in: ids }, ownerId: null } })).toBe(2);
  });
});

describe("deleting untouched leads", () => {
  it("is for administrators only, deletes only leads nobody worked on, and only as many as confirmed", async () => {
    const csv = "Company,Service,Campaign\nPurge Alpha,Gas,Purge list\nPurge Beta,Electricity,Purge list\nPurge Gamma,Electricity,Purge list\nPurge Delta,Electricity,Purge list\n";
    expectStatus(await ops.client.upload("/opportunities/import", Buffer.from(csv), "leads.csv", "text/csv"), 201);
    const [alpha, beta, gamma, delta] = [await leadId("Purge Alpha"), await leadId("Purge Beta"), await leadId("Purge Gamma"), await leadId("Purge Delta")];
    // Lost leads still at New Lead can go; a lead with a supply site, or one past New Lead, stays.
    expectStatus(await manager.client.post(`/opportunities/${beta}/lost`, { reason: "No answer" }), 204);
    expectStatus(await ops.client.post(`/opportunities/${gamma}/sites`, { serviceType: "electricity", address: { line1: "1 Quay St" } }), 201);
    expectStatus(await ops.client.post(`/opportunities/${delta}/stage`, { stage: "contacted" }), 204);

    const filter = "?campaign=Purge%20list";
    for (const c of [manager, ops, sales]) {
      expectStatus(await c.client.get(`/lead-purge${filter}`), 403);
      expectStatus(await c.client.post("/lead-purge", { campaign: "Purge list", expected: 2, confirm: "DELETE" }), 403);
    }
    const preview = expectStatus(await admin.client.get(`/lead-purge${filter}`), 200).body;
    expect(preview).toMatchObject({ deletable: 2, kept: 1 });
    expect(preview.campaigns).toContain("Purge list");

    expectStatus(await admin.client.post("/lead-purge", { campaign: "Purge list", expected: 2 }), 400);
    expect(expectStatus(await admin.client.post("/lead-purge", { campaign: "Purge list", expected: 3, confirm: "DELETE" }), 409).body.message).toMatch(/^2 lead\(s\) can be deleted now/);
    expect(await t.prisma.opportunity.count({ where: { campaign: "Purge list" } })).toBe(4);

    const numbers = (await t.prisma.opportunity.findMany({ where: { id: { in: [alpha, beta] } }, orderBy: { number: "asc" } })).map((o) => o.number);
    expect(expectStatus(await admin.client.post("/lead-purge", { campaign: "Purge list", expected: 2, confirm: "DELETE" }), 200).body).toEqual({ deleted: 2 });
    expect((await t.prisma.opportunity.findMany({ where: { campaign: "Purge list" } })).map((o) => o.id).sort()).toEqual([gamma, delta].sort());
    expect(await t.prisma.timelineEntry.count({ where: { opportunityId: { in: [alpha, beta] } } })).toBe(0);
    expect(await t.prisma.stageHistory.count({ where: { opportunityId: { in: [alpha, beta] } } })).toBe(0);
    expectStatus(await admin.client.get(`/opportunities/${alpha}`), 404);

    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "opportunity.purge" } });
    expect(audit.summary).toBe("Permanently deleted 2 untouched leads (from Purge list)");
    expect((audit.data as { numbers: number[] }).numbers.sort((a, b) => a - b)).toEqual(numbers);
    expect(expectStatus(await admin.client.get(`/lead-purge${filter}`), 200).body).toMatchObject({ deletable: 0, kept: 1 });
  });

  it("still refuses any other delete of an opportunity", async () => {
    const id = (await t.prisma.opportunity.findFirstOrThrow({ where: { companyName: "Purge Gamma" } })).id;
    await expect(t.prisma.opportunity.delete({ where: { id } })).rejects.toThrow(/permanent records/);
  });
});
