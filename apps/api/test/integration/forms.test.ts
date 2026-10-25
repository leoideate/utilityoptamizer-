import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { FORM_PRESETS, type FormPreset } from "../../src/forms/presets";
import { OBJECT_STORAGE, type ObjectStorage } from "../../src/storage/storage";
import { type TestApp, createTestApp, expectStatus, pdf, userAndClient } from "../support/app";
import { type Team, createOpportunity, readyEnergy, supplier } from "../support/fixtures";
import { png, supplierPdf } from "../support/forms";

let t: TestApp;
let team: Team;
let admin: Awaited<ReturnType<typeof userAndClient>>;

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
  admin = await userAndClient(t, ["administrator"], "Aisling Admin");
});
afterAll(() => t.close());

async function createTemplate(name = "Bord Gáis application", supplierId?: string) {
  const res = expectStatus(
    await team.manager.agent
      .post("/api/form-templates")
      .set("Origin", "http://localhost:3000")
      .set("X-CSRF-Token", team.manager.csrf)
      .field("name", name)
      .field("documentType", "application_form")
      .field("supplierId", supplierId ?? "")
      .attach("file", await supplierPdf(), { filename: "form.pdf", contentType: "application/pdf" }),
    201,
  );
  return res.body as { id: string; fieldsFound: number };
}

async function configureTemplate(id: string, extra: object[] = []) {
  const tpl = expectStatus(await team.manager.get(`/form-templates/${id}`), 200).body;
  const fields = tpl.fields.map((f: { label: string }) => {
    if (f.label === "Customer name") return { ...f, source: "customer.legalName", required: true };
    if (f.label === "Electricity") return { ...f, source: "is.electricity" };
    if (f.label === "MPRN boxes") return { ...f, source: "site.mprn" };
    return f;
  });
  // A field placed by hand on the flat part of the page.
  fields.push({ id: "mprn", label: "MPRN", kind: "text", page: 0, x: 50, y: 680, w: 150, h: 16, source: "site.mprn" }, ...extra);
  expectStatus(await team.manager.patch(`/form-templates/${id}`, { fields }), 204);
}

const signatureMeta = { role: "customer", signerName: "Mary Murphy", signerCapacity: "Director", authorisation: "signed_in_person", attest: "true" };
const uploadSignature = (c: Team["sales"], formId: string, meta: Record<string, string> = signatureMeta) => {
  let req = c.agent.post(`/api/forms/${formId}/signatures`).set("Origin", "http://localhost:3000").set("X-CSRF-Token", c.csrf);
  for (const [k, v] of Object.entries(meta)) req = req.field(k, v);
  return req.attach("file", png(), { filename: "signature.png", contentType: "image/png" });
};

describe("form templates", () => {
  it("imports fillable fields, and only template managers can add or change templates", async () => {
    const s = await supplier(t, "Bord Gáis Energy");
    const tpl = await createTemplate("Bord Gáis electricity", s.id);
    expect(tpl.fieldsFound).toBe(5);
    const full = expectStatus(await team.sales.get(`/form-templates/${tpl.id}`), 200).body;
    expect(full.storageKey).toBeUndefined();
    expect(full.fields.map((f: { kind: string }) => f.kind).sort()).toEqual(["check", "signature", "signed_date", "text", "text"]);
    expect(full.fields.find((f: { label: string }) => f.label === "MPRN boxes").comb).toBe(11);
    expect(full.fields.find((f: { kind: string }) => f.kind === "signature").signer).toBe("customer");

    expectStatus(await team.sales.upload("/form-templates", await supplierPdf(), "form.pdf", "application/pdf").field("name", "x").field("documentType", "rate_card"), 403);
    expectStatus(await team.sales.patch(`/form-templates/${tpl.id}`, { name: "Renamed" }), 403);
    expectStatus(await team.manager.upload("/form-templates", pdf("not really"), "form.pdf", "application/pdf").field("name", "Broken").field("documentType", "rate_card"), 422);

    await configureTemplate(tpl.id);
    expect(expectStatus(await team.manager.get(`/form-templates/${tpl.id}`), 200).body.version).toBe(2);
    // The blank PDF downloads as a PDF (for the template editor).
    const file = expectStatus(await team.sales.get(`/form-templates/${tpl.id}/file`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    }), 200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    const listed = expectStatus(await team.sales.get(`/form-templates?supplierId=${s.id}`), 200).body;
    expect(listed.map((x: { id: string }) => x.id)).toContain(tpl.id);
  });

  it("rejects a signature box without a signer", async () => {
    const tpl = await createTemplate("No signer");
    const res = expectStatus(await team.manager.patch(`/form-templates/${tpl.id}`, { fields: [{ id: "s", label: "Sign here", kind: "signature", page: 0, x: 1, y: 1, w: 50, h: 20 }] }), 400);
    expect(JSON.stringify(res.body)).toMatch(/whose signature/);
  });
});

