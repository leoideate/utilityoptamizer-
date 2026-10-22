import request from "supertest";
import { PDFDocument } from "pdf-lib";
import { CryptoService } from "../../src/common/crypto.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../../src/storage/storage";
import { BGE_LAYOUT, bgeFields } from "../../src/supplier-applications/bord-gais-electricity/layout";
import { type Client, ORIGIN, type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";
import { bordGaisStandInPdf } from "../support/bord-gais";
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
  await bordGaisTemplate();
});
afterAll(() => t.close());

const anon = () => request(t.app.getHttpServer());
const tokenOf = (url: string) => url.split("/sign/")[1];
const base = (oppId: string) => `/opportunities/${oppId}/bord-gais-electricity`;
const storage = () => t.app.get<ObjectStorage>(OBJECT_STORAGE);

/** The Bord Gáis template as an upload of the real PDF would create it, with a stand-in for the PDF itself. */
async function bordGaisTemplate() {
  const bytes = await bordGaisStandInPdf();
  const storageKey = "form-templates/bord-gais-test.pdf";
  await storage().put(storageKey, bytes, "application/pdf");
  const s = await supplier(t, "Bord Gáis Energy");
  return t.prisma.formTemplate.create({
    data: { name: BGE_LAYOUT.name, supplierId: s.id, documentType: "application_form", storageKey, filename: "bge.pdf", sha256: CryptoService.sha256(bytes), pages: BGE_LAYOUT.pages as never, fields: bgeFields() as never, workflow: "bord_gais_electricity" },
  });
}

/** An electricity deal with its customer, site, meter (two serials), a reading and a contract, with the given supplier selected. */
async function bordGaisDeal(opts: { supplierName?: string; productInterest?: string[] } = {}) {
  const s = await supplier(t, opts.supplierName ?? "Bord Gáis Energy");
  const oppId = await createOpportunity(team.sales, "electricity", { productInterest: opts.productInterest ?? ["electricity"], supplyChanges: ["change_of_supplier"], contactRole: "Director" });
  const customerId = expectStatus(await team.sales.post(`/opportunities/${oppId}/customer/create`), 201).body.customerId as string;
  expectStatus(
    await team.sales.patch(`/customers/${customerId}`, {
      legalEntity: "limited_company",
      businessType: "Bakery",
      companyRegNumber: "654321",
      incorporationDate: "2015-04-01",
      employees: 12,
      priorityCustomer: false,
      marketingEmail: false,
      marketingPost: true,
      marketingPhone: true,
      marketingSms: false,
      addresses: [{ kind: "registered", line1: "1 Main Street", city: "Naas", county: "Kildare", postcode: "W91 AB12" }],
    }),
    204,
  );
  const siteId = expectStatus(
    await team.sales.post(`/opportunities/${oppId}/sites`, { label: "Bakery", serviceType: "electricity", annualConsumptionKwh: 45000, address: { line1: "Unit 4, Ballymount Ind Est", city: "Dublin 12", county: "Dublin", postcode: "D12 AB34" } }),
    201,
  ).body.id as string;
  const meterId = expectStatus(await team.sales.post(`/sites/${siteId}/meters`, { fuel: "electricity", mprn: "10012345678", mccCode: "01", meterNumber: "000123456", mic: 50, dgCode: "DG1", voltage: "LV", profileClass: "1" }), 201).body.id as string;
  expectStatus(await team.sales.post(`/meters/${meterId}/readings`, { readingType: "actual", register: "day", value: 12345, readingDate: "2026-10-01" }), 201);
  expectStatus(
    await team.sales.post(`/opportunities/${oppId}/contracts`, {
      fuel: "electricity",
      siteId,
      existingSupplierName: "Electric Ireland",
      pricingPlan: "Business Fixed 24",
      termMonths: 24,
      priceType: "fixed",
      dayRate: 0.2145,
      nightRate: 0.1237,
      standingCharge: 0.5512,
      proposedActivationDate: "2026-11-01",
    }),
    201,
  );
  expectStatus(await team.sales.patch(`/opportunities/${oppId}`, { selectedSupplierId: s.id }), 204);
  return { oppId, customerId, siteId, meterId };
}

