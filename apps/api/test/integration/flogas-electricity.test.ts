import request from "supertest";
import { type BillReading, flogasFillSave, flogasFillSuggestions } from "@uo/shared";
import { PDFDocument } from "pdf-lib";
import { CryptoService } from "../../src/common/crypto.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../../src/storage/storage";
import { FLOGAS_ELECTRICITY_LAYOUT } from "../../src/supplier-applications/flogas-electricity/layout";
import { flogasLayoutFields } from "../../src/supplier-applications/flogas-electricity/render";
import { type Client, ORIGIN, type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";
import { type Team, createOpportunity, supplier } from "../support/fixtures";
import { png } from "../support/forms";

// Signing links are emailed; the recording job queue captures the email instead of sending it.
process.env.SMTP_URL = "smtp://127.0.0.1:1025";

const IBAN = "IE29AIBK93115212345678";
let t: TestApp;
let team: Team;
let finance: Client;
let otherSales: Client;

beforeAll(async () => {
  t = await createTestApp();
  const sales = await userAndClient(t, ["salesperson"], "Sarah Sales");
  team = {
    sales: sales.client,
    salesId: sales.user.id,
    ops: (await userAndClient(t, ["operations"], "Orla Ops")).client,
    manager: (await userAndClient(t, ["manager"], "Michael Manager")).client,
    compliance: (await userAndClient(t, ["compliance"])).client,
  };
  finance = (await userAndClient(t, ["finance"], "Fiona Finance")).client;
  otherSales = (await userAndClient(t, ["salesperson"], "Sean Sales")).client;
  await flogasTemplate();
});
afterAll(() => t.close());

const anon = () => request(t.app.getHttpServer());
const tokenOf = (url: string) => url.split("/sign/")[1];
const base = (oppId: string) => `/opportunities/${oppId}/flogas-electricity`;

/**
 * The Flogas template as an upload of the real PDF would create it. The supplier's PDF isn't in the
 * repository, so a blank PDF of the same size stands in for it.
 */
async function flogasTemplate() {
  const doc = await PDFDocument.create();
  for (const p of FLOGAS_ELECTRICITY_LAYOUT.pages) doc.addPage([p.width, p.height]);
  const bytes = Buffer.from(await doc.save());
  const storageKey = "form-templates/flogas-test.pdf";
  await t.app.get<ObjectStorage>(OBJECT_STORAGE).put(storageKey, bytes, "application/pdf");
  const flogas = await supplier(t, "Flogas");
  return t.prisma.formTemplate.create({
    data: {
      name: FLOGAS_ELECTRICITY_LAYOUT.name,
      supplierId: flogas.id,
      documentType: "application_form",
      storageKey,
      filename: "flogas.pdf",
      sha256: CryptoService.sha256(bytes),
      pages: FLOGAS_ELECTRICITY_LAYOUT.pages as never,
      fields: flogasLayoutFields() as never,
      workflow: "flogas_electricity",
    },
  });
}

/** An electricity deal with Flogas selected, its customer, supply site, meter, reading and contract. */
async function flogasDeal(opts: { supplierName?: string; productInterest?: string[] } = {}) {
  const s = await supplier(t, opts.supplierName ?? "Flogas");
  await t.prisma.supplier.update({ where: { id: s.id }, data: { agencyId: "UO-FLG-0042" } });
  const oppId = await createOpportunity(team.sales, "electricity", { productInterest: opts.productInterest ?? ["electricity"], supplyChanges: ["change_of_supplier"], contactRole: "Director" });
  const customerId = expectStatus(await team.sales.post(`/opportunities/${oppId}/customer/create`), 201).body.customerId as string;
  expectStatus(await team.sales.patch(`/customers/${customerId}`, { legalEntity: "limited_company", businessType: "Bakery", companyRegNumber: "654321", vatExempt: false, priorityCustomer: false }), 204);
  const siteId = expectStatus(
    await team.sales.post(`/opportunities/${oppId}/sites`, { serviceType: "electricity", occupancyType: "owner_occupied", occupiedSince: "2019-03-01", address: { line1: "Unit 4, Ballymount Ind Est", city: "Dublin 12", county: "Dublin", postcode: "D12 AB34" } }),
    201,
  ).body.id as string;
  const meterId = expectStatus(await team.sales.post(`/sites/${siteId}/meters`, { fuel: "electricity", mprn: "10012345678", mccCode: "01" }), 201).body.id as string;
  expectStatus(await team.sales.post(`/meters/${meterId}/readings`, { readingType: "actual", register: "day", value: 12345, readingDate: "2026-10-01" }), 201);
  expectStatus(await team.sales.post(`/meters/${meterId}/readings`, { readingType: "actual", register: "night", value: 6789, readingDate: "2026-10-01" }), 201);
  expectStatus(
    await team.sales.post(`/opportunities/${oppId}/contracts`, { fuel: "electricity", siteId, existingSupplierName: "Electric Ireland", termMonths: 24, priceType: "fixed", dayRate: 0.2145, nightRate: 0.1237, proposedActivationDate: "2026-11-15" }),
    201,
  );
  expectStatus(await team.sales.patch(`/opportunities/${oppId}`, { selectedSupplierId: s.id }), 204);
  return { oppId, customerId, siteId, meterId };
}

/** Everything the form still needs after flogasDeal: a bank account and the signatory. */
async function completeDeal() {
  const deal = await flogasDeal();
  expectStatus(await team.sales.put(base(deal.oppId), { bank: { accountName: "Murphy's Bakery Ltd", iban: IBAN, bic: "AIBKIE2D" }, answers: { signatoryPosition: "Director" } }), 200);
  return deal;
}

describe("Flogas electricity: when it shows", () => {
  it("applies only to Electricity deals with Flogas selected", async () => {
    const { oppId } = await flogasDeal();
    expect(expectStatus(await team.sales.get(base(oppId)), 200).body.applies).toBe(true);
    const energia = await flogasDeal({ supplierName: "Energia" });
    expect(expectStatus(await team.sales.get(base(energia.oppId)), 200).body.applies).toBe(false);
    const gasOnly = await flogasDeal({ productInterest: ["gas"] });
    expect(expectStatus(await team.sales.get(base(gasOnly.oppId)), 200).body.applies).toBe(false);
    // Nothing can be saved or generated for a deal it doesn't apply to.
    expect(expectStatus(await team.sales.put(base(energia.oppId), { answers: { sector: "lvmd" } }), 422).body.issues[0]).toMatch(/only applies when Electricity/);
    expectStatus(await team.sales.post(`${base(energia.oppId)}/versions`, {}), 422);
  });
});

describe("Flogas electricity: prefill and drafts", () => {
  it("fills the form from the opportunity, customer, site, meter and contract", async () => {
    const { oppId, meterId } = await flogasDeal();
    const v = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(v.data).toMatchObject({
      legalName: "Test Trading Ltd",
      supplyAddress: { line1: "Unit 4, Ballymount Ind Est", city: "Dublin 12", postcode: "D12 AB34" },
      billingSameAsSupply: true,
      legalEntity: "limited_company",
      businessType: "Bakery",
      companyRegNumber: "654321",
      contactFirstName: "Mary",
      contactLastName: "Murphy",
      email: "mary@testtrading.ie",
      occupancyType: "owner_occupied",
      occupiedSince: "2019-03-01",
      requirements: ["change_of_supplier"],
      meters: [{ id: meterId, mprn: "10012345678", mccCode: "01", day: 12345, night: 6789, wattless: null }],
      readingDate: "2026-10-01",
      expectedChangeover: "2026-11-15",
      termMonths: 24,
      sector: "gp_night_saver",
      priceType: "fixed",
      dayRateCent: 21.45,
      nightRateCent: 12.37,
      directDebit: true,
      signatoryName: "Mary Murphy",
      signatoryPosition: "Director",
      agencyId: "UO-FLG-0042",
      agentName: "Sarah Sales",
    });
    expect(v.status).toBe("draft");
    expect(v.issues.map((i: { path: string }) => i.path)).toEqual(["debtorName", "iban"]);
  });

  it("saves a draft back to the CRM records and the application, and reopens it", async () => {
    const { oppId, customerId, siteId, meterId } = await flogasDeal();
    const saved = expectStatus(
      await team.sales.put(base(oppId), {
        customer: { legalName: "Murphy's Bakery Limited", vatExempt: true, vatExemptNumber: "VEX-1" },
        contact: { mobile: "087 765 4321" },
        billingAddress: { line1: "PO Box 12", city: "Naas" },
        premises: { occupancyType: "rented", landlordName: "Ballymount Properties", landlordContact: "01 555 0199" },
        meters: [
          { id: meterId, mprn: "10012345678", mccCode: "02", day: 12400, night: 6789 },
          { mprn: "10087654321", mccCode: "01", day: 500, night: 200 },
        ],
        readingDate: "2026-10-20",
        contract: { dayRateCent: 20.99, termMonths: 36 },
        answers: { billingSameAsSupply: false, requirements: ["change_of_supplier", "renewal"], existingFlogasCustomer: false, mandateReference: "OFFICE-1" },
      }),
      200,
    ).body;
    expect(saved.data).toMatchObject({ legalName: "Murphy's Bakery Limited", vatExempt: true, mobile: "087 765 4321", billingSameAsSupply: false, billingAddress: { line1: "PO Box 12" }, termMonths: 36, dayRateCent: 20.99 });
    expect(saved.data.meters).toHaveLength(2);
    expect(saved.data.meters[1]).toMatchObject({ mprn: "10087654321", day: 500, night: 200 });

    // Each value lives on its own record; the application only holds the Flogas answers.
    expect(await t.prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).toMatchObject({ legalName: "Murphy's Bakery Limited", vatExempt: true, vatExemptNumber: "VEX-1" });
    expect(await t.prisma.supplySite.findUniqueOrThrow({ where: { id: siteId } })).toMatchObject({ occupancyType: "rented", landlordName: "Ballymount Properties" });
    expect(await t.prisma.meterPoint.count({ where: { siteId, fuel: "electricity" } })).toBe(2);
    // Readings are history: the changed day reading is a new row, the old one is kept.
    const readings = await t.prisma.meterReading.findMany({ where: { meterPointId: meterId }, orderBy: { createdAt: "asc" } });
    expect(readings.map((r) => [r.register, Number(r.value)])).toEqual([
      ["day", 12345],
      ["night", 6789],
      ["day", 12400],
      ["night", 6789],
    ]);
    const app = await t.prisma.supplierApplication.findFirstOrThrow({ where: { opportunityId: oppId } });
    expect(app.answers).toMatchObject({ billingSameAsSupply: false, requirements: ["change_of_supplier", "renewal"], mandateReference: "OFFICE-1" });
    expect(Object.keys(app.answers as object)).not.toContain("legalName");

    // Reopening shows the same draft.
    const reopened = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(reopened.data).toEqual(saved.data);
    expect(reopened.answered).toEqual(expect.arrayContaining(["billingSameAsSupply", "requirements", "mandateReference", "meterOrder"]));

    // The timeline names what changed, never the values.
    const entry = await t.prisma.timelineEntry.findFirstOrThrow({ where: { opportunityId: oppId, body: { startsWith: "Flogas electricity application saved" } } });
    expect(entry.body).toContain("legal entity");
    expect(entry.body).not.toContain("Murphy's Bakery");
    expect(entry.body).not.toContain("VEX-1");
  });

  it("removes a meter row from the application but keeps the meter on the deal", async () => {
    const { oppId, meterId, siteId } = await flogasDeal();
    const two = expectStatus(await team.sales.put(base(oppId), { meters: [{ id: meterId, mprn: "10012345678" }, { mprn: "10087654321" }] }), 200).body;
    const second = two.data.meters[1].id;
    const one = expectStatus(await team.sales.put(base(oppId), { meters: [{ id: second, mprn: "10087654321" }] }), 200).body;
    expect(one.data.meters.map((m: { id: string }) => m.id)).toEqual([second]);
    expect(await t.prisma.meterPoint.count({ where: { siteId } })).toBe(2);
    expectStatus(await team.sales.put(base(oppId), { meters: [] }), 400);
  });

  it("rejects invalid input on the server", async () => {
    const { oppId, meterId } = await flogasDeal();
    expectStatus(await team.sales.put(base(oppId), { contract: { dayRateCent: -1 } }), 400);
    expectStatus(await team.sales.put(base(oppId), { answers: { sector: "solar" } }), 400);
    expectStatus(await team.sales.put(base(oppId), { meters: [{ id: meterId, mprn: "10012345678", day: -3 }] }), 400);
    const dup = expectStatus(await team.sales.put(base(oppId), { meters: [{ id: meterId, mprn: "10012345678" }, { mprn: "10012345678" }] }), 422).body;
    expect(dup.issues).toEqual(["MPRN 10012345678 is on the form twice."]);
    const bad = expectStatus(await team.sales.put(base(oppId), { meters: [{ id: meterId, mprn: "999" }] }), 422).body;
    expect(bad.issues[0]).toMatch(/Meter row 1: MPRN "999" should be 11 digits/);
    const noDate = expectStatus(await team.sales.put(base(oppId), { meters: [{ id: meterId, mprn: "10012345678", day: 1 }], readingDate: null }), 422).body;
    expect(noDate.issues).toEqual(["Enter the date of the meter reading."]);
  });
});

describe("Flogas electricity: validation and generation", () => {
  it("lists missing details by field and refuses to generate until they're given", async () => {
    const { oppId } = await flogasDeal();
    expectStatus(await team.sales.put(base(oppId), { premises: { occupancyType: "rented" }, answers: { sector: "gp_24h", signatoryPosition: null } }), 200);
    const v = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(v.issues.map((i: { path: string; tab: string }) => `${i.tab}:${i.path}`)).toEqual(["customer:landlordName", "customer:landlordContact", "debit:debtorName", "debit:iban", "documents:signatoryPosition"]);
    const res = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 422).body;
    expect(res.issues).toContain("Enter the landlord or agent's name.");
    expect(await t.prisma.supplierApplicationVersion.count({ where: { application: { opportunityId: oppId } } })).toBe(0);
  });

  it("generates an immutable, sensitive version on the Flogas template and doesn't duplicate an unchanged one", async () => {
    const { oppId } = await completeDeal();
    const gen = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body;
    expect(gen).toMatchObject({ version: 1, unchanged: false });
    const v = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(v.status).toBe("ready");
    expect(v.versions[0]).toMatchObject({ version: 1, current: true, qcPassed: true, sensitive: true, requiredSigners: ["customer"], layoutVersion: FLOGAS_ELECTRICITY_LAYOUT.version });

    // The stored PDF keeps both pages and carries the values; the snapshot is encrypted.
    const form = await t.prisma.generatedForm.findUniqueOrThrow({ where: { id: gen.formId } });
    const file = await t.prisma.documentVersion.findUniqueOrThrow({ where: { id: form.versionId } });
    const bytes = await t.app.get<ObjectStorage>(OBJECT_STORAGE).get(file.storageKey);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
    const values = t.app.get(CryptoService).decryptJson<Record<string, unknown>>(form.valuesEnc)!;
    expect(values).toMatchObject({ legalName: "TEST TRADING LTD", mprn: "10012345678", iban: "IE29 AIBK 9311 5212 3456 78", entityCompany: true, sectorNightSaver: true, requirementChangeOfSupplier: true });
    const version = await t.prisma.supplierApplicationVersion.findUniqueOrThrow({ where: { formId: gen.formId } });
    expect(version.dataEnc).not.toContain(IBAN);
    await expect(t.prisma.supplierApplicationVersion.update({ where: { id: version.id }, data: { layoutVersion: "x" } })).rejects.toThrow();
    await expect(t.prisma.supplierApplicationVersion.delete({ where: { id: version.id } })).rejects.toThrow();

    // Generating again with nothing changed returns the same version.
    expect(expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body).toMatchObject({ version: 1, unchanged: true });
  });

  it("keeps a sent version exactly as sent: CRM edits need a new version, which replaces it only when confirmed", async () => {
    const { oppId, customerId } = await completeDeal();
    const v1 = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body;
    const link = expectStatus(await team.sales.post(`${base(oppId)}/versions/${v1.formId}/send`, { role: "customer", signerName: "Mary Murphy", email: "mary@testtrading.ie" }), 201).body;
    expect(link.emailed).toBe(true);
    const v1Form = await t.prisma.generatedForm.findUniqueOrThrow({ where: { id: v1.formId } });
    const v1File = await t.prisma.documentVersion.findUniqueOrThrow({ where: { id: v1Form.versionId } });

    // A CRM edit after sending: the sent version is now out of date and can't be sent again.
    expectStatus(await team.sales.patch(`/customers/${customerId}`, { tradingName: "Murphy's" }), 204);
    const stale = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(stale).toMatchObject({ stale: true, status: "sent" });
    expect(expectStatus(await team.sales.post(`${base(oppId)}/versions/${v1.formId}/send`, { role: "customer", signerName: "Mary Murphy", email: "mary@testtrading.ie" }), 422).body.issues[0]).toMatch(/changed since version 1/);
    expect(expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 422).body.issues[0]).toMatch(/Version 1 has already been sent for signature. Confirm/);

    const v2 = expectStatus(await team.sales.post(`${base(oppId)}/versions`, { confirmReplace: true }), 201).body;
    expect(v2.version).toBe(2);
    // Version 1 is kept, unchanged; its link no longer works.
    expect(await t.prisma.generatedForm.findUniqueOrThrow({ where: { id: v1.formId } })).toMatchObject({ status: "superseded", versionId: v1Form.versionId });
    expect((await t.prisma.documentVersion.findUniqueOrThrow({ where: { id: v1File.id } })).sha256).toBe(v1File.sha256);
    expectStatus(await anon().get(`/api/public/sign/${tokenOf(link.url)}`), 404);
    expect(expectStatus(await team.sales.post(`${base(oppId)}/versions/${v1.formId}/send`, { role: "customer", signerName: "M", email: "m@x.ie" }), 422).body.issues[0]).toMatch(/replaced/);
  });
});

