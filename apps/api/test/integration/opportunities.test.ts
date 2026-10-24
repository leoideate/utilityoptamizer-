import { type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";
import { type Team, createOpportunity, readyEnergy, readyMerchant, sendAndAccept, supplier } from "../support/fixtures";

let t: TestApp;
let team: Team;
let otherSales: Awaited<ReturnType<typeof userAndClient>>;

beforeAll(async () => {
  t = await createTestApp();
  const sales = await userAndClient(t, ["salesperson"], "Sarah Sales");
  team = {
    sales: sales.client,
    salesId: sales.user.id,
    ops: (await userAndClient(t, ["operations"])).client,
    manager: (await userAndClient(t, ["manager"])).client,
    compliance: (await userAndClient(t, ["compliance"])).client,
  };
  otherSales = await userAndClient(t, ["salesperson"], "Sean Sales");
});
afterAll(() => t.close());

describe("creating opportunities (scenarios 1–4)", () => {
  it.each(["electricity", "gas", "dual_fuel", "merchant_services"] as const)("creates a %s opportunity with only a name and service", async (serviceType) => {
    const res = expectStatus(await team.sales.post("/opportunities", { name: `Quick ${serviceType}`, serviceType }), 201);
    const ws = expectStatus(await team.sales.get(`/opportunities/${res.body.id}`), 200).body;
    expect(ws).toMatchObject({ serviceType, saleType: "new_sale", outcome: "open", active: true, ownerId: team.salesId, stage: { key: "new_lead" } });
    // A first-contact task was scheduled for the salesperson.
    const acts = expectStatus(await team.sales.get(`/activities?opportunityId=${res.body.id}`), 200).body;
    expect(acts.items.map((a: { summary: string }) => a.summary)).toContain("Make first contact");
  });

  it("rejects a missing name with a readable message", async () => {
    const res = expectStatus(await team.sales.post("/opportunities", { name: "", serviceType: "gas" }), 400);
    expect(res.body.issues).toContain("name: Give the opportunity a name.");
  });
});

describe("conditional fields (scenario 5)", () => {
  it("energy details are refused on a Worldpay opportunity and vice versa", async () => {
    const wp = await createOpportunity(team.sales, "merchant_services");
    const site = expectStatus(await team.sales.post(`/opportunities/${wp}/sites`, { serviceType: "electricity", address: { line1: "x" } }), 422);
    expect(site.body.message).toMatch(/Worldpay opportunity/);

    const gas = await createOpportunity(team.sales, "gas");
    expect(expectStatus(await team.sales.post(`/opportunities/${gas}/merchant-applications`, {}), 422).body.message).toMatch(/Merchant Services/);
    expect(expectStatus(await team.sales.post(`/opportunities/${gas}/contracts`, { fuel: "electricity" }), 422).body.message).toMatch(/gas opportunity/);
  });

  it("only the right identifier is accepted for each meter", async () => {
    const opp = await createOpportunity(team.sales, "electricity");
    const site = expectStatus(await team.sales.post(`/opportunities/${opp}/sites`, { serviceType: "electricity", address: { line1: "2 Main St" } }), 201).body.id;
    expectStatus(await team.sales.post(`/sites/${site}/meters`, { fuel: "gas", gprn: "1234567" }), 422);
    expect(expectStatus(await team.sales.post(`/sites/${site}/meters`, { fuel: "electricity", mprn: "123" }), 422).body.message).toMatch(/11 digits/);
    // A genuine exception is allowed with a reason.
    expectStatus(await team.sales.post(`/sites/${site}/meters`, { fuel: "electricity", mprn: "PENDING-NEW", formatExceptionReason: "New connection, MPRN not issued yet" }), 201);
  });
});

describe("onboarding fields", () => {
  it("saves the new lead fields and keeps the checklist in step with supply changes", async () => {
    const created = expectStatus(
      await team.sales.post("/opportunities", {
        name: "Onboarding fields",
        serviceType: "electricity",
        contactRole: "Owner",
        expectedCloseDate: "2026-12-01",
        visitDate: "2026-10-10",
        productInterest: ["electricity", "payment_services"],
        supplyChanges: ["change_of_supplier"],
      }),
      201,
    ).body.id;
    let ws = expectStatus(await team.sales.get(`/opportunities/${created}`), 200).body;
    expect(ws).toMatchObject({ contactRole: "Owner", productInterest: ["electricity", "payment_services"], supplyChanges: ["change_of_supplier"] });
    expect(ws.expectedCloseDate).toMatch(/^2026-12-01/);
    expect(ws.visitDate).toMatch(/^2026-10-10/);

    // The checklist created at Details Requested includes what the supply changes need.
    for (const stage of ["call_scheduled", "contacted", "interested", "details_requested"]) expectStatus(await team.sales.post(`/opportunities/${created}/stage`, { stage }), 204);
    const docs = async () => expectStatus(await team.sales.get(`/opportunities/${created}/documents`), 200).body as { documentType: string; required: boolean }[];
    expect((await docs()).find((d) => d.documentType === "meter_reading_photo")).toBeUndefined();

    // Adding changes later adds their documents and makes optional ones required.
    expectStatus(await team.sales.patch(`/opportunities/${created}`, { supplyChanges: ["change_of_supplier", "change_of_legal_entity", "reenergise_meter"] }), 204);
    const after = await docs();
    for (const t of ["lease_agreement", "meter_reading_photo", "change_of_tenancy"]) expect(after.find((d) => d.documentType === t)?.required).toBe(true);
    ws = expectStatus(await team.sales.get(`/opportunities/${created}`), 200).body;
    expect(ws.supplyChanges).toEqual(["change_of_supplier", "change_of_legal_entity", "reenergise_meter"]);
    const timeline = expectStatus(await team.sales.get(`/opportunities/${created}/timeline`), 200).body;
    expect(JSON.stringify(timeline)).toMatch(/Supply changes: Change of supplier, Change of legal entity, Re-energise/);
  });

  it("rejects unknown supply changes", async () => {
    expectStatus(await team.sales.post("/opportunities", { name: "Bad change", serviceType: "gas", supplyChanges: ["new_connection"] }), 400);
  });
});

describe("stage validation (scenarios 6–9)", () => {
  it("early stages need nothing; later stages list what's missing", async () => {
    const opp = await createOpportunity(team.sales, "dual_fuel");
    for (const stage of ["call_scheduled", "contacted", "interested", "details_requested", "details_received", "comparison_prepared"]) {
      expectStatus(await team.sales.post(`/opportunities/${opp}/stage`, { stage }), 204);
    }
    const res = expectStatus(await team.sales.post(`/opportunities/${opp}/stage`, { stage: "proposal_sent" }), 422);
    expect(res.body.message).toBe("Add at least one supply site before sending a proposal.");
    // Moving to Details Requested added the standard document checklist.
    const docs = expectStatus(await team.sales.get(`/opportunities/${opp}/documents`), 200).body;
    expect(docs.map((d: { documentType: string }) => d.documentType)).toEqual(expect.arrayContaining(["energy_bill", "letter_of_authority"]));
  });

  it("submission requires MPRN/GPRN, approved documents, signature and internal approval (7, 8)", async () => {
    const s = await supplier(t);
    const opp = await createOpportunity(team.sales, "gas");
    expectStatus(await team.sales.post(`/opportunities/${opp}/customer/create`), 201);
    expectStatus(await team.sales.patch(`/opportunities/${opp}`, { selectedSupplierId: s.id }), 204);
    expectStatus(await team.sales.post(`/opportunities/${opp}/sites`, { serviceType: "gas", address: { line1: "3 Main St" } }), 201);
    await team.sales.post(`/opportunities/${opp}/documents/standard`);
    const res = expectStatus(await team.ops.post(`/opportunities/${opp}/stage`, { stage: "submitted" }), 422);
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        "Enter a GPRN for every gas meter.",
        "Add the energy contract details.",
        "The customer must sign before submission.",
        "Internal approval must be granted before submission.",
        expect.stringMatching(/^These required documents must be received and approved: Recent energy bill, Letter of authority, Signed supplier contract\.$/),
      ]),
    );
    expect(res.body.issues.join(" ")).not.toMatch(/MPRN/);
  });

  it("only managers can grant internal approval (8)", async () => {
    const opp = await createOpportunity(team.sales, "electricity");
    expectStatus(await team.sales.post(`/opportunities/${opp}/approval`, { decision: "approved" }), 403);
    expectStatus(await team.ops.post(`/opportunities/${opp}/approval`, { decision: "approved" }), 403);
    expectStatus(await team.manager.post(`/opportunities/${opp}/approval`, { decision: "approved" }), 204);
    const ws = expectStatus(await team.sales.get(`/opportunities/${opp}`), 200).body;
    expect(ws.internalApproval).toBe("approved");
  });

  it("a fully prepared energy deal can be submitted by Operations but not by Sales", async () => {
    const { oppId } = await readyEnergy(t, team, "dual_fuel");
    expectStatus(await team.sales.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 403);
    expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 204);
  });

  it("Worldpay: deposit/prepayment details and percentages (9)", async () => {
    const opp = await createOpportunity(team.sales, "merchant_services");
    const app = expectStatus(await team.sales.post(`/opportunities/${opp}/merchant-applications`, { legalEntity: "sole_trader" }), 201).body.id;
    expect(expectStatus(await team.sales.put(`/merchant-applications/${app}/risk`, { depositTxnPct: 120 }), 400).body.issues[0]).toBe("depositTxnPct: Deposit transaction percentage must be between 0 and 100.");
    expectStatus(await team.sales.post(`/merchant-applications/${app}/pricing`, { product: "Terminal", debitRate: 101 }), 400);
    expectStatus(await team.sales.put(`/merchant-applications/${app}/risk`, { depositsAccepted: true, fullPrepaymentAccepted: true }), 204);
    expectStatus(await team.sales.post(`/opportunities/${opp}/stage`, { stage: "comparison_prepared" }), 204);
    const blocked = expectStatus(await team.sales.post(`/opportunities/${opp}/stage`, { stage: "proposal_sent" }), 422);
    expect(blocked.body.issues).toContain("Enter the estimated annual turnover.");
    await team.sales.patch(`/merchant-applications/${app}`, { estimatedAnnualTurnover: 90000, cardTurnoverPct: 50, averageTransactionValue: 40, advertisingMethod: "Instagram" });
    await team.sales.post(`/merchant-applications/${app}/pricing`, { product: "Terminal" });
    expectStatus(await team.sales.post(`/opportunities/${opp}/customer/create`), 201);
    const docs = expectStatus(await team.sales.post(`/opportunities/${opp}/stage`, { stage: "documents_prepared" }), 422).body.issues as string[];
    expect(docs.filter((i) => i.startsWith("Deposits are accepted"))).toHaveLength(4);
    expect(docs.filter((i) => i.startsWith("Full payment in advance"))).toHaveLength(2);
    expect(docs).toContain("A sole trader needs principal details for the owner.");
    // Turning deposits off clears the requirement (and the stale numbers).
    await team.sales.put(`/merchant-applications/${app}/risk`, { depositsAccepted: false, fullPrepaymentAccepted: false });
    const after = expectStatus(await team.sales.post(`/opportunities/${opp}/stage`, { stage: "documents_prepared" }), 422).body.issues as string[];
    expect(after.some((i) => i.startsWith("Deposits") || i.startsWith("Full payment"))).toBe(false);
  });

  it("a complete Worldpay deal passes every gate", async () => {
    const { oppId } = await readyMerchant(t, team);
    expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 204);
  });
});

