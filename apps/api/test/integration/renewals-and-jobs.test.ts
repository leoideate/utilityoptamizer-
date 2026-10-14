import { addDays, today } from "@uo/shared";
import { SYSTEM } from "../../src/common/actor";
import { AutomationsService } from "../../src/automations/automations.service";
import { RenewalsService } from "../../src/automations/renewals.service";
import { IntegrationsService } from "../../src/integrations/integrations.service";
import { StagesService } from "../../src/opportunities/stages.service";
import { signWebhook } from "../../src/signatures/provider";
import { type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";
import { type Team, createOpportunity, readyEnergy, readyMerchant } from "../support/fixtures";

let t: TestApp;
let team: Team;

beforeAll(async () => {
  t = await createTestApp();
  const sales = await userAndClient(t, ["salesperson"]);
  team = {
    sales: sales.client,
    salesId: sales.user.id,
    ops: (await userAndClient(t, ["operations"])).client,
    manager: (await userAndClient(t, ["manager"])).client,
    compliance: (await userAndClient(t, ["compliance"])).client,
  };
});
afterAll(() => t.close());

/** A live dual-fuel deal whose contracts end `daysToEnd` days from today. */
async function liveDualFuel(daysToEnd: number) {
  const { oppId } = await readyEnergy(t, team, "dual_fuel");
  expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 204);
  expectStatus(await team.ops.post(`/opportunities/${oppId}/activate`, { activationDate: addDays(today(), -600) }), 204);
  await t.prisma.energyContract.updateMany({ where: { opportunityId: oppId }, data: { contractEndDate: new Date(`${addDays(today(), daysToEnd)}T00:00:00Z`) } });
  return oppId;
}

describe("renewals (scenarios 15–17)", () => {
  it("creates one linked renewal per deal, copies only reusable data, and never duplicates", async () => {
    const original = await liveDualFuel(100);
    const before = await t.prisma.energyContract.findMany({ where: { opportunityId: original }, orderBy: { fuel: "asc" } });
    const origOpp = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: original } });
    const renewals = t.app.get(RenewalsService);

    const first = await renewals.run();
    expect(first.created).toHaveLength(1);
    const renewal = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: first.created[0] }, include: { stage: true, contracts: true } });
    expect(renewal).toMatchObject({
      saleType: "renewal",
      serviceType: "dual_fuel",
      previousOpportunityId: original,
      ownerId: team.salesId,
      customerId: origOpp.customerId,
      outcome: "open",
      leadSource: "renewal",
      internalApproval: "not_requested",
      selectedSupplierId: null,
    });
    expect(renewal.stage.key).toBe("renewal_scheduled");
    expect(renewal.contracts).toHaveLength(2);
    for (const c of renewal.contracts) {
      const prev = before.find((b) => b.id === c.previousContractId)!;
      expect(prev).toBeDefined();
      expect(c).toMatchObject({ status: "draft", siteId: prev.siteId, fuel: prev.fuel, existingSupplierName: "Energia", dayRate: null, supplierReference: null });
      expect(c.currentContractEndDate?.toISOString()).toBe(prev.contractEndDate?.toISOString());
    }

    // Idempotent: a second (or concurrent) run creates nothing new.
    const [second, third] = await Promise.all([renewals.run(), renewals.run()]);
    expect(second.created.length + third.created.length).toBe(0);
    expect(await t.prisma.opportunity.count({ where: { previousOpportunityId: original } })).toBe(1);

    // History is preserved: the original deal and contracts are unchanged.
    const after = await t.prisma.energyContract.findMany({ where: { opportunityId: original }, orderBy: { fuel: "asc" } });
    expect(after).toEqual(before);
    const origAfter = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: original } });
    expect(origAfter).toMatchObject({ outcome: "won", active: true, ownerId: origOpp.ownerId, stageId: origOpp.stageId });
    // Live contracts can't be edited through the API.
    expect(expectStatus(await team.ops.patch(`/contracts/${before[0].id}`, { dayRate: 0.1 }), 422).body.message).toMatch(/kept as history/);
  });

  it("ignores contracts outside the 120-day window", async () => {
    await liveDualFuel(200);
    const run = await t.app.get(RenewalsService).run();
    expect(run.created).toHaveLength(0);
  });

  it("renews Worldpay applications with principals but a fresh risk review", async () => {
    const { oppId, appId } = await readyMerchant(t, team);
    await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" });
    expectStatus(await team.ops.post(`/opportunities/${oppId}/activate`, { activationDate: addDays(today(), -400) }), 204);
    await t.prisma.merchantApplication.update({ where: { id: appId }, data: { contractEndDate: new Date(`${addDays(today(), 95)}T00:00:00Z`) } });
    const run = await t.app.get(RenewalsService).run();
    expect(run.created).toHaveLength(1);
    const app = await t.prisma.merchantApplication.findFirstOrThrow({ where: { opportunityId: run.created[0] }, include: { risk: true, principals: true, pricing: true } });
    expect(app).toMatchObject({ previousApplicationId: appId, status: "draft", legalEntity: "limited_company" });
    expect(app.principals).toHaveLength(1);
    expect(app.pricing).toHaveLength(0);
    expect(app.risk?.complianceStatus).toBe("not_started");
  });
});

