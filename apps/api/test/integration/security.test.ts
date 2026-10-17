import request from "supertest";
import { MAX_FAILED_LOGINS } from "../../src/auth/auth.service";
import { ORIGIN, type TestApp, createTestApp, createUser, expectStatus, login, pdf, userAndClient } from "../support/app";
import { type Team, createOpportunity, readyMerchant } from "../support/fixtures";

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

describe("duplicate customers (scenario 18)", () => {
  it("shows matches instead of creating, and never merges automatically", async () => {
    const first = expectStatus(
      await team.sales.post("/customers", { legalName: "Murphy's Bar Ltd", email: "info@murphys.ie", phone: "+353 1 234 5678", companyRegNumber: "123 456", vatNumber: "IE1234567T", addresses: [{ line1: "1 Quay St", postcode: "H91 A1B2" }] }),
      201,
    ).body;
    expect(first.id).toBeDefined();

    const byEmail = expectStatus(await team.sales.post("/customers", { legalName: "Different Name", email: "INFO@murphys.ie" }), 201).body;
    expect(byEmail.id).toBeUndefined();
    expect(byEmail.duplicates[0].reasons).toEqual(["Same email"]);

    const checks = [
      [{ phone: "01 234 5678" }, "Same phone number"],
      [{ companyRegNumber: "123456" }, "Same company registration number"],
      [{ vatNumber: "ie1234567t" }, "Same VAT number"],
      [{ legalName: "murphy's bar ltd", postcode: "H91 A1B2" }, "Same name and postcode"],
    ] as const;
    for (const [body, reason] of checks) {
      const res = expectStatus(await team.sales.post("/customers/duplicates", body), 200).body;
      expect(res[0].reasons).toContain(reason);
    }
    // The user can still choose to create a new customer.
    const forced = expectStatus(await team.sales.post("/customers?confirmNew=true", { legalName: "Different Name", email: "info@murphys.ie" }), 201).body;
    expect(forced.id).toBeDefined();
    expect(await t.prisma.customer.count({ where: { mergedIntoId: { not: null } } })).toBe(0);

    // Merging is a manager action.
    expectStatus(await team.sales.post(`/customers/${first.id}/merge`, { sourceId: forced.id }), 403);
    expectStatus(await team.manager.post(`/customers/${first.id}/merge`, { sourceId: forced.id }), 204);
    const merged = await t.prisma.customer.findUniqueOrThrow({ where: { id: forced.id } });
    expect(merged).toMatchObject({ mergedIntoId: first.id, active: false });
  });
});

