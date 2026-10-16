import { deflateSync, crc32 } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { OBJECT_STORAGE, type ObjectStorage } from "../../src/storage/storage";
import { type TestApp, createTestApp, expectStatus, pdf, userAndClient } from "../support/app";
import { type Team, createOpportunity, readyEnergy, supplier } from "../support/fixtures";

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

/** A one-page supplier form with fillable fields, like the Bord Gáis electricity form. */
async function supplierPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();
  form.createTextField("Customer name").addToPage(page, { x: 50, y: 760, width: 250, height: 18 });
  form.createCheckBox("Electricity").addToPage(page, { x: 50, y: 720, width: 12, height: 12 });
  form.createTextField("Client Signature").addToPage(page, { x: 50, y: 120, width: 200, height: 40 });
  form.createTextField("Signature Date").addToPage(page, { x: 300, y: 120, width: 100, height: 18 });
  const mprn = form.createTextField("MPRN boxes");
  mprn.setMaxLength(11);
  mprn.enableCombing();
  mprn.addToPage(page, { x: 50, y: 600, width: 220, height: 18 });
  return Buffer.from(await doc.save());
}

/** A small valid PNG (dark pixels on transparent), standing in for a cleaned signature photo. */
function png(w = 40, h = 12) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) if ((x + y) % 3 === 0) row.set([20, 20, 60, 255], 1 + x * 4);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

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