/** Everything else the form needs: bank details and the broader-marketing answer. */
async function completeDeal() {
  const deal = await bordGaisDeal();
  expectStatus(await team.sales.put(base(deal.oppId), { bank: { accountName: "Murphy's Bakery Ltd", iban: IBAN, bic: "AIBKIE2D" }, answers: { broaderMarketing: false } }), 200);
  return deal;
}

describe("Bord Gáis electricity: when it shows", () => {
  it("applies to Electricity with Bord Gáis Energy, or an old spelling of it, and nothing else", async () => {
    expect(expectStatus(await team.sales.get(base((await bordGaisDeal()).oppId)), 200).body.applies).toBe(true);
    expect(expectStatus(await team.sales.get(base((await bordGaisDeal({ supplierName: "Board Gais" })).oppId)), 200).body.applies).toBe(true);
    const energia = await bordGaisDeal({ supplierName: "Energia" });
    expect(expectStatus(await team.sales.get(base(energia.oppId)), 200).body.applies).toBe(false);
    expect(expectStatus(await team.sales.get(base((await bordGaisDeal({ productInterest: ["gas"] })).oppId)), 200).body.applies).toBe(false);
    expect(expectStatus(await team.sales.put(base(energia.oppId), { answers: { directDebit: false } }), 422).body.issues[0]).toMatch(/only applies when Electricity/);
    expectStatus(await team.sales.post(`${base(energia.oppId)}/versions`, {}), 422);
  });
});