describe("customer linking and won retention (scenarios 10–12)", () => {
  it("creating or linking a customer never removes, archives or reassigns the opportunity (10)", async () => {
    const opp = await createOpportunity(team.sales, "electricity");
    await team.sales.post(`/opportunities/${opp}/stage`, { stage: "interested" });
    const created = expectStatus(await team.sales.post(`/opportunities/${opp}/customer/create`), 201).body.customerId;
    let ws = expectStatus(await team.sales.get(`/opportunities/${opp}`), 200).body;
    expect(ws).toMatchObject({ customerId: created, active: true, outcome: "open", ownerId: team.salesId, stage: { key: "interested" } });

    const other = expectStatus(await team.sales.post("/customers?confirmNew=true", { legalName: "Another Ltd" }), 201).body.id;
    expectStatus(await team.sales.post(`/opportunities/${opp}/customer`, { customerId: other }), 204);
    ws = expectStatus(await team.sales.get(`/opportunities/${opp}`), 200).body;
    expect(ws).toMatchObject({ customerId: other, active: true, outcome: "open", ownerId: team.salesId, stage: { key: "interested" } });
    const list = expectStatus(await team.sales.get("/opportunities?view=my_open&pageSize=200"), 200).body;
    expect(list.items.some((o: { id: string }) => o.id === opp)).toBe(true);
    // The customer profile shows the opportunity too.
    const profile = expectStatus(await team.sales.get(`/customers/${other}`), 200).body;
    expect(profile.opportunities.map((o: { id: string }) => o.id)).toContain(opp);
  });

  it("activation makes the deal Live / Won, active, searchable and still assigned (11, 12)", async () => {
    const { oppId } = await readyEnergy(t, team);
    expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 204);
    expectStatus(await team.sales.post(`/opportunities/${oppId}/activate`, { activationDate: "2026-11-01" }), 403);
    // Submitted is not accepted: the supplier's acceptance must be recorded first.
    expect(expectStatus(await team.ops.post(`/opportunities/${oppId}/activate`, { activationDate: "2026-11-01" }), 422).body.issues).toContain(
      "Record what was sent to the external party (recipient, files and proof of delivery).",
    );
    await sendAndAccept(team, oppId);
    expectStatus(await team.ops.post(`/opportunities/${oppId}/activate`, { activationDate: "2026-11-01", supplierReference: "EN-1001" }), 204);

    const ws = expectStatus(await team.sales.get(`/opportunities/${oppId}`), 200).body;
    expect(ws).toMatchObject({ outcome: "won", probability: 100, active: true, ownerId: team.salesId, stage: { key: "live_won" } });
    expect(ws.activationDate.slice(0, 10)).toBe("2026-11-01");
    expect(ws.renewalDate.slice(0, 10)).toBe("2028-10-31");

    const won = expectStatus(await team.manager.get("/opportunities?view=all_won&pageSize=200"), 200).body;
    expect(won.items.map((o: { id: string }) => o.id)).toContain(oppId);
    const search = expectStatus(await team.sales.get(`/search?q=UO-${ws.number}`), 200).body;
    expect(search.opportunities.map((o: { id: string }) => o.id)).toContain(oppId);
    const board = expectStatus(await team.sales.get("/opportunities/board?view=all"), 200).body;
    const liveCol = board.columns.find((c: { stage: { key: string } }) => c.stage.key === "live_won");
    expect(liveCol.cards.map((c: { id: string }) => c.id)).toContain(oppId);

    // Won deals keep their salesperson and can't drift back into the pipeline.
    expect(expectStatus(await team.manager.post(`/opportunities/${oppId}/assign`, { ownerId: null }), 422).body.message).toMatch(/keeps its salesperson/);
    expectStatus(await team.sales.post(`/opportunities/${oppId}/stage`, { stage: "contacted" }), 422);
    expectStatus(await team.sales.post(`/opportunities/${oppId}/lost`, { reason: "x" }), 422);

    // The database itself refuses to archive or delete it.
    await expect(t.prisma.opportunity.update({ where: { id: oppId }, data: { active: false } })).rejects.toThrow(/cannot be archived/);
    await expect(t.prisma.opportunity.delete({ where: { id: oppId } })).rejects.toThrow(/cannot be deleted/);

    // Contracts went live with an end date; a renewal review task exists.
    const energy = expectStatus(await team.sales.get(`/opportunities/${oppId}/energy`), 200).body;
    expect(energy.contracts[0]).toMatchObject({ status: "live", supplierReference: "EN-1001" });
    const acts = expectStatus(await team.sales.get(`/activities?opportunityId=${oppId}`), 200).body.items;
    expect(acts.some((a: { type: string }) => a.type === "renewal_review")).toBe(true);
  });

  it("lost is an outcome: the record stays active and visible under Lost", async () => {
    const opp = await createOpportunity(team.sales, "gas");
    expectStatus(await team.sales.post(`/opportunities/${opp}/lost`, { reason: "Stayed with current supplier" }), 204);
    const ws = expectStatus(await team.sales.get(`/opportunities/${opp}`), 200).body;
    expect(ws).toMatchObject({ outcome: "lost", active: true, stage: { key: "new_lead" } });
    const lost = expectStatus(await team.sales.get("/opportunities?view=lost"), 200).body;
    expect(lost.items.map((o: { id: string }) => o.id)).toContain(opp);
    expectStatus(await team.sales.post(`/opportunities/${opp}/reopen`), 204);
  });

  it("only a manager can reopen a won deal", async () => {
    const { oppId } = await readyEnergy(t, team, "gas");
    await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" });
    await sendAndAccept(team, oppId);
    expectStatus(await team.ops.post(`/opportunities/${oppId}/activate`, { activationDate: "2026-10-01" }), 204);
    expectStatus(await team.sales.post(`/opportunities/${oppId}/reopen`), 403);
    expectStatus(await team.manager.post(`/opportunities/${oppId}/reopen`), 204);
    const ws = expectStatus(await team.manager.get(`/opportunities/${oppId}`), 200).body;
    expect(ws).toMatchObject({ outcome: "open", active: true, ownerId: team.salesId, stage: { key: "awaiting_confirmation" } });
  });
});

