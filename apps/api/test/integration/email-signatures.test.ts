import request from "supertest";
import { type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";
import { createOpportunity } from "../support/fixtures";
import { png } from "../support/forms";

// Email is sent through SMTP here; the recording job queue captures it instead of sending.
process.env.SMTP_URL = "smtp://127.0.0.1:1025";

let t: TestApp;
let sales: Awaited<ReturnType<typeof userAndClient>>;
let admin: Awaited<ReturnType<typeof userAndClient>>;

beforeAll(async () => {
  t = await createTestApp();
  sales = await userAndClient(t, ["salesperson"], "Sarah Sales");
  admin = await userAndClient(t, ["administrator"], "Aisling Admin");
});
afterAll(() => t.close());

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
const style = { image: "company", imageWidth: 160, accentColor: "#036b5c", showCompany: true };
const upload = (c: typeof sales.client, url: string, file: Buffer, type = "image/png") => c.upload(url, file, "picture.png", type);

describe("email signatures", () => {
  it("starts everyone from the company template with the letterhead logo and details", async () => {
    const mine = expectStatus(await sales.client.get("/account/email-signature"), 200).body;
    expect(mine.signature).toMatchObject({ enabled: true, fullName: "Sarah Sales", image: "company", showCompany: true });
    expect(mine.preview.text).toContain("Greenhills Road");
    expect(mine.preview.html).toContain(mine.logoUrl);
    // The default logo is served publicly for recipients' mail apps.
    const logo = await binary(request(t.app.getHttpServer()).get(new URL(mine.logoUrl).pathname));
    expect(logo.status).toBe(200);
    expect(logo.headers["content-type"]).toBe("image/png");
  });

  it("lets each person customise their signature and use their own picture", async () => {
    expectStatus(await sales.client.put("/account/email-signature", { ...style, enabled: true, fullName: "Sarah Sales", image: "own" }), 422);
    expectStatus(await upload(sales.client, "/account/email-signature/image", Buffer.from("GIF89a not allowed"), "image/gif"), 422);

    const withPicture = expectStatus(await upload(sales.client, "/account/email-signature/image", png(80, 80)), 201).body;
    expect(withPicture.signature.image).toBe("own");
    const pic = await binary(request(t.app.getHttpServer()).get(new URL(withPicture.ownImageUrl).pathname));
    expect(pic.status).toBe(200);
    expect(pic.headers["x-content-type-options"]).toBe("nosniff");

    const saved = expectStatus(
      await sales.client.put("/account/email-signature", { ...style, enabled: true, fullName: "Sarah Sales", jobTitle: "Energy Consultant", mobile: "087 765 4321", extra: "Fluent in Irish", image: "own", accentColor: "#1a237e", imageWidth: 90, showCompany: false }),
      200,
    ).body;
    expect(saved.preview.text).toBe("Sarah Sales\nEnergy Consultant\nM 087 765 4321\nFluent in Irish");
    expect(saved.preview.html).toContain(withPicture.ownImageUrl);
    expect(saved.preview.html).toContain("#1a237e");
    expect(expectStatus(await sales.client.put("/account/email-signature", { ...style, enabled: true, fullName: "x", accentColor: "red" }), 400).status).toBe(400);
  });

  it("adds the sender's signature to email sent from a deal, as HTML and text", async () => {
    const oppId = await createOpportunity(sales.client, "electricity");
    expectStatus(await sales.client.put("/account/email-signature", { ...style, enabled: true, fullName: "Sarah Sales", jobTitle: "Energy Consultant" }), 200);
    expectStatus(await sales.client.post(`/opportunities/${oppId}/emails`, { to: "mary@testtrading.ie", subject: "Your quote", body: "Hi Mary,\n\nYour quote is attached.", idempotencyKey: "sig-test-0001" }), 201);
    const job = await t.prisma.integrationJob.findFirstOrThrow({ where: { opportunityId: oppId, kind: "email.send" } });
    const p = job.payload as { text: string; html?: string };
    expect(p.text).toMatch(/Your quote is attached\.\n\n-- \nSarah Sales\nEnergy Consultant/);
    expect(p.html).toContain("Hi Mary,<br><br>Your quote is attached.");
    expect(p.html).toContain("Energy Consultant");
    // The deal's timeline shows the message, not the signature.
    const timeline = (expectStatus(await sales.client.get(`/opportunities/${oppId}/timeline`), 200).body as { body: string }[]).map((e) => e.body);
    expect(timeline.find((b) => b.includes("Your quote"))).not.toContain("Energy Consultant");

    // Turned off: plain text only.
    expectStatus(await sales.client.put("/account/email-signature", { ...style, enabled: false, fullName: "Sarah Sales" }), 200);
    expectStatus(await sales.client.post(`/opportunities/${oppId}/emails`, { to: "mary@testtrading.ie", subject: "Again", body: "Hello", idempotencyKey: "sig-test-0002" }), 201);
    const plain = await t.prisma.integrationJob.findFirstOrThrow({ where: { opportunityId: oppId, kind: "email.send" }, orderBy: { createdAt: "desc" } });
    expect(plain.payload).toMatchObject({ text: "Hello" });
    expect((plain.payload as { html?: string }).html).toBeUndefined();
  });

  it("only administrators change the company template and logo", async () => {
    const company = { companyName: "Utility Optimizer Limited", address: "First Floor, Greenhills Road\nDublin 12", phone: "01 555 0000", website: "utilityoptimizer.ie", email: "", disclaimer: "Registered in Ireland." };
    expectStatus(await sales.client.put("/admin/settings/email-signature", company), 403);
    expectStatus(await upload(sales.client, "/admin/settings/email-signature/logo", png()), 403);
    expectStatus(await admin.client.put("/admin/settings/email-signature", company), 204);
    const logo = expectStatus(await upload(admin.client, "/admin/settings/email-signature/logo", png(120, 40)), 201).body;
    expect(logo.logoUrl).not.toContain("default-logo");

    const mine = expectStatus(await admin.client.get("/account/email-signature"), 200).body;
    expect(mine.preview.text).toContain("T 01 555 0000 · utilityoptimizer.ie");
    expect(mine.preview.text).toContain("Registered in Ireland.");
    expect(mine.logoUrl).toBe(logo.logoUrl);
    expect(expectStatus(await admin.client.del("/admin/settings/email-signature/logo"), 200).body.logoUrl).toContain("default-logo");
    expectStatus(await request(t.app.getHttpServer()).get("/api/public/email-images/not-an-id"), 404);
  });
});