describe("Flogas electricity: signing", () => {
  it("tracks sent, viewed, declined, signed and completed, and only the application can send its forms", async () => {
    const { oppId } = await completeDeal();
    const { formId } = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body;
    // The generic signing route refuses an application's form, so its checks can't be skipped.
    expect(expectStatus(await team.sales.post(`/forms/${formId}/signing-links`, { role: "customer", signerName: "Mary", email: "mary@testtrading.ie" }), 422).body.issues[0]).toMatch(/application tab/);

    const first = expectStatus(await team.sales.post(`${base(oppId)}/versions/${formId}/send`, { role: "customer", signerName: "Mary Murphy", email: "mary@testtrading.ie" }), 201).body;
    expect(expectStatus(await team.sales.get(base(oppId)), 200).body.status).toBe("sent");
    expectStatus(await anon().get(`/api/public/sign/${tokenOf(first.url)}`), 200);
    expect(expectStatus(await team.sales.get(base(oppId)), 200).body.status).toBe("viewed");

    const declined = await anon().post(`/api/public/sign/${tokenOf(first.url)}/decline`).set("Origin", ORIGIN).send({ reason: "Wrong rates" });
    expectStatus(declined, 201);
    const afterDecline = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(afterDecline.status).toBe("declined");
    expect(afterDecline.versions[0].links[0]).toMatchObject({ status: "declined", declineReason: "Wrong rates" });
    // A declined link is finished: it can't be used, declined again or resent.
    expectStatus(await anon().post(`/api/public/sign/${tokenOf(first.url)}/decline`).set("Origin", ORIGIN).send({}), 404);
    expectStatus(await team.sales.post(`${base(oppId)}/signing-links/${first.id}/resend`), 422);

    const second = expectStatus(await team.sales.post(`${base(oppId)}/versions/${formId}/send`, { role: "customer", signerName: "Mary Murphy", email: "mary@testtrading.ie" }), 201).body;
    const resent = expectStatus(await team.sales.post(`${base(oppId)}/signing-links/${second.id}/resend`), 201).body;
    expectStatus(await anon().get(`/api/public/sign/${tokenOf(second.url)}`), 404); // the old token stops working
    const sign = (token: string) => anon().post(`/api/public/sign/${token}`).set("Origin", ORIGIN).send({ typedName: "Mary Murphy", consent: true, signaturePng: `data:image/png;base64,${png(120, 40).toString("base64")}` });
    expect(expectStatus(await sign(tokenOf(resent.url)), 201).body).toEqual({ signed: true, complete: true });
    // Signing is single use.
    expectStatus(await sign(tokenOf(resent.url)), 404);
    const signed = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(signed.status).toBe("signed");
    expect(signed.versions[0].signedVersionId).toBeTruthy();

    // A second person approves the signed copy; the application is complete.
    expectStatus(await team.ops.post(`/forms/${formId}/review`, { decision: "approved" }), 204);
    const done = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(done.status).toBe("completed");
    // The completed signed version can only be replaced on purpose, and is kept.
    expectStatus(await team.sales.put(base(oppId), { answers: { mandateReference: "NEW" } }), 200);
    expect(expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 422).body.issues[0]).toMatch(/signed and approved/);

    const history = expectStatus(await team.sales.get(`${base(oppId)}/history`), 200).body as { action: string }[];
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(["supplier_application.save", "supplier_application.generate", "form.signing_link", "form.signing_declined", "form.signature_online", "form.approved"]));
  });

  it("asks the second account holder to sign the mandate too", async () => {
    const { oppId } = await completeDeal();
    expectStatus(await team.sales.put(base(oppId), { answers: { secondAccountHolder: { name: "Declan Murphy", email: "declan@testtrading.ie" } } }), 200);
    const { formId } = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body;
    const v = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(v.versions[0].requiredSigners).toEqual(["customer", "account_holder_2"]);
    expectStatus(await team.sales.post(`${base(oppId)}/versions/${formId}/send`, { role: "account_holder_2", signerName: "Declan Murphy", email: "declan@testtrading.ie" }), 201);
    expect(expectStatus(await team.sales.post(`${base(oppId)}/versions/${formId}/send`, { role: "broker", signerName: "Sarah", email: "s@x.ie" }), 422).body.issues).toEqual(["This version has no signature box for that signer."]);
  });
});