describe("visibility (scenarios 13–14)", () => {
  it("managers see every opportunity; salespeople only their own and unassigned", async () => {
    const mine = await createOpportunity(team.sales, "electricity");
    const theirs = await createOpportunity(otherSales.client, "electricity");
    const unassigned = expectStatus(await team.ops.post("/opportunities", { name: "Web enquiry", serviceType: "gas", leadSource: "website" }), 201).body.id;

    const managerList = expectStatus(await team.manager.get("/opportunities?view=all&pageSize=200"), 200).body.items.map((o: { id: string }) => o.id);
    expect(managerList).toEqual(expect.arrayContaining([mine, theirs, unassigned]));

    const salesList = expectStatus(await team.sales.get("/opportunities?view=all&pageSize=200"), 200).body.items.map((o: { id: string }) => o.id);
    expect(salesList).toEqual(expect.arrayContaining([mine, unassigned]));
    expect(salesList).not.toContain(theirs);
    expectStatus(await team.sales.get(`/opportunities/${theirs}`), 404);
    expectStatus(await team.sales.patch(`/opportunities/${theirs}`, { name: "hijack" }), 404);

    const unassignedView = expectStatus(await team.sales.get("/opportunities?view=unassigned&pageSize=200"), 200).body.items.map((o: { id: string }) => o.id);
    expect(unassignedView).toContain(unassigned);
    // A salesperson may pick up an unassigned lead, but not give leads to others.
    expectStatus(await team.sales.post(`/opportunities/${unassigned}/assign`, { ownerId: otherSales.user.id }), 403);
    expectStatus(await team.sales.post(`/opportunities/${unassigned}/assign`, { ownerId: team.salesId }), 204);
    expectStatus(await otherSales.client.get(`/opportunities/${unassigned}`), 404);
  });
});

