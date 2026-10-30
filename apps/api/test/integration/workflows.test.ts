/**
 * Developer acceptance checks from the Utility Optimizer workflow briefs:
 * change of legal entity (known supply point and new to us) and existing-supplier renewal.
 */
import { crc32, deflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from "pdf-lib";
import { addDays, addMonths, today } from "@uo/shared";
import { AutomationsService } from "../../src/automations/automations.service";
import { RenewalsService } from "../../src/automations/renewals.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../../src/storage/storage";
import { type Client, type TestApp, createTestApp, expectStatus, pdf, userAndClient } from "../support/app";
import { type Team, completeDocuments, createOpportunity, readyEnergy, sendAndAccept, supplier } from "../support/fixtures";

let t: TestApp;
let team: Team;
let admin: Awaited<ReturnType<typeof userAndClient>>;
let opsUser: Awaited<ReturnType<typeof userAndClient>>;

beforeAll(async () => {
  t = await createTestApp();
  const sales = await userAndClient(t, ["salesperson"], "Sarah Sales");
  opsUser = await userAndClient(t, ["operations"], "Orla Ops");
  team = {
    sales: sales.client,
    salesId: sales.user.id,
    ops: opsUser.client,
    manager: (await userAndClient(t, ["manager"], "Michael Manager")).client,
    compliance: (await userAndClient(t, ["compliance"])).client,
  };
  admin = await userAndClient(t, ["administrator"], "Aisling Admin");
});
afterAll(() => t.close());

// --- Helpers ---------------------------------------------------------------------------

async function formPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

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
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) if ((x + y) % 3 === 0) row.set([20, 20, 60, 255], 1 + x * 4);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/** A supplier template with the given CRM sources, one text box each, plus a client signature box. */
async function template(name: string, sources: string[], opts: { supplierId?: string; documentType?: string } = {}) {
  const res = expectStatus(
    await team.manager.agent
      .post("/api/form-templates")
      .set("Origin", "http://localhost:3000")
      .set("X-CSRF-Token", team.manager.csrf)
      .field("name", name)
      .field("documentType", opts.documentType ?? "application_form")
      .field("supplierId", opts.supplierId ?? "")
      .attach("file", await formPdf(), { filename: "form.pdf", contentType: "application/pdf" }),
    201,
  ).body as { id: string };
  const fields: object[] = sources.map((source, i) => ({ id: source.replace(/\W/g, "_"), label: source, kind: "text", page: 0, x: 40, y: 780 - i * 30, w: 400, h: 18, source }));
  fields.push({ id: "sig", label: "Client signature", kind: "signature", page: 0, x: 40, y: 80, w: 200, h: 40, signer: "customer" });
  expectStatus(await team.manager.patch(`/form-templates/${res.id}`, { fields }), 204);
  return res.id;
}

const uploadSignature = (c: Client, formId: string) => {
  let req = c.agent.post(`/api/forms/${formId}/signatures`).set("Origin", "http://localhost:3000").set("X-CSRF-Token", c.csrf);
  for (const [k, v] of Object.entries({ role: "customer", signerName: "Niamh Byrne", signerCapacity: "Director", authorisation: "signed_in_person", attest: "true" })) req = req.field(k, v);
  return req.attach("file", png(), { filename: "signature.png", contentType: "image/png" });
};

/** Generates, signs and approves a form (the reviewer is someone other than the uploader). */
async function signedForm(oppId: string, templateId: string, values: object = {}) {
  const form = expectStatus(await team.sales.post(`/opportunities/${oppId}/forms`, { templateId, values }), 201).body as { id: string; qcPassed: boolean };
  expect(form.qcPassed).toBe(true);
  expectStatus(await uploadSignature(team.sales, form.id), 201);
  expectStatus(await team.ops.post(`/forms/${form.id}/review`, { decision: "approved" }), 204);
  return form.id;
}

async function storedPdf(versionId: string) {
  const v = await t.prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
  return PDFDocument.load(await t.app.get<ObjectStorage>(OBJECT_STORAGE).get(v.storageKey));
}

/** Page content as written by the PDF, lower-case: drawn values appear as their hex strings. */
function pageContent(doc: PDFDocument, index = 0) {
  const contents = doc.getPages()[index].node.Contents();
  const streams: PDFStream[] = [];
  if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i++) streams.push(doc.context.lookup(contents.get(i)) as PDFStream);
  else if (contents instanceof PDFStream) streams.push(contents);
  return streams.map((s) => Buffer.from(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()).toString("latin1")).join("\n").toLowerCase();
}
const hex = (text: string) => Buffer.from(text, "latin1").toString("hex");

const caseOf = async (c: Client, oppId: string) => expectStatus(await c.get(`/opportunities/${oppId}/case`), 200).body;
const gate = async (oppId: string, stage: string) => expectStatus(await team.ops.get(`/opportunities/${oppId}/gates/${stage}`), 200).body.issues as string[];
const leaseCheck = { status: "signed", landlordName: "Harbour Properties Ltd", tenantName: "Incoming Café Ltd", tenancyStartDate: "2026-10-01", landlordMatches: true, tenantMatches: true, addressMatches: true, datesMatch: true, signedByLandlord: true, signedByTenant: true };

// --- Change of legal entity ----------------------------------------------------------------