describe("Flogas electricity: permissions and bank details", () => {
  it("hides other salespeople's deals and keeps read-only roles read-only", async () => {
    const { oppId } = await flogasDeal();
    expectStatus(await otherSales.get(base(oppId)), 404);
    expectStatus(await otherSales.put(base(oppId), { answers: { sector: "lvmd" } }), 404);
    const compliance = expectStatus(await team.compliance.get(base(oppId)), 200).body;
    expect(compliance.permissions.write).toBe(false);
    expectStatus(await team.compliance.put(base(oppId), { answers: { sector: "lvmd" } }), 403);
    expectStatus(await team.compliance.post(`${base(oppId)}/versions`, {}), 403);
  });

  it("masks bank details for anyone without bank.read and confirms IBAN changes", async () => {
    const { oppId } = await completeDeal();
    const sales = await team.sales.get(base(oppId));
    expect(sales.text).not.toContain(IBAN);
    expect(sales.text).not.toContain("AIBKIE2D");
    expect(sales.body.data).toMatchObject({ iban: null, bic: null, debtorName: null, bankOnFile: true, ibanLast4: "5678" });
    expect(sales.body.issues).toEqual([]);

    const fin = expectStatus(await finance.get(base(oppId)), 200).body;
    expect(fin.data).toMatchObject({ iban: IBAN, bic: "AIBKIE2D", debtorName: "Murphy's Bakery Ltd" });
    expect(await t.prisma.auditLog.count({ where: { action: "sensitive.read", entityId: oppId } })).toBeGreaterThan(0);

    const change = { bank: { accountName: "Murphy's Bakery Ltd", iban: "IE64IRCE92050112345678" } };
    expect(expectStatus(await team.sales.put(base(oppId), change), 422).body.issues[0]).toMatch(/IBAN differs/);
    expectStatus(await team.sales.put(base(oppId), { ...change, confirmIbanChange: true }), 200);
    const customer = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: oppId }, select: { customerId: true } });
    expect(await t.prisma.bankAccount.count({ where: { customerId: customer.customerId! } })).toBe(2);

    // Neither the timeline nor the audit trail holds the IBAN.
    const timeline = await t.prisma.timelineEntry.findMany({ where: { opportunityId: oppId } });
    expect(JSON.stringify(timeline)).not.toMatch(/IE29AIBK|IE64IRCE/);
    const audit = await t.prisma.auditLog.findMany({ where: { entityType: "supplier_application" } });
    expect(JSON.stringify(audit)).not.toMatch(/IE29AIBK|IE64IRCE/);

    // Without bank.read the draft preview masks the IBAN; the stored version needs read_sensitive to open.
    const preview = await team.sales.get(`${base(oppId)}/preview`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expectStatus(preview, 200);
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect((preview.body as Buffer).toString("latin1")).not.toMatch(/IE64|IE29/);
    const { formId } = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body;
    const form = await t.prisma.generatedForm.findUniqueOrThrow({ where: { id: formId } });
    expectStatus(await team.sales.get(`/document-versions/${form.versionId}/url`), 403);
    expectStatus(await finance.get(`/document-versions/${form.versionId}/url`), 200);
  });

  it("needs bank.write to change bank details", async () => {
    const { oppId } = await flogasDeal();
    expectStatus(await team.compliance.put(base(oppId), { bank: { accountName: "X", iban: IBAN } }), 403);
  });
});