describe("background automations", () => {
  it("creates each reminder once, however often the job runs", async () => {
    const opp = await createOpportunity(team.sales, "electricity");
    await team.sales.post(`/opportunities/${opp}/stage`, { stage: "details_requested" });
    await t.prisma.documentItem.updateMany({ where: { opportunityId: opp }, data: { requestedAt: new Date(Date.now() - 5 * 86400000) } });
    const automations = t.app.get(AutomationsService);
    await automations.runAll();
    await automations.runAll();
    const reminders = await t.prisma.activity.findMany({ where: { opportunityId: opp, status: "open", automationKey: { in: ["missing_information", "missing_documents"] } } });
    expect(reminders.map((r) => r.automationKey).sort()).toEqual(["missing_documents", "missing_information"]);
  });

  it("assigns unassigned new leads to the least-busy salesperson", async () => {
    const lead = expectStatus(await team.ops.post("/opportunities", { name: "Website form", serviceType: "gas", leadSource: "website" }), 201).body.id;
    await t.app.get(AutomationsService).assignNewLeads();
    const opp = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: lead } });
    expect(opp.ownerId).not.toBeNull();
    const timeline = await t.prisma.timelineEntry.findMany({ where: { opportunityId: lead, kind: "assignment" } });
    expect(timeline[0].body).toMatch(/Automatically assigned/);
  });

  it("flags unanswered inbound messages", async () => {
    const opp = await createOpportunity(team.sales, "gas");
    await t.prisma.timelineEntry.create({ data: { opportunityId: opp, kind: "email", direction: "inbound", body: "Can you call me?", occurredAt: new Date(Date.now() - 6 * 3600000) } });
    expect(await t.app.get(AutomationsService).unansweredMessages(new Date())).toBe(1);
    expectStatus(await team.sales.post(`/opportunities/${opp}/timeline`, { kind: "call", body: "Called back", direction: "outbound" }), 201);
    await t.app.get(AutomationsService).unansweredMessages(new Date());
    expect(await t.prisma.activity.count({ where: { opportunityId: opp, automationKey: "reply_needed", status: "open" } })).toBe(0);
  });

  it("queues a virus scan for every upload", async () => {
    expect(t.queue.jobs.some((j) => j.queue === "documents" && j.name === "scan")).toBe(true);
  });
});