describe("closing an import batch", () => {
  it("marks a campaign's leads still at New Lead lost, optionally one service, only as many as the manager confirmed", async () => {
    const csv = "Company,Service,Campaign\nAlpha Café,Worldpay,Spring list\nAlpha Café,Electricity,Spring list\nBeta Bar,Worldpay,Spring list\nBeta Bar,Electricity,Spring list\nGamma Deli,Gas,Other list\n";
    expectStatus(await team.ops.upload("/opportunities/import", Buffer.from(csv), "leads.csv", "text/csv"), 201);
    // A lead someone has started working isn't part of a batch close.
    const worked = await t.prisma.opportunity.findFirstOrThrow({ where: { companyName: "Beta Bar", serviceType: "electricity" } });
    expectStatus(await team.ops.post(`/opportunities/${worked.id}/stage`, { stage: "contacted" }), 204);

    // Managers and administrators only.
    expectStatus(await team.sales.get("/lead-batches"), 403);
    expectStatus(await team.ops.get("/lead-batches"), 403);
    expectStatus(await team.ops.post("/lead-batches/close", { campaign: "Spring list", reason: "x", expected: 3 }), 403);
    const batches = expectStatus(await team.manager.get("/lead-batches"), 200).body.filter((b: { campaign: string }) => b.campaign.endsWith(" list"));
    expect(batches).toEqual([
      { campaign: "Other list", total: 1, services: { gas: 1 } },
      { campaign: "Spring list", total: 3, services: { merchant_services: 2, electricity: 1 } },
    ]);

    // A count that no longer matches closes nothing.
    expect(expectStatus(await team.manager.post("/lead-batches/close", { campaign: "Spring list", serviceType: "merchant_services", reason: "Duplicate", expected: 3 }), 409).body.message).toMatch(/^2 lead\(s\) in this batch/);
    expect(await t.prisma.opportunity.count({ where: { outcome: "lost" } })).toBe(0);

    const reason = "Duplicate: one lead per business";
    expect(expectStatus(await team.manager.post("/lead-batches/close", { campaign: "Spring list", serviceType: "merchant_services", reason, expected: 2 }), 200).body).toEqual({ closed: 2 });
    const spring = await t.prisma.opportunity.findMany({ where: { campaign: "Spring list" }, orderBy: { number: "asc" } });
    expect(spring.map((o) => [o.companyName, o.serviceType, o.outcome, o.lostReason, o.active])).toEqual([
      ["Alpha Café", "merchant_services", "lost", reason, true],
      ["Alpha Café", "electricity", "open", null, true],
      ["Beta Bar", "merchant_services", "lost", reason, true],
      ["Beta Bar", "electricity", "open", null, true],
    ]);
    const lost = spring.filter((o) => o.outcome === "lost").map((o) => o.id);
    expect(await t.prisma.timelineEntry.count({ where: { opportunityId: { in: lost }, kind: "outcome", body: `Marked lost: ${reason}` } })).toBe(2);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "opportunity.lost_batch" } });
    expect(audit.summary).toBe("Marked 2 imported Merchant Services / Worldpay leads lost (Spring list)");
    expect((audit.data as { ids: string[] }).ids.sort()).toEqual([...lost].sort());

    // What's left of the batch; each closed lead can still be reopened on its own.
    const after = expectStatus(await team.manager.get("/lead-batches"), 200).body.find((b: { campaign: string }) => b.campaign === "Spring list");
    expect(after).toEqual({ campaign: "Spring list", total: 1, services: { electricity: 1 } });
    expectStatus(await team.manager.post(`/opportunities/${lost[0]}/reopen`), 204);
  });
});