describe("Flogas electricity: other suppliers are unchanged", () => {
  it("keeps the Flogas template out of the generic form filler", async () => {
    const { oppId } = await flogasDeal();
    const list = expectStatus(await team.sales.get("/form-templates"), 200).body as { workflow?: string; name: string }[];
    expect(list.some((x) => x.name === FLOGAS_ELECTRICITY_LAYOUT.name)).toBe(false);
    const tpl = await t.prisma.formTemplate.findFirstOrThrow({ where: { workflow: "flogas_electricity" } });
    expect(expectStatus(await team.sales.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: {} }), 422).body.issues[0]).toMatch(/own application tab/);
    expect(expectStatus(await team.manager.patch(`/form-templates/${tpl.id}`, { fields: [] }), 422).body.issues[0]).toMatch(/maintained with its application/);
  });

  it("shows the workspace whether a Flogas document exists, so supplier changes can warn", async () => {
    const { oppId } = await completeDeal();
    expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201);
    const ws = expectStatus(await team.sales.get(`/opportunities/${oppId}`), 200).body;
    expect(ws.supplierApps).toEqual([{ kind: "flogas_electricity", _count: { versions: 1 } }]);
    // Changing supplier keeps the draft and versions but hides the application.
    const energia = await supplier(t, "Energia");
    expectStatus(await team.sales.patch(`/opportunities/${oppId}`, { selectedSupplierId: energia.id }), 204);
    const v = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(v.applies).toBe(false);
    expect(v.versions).toHaveLength(1);
    expectStatus(await team.sales.post(`${base(oppId)}/versions/${v.versions[0].formId}/send`, { role: "customer", signerName: "M", email: "m@x.ie" }), 422);
  });
});

