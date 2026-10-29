import { type TestApp, createTestApp, expectStatus, pdf, userAndClient } from "../support/app";
import { createOpportunity } from "../support/fixtures";

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
afterAll(() => t.close());

type Item = { id: string; documentType: string; received: boolean; approval: string; versions: { id: string; version: number; removedAt: string | null; removeReason?: string | null }[] };
const checklist = async (oppId: string) => expectStatus(await sales.client.get(`/opportunities/${oppId}/documents`), 200).body as Item[];
const upload = async (itemId: string, label: string) => expectStatus(await sales.client.upload(`/documents/${itemId}/versions`, pdf(label), `${label}.pdf`, "application/pdf"), 201).body as { id: string; version: number };

describe("removing a wrong upload", () => {
  it("keeps the file in the history, makes the earlier file current again and needs a fresh review", async () => {
    const oppId = await createOpportunity(sales.client, "electricity");
    const item = expectStatus(await sales.client.post(`/opportunities/${oppId}/documents`, { documentType: "energy_bill", required: true }), 201).body.id as string;
    const v1 = await upload(item, "right-bill");
    const v2 = await upload(item, "wrong-customer");
    expectStatus(await ops.client.post(`/documents/${item}/review`, { approval: "approved" }), 204);

    // A reason is needed, and another salesperson can't touch it.
    expectStatus(await sales.client.post(`/document-versions/${v2.id}/remove`, { reason: "" }), 400);
    expectStatus(await other.client.post(`/document-versions/${v2.id}/remove`, { reason: "Wrong customer's bill" }), 404);
    expectStatus(await sales.client.post(`/document-versions/${v2.id}/remove`, { reason: "Wrong customer's bill" }), 204);
    expectStatus(await sales.client.post(`/document-versions/${v2.id}/remove`, { reason: "Again" }), 422);

    const [row] = (await checklist(oppId)).filter((i) => i.id === item);
    expect(row).toMatchObject({ received: true, approval: "pending" });
    expect(row.versions.find((v) => v.id === v2.id)).toMatchObject({ removeReason: "Wrong customer's bill" });
    expect(row.versions.find((v) => v.id === v2.id)?.removedAt).toBeTruthy();
    expect(row.versions.find((v) => v.id === v1.id)?.removedAt).toBeNull();
    // The bill used for checks is the remaining one.
    const facts = await t.prisma.documentVersion.findFirst({ where: { itemId: item, removedAt: null }, orderBy: { version: "desc" } });
    expect(facts?.id).toBe(v1.id);

    // The next upload gets a new number, never a removed one's.
    expect((await upload(item, "new-bill")).version).toBe(3);

    const timeline = await t.prisma.timelineEntry.findMany({ where: { opportunityId: oppId }, select: { body: true } });
    expect(timeline.map((e) => e.body)).toContain("Removed Recent energy bill version 2: Wrong customer's bill");
    expect(await t.prisma.auditLog.count({ where: { action: "document.remove_version", entityId: item } })).toBe(1);
  });

  it("marks the document as not received when its only file is removed", async () => {
    const oppId = await createOpportunity(sales.client, "gas");
    const item = expectStatus(await sales.client.post(`/opportunities/${oppId}/documents`, { documentType: "other", required: true }), 201).body.id as string;
    const v = await upload(item, "only");
    expectStatus(await sales.client.post(`/document-versions/${v.id}/remove`, { reason: "Uploaded to the wrong deal" }), 204);
    const [row] = (await checklist(oppId)).filter((i) => i.id === item);
    expect(row).toMatchObject({ received: false, approval: "pending" });
  });

  it("keeps files other records use, and documents on closed deals", async () => {
    const oppId = await createOpportunity(sales.client, "electricity");
    const item = expectStatus(await sales.client.post(`/opportunities/${oppId}/documents`, { documentType: "energy_bill", required: true }), 201).body.id as string;
    const v = await upload(item, "checked-bill");
    await t.prisma.billCheck.create({
      data: { opportunityId: oppId, documentVersionId: v.id, previousSupplier: "Electric Ireland", readable: true, customerNameMatches: true, supplyPointMatches: true, supplierMatches: true, passed: true, verifiedById: sales.user.id },
    });
    expect(expectStatus(await sales.client.post(`/document-versions/${v.id}/remove`, { reason: "Not needed" }), 422).body.issues[0]).toMatch(/bill check/);

    const lost = await createOpportunity(sales.client, "electricity");
    const lostItem = expectStatus(await sales.client.post(`/opportunities/${lost}/documents`, { documentType: "other", required: true }), 201).body.id as string;
    const lostFile = await upload(lostItem, "lost");
    await t.prisma.opportunity.update({ where: { id: lost }, data: { outcome: "lost", lostAt: new Date(), lostReason: "Price" } });
    expectStatus(await sales.client.post(`/document-versions/${lostFile.id}/remove`, { reason: "Tidy up" }), 422);
  });
});