describe("Bord Gáis electricity: prefill and drafts", () => {
  it("fills the form from the customer, contact, site, meter, reading and contract", async () => {
    const { oppId } = await bordGaisDeal();
    const v = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(v.data).toMatchObject({
      legalName: "Test Trading Ltd",
      accountHolderName: "Test Trading Ltd",
      accountAddress: { line1: "1 Main Street", city: "Naas" },
      mainActivity: "Bakery",
      dateEstablished: "2015-04-01",
      organisationType: "limited_company",
      croNumber: "654321",
      employees: 12,
      contactFirstName: "Mary",
      contactLastName: "Murphy",
      position: "Director",
      siteName: "Bakery",
      supplyAddress: { line1: "Unit 4, Ballymount Ind Est" },
      premisesContactName: "Mary Murphy",
      billingSource: "account_holder",
      mprn: "10012345678",
      mic: 50,
      dgCode: "DG1",
      mcc: "01",
      existingSupplier: "Electric Ireland",
      annualConsumptionKwh: 45000,
      meters: [{ serial: "000123456", readings: { day: "12345" } }, { serial: null }],
      readingDate: "2026-10-01",
      pricePlan: "Business Fixed 24",
      startDate: "2026-11-01",
      commitmentMonths: 24,
      rateType: "fixed",
      marketing: { email: false, post: true, phone: true, sms: false },
      directDebit: true,
      signatoryName: "Mary Murphy",
      agentName: "Sarah Sales",
    });
    // A night rate means the contract's day rate is "Day rate Block 1" of the Energy Rate row.
    expect(v.data.rates.energy).toMatchObject({ day1: 21.45, rate24h1: null, night: 12.37, standingCharge: 55.12 });
    expect(v.issues.map((i: { path: string }) => i.path)).toEqual(["iban", "bic", "bankAccountName"]);
    expect(v.status).toBe("draft");
  });

  it("saves a draft back to the records it belongs to, keeping readings exactly as read, and reopens it", async () => {
    const { oppId, customerId, meterId } = await bordGaisDeal();
    const rates = { energy: { day1: 20.99, day2: 19.5, night: 12, standingCharge: 50 }, nonEnergy: { day1: 3.21, night: 1.84 } };
    const saved = expectStatus(
      await team.sales.put(base(oppId), {
        customer: { legalEntity: "sole_trader", employees: 3 },
        homeAddress: { line1: "4 Oak Park", city: "Naas" },
        meter: { serial2: "AB9876543" },
        readings: { meter1: { day: "01234.5", night: "00987" }, meter2: { night: "00321.9" }, readingDate: "2026-10-20" },
        rates,
        answers: { billingSource: "separate", premisesContact: { fax: "01 555 0100" }, broaderMarketing: true, discounts: { y1_24: 5 }, accountHolderName: "Mary Murphy t/a Test Trading" },
        billingAddress: { line1: "PO Box 12", city: "Naas" },
      }),
      200,
    ).body;
    expect(saved.data).toMatchObject({
      organisationType: "sole_trader",
      employees: 3,
      homeAddress: { line1: "4 Oak Park" },
      billingSource: "separate",
      billingAddress: { line1: "PO Box 12" },
      premisesFax: "01 555 0100",
      broaderMarketing: true,
      accountHolderName: "Mary Murphy t/a Test Trading",
      meters: [
        { serial: "000123456", readings: { day: "01234.5", night: "00987" } },
        { serial: "AB9876543", readings: { night: "00321.9", day: null } },
      ],
      readingDate: "2026-10-20",
    });
    expect(saved.data.rates.energy).toMatchObject({ day1: 20.99, day2: 19.5, night: 12, standingCharge: 50 });
    expect(saved.data.rates.nonEnergy).toMatchObject({ day1: 3.21, night: 1.84 });

    // Each value lives on its own record: the Energy Rate row on the contract, the rest on the application.
    expect(await t.prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).toMatchObject({ legalEntity: "sole_trader", employees: 3 });
    const contract = await t.prisma.energyContract.findFirstOrThrow({ where: { opportunityId: oppId } });
    expect([Number(contract.dayRate), Number(contract.nightRate), Number(contract.standingCharge)]).toEqual([0.2099, 0.12, 0.5]);
    const app = await t.prisma.supplierApplication.findFirstOrThrow({ where: { opportunityId: oppId } });
    const answers = app.answers as { rates: Record<string, Record<string, number | null>> };
    expect(answers.rates.energy).toEqual(expect.objectContaining({ day2: 19.5 }));
    expect(answers.rates.energy).not.toHaveProperty("day1");
    expect(answers.rates.nonEnergy).toEqual(expect.objectContaining({ day1: 3.21 }));
    // Readings are history, kept as read and tagged with their meter.
    const readings = await t.prisma.meterReading.findMany({ where: { meterPointId: meterId, rawValue: { not: null } }, orderBy: { createdAt: "asc" } });
    expect(readings.map((r) => [r.meterSerial, r.register, r.rawValue, Number(r.value)])).toEqual([
      ["000123456", "day", "01234.5", 1234.5],
      ["000123456", "night", "00987", 987],
      ["AB9876543", "night", "00321.9", 321.9],
    ]);
    expect(await t.prisma.meterReading.count({ where: { meterPointId: meterId } })).toBe(4); // the original reading is kept

    const reopened = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(reopened.data).toEqual(saved.data);
    const entry = await t.prisma.timelineEntry.findFirstOrThrow({ where: { opportunityId: oppId, body: { startsWith: "Bord Gáis electricity application saved" } } });
    expect(entry.body).toContain("meter readings");
    expect(entry.body).not.toContain("01234");
  });

  it("moves the contract's rates to the row of a new rate type and keeps the old row's cells", async () => {
    const { oppId } = await bordGaisDeal();
    const before = expectStatus(await team.sales.get(base(oppId)), 200).body.data.rates;
    const rates = { ...before, variable: { ...before.variable, rate24h1: 25.5, standingCharge: 60 } };
    const after = expectStatus(await team.sales.put(base(oppId), { contract: { rateType: "variable" }, rates }), 200).body.data;
    expect(after.rateType).toBe("variable");
    expect(after.rates.variable).toMatchObject({ rate24h1: 25.5, standingCharge: 60, night: null });
    expect(after.rates.energy).toMatchObject({ day1: 21.45, night: 12.37, standingCharge: 55.12 });
    const contract = await t.prisma.energyContract.findFirstOrThrow({ where: { opportunityId: oppId } });
    expect([Number(contract.dayRate), contract.nightRate, Number(contract.standingCharge)]).toEqual([0.255, null, 0.6]);
  });

  it("validates input on the server", async () => {
    const { oppId } = await bordGaisDeal();
    expectStatus(await team.sales.put(base(oppId), { rates: { energy: { day1: -1 } } }), 400);
    expectStatus(await team.sales.put(base(oppId), { readings: { meter1: { day: "12a" } } }), 400);
    expectStatus(await team.sales.put(base(oppId), { answers: { discounts: { y1_12: 150 } } }), 400);
    expectStatus(await team.sales.put(base(oppId), { bank: { accountName: "A", iban: IBAN, bic: "X" } }), 400);
    expect(expectStatus(await team.sales.put(base(oppId), { readings: { meter2: { day: "00001" } } }), 422).body.issues).toEqual(["Enter meter serial number 2 before its readings."]);
    expect(expectStatus(await team.sales.put(base(oppId), { meter: { mprn: "999" } }), 422).body.issues[0]).toMatch(/MPRN "999" should be 11 digits/);
  });
});

