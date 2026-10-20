import request from "supertest";
import { PDFDocument } from "pdf-lib";
import { OBJECT_STORAGE, type ObjectStorage } from "../../src/storage/storage";
import { ORIGIN, type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";
import { type Team, readyEnergy } from "../support/fixtures";
import { png, supplierPdf } from "../support/forms";

// Signing links are emailed; the recording job queue captures the email instead of sending it.
process.env.SMTP_URL = "smtp://127.0.0.1:1025";

let t: TestApp;
let team: Team;
let otherSales: Awaited<ReturnType<typeof userAndClient>>;

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
  otherSales = await userAndClient(t, ["salesperson"], "Sean Sales");
});
afterAll(() => t.close());

const anon = () => request(t.app.getHttpServer());
const signaturePng = () => `data:image/png;base64,${png(120, 40).toString("base64")}`;
const tokenOf = (url: string) => url.split("/sign/")[1];
const sign = (token: string, body: object = { typedName: "Mary Murphy", consent: true, signaturePng: signaturePng() }) =>
  anon().post(`/api/public/sign/${token}`).set("Origin", ORIGIN).set("User-Agent", "Jest signing browser").send(body);

/** A form with a client and a broker signature box. */
async function formWithTwoSigners() {
  const { oppId } = await readyEnergy(t, team);
  const tpl = expectStatus(
    await team.manager.agent
      .post("/api/form-templates")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", team.manager.csrf)
      .field("name", "Application")
      .field("documentType", "application_form")
      .field("supplierId", "")
      .attach("file", await supplierPdf(), { filename: "form.pdf", contentType: "application/pdf" }),
    201,
  ).body as { id: string };
  const full = expectStatus(await team.manager.get(`/form-templates/${tpl.id}`), 200).body;
  const fields = [...full.fields, { id: "bsig", label: "Broker signature", kind: "signature", signer: "broker", page: 0, x: 300, y: 200, w: 150, h: 40 }];
  expectStatus(await team.manager.patch(`/form-templates/${tpl.id}`, { fields }), 204);
  const form = expectStatus(await team.sales.post(`/opportunities/${oppId}/forms`, { templateId: tpl.id, values: {} }), 201).body as { id: string; qcPassed: boolean };
  expect(form.qcPassed).toBe(true);
  return { oppId, formId: form.id };
}