describe("filling, signing and reviewing a supplier form", () => {
  it("fills from the CRM, records hand changes, signs with an authorised upload and needs a second person to review", async () => {
    const { oppId } = await readyEnergy(t, team);
    const tpl = await createTemplate("Application");
    await configureTemplate(tpl.id);

    const pre = expectStatus(await team.sales.get(`/opportunities/${oppId}/forms/prefill?templateId=${tpl.id}`), 200).body;
    const value = (label: string) => pre.fields.find((f: { label: string }) => f.label === label).value;
    expect(value("Customer name")).toBe("Test Trading Ltd");
    expect(value("Electricity")).toBe(true);
    expect(value("MPRN")).toBe("10012345678");

    // A generated form that isn't signed yet blocks submission.
    const first = expectStatus(await team.sales.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: {} }), 201).body;
    expect(first).toMatchObject({ qcPassed: true, qcIssues: [] });
    let gate = expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 422).body.issues;
    expect(gate).toContain('"Application" still needs its signatures.');

    // Regenerating with a hand-typed value supersedes the first copy and records the change.
    const nameField = pre.fields.find((f: { label: string }) => f.label === "Customer name").id;
    const second = expectStatus(await team.sales.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: { [nameField]: "Test Trading (Naas) Ltd" } }), 201).body;
    let forms = expectStatus(await team.sales.get(`/opportunities/${oppId}/forms`), 200).body;
    expect(forms.find((f: { id: string }) => f.id === first.id).status).toBe("superseded");
    expect(forms.find((f: { id: string }) => f.id === second.id)).toMatchObject({ status: "generated", changedFields: ["Customer name"], requiredSigners: ["customer"] });

    // The signer's authorisation must be confirmed, and only boxes on the form can be signed.
    expectStatus(await uploadSignature(team.sales, second.id, { ...signatureMeta, attest: "false" }), 400);
    expectStatus(await uploadSignature(team.sales, second.id, { ...signatureMeta, role: "broker", authorisation: "broker_own_signature" }), 422);
    const signed = expectStatus(await uploadSignature(team.sales, second.id), 201).body;
    expect(signed).toMatchObject({ signed: true, qcPassed: true });
    forms = expectStatus(await team.sales.get(`/opportunities/${oppId}/forms`), 200).body;
    const form = forms.find((f: { id: string }) => f.id === second.id);
    expect(form.status).toBe("awaiting_review");
    expect(form.signedVersionId).toBeTruthy();
    expect(form.signatures[0]).toMatchObject({ role: "customer", signerName: "Mary Murphy", authorisation: "signed_in_person", uploadedBy: "Sarah Sales" });

    // The signed PDF has the values and the signature baked in, with no fillable fields left.
    const version = await t.prisma.documentVersion.findUniqueOrThrow({ where: { id: form.signedVersionId } });
    const saved = await PDFDocument.load(await t.app.get<ObjectStorage>(OBJECT_STORAGE).get(version.storageKey));
    expect(saved.getForm().getFields()).toHaveLength(0);

    gate = expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 422).body.issues;
    expect(gate).toContain('Review the signatures on "Application".');

    // Salespeople can't review; the person who uploaded the signature can't approve it.
    expectStatus(await team.sales.post(`/forms/${second.id}/review`, { decision: "approved" }), 403);
    expectStatus(await team.ops.post(`/forms/${second.id}/review`, { decision: "rejected" }), 422);
    expectStatus(await team.ops.post(`/forms/${second.id}/review`, { decision: "approved" }), 204);

    expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 204);
    const timeline = (expectStatus(await team.sales.get(`/opportunities/${oppId}/timeline`), 200).body as { body: string }[]).map((e) => e.body);
    expect(timeline).toContain('Generated "Application" from the CRM; changed by hand: Customer name. Quality check passed.');
    expect(timeline).toContain('Client signature for "Application" uploaded: Mary Murphy (Director). Signed on paper in front of us.');
    expect(timeline).toContain('Signed "Application" approved.');
  });

  it("the uploader can't review their own signature upload", async () => {
    const oppId = await createOpportunity(team.manager, "electricity");
    const tpl = await createTemplate("Four eyes");
    const form = expectStatus(await team.manager.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: {} }), 201).body;
    expectStatus(await uploadSignature(team.manager, form.id), 201);
    const res = expectStatus(await team.manager.post(`/forms/${form.id}/review`, { decision: "approved" }), 422);
    expect(res.body.message).toMatch(/Someone other than the person who uploaded/);
  });

  it("takes a scan of the form signed on paper, reviewed by someone else, as the customer's signature", async () => {
    const oppId = await createOpportunity(team.manager, "electricity");
    const tpl = await createTemplate("Signed on paper");
    const form = expectStatus(await team.manager.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: {} }), 201).body;
    const uploadCopy = (c: Team["sales"], file: Buffer, filename = "signed.pdf", contentType = "application/pdf") =>
      c.agent.post(`/api/forms/${form.id}/signed-copy`).set("Origin", "http://localhost:3000").set("X-CSRF-Token", c.csrf).attach("file", file, { filename, contentType });

    expectStatus(await uploadCopy(team.manager, png(), "signed.png", "image/png"), 422);
    expectStatus(await uploadCopy(team.manager, pdf("signed on paper")), 201);
    const row = expectStatus(await team.manager.get(`/opportunities/${oppId}/forms`), 200).body.find((f: { id: string }) => f.id === form.id);
    expect(row).toMatchObject({ status: "awaiting_review", signedCopyUpload: { uploadedBy: "Michael Manager" } });
    expect(row.signedVersionId).toBeTruthy();

    // The uploader can't approve it; someone else can, and it then counts as the customer's signature.
    expect(expectStatus(await team.manager.post(`/forms/${form.id}/review`, { decision: "approved" }), 422).body.message).toMatch(/uploaded the signed copy/);
    expectStatus(await team.ops.post(`/forms/${form.id}/review`, { decision: "approved" }), 204);
    const blocked = expectStatus(await team.manager.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 422).body.issues as string[];
    expect(blocked).not.toContain("The customer must sign before submission.");
    expect(blocked.some((i) => i.includes("Signed on paper"))).toBe(false);

    // An approved form can't take another signed copy.
    expectStatus(await uploadCopy(team.manager, pdf("again")), 422);
    expect(await t.prisma.auditLog.count({ where: { action: "form.signed_copy_upload", entityId: form.id } })).toBe(1);
    const timeline = (await t.prisma.timelineEntry.findMany({ where: { opportunityId: oppId } })).map((e) => e.body);
    expect(timeline).toContain('Signed copy of "Signed on paper" uploaded (signed on paper) and sent for review.');
  });

  it("fails the quality check when a value can't be printed, and blocks signing and submission", async () => {
    const { oppId } = await readyEnergy(t, team);
    const tpl = await createTemplate("Quality check");
    await configureTemplate(tpl.id);
    const pre = expectStatus(await team.sales.get(`/opportunities/${oppId}/forms/prefill?templateId=${tpl.id}`), 200).body;
    const nameField = pre.fields.find((f: { label: string }) => f.label === "Customer name").id;
    const bad = expectStatus(await team.sales.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: { [nameField]: "Łukasz Café" } }), 201).body;
    expect(bad.qcPassed).toBe(false);
    expect(bad.qcIssues.join(" ")).toMatch(/characters the PDF font can't show \(Ł\)/);
    expectStatus(await uploadSignature(team.sales, bad.id), 422);
    const gate = expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 422).body.issues;
    expect(gate).toContain('"Quality check" failed its quality check. Generate it again.');
    // Irish names with fadas print fine.
    const good = expectStatus(await team.sales.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: { [nameField]: "Seán Ó Briain Teo" } }), 201).body;
    expect(good.qcPassed).toBe(true);
  });

  it("bank details are restricted, and a changed IBAN must be confirmed", async () => {
    const { oppId } = await readyEnergy(t, team);
    const opp = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } });
    expectStatus(await admin.client.post(`/customers/${opp.customerId}/bank-accounts`, { accountName: "Test Trading Ltd", iban: "IE29AIBK93115212345678" }), 201);
    const tpl = await createTemplate("Direct debit");
    await configureTemplate(tpl.id, [{ id: "iban", label: "IBAN", kind: "text", page: 0, x: 50, y: 640, w: 250, h: 16, source: "bank.iban" }]);
    expectStatus(await admin.client.patch(`/form-templates/${tpl.id}`, { documentType: "direct_debit_mandate" }), 204);

    const salesView = expectStatus(await team.sales.get(`/opportunities/${oppId}/forms/prefill?templateId=${tpl.id}`), 200).body;
    expect(salesView.fields.find((f: { id: string }) => f.id === "iban")).toMatchObject({ restricted: true, value: null });
    const adminView = expectStatus(await admin.client.get(`/opportunities/${oppId}/forms/prefill?templateId=${tpl.id}`), 200).body;
    expect(adminView.fields.find((f: { id: string }) => f.id === "iban").value).toBe("IE29AIBK93115212345678");

    const changed = { templateId: tpl.id, values: { iban: "IE64IRCE92050112345678" } };
    expect(expectStatus(await admin.client.post(`/opportunities/${oppId}/forms`, changed), 422).body.message).toMatch(/IBAN on this form differs/);
    const ok = expectStatus(await admin.client.post(`/opportunities/${oppId}/forms`, { ...changed, confirmIbanChange: true }), 201).body;
    const form = (expectStatus(await admin.client.get(`/opportunities/${oppId}/forms`), 200).body as { id: string; ibanChangeConfirmed: boolean; versionId: string }[]).find((f) => f.id === ok.id)!;
    expect(form.ibanChangeConfirmed).toBe(true);
    // The mandate holds bank details, so salespeople can't open it.
    expectStatus(await team.sales.get(`/document-versions/${form.versionId}/url`), 403);
    // The IBAN is never written to the timeline or audit log.
    const audit = await t.prisma.auditLog.findMany({ where: { entityId: ok.id } });
    expect(JSON.stringify(audit)).not.toMatch(/IE64IRCE/);
    // A salesperson's generation still fills the IBAN on file without seeing it.
    const salesForm = expectStatus(await team.sales.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: {} }), 201).body;
    expect(salesForm.qcPassed).toBe(true);
  });

  it("other salespeople can't see or fill forms on someone else's deal", async () => {
    const oppId = await createOpportunity(team.sales, "electricity");
    const tpl = await createTemplate("Private");
    const other = await userAndClient(t, ["salesperson"], "Sean Sales");
    expectStatus(await other.client.get(`/opportunities/${oppId}/forms`), 404);
    expectStatus(await other.client.get(`/opportunities/${oppId}/forms/prefill?templateId=${tpl.id}`), 404);
    expectStatus(await other.client.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: {} }), 404);
  });
});