describe("Bord Gáis electricity: generating and signing", () => {
  it("refuses to generate until the required details are there", async () => {
    const { oppId } = await bordGaisDeal();
    const res = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 422).body;
    expect(res.issues).toEqual(["Enter the IBAN.", "Enter the BIC.", "Enter the bank account holder's name."]);
  });

  it("fills the PDF's own fields in a stored, sensitive, fillable version", async () => {
    const { oppId } = await completeDeal();
    const gen = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body;
    expect(gen).toMatchObject({ version: 1, unchanged: false });
    const v = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(v.status).toBe("ready");
    expect(v.versions[0]).toMatchObject({ version: 1, qcPassed: true, sensitive: true, requiredSigners: ["customer"], layoutVersion: BGE_LAYOUT.version });

    const form = await t.prisma.generatedForm.findUniqueOrThrow({ where: { id: gen.formId } });
    const file = await t.prisma.documentVersion.findUniqueOrThrow({ where: { id: form.versionId } });
    const pdf = await PDFDocument.load(await storage().get(file.storageKey));
    const fields = pdf.getForm();
    expect(fields.getFields()).toHaveLength(132);
    expect(fields.getTextField("Text 6").getText()).toBe("TEST TRADING LTD");
    expect(fields.getTextField("M").getText()).toBe("10012345678");
    expect(fields.getTextField("Text48").getText()).toBe(IBAN);
    expect(fields.getCheckBox("Check Box 78").isChecked()).toBe(true);
    expect(fields.getCheckBox("EMAIL").isChecked()).toBe(true); // marketingEmail false: "do not want" is ticked
    expect(fields.getCheckBox("POST").isChecked()).toBe(false);
    expect(fields.getTextField("Day rate Block 1Energy Rate").getText()).toBe("21.45");

    expect(expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body).toMatchObject({ version: 1, unchanged: true });
  });

  it("signs online, both account holders, into a flattened signed copy that needs a second person's review", async () => {
    const { oppId } = await completeDeal();
    expectStatus(await team.sales.put(base(oppId), { answers: { secondAccountHolder: { name: "Declan Murphy", email: "declan@testtrading.ie" } } }), 200);
    const { formId } = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body;
    expect(expectStatus(await team.sales.post(`/forms/${formId}/signing-links`, { role: "customer", signerName: "Mary", email: "mary@testtrading.ie" }), 422).body.issues[0]).toMatch(/application tab/);

    const sign = (url: string, name: string) =>
      anon().post(`/api/public/sign/${tokenOf(url)}`).set("Origin", ORIGIN).send({ typedName: name, consent: true, signaturePng: `data:image/png;base64,${png(120, 40).toString("base64")}` });
    const customer = expectStatus(await team.sales.post(`${base(oppId)}/versions/${formId}/send`, { role: "customer", signerName: "Mary Murphy", email: "mary@testtrading.ie" }), 201).body;
    const joint = expectStatus(await team.sales.post(`${base(oppId)}/versions/${formId}/send`, { role: "account_holder_2", signerName: "Declan Murphy", email: "declan@testtrading.ie" }), 201).body;
    expect(expectStatus(await sign(customer.url, "Mary Murphy"), 201).body).toEqual({ signed: true, complete: false });
    expect(expectStatus(await team.sales.get(base(oppId)), 200).body.status).toBe("sent");
    expect(expectStatus(await sign(joint.url, "Declan Murphy"), 201).body).toEqual({ signed: true, complete: true });

    const v = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(v.status).toBe("signed");
    const signed = await t.prisma.documentVersion.findUniqueOrThrow({ where: { id: v.versions[0].signedVersionId } });
    const pdf = await PDFDocument.load(await storage().get(signed.storageKey));
    expect(pdf.getForm().getFields()).toHaveLength(0); // flattened: nothing left to edit
    expect(pdf.getPageCount()).toBe(2); // the form plus the online-signing evidence page

    expectStatus(await team.ops.post(`/forms/${formId}/review`, { decision: "approved" }), 204);
    expect(expectStatus(await team.sales.get(base(oppId)), 200).body.status).toBe("completed");
    const history = expectStatus(await team.sales.get(`${base(oppId)}/history`), 200).body as { action: string }[];
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(["supplier_application.save", "supplier_application.generate", "form.signing_link", "form.signature_online", "form.approved"]));
  });

  it("keeps a sent version as sent: edits need a new version, replacing it only when confirmed", async () => {
    const { oppId, customerId } = await completeDeal();
    const v1 = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body;
    const link = expectStatus(await team.sales.post(`${base(oppId)}/versions/${v1.formId}/send`, { role: "customer", signerName: "Mary Murphy", email: "mary@testtrading.ie" }), 201).body;
    expectStatus(await team.sales.patch(`/customers/${customerId}`, { tradingName: "Murphy's" }), 204);
    expect(expectStatus(await team.sales.get(base(oppId)), 200).body).toMatchObject({ stale: true, status: "sent" });
    expect(expectStatus(await team.sales.post(`${base(oppId)}/versions/${v1.formId}/send`, { role: "customer", signerName: "Mary Murphy", email: "mary@testtrading.ie" }), 422).body.issues[0]).toMatch(/changed since version 1/);
    expect(expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 422).body.issues[0]).toMatch(/Confirm to replace/);
    const v2 = expectStatus(await team.sales.post(`${base(oppId)}/versions`, { confirmReplace: true }), 201).body;
    expect(v2.version).toBe(2);
    expect((await t.prisma.generatedForm.findUniqueOrThrow({ where: { id: v1.formId } })).status).toBe("superseded");
    expectStatus(await anon().get(`/api/public/sign/${tokenOf(link.url)}`), 404);
    await expect(t.prisma.supplierApplicationVersion.update({ where: { formId: v1.formId }, data: { layoutVersion: "x" } })).rejects.toThrow();
  });
});