describe("change of entity on a supply point already in our records", () => {
  let outgoingOpp: string;
  let outgoingCustomer: string;
  let siteId: string;
  let caseOpp: string;
  let incoming: string;
  let tpl: string;
  let formId: string;
  let submissionId: string;

  it("matches the existing MPRN and address, and keeps the incoming customer a separate record", async () => {
    const ready = await readyEnergy(t, team);
    outgoingOpp = ready.oppId;
    siteId = ready.siteId;
    outgoingCustomer = (await t.prisma.opportunity.findUniqueOrThrow({ where: { id: outgoingOpp } })).customerId!;
    expectStatus(await admin.client.post(`/customers/${outgoingCustomer}/bank-accounts`, { accountName: "Test Trading Ltd", iban: "IE29AIBK93115212345678" }), 201);
    await sendAndAccept(team, outgoingOpp);
    expectStatus(await team.ops.post(`/opportunities/${outgoingOpp}/activate`, { activationDate: addDays(today(), -400) }), 204);

    caseOpp = await createOpportunity(team.sales, "electricity", { name: "Change of entity: Incoming Café", companyName: "Incoming Café Ltd", contactName: "Niamh Byrne", email: "niamh@incoming.ie", leadSource: "whatsapp" });
    expectStatus(await team.sales.patch(`/opportunities/${caseOpp}`, { supplyChanges: ["change_of_legal_entity"], selectedSupplierId: ready.supplierId }), 204);

    // The broker's request is matched to the existing supply point by its MPRN.
    const found = expectStatus(await team.sales.get(`/supply-points?q=10012345678`), 200).body;
    expect(found.ambiguous).toBe(false);
    expect(found.matches[0]).toMatchObject({ siteId, customer: { id: outgoingCustomer, legalName: "Test Trading Ltd" }, meters: [{ fuel: "electricity", mprn: "10012345678" }] });
    expectStatus(await team.sales.put(`/opportunities/${caseOpp}/case`, { siteId, requestChannel: "whatsapp", requestReceivedAt: today(), outgoingAccountRef: "EN-1001" }), 204);

    let kase = await caseOf(team.sales, caseOpp);
    expect(kase).toMatchObject({ kind: "change_of_entity", case: { supplyPath: "known_supply_point", siteId, outgoingCustomerId: outgoingCustomer } });
    expect(kase.steps.slice(0, 2).map((s: { done: boolean }) => s.done)).toEqual([true, true]);
    expect(kase.status).toBe("Awaiting incoming details");

    // Linking the outgoing account holder as the "incoming" customer is refused or flagged.
    expectStatus(await team.sales.post(`/opportunities/${caseOpp}/customer`, { customerId: outgoingCustomer }), 204);
    expect(await gate(caseOpp, "documents_prepared")).toContain("Link the incoming customer: the outgoing account holder can't be the incoming customer.");
    expect(expectStatus(await team.sales.put(`/opportunities/${caseOpp}/case`, { outgoingCustomerId: outgoingCustomer }), 422).body.issues[0]).toMatch(/can't also be the incoming customer/);

    incoming = expectStatus(
      await team.sales.post("/customers?confirmNew=true", { legalName: "Incoming Café Ltd", email: "accounts@incoming.ie", addresses: [{ kind: "billing", line1: "2 New Road", city: "Naas" }] }),
      201,
    ).body.id;
    expectStatus(await team.sales.post(`/opportunities/${caseOpp}/customer`, { customerId: incoming }), 204);
    kase = await caseOf(team.sales, caseOpp);
    expect(kase.checklist.find((i: { key: string }) => i.key === "incoming_customer").done).toBe(true);
    // The outgoing customer and their history stay where they were.
    expect((await t.prisma.supplySite.findUniqueOrThrow({ where: { id: siteId } })).customerId).toBe(outgoingCustomer);
  });

  it("never fills the incoming customer's fields with the outgoing customer's name or IBAN", async () => {
    tpl = await template("Change of tenancy", ["customer.legalName", "bank.iban", "site.mprn", "landlord.name", "tenancy.occupancyDate", "outgoing.legalName"], { documentType: "change_of_tenancy" });
    const pre = expectStatus(await admin.client.get(`/opportunities/${caseOpp}/forms/prefill?templateId=${tpl}`), 200).body;
    const value = (label: string) => pre.fields.find((f: { label: string }) => f.label === label).value;
    expect(value("customer.legalName")).toBe("Incoming Café Ltd");
    expect(value("bank.iban")).toBeNull(); // the outgoing customer's IBAN is not used
    expect(value("outgoing.legalName")).toBe("Test Trading Ltd");
    expect(value("site.mprn")).toBe("10012345678");

    // The checklist lists the missing IBAN, landlord details and occupancy date, but doesn't block a move.
    expect(await gate(caseOpp, "documents_prepared")).toEqual([]);
  });

  it("an IBAN copied from the outgoing customer blocks documents", async () => {
    const other = expectStatus(await team.sales.post("/customers?confirmNew=true", { legalName: "Copycat Ltd" }), 201).body.id;
    const opp = await createOpportunity(team.sales, "electricity", { companyName: "Copycat Ltd" });
    expectStatus(await team.sales.patch(`/opportunities/${opp}`, { supplyChanges: ["change_of_legal_entity"] }), 204);
    expectStatus(await team.sales.post(`/opportunities/${opp}/customer`, { customerId: other }), 204);
    expectStatus(await team.sales.put(`/opportunities/${opp}/case`, { siteId }), 204);
    expectStatus(await admin.client.post(`/customers/${other}/bank-accounts`, { accountName: "Copycat", iban: "IE29 AIBK 9311 5212 3456 78".replace(/ /g, "") }), 201);
    expect(await gate(opp, "documents_prepared")).toContain("The incoming customer's IBAN is the same as the outgoing customer's. Record the incoming customer's own bank account.");
    const res = expectStatus(await team.sales.post(`/opportunities/${opp}/forms`, { templateId: tpl, values: {} }), 422);
    expect(res.body.issues).toContain("The incoming customer's IBAN is the same as the outgoing customer's. Record the incoming customer's own bank account first.");
  });

  it("fills the form from verified incoming data and reopens it with the entity and landlord intact", async () => {
    expectStatus(await admin.client.post(`/customers/${incoming}/bank-accounts`, { accountName: "Incoming Café Ltd", iban: "IE64IRCE92050112345678" }), 201);
    expectStatus(await team.sales.patch(`/sites/${siteId}`, { occupancyType: "rented", landlordName: "Harbour Properties Ltd", landlordContact: "087 555 0101" }), 204);
    expectStatus(await team.sales.put(`/opportunities/${caseOpp}/case`, { occupancyDate: "2026-11-01" }), 204);
    expect(await gate(caseOpp, "documents_prepared")).toEqual([]);

    formId = await signedForm(caseOpp, tpl);
    const form = (expectStatus(await team.sales.get(`/opportunities/${caseOpp}/forms`), 200).body as { id: string; signedVersionId: string }[]).find((f) => f.id === formId)!;
    const saved = await storedPdf(form.signedVersionId);
    expect(saved.getForm().getFields()).toHaveLength(0);
    const content = pageContent(saved);
    for (const text of ["Incoming Café Ltd", "Harbour Properties Ltd", "IE64IRCE92050112345678", "10012345678", "01/11/2026", "Test Trading Ltd"]) expect(content).toContain(hex(text));
    expect(content).not.toContain(hex("IE29AIBK93115212345678"));
    expect(content).toMatch(/\sdo\b/); // the signature image
  });

  it("a missing or unsigned lease keeps the case out of Ready to submit; draft and signed copies are distinct", async () => {
    await completeDocuments(team, caseOpp);
    expectStatus(await team.sales.post(`/opportunities/${caseOpp}/contracts`, { fuel: "electricity", siteId, termMonths: 12 }), 201);
    expectStatus(await team.manager.post(`/opportunities/${caseOpp}/approval`, { decision: "approved" }), 204);
    expect(await gate(caseOpp, "submitted")).toContain("Check the lease agreement (draft or signed, names, address, dates and signatures).");

    // Salespeople can't verify a lease; a draft is recorded as a draft and still blocks.
    expectStatus(await team.sales.post(`/opportunities/${caseOpp}/lease-checks`, leaseCheck), 403);
    expect(expectStatus(await team.ops.post(`/opportunities/${caseOpp}/lease-checks`, { ...leaseCheck, status: "draft", signedByLandlord: false, signedByTenant: false }), 201).body.passed).toBe(false);
    expect(await gate(caseOpp, "submitted")).toContain("The lease is still a draft. Upload the copy signed by the landlord and tenant, then check it.");
    expect((await caseOf(team.ops, caseOpp)).status).toBe("Awaiting tenancy evidence");

    // The signed copy is a new version with its own check.
    const item = await t.prisma.documentItem.findFirstOrThrow({ where: { opportunityId: caseOpp, documentType: "lease_agreement" } });
    expectStatus(await team.sales.upload(`/documents/${item.id}/versions`, pdf("signed lease"), "lease-signed.pdf", "application/pdf"), 201);
    expectStatus(await team.ops.post(`/documents/${item.id}/review`, { approval: "approved" }), 204);
    expect(await gate(caseOpp, "submitted")).toContain("Check the lease agreement (draft or signed, names, address, dates and signatures).");
    expect(expectStatus(await team.ops.post(`/opportunities/${caseOpp}/lease-checks`, { ...leaseCheck, signedByLandlord: false }), 201).body.passed).toBe(false);
    expect(await gate(caseOpp, "submitted")).toContain("The signed lease failed its check. Get a lease that matches this case and is signed by both parties.");
    expect(expectStatus(await team.ops.post(`/opportunities/${caseOpp}/lease-checks`, leaseCheck), 201).body.passed).toBe(true);
    expect(await gate(caseOpp, "submitted")).toEqual([]);

    const kase = await caseOf(team.ops, caseOpp);
    expect(kase.status).toBe("Ready to submit");
    expect(kase.lease.checks.map((c: { status: string; passed: boolean; current: boolean }) => [c.status, c.passed, c.current])).toEqual([
      ["signed", true, true],
      ["signed", false, true],
      ["draft", false, false],
    ]);
  });

  it("retains the exact files sent, and keeps Sent, Accepted, Entity change confirmed and Completed distinct", async () => {
    const kase = await caseOf(team.ops, caseOpp);
    const lease = kase.lease.latest.versionId as string;
    const others = (kase.files as { versionId: string }[]).map((f) => f.versionId).filter((v) => v !== lease);
    const body = { recipient: "cot@supplier.test", channel: "email", documentVersionIds: others, deliveryEvidence: "Sent from ops@utilityoptimizer.ie, 10:42" };
    expectStatus(await team.sales.post(`/opportunities/${caseOpp}/submissions`, { ...body, documentVersionIds: [...others, lease] }), 403);
    expect(expectStatus(await team.ops.post(`/opportunities/${caseOpp}/submissions`, body), 422).body.issues).toContain("Include the signed lease agreement.");
    submissionId = expectStatus(await team.ops.post(`/opportunities/${caseOpp}/submissions`, { ...body, documentVersionIds: [...others, lease] }), 201).body.id;

    let ws = expectStatus(await team.ops.get(`/opportunities/${caseOpp}`), 200).body;
    expect(ws.stage.key).toBe("submitted");
    expect((await caseOf(team.ops, caseOpp)).status).toBe("Sent");
    // A sent case can't be completed, and a follow-up task waits for the response.
    expect(expectStatus(await team.ops.post(`/opportunities/${caseOpp}/activate`, { activationDate: "2026-11-01" }), 422).body.issues).toContain(
      "Record the external party's acceptance and reference: a sent submission is not an accepted one.",
    );
    expect(await t.prisma.activity.count({ where: { opportunityId: caseOpp, automationKey: "submission_follow_up", status: "open" } })).toBe(1);

    // Rejection: reason, owner and due date, with a correction task.
    expectStatus(await team.ops.post(`/submissions/${submissionId}/responses`, { outcome: "rejected", receivedVia: "email" }), 400);
    expectStatus(
      await team.ops.post(`/submissions/${submissionId}/responses`, { outcome: "rejected", receivedVia: "email", reason: "Lease page 3 missing", correctionOwnerId: opsUser.user.id, correctionDueDate: addDays(today(), 2) }),
      201,
    );
    let kaseNow = await caseOf(team.ops, caseOpp);
    expect(kaseNow.status).toBe("Rejected");
    const correction = await t.prisma.activity.findFirstOrThrow({ where: { opportunityId: caseOpp, automationKey: "submission_correction", status: "open" } });
    expect(correction).toMatchObject({ ownerId: opsUser.user.id, priority: "high", note: "Lease page 3 missing" });

    // Resubmission closes the correction task; acceptance moves the deal on.
    submissionId = expectStatus(await team.ops.post(`/opportunities/${caseOpp}/submissions`, { ...body, documentVersionIds: [...others, lease], note: "Full lease attached" }), 201).body.id;
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: correction.id } })).status).toBe("done");
    expect((await caseOf(team.ops, caseOpp)).status).toBe("Sent");
    expectStatus(await team.ops.post(`/submissions/${submissionId}/responses`, { outcome: "accepted", receivedVia: "supplier_portal", externalReference: "COT-77812" }), 201);
    ws = expectStatus(await team.ops.get(`/opportunities/${caseOpp}`), 200).body;
    expect(ws.stage.key).toBe("awaiting_confirmation");
    expect((await caseOf(team.ops, caseOpp)).status).toBe("Accepted");
    expect(expectStatus(await team.ops.post(`/opportunities/${caseOpp}/activate`, { activationDate: "2026-11-01" }), 422).body.issues).toEqual(["Record the confirmed effective date of the change of entity."]);

    expectStatus(await team.ops.post(`/submissions/${submissionId}/responses`, { outcome: "change_confirmed", receivedVia: "email", effectiveDate: "2026-11-01" }), 201);
    expect((await caseOf(team.ops, caseOpp)).status).toBe("Entity change confirmed");
    expectStatus(await team.ops.post(`/opportunities/${caseOpp}/activate`, { activationDate: "2026-11-01" }), 204);
    kaseNow = await caseOf(team.ops, caseOpp);
    expect(kaseNow.status).toBe("Completed");

    // Everything is retained: both submissions with their files, and every response.
    expect(kaseNow.submissions).toHaveLength(2);
    expect(kaseNow.submissions[1].responses.map((r: { outcome: string }) => r.outcome)).toEqual(["rejected"]);
    expect(kaseNow.submissions[0].responses.map((r: { outcome: string; externalReference: string | null; effectiveDate: string | null }) => [r.outcome, r.externalReference, r.effectiveDate])).toEqual([
      ["accepted", "COT-77812", null],
      ["change_confirmed", null, "2026-11-01"],
    ]);
    expect(kaseNow.submissions[0].files.map((f: { documentVersionId: string }) => f.documentVersionId)).toContain(lease);
    const signedVersion = (await t.prisma.generatedForm.findUniqueOrThrow({ where: { id: formId } })).signedVersionId;
    expect(kaseNow.submissions[0].files.map((f: { documentVersionId: string }) => f.documentVersionId)).toContain(signedVersion);
  });

  it("links the incoming customer to the supply point from the effective date and keeps the outgoing history", async () => {
    expect((await t.prisma.supplySite.findUniqueOrThrow({ where: { id: siteId } })).customerId).toBe(incoming);
    const history = await t.prisma.supplyOccupancy.findMany({ where: { siteId }, orderBy: { recordedAt: "asc" } });
    expect(history.map((h) => [h.customerId, h.fromDate?.toISOString().slice(0, 10) ?? null])).toEqual([
      [outgoingCustomer, null],
      [incoming, "2026-11-01"],
    ]);
    const outgoingProfile = expectStatus(await team.sales.get(`/customers/${outgoingCustomer}`), 200).body;
    expect(outgoingProfile.occupancies.map((o: { siteId: string }) => o.siteId)).toContain(siteId);
    // The outgoing customer's contract and deal are untouched.
    const contract = await t.prisma.energyContract.findFirstOrThrow({ where: { opportunityId: outgoingOpp } });
    expect(contract).toMatchObject({ status: "live", customerId: outgoingCustomer });
    expect((await t.prisma.opportunity.findUniqueOrThrow({ where: { id: outgoingOpp } })).outcome).toBe("won");

    // No bank details reach the timeline or the audit log.
    const timeline = await t.prisma.timelineEntry.findMany({ where: { opportunityId: caseOpp } });
    const audit = await t.prisma.auditLog.findMany({ where: { entityId: caseOpp } });
    expect(JSON.stringify([timeline, audit])).not.toMatch(/IE64IRCE|IE29AIBK/);
  });

  it("evidence can't be changed or deleted", async () => {
    await expect(t.prisma.submission.deleteMany({ where: { opportunityId: caseOpp } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.submissionResponse.updateMany({ where: { opportunityId: caseOpp }, data: { externalReference: "X" } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.leaseCheck.deleteMany({ where: { opportunityId: caseOpp } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.supplyOccupancy.deleteMany({ where: { siteId } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.workflowCase.deleteMany({ where: { opportunityId: caseOpp } })).rejects.toThrow(/append-only/);
  });
});

describe("change of entity for a customer and supply point new to us", () => {
  it("the checklist flags missing MPRN, contacts, IBAN and landlord, and records the source of the supply details", async () => {
    const opp = await createOpportunity(team.sales, "electricity", { companyName: "Brand New Bakery Ltd", contactName: null, email: null, phone: null });
    expectStatus(await team.sales.patch(`/opportunities/${opp}`, { supplyChanges: ["change_of_legal_entity"] }), 204);
    // Duplicate check before creating the customer.
    expect(expectStatus(await team.sales.post("/customers/duplicates", { legalName: "Brand New Bakery Ltd" }), 200).body).toEqual([]);
    expectStatus(await team.sales.post(`/opportunities/${opp}/customer/create`), 201);
    expectStatus(await team.sales.put(`/opportunities/${opp}/case`, { supplyPath: "new_supply_point", requestChannel: "email" }), 204);
    const site = expectStatus(await team.sales.post(`/opportunities/${opp}/sites`, { serviceType: "electricity", occupancyType: "rented", address: { line1: "Unit 9 Mill Lane" } }), 201).body.id;
    expectStatus(await team.sales.post(`/sites/${site}/meters`, { fuel: "electricity" }), 201);

    let kase = await caseOf(team.sales, opp);
    const missing = kase.checklist.filter((i: { done: boolean }) => !i.done).map((i: { key: string }) => i.key);
    expect(missing).toEqual(["supply_source", "meter_ids", "occupancy_date", "contact_name", "contact_reach", "billing_address", "iban", "landlord_name", "landlord_contact"]);
    expect(kase.status).toBe("Awaiting incoming details");
    // A matched supply point can't be "new to us".
    const known = await readyEnergy(t, team);
    expectStatus(await team.sales.put(`/opportunities/${opp}/case`, { supplyPath: "new_supply_point", siteId: known.siteId }), 422);

    expectStatus(await team.sales.put(`/opportunities/${opp}/case`, { supplySource: "ESB Networks connection letter, checked against the meter photo" }), 204);
    kase = await caseOf(team.sales, opp);
    expect(kase.checklist.find((i: { key: string }) => i.key === "supply_source").done).toBe(true);
    expect(kase.case.supplyVerifiedBy).toBe("Sarah Sales");
  });
});

describe("finding the supply point", () => {
  it("flags ambiguous matches and open cases, and only counts records the user can't see", async () => {
    const a = await readyEnergy(t, team);
    const res = expectStatus(await team.ops.get(`/supply-points?q=10012345678`), 200).body;
    expect(res.ambiguous).toBe(true);
    const match = res.matches.find((m: { siteId: string }) => m.siteId === a.siteId);
    expect(match.openCases.map((c: { id: string }) => c.id)).toContain(a.oppId);
    const stranger = await userAndClient(t, ["salesperson"], "Sean Stranger");
    const seen = expectStatus(await stranger.client.get(`/supply-points?q=10012345678`), 200).body;
    expect(seen.matches).toEqual([]);
    expect(seen.hiddenCount).toBeGreaterThan(1);
    expectStatus(await stranger.client.get(`/supply-points?q=10`), 400);
  });
});

// --- Existing-supplier renewal --------------------------------------------------------------

describe("renewal with the existing supplier", () => {
  let previous: string;
  let renewal: string;
  let tpl: string;
  let supplierId: string;

  it("an existing client's renewal is created from the previous contract and prefills without retyping", async () => {
    const ready = await readyEnergy(t, team);
    previous = ready.oppId;
    supplierId = ready.supplierId;
    const customer = (await t.prisma.opportunity.findUniqueOrThrow({ where: { id: previous } })).customerId!;
    expectStatus(await team.sales.patch(`/customers/${customer}`, { addresses: [{ kind: "billing", line1: "1 Main Street", city: "Naas" }] }), 204);
    tpl = await template("Energia renewal", ["customer.legalName", "contact.fullName", "site.mprn", "site.full", "contract.dayRate"], { supplierId });
    await signedForm(previous, tpl);
    await sendAndAccept(team, previous);
    expectStatus(await team.ops.post(`/opportunities/${previous}/activate`, { activationDate: addDays(today(), -600) }), 204);
    await t.prisma.energyContract.updateMany({ where: { opportunityId: previous }, data: { contractEndDate: new Date(`${addDays(today(), 100)}T00:00:00Z`) } });
    const run = await t.app.get(RenewalsService).run();
    renewal = run.created[0];
    expect(renewal).toBeTruthy();

    const kase = await caseOf(team.sales, renewal);
    expect(kase).toMatchObject({ kind: "renewal" });
    expect(kase.steps[0]).toMatchObject({ key: "request", done: true });
    expect(kase.status).toBe("Awaiting terms confirmation");

    // The supply site lives on the previous deal, and still fills the form.
    const pre = expectStatus(await team.sales.get(`/opportunities/${renewal}/forms/prefill?templateId=${tpl}`), 200).body;
    const field = (label: string) => pre.fields.find((f: { label: string }) => f.label === label);
    expect(field("site.mprn")).toMatchObject({ value: "10012345678", previousValue: "10012345678", changedSincePrevious: false });
    expect(field("customer.legalName")).toMatchObject({ value: "Test Trading Ltd", changedSincePrevious: false });
    expect(pre.previousForm.opportunityId).toBe(previous);
  });

  it("terms must be verified by Admin before documents, and a later change needs a new verification", async () => {
    expect(expectStatus(await team.sales.post(`/opportunities/${renewal}/forms`, { templateId: tpl, values: {} }), 422).body.issues).toEqual(["Verify the renewal terms before generating documents."]);
    expectStatus(await team.sales.post(`/opportunities/${renewal}/terms-checks`), 403);
    expectStatus(await team.ops.post(`/opportunities/${renewal}/terms-checks`), 422);
    const contract = await t.prisma.energyContract.findFirstOrThrow({ where: { opportunityId: renewal } });
    expectStatus(await team.sales.patch(`/contracts/${contract.id}`, { selectedSupplierId: supplierId, termMonths: 24, proposedActivationDate: addDays(today(), 100), dayRate: 0.2915, standingCharge: 0.65 }), 204);
    expectStatus(await team.ops.post(`/opportunities/${renewal}/terms-checks`), 201);
    expect((await caseOf(team.ops, renewal)).terms.verified).toBe(true);
    expectStatus(await team.sales.patch(`/contracts/${contract.id}`, { dayRate: 0.2999 }), 204);
    expect(await gate(renewal, "documents_prepared")).toContain("Verify the renewal terms (rates, term, start date and supplier).");
    expectStatus(await team.ops.post(`/opportunities/${renewal}/terms-checks`), 201);
    expect(await gate(renewal, "documents_prepared")).toEqual([]);
  });

  it("every value that changed since the last form stays visible in the change log", async () => {
    const first = expectStatus(await team.sales.post(`/opportunities/${renewal}/forms`, { templateId: tpl, values: {} }), 201).body;
    let forms = expectStatus(await team.sales.get(`/opportunities/${renewal}/forms`), 200).body as { id: string; changedSincePrevious: string[]; changedFields: string[] }[];
    // Only the rate changed: nothing about the customer was retyped.
    expect(forms.find((f) => f.id === first.id)).toMatchObject({ changedSincePrevious: ["contract.dayRate"], changedFields: [] });
    const second = expectStatus(await team.sales.post(`/opportunities/${renewal}/forms`, { templateId: tpl, values: { contact_fullName: "Mary Murphy-Walsh" }, changeReason: "Married name" }), 201).body;
    forms = expectStatus(await team.sales.get(`/opportunities/${renewal}/forms`), 200).body;
    expect(forms.find((f) => f.id === second.id)).toMatchObject({ changedSincePrevious: ["contact.fullName", "contract.dayRate"], changedFields: ["contact.fullName"], changeReason: "Married name" });
    const timeline = (expectStatus(await team.sales.get(`/opportunities/${renewal}/timeline`), 200).body as { body: string }[]).map((e) => e.body).join("\n");
    expect(timeline).toMatch(/Changed since the previous form \(UO-\d{6}\): contact\.fullName, contract\.dayRate \(Married name\)\./);
  });

  it("can't be completed until the external party's acceptance and the final document version are recorded", async () => {
    expect(await gate(renewal, "submitted")).toContain("This supplier needs its full renewal form: generate it, add the signatures and have it reviewed.");
    const forms = expectStatus(await team.sales.get(`/opportunities/${renewal}/forms`), 200).body as { id: string; status: string }[];
    const current = forms.find((f) => f.status === "generated")!;
    expectStatus(await uploadSignature(team.sales, current.id), 201);
    expectStatus(await team.ops.post(`/forms/${current.id}/review`, { decision: "approved" }), 204);
    await completeDocuments(team, renewal);
    expectStatus(await team.manager.post(`/opportunities/${renewal}/approval`, { decision: "approved" }), 204);
    expect(await gate(renewal, "submitted")).toEqual([]);

    const sub = await sendSome(renewal);
    expect((await caseOf(team.ops, renewal)).status).toBe("Sent to external party");
    expectStatus(await team.ops.post(`/opportunities/${renewal}/stage`, { stage: "awaiting_confirmation" }), 422);
    expectStatus(await team.ops.post(`/opportunities/${renewal}/activate`, { activationDate: addDays(today(), 100) }), 422);
    expectStatus(await team.ops.post(`/submissions/${sub}/responses`, { outcome: "accepted", receivedVia: "email", externalReference: "REN-55" }), 201);
    expectStatus(await team.ops.post(`/opportunities/${renewal}/activate`, { activationDate: addDays(today(), 100) }), 204);
    const kase = await caseOf(team.ops, renewal);
    expect(kase.status).toBe("Completed");
    // The final signed version is in the retained submission, and the next renewal date is set.
    const signed = (await t.prisma.generatedForm.findFirstOrThrow({ where: { opportunityId: renewal, status: "approved" } })).signedVersionId;
    expect(kase.submissions[0].files.map((f: { documentVersionId: string }) => f.documentVersionId)).toContain(signed);
    const ws = expectStatus(await team.ops.get(`/opportunities/${renewal}`), 200).body;
    expect(ws.renewalDate.slice(0, 10)).toBe(addDays(addMonths(addDays(today(), 100), 24), -1));
  });

  it("supplier rules choose the full form or the rate card alone, and the submission checklist adapts", async () => {
    const card = await supplier(t, "Flogas");
    expectStatus(await admin.client.patch(`/admin/suppliers/${card.id}`, { name: "Flogas", kind: "energy", renewalRoute: "rate_card_only" }), 200);
    const { oppId } = await readyEnergy(t, team);
    expectStatus(await team.sales.patch(`/opportunities/${oppId}`, { saleType: "renewal", selectedSupplierId: card.id }), 204);
    const customer = (await t.prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } })).customerId!;
    expectStatus(await team.sales.patch(`/customers/${customer}`, { addresses: [{ kind: "billing", line1: "1 Main Street" }] }), 204);
    expect(await gate(oppId, "documents_prepared")).not.toContain("Choose whether the customer is an existing client or new to us.");
    expectStatus(await team.sales.put(`/opportunities/${oppId}/case`, { customerPath: "new_to_us", requestChannel: "email" }), 204);
    const contract = await t.prisma.energyContract.findFirstOrThrow({ where: { opportunityId: oppId } });
    expectStatus(await team.sales.patch(`/contracts/${contract.id}`, { proposedActivationDate: addDays(today(), 60), gasRate: null, dayRate: 0.28 }), 204);
    expectStatus(await team.ops.post(`/opportunities/${oppId}/terms-checks`), 201);
    expect(await gate(oppId, "submitted")).toEqual(["This supplier renews on the rate card alone: upload and approve the signed rate card."]);

    const item = expectStatus(await team.sales.post(`/opportunities/${oppId}/documents`, { documentType: "rate_card", required: true }), 201).body.id;
    expectStatus(await team.sales.upload(`/documents/${item}/versions`, pdf("rate card"), "rate-card.pdf", "application/pdf"), 201);
    expectStatus(await team.ops.post(`/documents/${item}/review`, { approval: "approved" }), 204);
    expect(await gate(oppId, "submitted")).toEqual([]);

    // The same deal with a full-form supplier needs the renewal form instead.
    expectStatus(await admin.client.patch(`/admin/suppliers/${card.id}`, { name: "Flogas", kind: "energy", renewalRoute: "full_form" }), 200);
    expect(await gate(oppId, "submitted")).toEqual(["This supplier needs its full renewal form: generate it, add the signatures and have it reviewed."]);
  });

  it("a customer new to us proceeds from a guided checklist when there's no bill", async () => {
    const opp = await createOpportunity(team.sales, "gas", { saleType: "renewal", companyName: "No Bill Ltd", contactName: null, email: null, phone: null });
    expectStatus(await team.sales.put(`/opportunities/${opp}/case`, { customerPath: "new_to_us", requestChannel: "whatsapp" }), 204);
    let kase = await caseOf(team.sales, opp);
    expect(kase.checklist.filter((i: { done: boolean }) => !i.done).map((i: { key: string }) => i.key)).toEqual([
      "customer",
      "contact_name",
      "contact_reach",
      "billing_address",
      "supply_point",
      "meter_ids",
      "current_supplier",
      "contract_end",
      "bill",
    ]);
    expectStatus(await team.sales.post(`/opportunities/${opp}/customer/create`), 201);
    const customer = (await t.prisma.opportunity.findUniqueOrThrow({ where: { id: opp } })).customerId!;
    expectStatus(await team.sales.patch(`/customers/${customer}`, { email: "hello@nobill.ie", addresses: [{ kind: "billing", line1: "3 Quay St" }] }), 204);
    expectStatus(await team.sales.post(`/customers/${customer}/contacts`, { firstName: "Aoife", lastName: "Kelly", isPrimary: true }), 201);
    const site = expectStatus(await team.sales.post(`/opportunities/${opp}/sites`, { serviceType: "gas", address: { line1: "3 Quay St" } }), 201).body.id;
    expectStatus(await team.sales.post(`/sites/${site}/meters`, { fuel: "gas", gprn: "1234567" }), 201);
    expectStatus(await team.sales.post(`/opportunities/${opp}/contracts`, { fuel: "gas", siteId: site, existingSupplierName: "Flogas", currentContractEndDate: addDays(today(), 80) }), 201);
    kase = await caseOf(team.sales, opp);
    // Only the bill is outstanding, and it's optional once the checklist is complete.
    expect(kase.checklist.filter((i: { done: boolean }) => !i.done).map((i: { key: string }) => i.key)).toEqual(["bill"]);
    expect((await gate(opp, "documents_prepared")).filter((i) => !/terms|supplier\.|proposal/i.test(i))).toEqual([]);
  });

  it("flags a duplicate open renewal for the same supply point", async () => {
    const other = await createOpportunity(team.sales, "electricity", { saleType: "renewal" });
    const site = expectStatus(await team.sales.post(`/opportunities/${other}/sites`, { serviceType: "electricity", address: { line1: "1 Main Street" } }), 201).body.id;
    expectStatus(await team.sales.post(`/sites/${site}/meters`, { fuel: "electricity", mprn: "10012345678" }), 201);
    // The auto-created renewal has no site of its own: its contracts point at the previous deal's site.
    const prev = await readyEnergy(t, team);
    await sendAndAccept(team, prev.oppId);
    expectStatus(await team.ops.post(`/opportunities/${prev.oppId}/activate`, { activationDate: addDays(today(), -700) }), 204);
    await t.prisma.energyContract.updateMany({ where: { opportunityId: prev.oppId }, data: { contractEndDate: new Date(`${addDays(today(), 110)}T00:00:00Z`) } });
    const created = (await t.app.get(RenewalsService).run()).created;
    const auto = created.find(Boolean)!;
    const res = expectStatus(await team.sales.get(`/opportunities/${auto}/switch-conflicts`), 200).body;
    expect(res.conflicts.map((c: { id: string }) => c.id)).toContain(other);
  });
});

describe("reminders, escalation and the case dashboard", () => {
  it("upcoming deadlines and sent cases without acceptance reach task queues with configurable reminders and escalation", async () => {
    expectStatus(await team.sales.put("/admin/settings/workflow", { submissionFollowUpDays: 3, renewalReminderDays: [100], escalateAfterDays: 1 }), 403);
    expectStatus(await admin.client.put("/admin/settings/workflow", { submissionFollowUpDays: 3, renewalReminderDays: [100], escalateAfterDays: 1 }), 204);
    expect(expectStatus(await admin.client.get("/admin/settings/workflow"), 200).body.renewalReminderDays).toEqual([100]);

    // A renewal 95 days from the end of the contract gets a deadline task.
    const renewal = await createOpportunity(team.sales, "electricity", { saleType: "renewal" });
    await t.prisma.opportunity.update({ where: { id: renewal }, data: { renewalDate: new Date(`${addDays(today(), 95)}T00:00:00Z`) } });
    const automations = t.app.get(AutomationsService);
    await automations.runAll();
    await automations.runAll();
    const deadline = await t.prisma.activity.findMany({ where: { opportunityId: renewal, automationKey: "renewal_deadline", status: "open" } });
    expect(deadline).toHaveLength(1);
    expect(deadline[0].summary).toMatch(/contract ends .* \(95 days\)/);

    // Overdue past the escalation point: a manager is asked to step in, once.
    await t.prisma.activity.update({ where: { id: deadline[0].id }, data: { dueDate: new Date(`${addDays(today(), -3)}T00:00:00Z`) } });
    await automations.escalateOverdue(today());
    await automations.escalateOverdue(today());
    const escalated = await t.prisma.activity.findMany({ where: { opportunityId: renewal, automationKey: "escalation:renewal_deadline", status: "open" }, include: { owner: { include: { roles: true } } } });
    expect(escalated).toHaveLength(1);
    expect(escalated[0].owner?.roles.map((r) => r.role)).toContain("manager");
  });

  it("a sent case without acceptance gets a follow-up at the configured interval and shows on the dashboard", async () => {
    const { oppId } = await readyEnergy(t, team);
    await sendSome(oppId);
    const follow = await t.prisma.activity.findFirstOrThrow({ where: { opportunityId: oppId, automationKey: "submission_follow_up", status: "open" } });
    expect(follow.dueDate.toISOString().slice(0, 10)).toBe(addDays(today(), 3));
    const all = expectStatus(await team.ops.get("/cases"), 200).body;
    expect(all.rows.find((r: { id: string }) => r.id === oppId)).toMatchObject({ bucket: "sent_awaiting", status: "Sent", kind: "new_supply" });
    expect(all.counts.sent_awaiting).toBeGreaterThanOrEqual(1);
    const renewals = expectStatus(await team.ops.get("/cases?kind=renewal"), 200).body;
    expect(renewals.rows.every((r: { kind: string }) => r.kind === "renewal")).toBe(true);
    // Salespeople see only their own cases.
    const stranger = await userAndClient(t, ["salesperson"], "Sid Stranger");
    expect(expectStatus(await stranger.client.get("/cases"), 200).body.rows).toEqual([]);
  });
});

describe("black and white copies", () => {
  it("are made from the signed PDF, checked, and required in the submission when the supplier asks", async () => {
    const mono = await supplier(t, "Pinergy");
    expectStatus(await admin.client.patch(`/admin/suppliers/${mono.id}`, { name: "Pinergy", kind: "energy", monoCopyRequired: true }), 200);
    const { oppId } = await readyEnergy(t, team);
    expectStatus(await team.sales.patch(`/opportunities/${oppId}`, { selectedSupplierId: mono.id }), 204);
    const tpl = await template("Pinergy application", ["customer.legalName", "site.mprn"], { supplierId: mono.id });
    const formId = await signedForm(oppId, tpl);
    await completeDocuments(team, oppId);
    const files = ((await caseOf(team.ops, oppId)).files as { versionId: string }[]).map((f) => f.versionId);
    const send = { recipient: "apps@pinergy.test", channel: "email", documentVersionIds: files, deliveryEvidence: "Sent 09:10" };
    expect(expectStatus(await team.ops.post(`/opportunities/${oppId}/submissions`, send), 422).body.issues).toContain('This supplier needs black and white copies: create one for "Pinergy application".');

    const { versionId } = expectStatus(await team.sales.post(`/forms/${formId}/mono`), 201).body;
    const form = await t.prisma.generatedForm.findUniqueOrThrow({ where: { id: formId } });
    expect(form.monoVersionId).toBe(versionId);
    // The reviewed form keeps its approval; the copy has all the signed page's content and a greyscale overlay.
    expect((await t.prisma.documentItem.findUniqueOrThrow({ where: { id: form.documentItemId } })).approval).toBe("approved");
    const signed = await storedPdf(form.signedVersionId!);
    const copy = await storedPdf(versionId);
    expect(pageContent(copy)).toContain(pageContent(signed));
    expect(pageContent(copy)).toContain(hex("Test Trading Ltd"));
    const gs = copy.getPages()[0].node.Resources()!.lookup(PDFName.of("ExtGState"), PDFDict);
    expect(gs.entries().some(([, v]) => (copy.context.lookup(v) as PDFDict).get(PDFName.of("BM"))?.toString() === "/Saturation")).toBe(true);

    expect(expectStatus(await team.ops.post(`/opportunities/${oppId}/submissions`, send), 422).body.issues).toContain('Include the black and white copy of "Pinergy application".');
    expectStatus(await team.ops.post(`/opportunities/${oppId}/submissions`, { ...send, documentVersionIds: [...files, versionId] }), 201);
  });
});

/** Records a submission of every current file; returns its id. */
async function sendSome(oppId: string) {
  const files = ((await caseOf(team.ops, oppId)).files as { versionId: string }[]).map((f) => f.versionId);
  return expectStatus(
    await team.ops.post(`/opportunities/${oppId}/submissions`, { recipient: "renewals@supplier.test", channel: "supplier_portal", documentVersionIds: files, deliveryEvidence: "Portal receipt 4471" }),
    201,
  ).body.id as string;
}

describe("sales to back office handover", () => {
  it("hands the deal to the back office at Supplier selected, and it appears in their work queue", async () => {
    const s = await supplier(t);
    const early = await createOpportunity(team.sales, "electricity", { name: "Still selling" });
    const opp = await createOpportunity(team.sales, "electricity", { name: "Agreed deal" });
    expectStatus(await team.sales.post(`/opportunities/${opp}/sites`, { serviceType: "electricity", address: { line1: "5 Market Sq" } }), 201);
    expectStatus(await team.sales.patch(`/opportunities/${opp}`, { selectedSupplierId: s.id }), 204);
    expectStatus(await team.sales.post(`/opportunities/${opp}/stage`, { stage: "supplier_selected" }), 204);

    const task = await t.prisma.activity.findFirstOrThrow({ where: { opportunityId: opp, automationKey: "back_office_handover", status: "open" } });
    expect(task).toMatchObject({ ownerId: opsUser.user.id, priority: "high", type: "submit_application" });
    const timeline = (expectStatus(await team.sales.get(`/opportunities/${opp}/timeline`), 200).body as { body: string }[]).map((e) => e.body);
    expect(timeline).toContain("Handed over to the back office (Orla Ops).");

    // Going back to the client and agreeing again doesn't create a second handover task.
    expectStatus(await team.sales.post(`/opportunities/${opp}/stage`, { stage: "client_reviewing" }), 204);
    expectStatus(await team.sales.post(`/opportunities/${opp}/stage`, { stage: "supplier_selected" }), 204);
    expect(await t.prisma.activity.count({ where: { opportunityId: opp, automationKey: "back_office_handover" } })).toBe(1);

    const queue = expectStatus(await team.ops.get("/cases?scope=back_office"), 200).body.rows.map((r: { id: string }) => r.id);
    expect(queue).toContain(opp);
    expect(queue).not.toContain(early);
    expect(expectStatus(await team.ops.get("/cases"), 200).body.rows.map((r: { id: string }) => r.id)).toContain(early);
  });
});