describe("change of supplier", () => {
  it("submission needs a passed check of the latest previous-supplier bill", async () => {
    const { oppId } = await readyEnergy(t, team);
    expectStatus(await team.sales.patch(`/opportunities/${oppId}`, { supplyChanges: ["change_of_supplier"] }), 204);
    let gate = expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 422).body.issues;
    expect(gate).toContain("Check the previous supplier's bill (readable, and the customer, MPRN/GPRN and supplier match).");

    const check = { previousSupplier: "Electric Ireland", billDate: "2026-09-01", readable: true, customerNameMatches: true, supplyPointMatches: false, supplierMatches: true, notes: "MPRN on bill ends 679" };
    expect(expectStatus(await team.sales.post(`/opportunities/${oppId}/bill-checks`, check), 201).body.passed).toBe(false);
    gate = expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 422).body.issues;
    expect(gate).toContain("The previous supplier's bill failed its check. Get a clear bill that matches this customer and supply point.");

    expect(expectStatus(await team.sales.post(`/opportunities/${oppId}/bill-checks`, { ...check, supplyPointMatches: true }), 201).body.passed).toBe(true);
    const checks = expectStatus(await team.sales.get(`/opportunities/${oppId}/bill-checks`), 200).body;
    expect(checks.checks[0]).toMatchObject({ passed: true, current: true, verifiedBy: "Sarah Sales" });

    // A newer bill needs its own check.
    const bill = await t.prisma.documentItem.findFirstOrThrow({ where: { opportunityId: oppId, documentType: "energy_bill" } });
    expectStatus(await team.sales.upload(`/documents/${bill.id}/versions`, pdf("new bill"), "bill.pdf", "application/pdf"), 201);
    expectStatus(await team.ops.post(`/documents/${bill.id}/review`, { approval: "approved" }), 204);
    gate = expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 422).body.issues;
    expect(gate).toContain("Check the previous supplier's bill (readable, and the customer, MPRN/GPRN and supplier match).");
    expectStatus(await team.sales.post(`/opportunities/${oppId}/bill-checks`, { ...check, supplyPointMatches: true }), 201);
    expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 204);
  });

  it("bill checks can't be changed or deleted", async () => {
    const { oppId } = await readyEnergy(t, team);
    await team.sales.post(`/opportunities/${oppId}/bill-checks`, { previousSupplier: "SSE Airtricity", readable: true, customerNameMatches: true, supplyPointMatches: true, supplierMatches: true });
    await expect(t.prisma.billCheck.deleteMany({ where: { opportunityId: oppId } })).rejects.toThrow(/append-only/);
  });

  it("flags another open deal switching the same meter", async () => {
    const { oppId } = await readyEnergy(t, team);
    const { oppId: other } = await readyEnergy(t, team);
    const res = expectStatus(await team.sales.get(`/opportunities/${oppId}/switch-conflicts`), 200).body;
    expect(res.conflicts.map((c: { id: string }) => c.id)).toContain(other);
    // Someone who can't see the other deal only gets a count.
    const sean = await userAndClient(t, ["salesperson"], "Sean Two");
    const mine = await createOpportunity(sean.client, "electricity");
    const site = expectStatus(await sean.client.post(`/opportunities/${mine}/sites`, { serviceType: "electricity", address: { line1: "1 Main Street" } }), 201).body.id;
    expectStatus(await sean.client.post(`/sites/${site}/meters`, { fuel: "electricity", mprn: "10012345678" }), 201);
    const seen = expectStatus(await sean.client.get(`/opportunities/${mine}/switch-conflicts`), 200).body;
    expect(seen.conflicts).toEqual([]);
    expect(seen.hiddenCount).toBeGreaterThanOrEqual(2);
  });
});