describe("persistent opportunity notes", () => {
  it("saves, updates and clears notes independently of other details and timeline", async () => {
    const id = await createOpportunity(team.sales, "electricity");
    const url = "/opportunities/" + id;
    const before = expectStatus(await team.sales.get(url), 200).body;
    const timeline = expectStatus(await team.sales.get(url + "/timeline"), 200).body;
    expect(before.notes).toBeNull();
    const notes = "Enjoys golf.\nAsk about the weekend tournament.";
    expectStatus(await team.sales.patch(url, { notes }), 204);
    expect(expectStatus(await team.sales.get(url), 200).body).toMatchObject({ notes, name: before.name, serviceType: before.serviceType });
    expectStatus(await otherSales.client.patch(url, { notes: "unauthorised" }), 404);
    expectStatus(await team.sales.patch(url, { notes: "x".repeat(10001) }), 400);
    expectStatus(await team.sales.patch(url, { notes: "Prefers afternoon calls." }), 204);
    expect(expectStatus(await team.sales.get(url), 200).body.notes).toBe("Prefers afternoon calls.");
    expectStatus(await team.sales.patch(url, { notes: null }), 204);
    expect(expectStatus(await team.sales.get(url), 200).body.notes).toBeNull();
    expect(expectStatus(await team.sales.get(url + "/timeline"), 200).body).toEqual(timeline);
  });
});


describe("social media lead source", () => {
  it("creates and updates social media leads and rejects the replaced source", async () => {
    const res = expectStatus(await team.sales.post("/opportunities", { name: "Social media enquiry", serviceType: "electricity", leadSource: "social_media" }), 201);
    const url = "/opportunities/" + res.body.id;
    expect(expectStatus(await team.sales.get(url), 200).body.leadSource).toBe("social_media");
    expectStatus(await team.sales.patch(url, { leadSource: "email" }), 204);
    expectStatus(await team.sales.patch(url, { leadSource: "social_media" }), 204);
    expect(expectStatus(await team.sales.get(url), 200).body.leadSource).toBe("social_media");
    expectStatus(await team.sales.patch(url, { leadSource: "telephone" }), 400);
  });
});