describe("Bord Gáis electricity: permissions and bank details", () => {
  it("hides other salespeople's deals and keeps read-only roles read-only", async () => {
    const { oppId } = await bordGaisDeal();
    expectStatus(await otherSales.get(base(oppId)), 404);
    expect(expectStatus(await team.compliance.get(base(oppId)), 200).body.permissions.write).toBe(false);
    expectStatus(await team.compliance.put(base(oppId), { answers: { directDebit: false } }), 403);
    expectStatus(await team.compliance.put(base(oppId), { bank: { accountName: "X", iban: IBAN, bic: "AIBKIE2D" } }), 403);
  });

  it("masks bank details without bank.read and keeps them out of the timeline and audit", async () => {
    const { oppId } = await completeDeal();
    const sales = await team.sales.get(base(oppId));
    expect(sales.text).not.toContain(IBAN);
    expect(sales.text).not.toContain("AIBKIE2D");
    expect(sales.body.data).toMatchObject({ iban: null, bic: null, bankAccountName: null, bankOnFile: true, bicOnFile: true, ibanLast4: "5678" });
    expect(sales.body.issues).toEqual([]);
    expect(expectStatus(await finance.get(base(oppId)), 200).body.data).toMatchObject({ iban: IBAN, bic: "AIBKIE2D", bankAccountName: "Murphy's Bakery Ltd" });
    const change = { bank: { accountName: "Murphy's Bakery Ltd", iban: "IE64IRCE92050112345678", bic: "IRCEIE2D" } };
    expect(expectStatus(await team.sales.put(base(oppId), change), 422).body.issues[0]).toMatch(/IBAN differs/);
    expectStatus(await team.sales.put(base(oppId), { ...change, confirmIbanChange: true }), 200);
    const everything = JSON.stringify([await t.prisma.timelineEntry.findMany({ where: { opportunityId: oppId } }), await t.prisma.auditLog.findMany({ where: { entityType: "supplier_application" } })]);
    expect(everything).not.toMatch(/IE29AIBK|IE64IRCE|AIBKIE2D|IRCEIE2D/);
    const { formId } = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body;
    const form = await t.prisma.generatedForm.findUniqueOrThrow({ where: { id: formId } });
    expectStatus(await team.sales.get(`/document-versions/${form.versionId}/url`), 403);
    expectStatus(await finance.get(`/document-versions/${form.versionId}/url`), 200);
  });
});