describe("tick and fill rules, and the new CRM values", () => {
  it("ticks on matching values, fills only for the right price type, and masks and capitalises text", async () => {
    const oppId = await createOpportunity(team.sales, "electricity");
    expectStatus(await team.sales.post(`/opportunities/${oppId}/customer/create`), 201);
    const { customerId } = await t.prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } });
    expectStatus(await team.sales.patch(`/customers/${customerId}`, { legalEntity: "sole_trader", marketingEmail: false, marketingPost: true, vatExempt: false, employees: 12 }), 204);
    const site = expectStatus(
      await team.sales.post(`/opportunities/${oppId}/sites`, { serviceType: "electricity", occupiedSince: "2019-01-01", leaseTerms: "10 years", address: { line1: "1 Main Street", line2: "Unit 4", city: "Naas", county: "Kildare" } }),
      201,
    ).body.id as string;
    const meter = expectStatus(await team.sales.post(`/sites/${site}/meters`, { fuel: "electricity", mprn: "10012345678", mic: 50, dgCode: "dg6", profileClass: "02" }), 201).body.id as string;
    expectStatus(await team.sales.post(`/meters/${meter}/readings`, { readingType: "actual", register: "day", value: 12345, readingDate: "2026-10-01" }), 201);
    expectStatus(await team.sales.post(`/meters/${meter}/readings`, { readingType: "actual", register: "Night", value: 6789, readingDate: "2026-10-01" }), 201);
    expectStatus(await team.sales.post(`/opportunities/${oppId}/contracts`, { fuel: "electricity", siteId: site, termMonths: 24, priceType: "fixed", dayRate: 0.305, nightRate: 0.152 }), 201);

    const tpl = await createTemplate("Rules");
    const at = (y: number) => ({ page: 0, x: 320, y, w: 150, h: 14 });
    const box = (y: number) => ({ page: 0, x: 320, y, w: 10, h: 10 });
    const fields = [
      { id: "sole", label: "Sole trader", kind: "check", ...box(700), source: "customer.legalEntity", match: "sole_trader" },
      { id: "ltd", label: "Limited", kind: "check", ...box(685), source: "customer.legalEntity", match: "limited_company" },
      { id: "noEmail", label: "No email offers", kind: "check", ...box(670), source: "marketing.email", match: "false" },
      { id: "noPost", label: "No post offers", kind: "check", ...box(655), source: "marketing.post", match: "false" },
      { id: "vatNo", label: "VAT exempt: no", kind: "check", ...box(640), source: "customer.vatExempt", match: "no" },
      { id: "t24", label: "24 months", kind: "check", ...box(625), source: "contract.termMonths", match: "24" },
      { id: "t12", label: "12 months", kind: "check", ...box(610), source: "contract.termMonths", match: "12" },
      { id: "fixedDay", label: "Fixed day rate", kind: "text", ...at(590), source: "contract.rateDayCent", onlyIf: { source: "contract.priceType", equals: "fixed" } },
      { id: "variableDay", label: "Variable day rate", kind: "text", ...at(570), source: "contract.rateDayCent", onlyIf: { source: "contract.priceType", equals: "variable" } },
      { id: "day", label: "Day reading", kind: "text", ...at(550), source: "reading.day" },
      { id: "night", label: "Night reading", kind: "text", ...at(530), source: "reading.night" },
      { id: "years", label: "Years at premises", kind: "text", ...at(510), source: "site.yearsAtPremises" },
      { id: "street", label: "Street", kind: "text", ...at(490), source: "site.street", upper: true, mask: true },
      { id: "mic", label: "MIC", kind: "text", ...at(470), source: "meter.mic" },
      { id: "dg", label: "DG code", kind: "text", ...at(450), source: "meter.dgCode" },
      { id: "tariff", label: "Night saver", kind: "check", ...box(430), source: "contract.tariff", match: "night_saver" },
      { id: "staff", label: "Employees", kind: "text", ...at(410), source: "customer.employees" },
      { id: "cover", label: "Old entry", kind: "text", ...at(390), source: null, mask: true },
    ];
    expectStatus(await team.manager.patch(`/form-templates/${tpl.id}`, { fields }), 204);
    // A tick box following a value that isn't yes/no needs the value to tick on.
    expectStatus(await team.manager.patch(`/form-templates/${tpl.id}`, { fields: [{ id: "x", label: "Entity", kind: "check", ...box(700), source: "customer.legalEntity" }] }), 400);

    const pre = expectStatus(await team.sales.get(`/opportunities/${oppId}/forms/prefill?templateId=${tpl.id}`), 200).body;
    const value = (id: string) => pre.fields.find((f: { id: string }) => f.id === id).value;
    expect([value("sole"), value("ltd"), value("noEmail"), value("noPost"), value("vatNo"), value("t24"), value("t12"), value("tariff")]).toEqual([true, false, true, false, true, true, false, true]);
    expect(value("fixedDay")).toBe("30.5");
    expect(value("variableDay")).toBeNull();
    expect([value("day"), value("night")]).toEqual(["12345", "6789"]);
    expect(Number(value("years"))).toBeGreaterThanOrEqual(7);
    expect(value("street")).toBe("1 Main Street, Unit 4");
    expect([value("mic"), value("dg"), value("staff")]).toEqual(["50", "DG6", "12"]);

    // Masked and block-capital values pass the quality check, which reads back what was drawn.
    const form = expectStatus(await team.sales.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: {} }), 201).body;
    expect(form).toMatchObject({ qcPassed: true, qcIssues: [] });
  });
});