describe("online signing links", () => {
  it("emails each signer a link, signs online, builds the checked signed copy and needs a second person to approve", async () => {
    const { oppId, formId } = await formWithTwoSigners();
    const before = t.queue.jobs.length;

    const client = expectStatus(await team.sales.post(`/forms/${formId}/signing-links`, { role: "customer", signerName: "Mary Murphy", email: "Mary@Example.ie" }), 201).body;
    expect(client).toMatchObject({ emailed: true });
    const token = tokenOf(client.url);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The email job carries the link; the token is stored only as a hash.
    const job = await t.prisma.integrationJob.findFirstOrThrow({ where: { kind: "email.send", opportunityId: oppId }, orderBy: { createdAt: "desc" } });
    expect(job.payload).toMatchObject({ to: "mary@example.ie", subject: "Please sign: Application" });
    expect((job.payload as { text: string }).text).toContain(client.url);
    expect(t.queue.jobs.length).toBe(before + 1);
    const stored = await t.prisma.signingLink.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.tokenHash).not.toContain(token);

    // The signer sees the form and their own box, and can download the unsigned PDF.
    const view = expectStatus(await anon().get(`/api/public/sign/${token}`), 200).body;
    expect(view).toMatchObject({ formName: "Application", signerName: "Mary Murphy", role: "customer" });
    expect(view.boxes).toHaveLength(1);
    const doc = await anon().get(`/api/public/sign/${token}/document`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(doc.status).toBe(200);
    expect((doc.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");

    // Consent is required; another site can't post the signature.
    expectStatus(await sign(token, { typedName: "Mary Murphy", consent: false, signaturePng: signaturePng() }), 400);
    expectStatus(await anon().post(`/api/public/sign/${token}`).set("Origin", "https://evil.example").send({ typedName: "Mary Murphy", consent: true, signaturePng: signaturePng() }), 403);

    expect(expectStatus(await sign(token), 201).body).toEqual({ signed: true, complete: false });
    // Single use.
    expectStatus(await sign(token), 404);
    expectStatus(await anon().get(`/api/public/sign/${token}`), 404);

    // The broker signs through their own link.
    const broker = expectStatus(await team.sales.post(`/forms/${formId}/signing-links`, { role: "broker", signerName: "Sarah Sales", email: "sarah@example.ie" }), 201).body;
    expect(expectStatus(await sign(tokenOf(broker.url), { typedName: "Sarah Sales", consent: true, signaturePng: signaturePng() }), 201).body).toEqual({ signed: true, complete: true });

    const links = expectStatus(await team.sales.get(`/forms/${formId}/signing-links`), 200).body;
    expect(links.map((l: { status: string }) => l.status)).toEqual(["signed", "signed"]);
    expect(JSON.stringify(links)).not.toContain(token);

    // The signed copy passed QC and ends with the signing record page.
    const forms = expectStatus(await team.sales.get(`/opportunities/${oppId}/forms`), 200).body;
    const form = forms.find((f: { id: string }) => f.id === formId);
    expect(form.status).toBe("awaiting_review");
    const version = await t.prisma.documentVersion.findUniqueOrThrow({ where: { id: form.signedVersionId } });
    const signed = await PDFDocument.load(await t.app.get<ObjectStorage>(OBJECT_STORAGE).get(version.storageKey));
    expect(signed.getPageCount()).toBe(2);
    const sig = await t.prisma.formSignature.findFirstOrThrow({ where: { formId, role: "customer" } });
    expect(sig).toMatchObject({ authorisation: "signed_online", signerName: "Mary Murphy", signerEmail: "mary@example.ie", signerUserAgent: "Jest signing browser", uploadedById: null });
    expect(sig.documentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.consentText).toMatch(/agree to sign it electronically/);

    // A second person approves, and the deal can be submitted.
    expectStatus(await team.ops.post(`/forms/${formId}/review`, { decision: "approved" }), 204);
    expectStatus(await team.ops.post(`/opportunities/${oppId}/stage`, { stage: "submitted" }), 204);

    const timeline = (expectStatus(await team.sales.get(`/opportunities/${oppId}/timeline`), 200).body as { body: string }[]).map((e) => e.body);
    expect(timeline).toContain('Signing link for "Application" emailed for Mary Murphy (client).');
    expect(timeline).toContain('Mary Murphy opened the signing link for "Application".');
    expect(timeline).toContain('Client signature for "Application" signed online: Mary Murphy. Signed online through a CRM signing link.');
    expect(JSON.stringify(timeline)).not.toContain(token);
    const audit = await t.prisma.auditLog.findMany({ where: { entityId: formId } });
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("blocks the link creator from reviewing the online signatures", async () => {
    const { formId } = await formWithTwoSigners();
    for (const role of ["customer", "broker"] as const) {
      const link = expectStatus(await team.manager.post(`/forms/${formId}/signing-links`, { role, signerName: "Signer", email: "signer@example.ie" }), 201).body;
      expectStatus(await sign(tokenOf(link.url), { typedName: "Signer", consent: true, signaturePng: signaturePng() }), 201);
    }
    const res = expectStatus(await team.manager.post(`/forms/${formId}/review`, { decision: "approved" }), 422);
    expect(res.body.message).toMatch(/Someone other than the person who sent the signing link/);
  });

  it("rejects unknown, cancelled, replaced, expired and resent links the same way", async () => {
    const { formId } = await formWithTwoSigners();
    expectStatus(await anon().get(`/api/public/sign/${"x".repeat(43)}`), 404);
    expectStatus(await anon().get("/api/public/sign/short"), 404);

    const first = expectStatus(await team.sales.post(`/forms/${formId}/signing-links`, { role: "customer", signerName: "Mary", email: "mary@example.ie" }), 201).body;
    // A new link for the same signer role replaces the open one.
    const second = expectStatus(await team.sales.post(`/forms/${formId}/signing-links`, { role: "customer", signerName: "Mary", email: "mary@example.ie" }), 201).body;
    expectStatus(await anon().get(`/api/public/sign/${tokenOf(first.url)}`), 404);
    expectStatus(await anon().get(`/api/public/sign/${tokenOf(second.url)}`), 200);

    // Resending issues a new URL; the old one stops working.
    const resent = expectStatus(await team.sales.post(`/signing-links/${second.id}/resend`), 201).body;
    expectStatus(await anon().get(`/api/public/sign/${tokenOf(second.url)}`), 404);
    expectStatus(await anon().get(`/api/public/sign/${tokenOf(resent.url)}`), 200);

    await t.prisma.signingLink.update({ where: { id: second.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expectStatus(await sign(tokenOf(resent.url)), 404);
    expect(expectStatus(await team.sales.get(`/forms/${formId}/signing-links`), 200).body.find((l: { id: string }) => l.id === second.id).status).toBe("expired");

    const third = expectStatus(await team.sales.post(`/forms/${formId}/signing-links`, { role: "customer", signerName: "Mary", email: "mary@example.ie" }), 201).body;
    expectStatus(await team.sales.post(`/signing-links/${third.id}/revoke`), 204);
    expectStatus(await sign(tokenOf(third.url)), 404);
    // Links are history: they can't be deleted.
    await expect(t.prisma.signingLink.delete({ where: { id: third.id } })).rejects.toThrow();
  });

  it("only offers boxes the form has, and only on deals the user can work on", async () => {
    const { formId } = await formWithTwoSigners();
    expectStatus(await otherSales.client.post(`/forms/${formId}/signing-links`, { role: "customer", signerName: "Mary", email: "mary@example.ie" }), 404);
    expectStatus(await otherSales.client.get(`/forms/${formId}/signing-links`), 404);
    expectStatus(await team.sales.post(`/forms/${formId}/signing-links`, { role: "customer", signerName: "Mary", email: "not-an-email" }), 400);
  });
});