describe("Bord Gáis electricity: other suppliers are unaffected", () => {
  it("keeps the template out of the generic form filler and its layout locked", async () => {
    const { oppId } = await bordGaisDeal();
    const list = expectStatus(await team.sales.get("/form-templates"), 200).body as { name: string }[];
    expect(list.some((x) => x.name === BGE_LAYOUT.name)).toBe(false);
    const tpl = await t.prisma.formTemplate.findFirstOrThrow({ where: { workflow: "bord_gais_electricity" } });
    expectStatus(await team.sales.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: {} }), 422);
    expectStatus(await team.manager.patch(`/form-templates/${tpl.id}`, { fields: [] }), 422);
  });

  it("hides the application when the supplier changes, keeping its versions and blocking sends", async () => {
    const { oppId } = await completeDeal();
    const { formId } = expectStatus(await team.sales.post(`${base(oppId)}/versions`, {}), 201).body;
    const ws = expectStatus(await team.sales.get(`/opportunities/${oppId}`), 200).body;
    expect(ws.supplierApps).toEqual([{ kind: "bord_gais_electricity", _count: { versions: 1 } }]);
    const flogas = await supplier(t, "Flogas");
    expectStatus(await team.sales.patch(`/opportunities/${oppId}`, { selectedSupplierId: flogas.id }), 204);
    const v = expectStatus(await team.sales.get(base(oppId)), 200).body;
    expect(v.applies).toBe(false);
    expect(v.versions).toHaveLength(1);
    expectStatus(await team.sales.post(`${base(oppId)}/versions/${formId}/send`, { role: "customer", signerName: "M", email: "m@x.ie" }), 422);
    // The Flogas application now applies to this deal instead.
    expect(expectStatus(await team.sales.get(`/opportunities/${oppId}/flogas-electricity`), 200).body.applies).toBe(true);
  });
});