describe("supplier forms that come set up", () => {
  it("recognises a known PDF by its hash and places its fields, and leaves other PDFs alone", async () => {
    const s = await supplier(t, "Bord Gáis Energy");
    const blank = await supplierPdf();
    const preset: FormPreset = {
      key: "test-preset",
      name: "Test supplier form",
      supplier: "bord gáis energy",
      documentType: "application_form",
      sha256: createHash("sha256").update(blank).digest("hex"),
      fields: [
        { id: "p1", label: "Customer", kind: "text", page: 0, x: 50, y: 760, w: 250, h: 18, source: "customer.legalName", upper: true },
        { id: "p2", label: "Sole trader", kind: "check", page: 0, x: 50, y: 720, w: 12, h: 12, source: "customer.legalEntity", match: "sole_trader" },
        { id: "p3", label: "Sign here", kind: "signature", page: 0, x: 50, y: 120, w: 200, h: 40, signer: "customer" },
      ],
    };
    FORM_PRESETS.push(preset);
    try {
      const upload = (file: Buffer) =>
        team.manager.agent
          .post("/api/form-templates")
          .set("Origin", "http://localhost:3000")
          .set("X-CSRF-Token", team.manager.csrf)
          .field("name", "Uploaded")
          .field("documentType", "application_form")
          .field("supplierId", "")
          .attach("file", file, { filename: "form.pdf", contentType: "application/pdf" });
      const known = expectStatus(await upload(blank), 201).body;
      expect(known).toMatchObject({ fieldsFound: 3, preset: "Test supplier form" });
      const tpl = expectStatus(await team.manager.get(`/form-templates/${known.id}`), 200).body;
      expect(tpl.supplierId).toBe(s.id);
      expect(tpl.fields).toEqual(preset.fields);

      const other = await PDFDocument.create();
      other.addPage([600, 800]);
      const unknown = expectStatus(await upload(Buffer.from(await other.save())), 201).body;
      expect(unknown).toMatchObject({ fieldsFound: 0, preset: null });
      expect(expectStatus(await team.manager.get(`/form-templates/${unknown.id}`), 200).body.supplierId).toBeNull();
    } finally {
      FORM_PRESETS.splice(FORM_PRESETS.indexOf(preset), 1);
    }
  });
});