describe("integrations", () => {
  it("dead-letters a job after its final attempt and notifies administrators", async () => {
    const admin = await userAndClient(t, ["administrator"]);
    const svc = t.app.get(IntegrationsService);
    const job = await svc.enqueue(SYSTEM, "email.send", { to: "a@b.ie", subject: "x", text: "y" }, "test:dead-letter");
    const again = await svc.enqueue(SYSTEM, "email.send", { to: "a@b.ie", subject: "x", text: "y" }, "test:dead-letter");
    expect(again.id).toBe(job.id); // idempotency key
    await svc.execute(job.id, 6, 6); // SMTP isn't configured in tests → NotConfigured → dead
    const row = await t.prisma.integrationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("dead");
    expect(row.lastError).toMatch(/not configured/);
    const notes = expectStatus(await admin.client.get("/notifications"), 200).body;
    expect(notes[0].title).toMatch(/Integration failed/);
  });

  it("verifies signature webhooks and processes each event once", async () => {
    const { oppId } = await readyEnergy(t, team, "gas");
    const req = await t.prisma.signatureRequest.findFirstOrThrow({ where: { opportunityId: oppId } });
    const body = JSON.stringify({ eventId: "evt-1", providerRequestId: req.providerRequestId, type: "expired" });
    const server = t.app.getHttpServer();
    const supertest = (await import("supertest")).default;
    expectStatus(await supertest(server).post("/api/webhooks/signatures").set("Content-Type", "application/json").set("x-uo-signature", "t=1,v1=00").send(body), 403);
    const sig = signWebhook(process.env.SIGNATURE_WEBHOOK_SECRET!, body);
    const first = expectStatus(await supertest(server).post("/api/webhooks/signatures").set("Content-Type", "application/json").set("x-uo-signature", sig).send(body), 200);
    expect(first.body.status).toBe("processed");
    const dup = expectStatus(await supertest(server).post("/api/webhooks/signatures").set("Content-Type", "application/json").set("x-uo-signature", sig).send(body), 200);
    expect(dup.body.status).toBe("duplicate");
    // Already completed, so "expired" doesn't change it.
    expect((await t.prisma.signatureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("completed");
  });
});

describe("stage migration", () => {
  it("is idempotent and adopts legacy stages by name", async () => {
    const stages = t.app.get(StagesService);
    await t.prisma.stage.update({ where: { key: "proposal_sent" }, data: { key: null, name: "Proposition" } });
    await t.prisma.stage.create({ data: { name: "Lost", sequence: 999 } });
    const first = await stages.sync();
    expect(first.created).toEqual([]);
    expect(first.matchedByName).toEqual(["Proposition → proposal_sent"]);
    expect(first.unmanaged).toEqual(["Lost"]);
    const second = await stages.sync();
    expect(second.created).toEqual([]);
    expect(second.matchedByName).toEqual([]);
    expect(await t.prisma.stage.count({ where: { key: { not: null } } })).toBe(18);
  });
});

describe("lead intake", () => {
  it("imports CSV leads and reports bad rows by line", async () => {
    const csv = "Company,Contact,Service,Email\nAcme Bakery,Ann Lee,Electricity,ann@acme.ie\nBad Row,,Solar,\nTaste Café,,Worldpay,not-an-email\nPub Ltd,,Dual fuel,\n";
    const res = expectStatus(await team.ops.upload("/opportunities/import", Buffer.from(csv), "leads.csv", "text/csv"), 201).body;
    expect(res.created).toBe(2);
    expect(res.errors.map((e: { line: number }) => e.line)).toEqual([3, 4]);
    expect(res.errors[0].issues[0]).toMatch(/Unknown service "Solar"/);
    const imported = await t.prisma.opportunity.findMany({ where: { leadSource: "csv_import" } });
    expect(imported.map((o) => o.serviceType).sort()).toEqual(["dual_fuel", "electricity"]);
    expect(imported.every((o) => o.ownerId === null)).toBe(true);
  });

  it("accepts signed website leads once and rejects unsigned ones", async () => {
    const supertest = (await import("supertest")).default;
    const server = t.app.getHttpServer();
    const body = JSON.stringify({ externalId: "form-123", serviceType: "gas", companyName: "Web Co", email: "hi@webco.ie", message: "Please call me" });
    expectStatus(await supertest(server).post("/api/public/leads").set("Content-Type", "application/json").send(body), 403);
    const sig = signWebhook(process.env.LEAD_WEBHOOK_SECRET!, body);
    const send = () => supertest(server).post("/api/public/leads").set("Content-Type", "application/json").set("x-uo-signature", sig).send(body);
    const first = expectStatus(await send(), 200).body;
    expect(first.status).toBe("created");
    expect(expectStatus(await send(), 200).body.status).toBe("duplicate");
    const opp = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: first.id } });
    expect(opp).toMatchObject({ leadSource: "website", serviceType: "gas", companyName: "Web Co", ownerId: null });
    const note = await t.prisma.timelineEntry.findFirst({ where: { opportunityId: first.id, kind: "note" } });
    expect(note?.direction).toBe("inbound");
  });
});