describe("role restrictions on sensitive data (scenario 19)", () => {
  it("masks principal details except for Compliance, and logs every unmasked view", async () => {
    const { oppId } = await readyMerchant(t, team);
    const salesView = expectStatus(await team.sales.get(`/opportunities/${oppId}/merchant`), 200).body[0];
    expect(salesView.principals[0]).toMatchObject({ restricted: true, dateOfBirth: null, nationality: null, hasDob: true });
    expect(salesView.principals[0].addressHistory[0].address).toBeNull();
    expect(salesView.risk.restrictedNotes).toBeUndefined();
    expect(salesView.risk.notesRestricted).toBe(true);

    const managerView = expectStatus(await team.manager.get(`/opportunities/${oppId}/merchant`), 200).body[0];
    expect(managerView.principals[0].dateOfBirth).toBeNull();

    const complianceView = expectStatus(await team.compliance.get(`/opportunities/${oppId}/merchant`), 200).body[0];
    expect(complianceView.principals[0]).toMatchObject({ restricted: false, dateOfBirth: "1980-05-17", nationality: "Irish" });
    expect(complianceView.principals[0].addressHistory[0].address.line1).toBe("4 Oak Park");
    expect(complianceView.risk.restrictedNotes).toBe("PEP check clear; ID verified.");
    expect(await t.prisma.auditLog.count({ where: { action: "sensitive.read", entityId: oppId } })).toBeGreaterThan(0);

    // Stored encrypted, never in clear text.
    const raw = await t.prisma.principal.findFirstOrThrow({ where: { application: { opportunityId: oppId } } });
    expect(raw.dobEnc).toMatch(/^v1:/);
    expect(raw.dobEnc).not.toContain("1980");
    // Restricted notes never reach the timeline.
    const timeline = await t.prisma.timelineEntry.findMany({ where: { opportunityId: oppId } });
    expect(timeline.some((e) => e.body.includes("PEP"))).toBe(false);
  });

  it("restricts identity documents and bank details", async () => {
    const opp = await createOpportunity(team.sales, "merchant_services");
    const item = expectStatus(await team.sales.post(`/opportunities/${opp}/documents`, { documentType: "photo_id" }), 201).body;
    expect(item.sensitive).toBe(true);
    const v = expectStatus(await team.sales.upload(`/documents/${item.id}/versions`, pdf("id"), "passport.pdf", "application/pdf"), 201).body;
    expectStatus(await team.sales.get(`/document-versions/${v.id}/url`), 403);
    const list = expectStatus(await team.sales.get(`/opportunities/${opp}/documents`), 200).body;
    expect(list[0].restricted).toBe(true);
    expect(list[0].versions[0].filename).toBeUndefined();
    const url = expectStatus(await team.compliance.get(`/document-versions/${v.id}/url`), 200).body.url as string;
    expect(url).toMatch(/\/api\/files\/local\?key=.*&exp=\d+&sig=[0-9a-f]+/);

    const customer = expectStatus(await team.sales.post("/customers?confirmNew=true", { legalName: "Bank Test Ltd" }), 201).body.id;
    const bank = expectStatus(await team.sales.post(`/customers/${customer}/bank-accounts`, { accountName: "Bank Test Ltd", iban: "IE29AIBK93115212345678" }), 201).body;
    expect(bank).toEqual({ id: bank.id, ibanLast4: "5678" });
    expectStatus(await team.sales.get(`/bank-accounts/${bank.id}`), 403);
    const finance = await userAndClient(t, ["finance"]);
    expect(expectStatus(await finance.client.get(`/bank-accounts/${bank.id}`), 200).body.iban).toBe("IE29AIBK93115212345678");
  });

  it("rejects uploads whose content doesn't match their type", async () => {
    const opp = await createOpportunity(team.sales, "electricity");
    const item = expectStatus(await team.sales.post(`/opportunities/${opp}/documents`, { documentType: "energy_bill" }), 201).body;
    const res = expectStatus(await team.sales.upload(`/documents/${item.id}/versions`, Buffer.from("MZ fake exe"), "bill.pdf", "application/pdf"), 422);
    expect(res.body.message).toMatch(/content doesn't match/);
  });

  it("administration and audit log are administrator-only", async () => {
    expectStatus(await team.manager.get("/admin/audit-log"), 403);
    expectStatus(await team.sales.post("/admin/users", { name: "x", email: "x@y.ie", password: "Long-enough-pass-1", roles: ["administrator"] }), 403);
    const admin = await userAndClient(t, ["administrator"]);
    expectStatus(await admin.client.get("/admin/audit-log"), 200);
  });

  it("requires a session, a CSRF token and the web app's origin", async () => {
    const anon = request(t.app.getHttpServer());
    expectStatus(await anon.get("/api/opportunities"), 401);
    const res = await team.sales.agent.post("/api/opportunities").set("Origin", ORIGIN).send({ name: "x", serviceType: "gas" });
    expect(res.status).toBe(403); // no CSRF header
    const bad = await team.sales.agent.post("/api/opportunities").set("Origin", "https://evil.example").set("X-CSRF-Token", team.sales.csrf).send({ name: "x", serviceType: "gas" });
    expect(bad.status).toBe(403);
  });

  it("locks an account after repeated failed logins", async () => {
    const u = await createUser(t, ["salesperson"]);
    const anon = request(t.app.getHttpServer());
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await anon.post("/api/auth/login").set("Origin", ORIGIN).send({ email: u.email, password: "wrong-password" });
    }
    const locked = await t.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    await expect(login(t, u.email)).rejects.toThrow(/Login failed/);
  });
});

describe("audit trail (scenario 20)", () => {
  it("records who changed what, and audit/timeline entries can't be edited or deleted", async () => {
    const opp = await createOpportunity(team.sales, "electricity");
    expectStatus(await team.sales.post(`/opportunities/${opp}/stage`, { stage: "contacted" }), 204);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: opp, action: "opportunity.stage" } });
    expect(audit).toMatchObject({ actorId: team.salesId, summary: "New Lead → Contacted" });
    const timeline = expectStatus(await team.sales.get(`/opportunities/${opp}/timeline`), 200).body;
    expect(timeline[0]).toMatchObject({ kind: "stage_change", body: "Stage changed from New Lead to Contacted.", actorId: team.salesId });

    await expect(t.prisma.auditLog.update({ where: { id: audit.id }, data: { summary: "edited" } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.auditLog.delete({ where: { id: audit.id } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.timelineEntry.update({ where: { id: timeline[0].id }, data: { body: "edited" } })).rejects.toThrow(/append-only/);

    // Corrections are new entries that point at the original.
    const note = expectStatus(await team.sales.post(`/opportunities/${opp}/timeline`, { kind: "note", body: "Spoke to Pat" }), 201).body;
    const fix = expectStatus(await team.sales.post(`/opportunities/${opp}/timeline`, { kind: "note", body: "Correction: spoke to Mary", correctsId: note.id }), 201).body;
    expect(fix.correctsId).toBe(note.id);
  });

  it("never writes passwords or restricted values into the audit log", async () => {
    const rows = await t.prisma.auditLog.findMany();
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/Integration-Test-Pass|1980-05-17|IE29AIBK/);
  });
});

describe("single sign-on only accounts without SSO set up", () => {
  it("refuses to turn off password sign-in, so nobody is locked out", async () => {
    const admin = (await userAndClient(t, ["administrator"])).client;
    const user = await createUser(t, ["salesperson"]);
    const res = await admin.patch(`/admin/users/${user.id}`, { passwordLogin: false });
    expect(res.status).toBe(422);
    expect(res.body.issues[0]).toMatch(/^Single sign-on isn't set up\./);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordLoginEnabled).toBe(true);
    await login(t, user.email);
  });
});