describe("deleting a checklist row", () => {
  it("deletes a row nothing was uploaded to, and keeps one with files", async () => {
    const oppId = await createOpportunity(sales.client, "electricity");
    const empty = expectStatus(await sales.client.post(`/opportunities/${oppId}/documents`, { documentType: "other", required: false }), 201).body.id as string;
    const used = expectStatus(await sales.client.post(`/opportunities/${oppId}/documents`, { documentType: "energy_bill", required: true }), 201).body.id as string;
    const v = await upload(used, "bill");
    expectStatus(await other.client.del(`/documents/${empty}`), 404);
    expectStatus(await sales.client.del(`/documents/${empty}`), 204);
    expect(await t.prisma.documentItem.count({ where: { id: empty } })).toBe(0);
    // Even after its file is removed, a row that had files stays (its history is on it).
    expectStatus(await sales.client.post(`/document-versions/${v.id}/remove`, { reason: "Wrong file" }), 204);
    expect(expectStatus(await sales.client.del(`/documents/${used}`), 422).body.issues[0]).toMatch(/Files have been uploaded/);
  });
});

describe("removing a supply site", () => {
  it("removes a site added by mistake with its meters, and unlinks draft contracts", async () => {
    const oppId = await createOpportunity(sales.client, "electricity");
    const keep = expectStatus(await sales.client.post(`/opportunities/${oppId}/sites`, { serviceType: "electricity", address: { line1: "1 Right St" } }), 201).body.id as string;
    const wrong = expectStatus(await sales.client.post(`/opportunities/${oppId}/sites`, { serviceType: "electricity", label: "Duplicate", address: { line1: "1 Right Street" } }), 201).body.id as string;
    expectStatus(await sales.client.post(`/sites/${wrong}/meters`, { fuel: "electricity", mprn: "10012345678" }), 201);
    const contract = expectStatus(await sales.client.post(`/opportunities/${oppId}/contracts`, { fuel: "electricity", siteId: wrong }), 201).body.id as string;

    expectStatus(await sales.client.post(`/sites/${wrong}/remove`, { reason: "" }), 400);
    expectStatus(await other.client.post(`/sites/${wrong}/remove`, { reason: "Duplicate" }), 404);
    expectStatus(await sales.client.post(`/sites/${wrong}/remove`, { reason: "Added twice" }), 204);

    const energy = expectStatus(await sales.client.get(`/opportunities/${oppId}/energy`), 200).body as { sites: { id: string }[]; contracts: { id: string; siteId: string | null }[] };
    expect(energy.sites.map((s) => s.id)).toEqual([keep]);
    expect(energy.contracts.find((c) => c.id === contract)?.siteId).toBeNull();
    expect(await t.prisma.meterPoint.count({ where: { mprn: "10012345678" } })).toBe(0);
    const timeline = await t.prisma.timelineEntry.findMany({ where: { opportunityId: oppId }, select: { body: true } });
    expect(timeline.map((e) => e.body)).toContain("Supply site removed: Duplicate (10012345678). Added twice");
  });

  it("keeps a site with a live contract, and sites on closed deals", async () => {
    const oppId = await createOpportunity(sales.client, "gas");
    const site = expectStatus(await sales.client.post(`/opportunities/${oppId}/sites`, { serviceType: "gas", address: { line1: "2 Gas Lane" } }), 201).body.id as string;
    const contract = expectStatus(await sales.client.post(`/opportunities/${oppId}/contracts`, { fuel: "gas", siteId: site }), 201).body.id as string;
    await t.prisma.energyContract.update({ where: { id: contract }, data: { status: "live" } });
    expect(expectStatus(await sales.client.post(`/sites/${site}/remove`, { reason: "Mistake" }), 422).body.issues[0]).toMatch(/live or ended contract/);

    const lost = await createOpportunity(sales.client, "gas");
    const lostSite = expectStatus(await sales.client.post(`/opportunities/${lost}/sites`, { serviceType: "gas", address: { line1: "3 Gas Lane" } }), 201).body.id as string;
    await t.prisma.opportunity.update({ where: { id: lost }, data: { outcome: "lost", lostAt: new Date(), lostReason: "Price" } });
    expectStatus(await sales.client.post(`/sites/${lostSite}/remove`, { reason: "Tidy up" }), 422);
  });
});