describe("Flogas electricity: fill from bill", () => {
  it("saves the ticked bill values through the form's own save, onto the deal's meter", async () => {
    const { oppId, meterId } = await flogasDeal();
    const reading = {
      readable: true,
      customerName: null,
      supplyAddress: null,
      fuel: "electricity",
      mprn: "10012345678",
      gprn: null,
      meterNumber: null,
      supplierName: "Electric Ireland",
      accountNumber: "EI-1",
      billDate: null,
      periodStart: null,
      periodEnd: null,
      tariffName: null,
      dayRate: null,
      nightRate: null,
      gasRate: null,
      standingChargePerDay: null,
      usageKwh: null,
      annualConsumptionKwh: null,
      mic: null,
      readings: [
        { register: "Day", value: "13001", readingDate: "2026-10-20", readingType: "actual" },
        { register: "Night", value: "7002", readingDate: "2026-10-20", readingType: "actual" },
      ],
      notes: null,
    } satisfies BillReading;
    const before = expectStatus(await team.sales.get(base(oppId)), 200).body.data;
    const keys = flogasFillSuggestions(reading, before).map((s) => s.key);
    expect(keys).toEqual(["reading:0", "reading:1", "readingDate"]);
    const after = expectStatus(await team.sales.put(base(oppId), flogasFillSave(reading, before, new Set(keys))), 200).body.data;
    expect(after.meters[0]).toMatchObject({ id: meterId, mprn: "10012345678", day: 13001, night: 7002 });
    expect(after.readingDate).toBe("2026-10-20");
    expect(flogasFillSuggestions(reading, after)).toEqual([]);
  });
});
