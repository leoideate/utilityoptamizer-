import request from "supertest";
import { type TestApp, createTestApp, expectStatus, userAndClient } from "../support/app";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe("the CRM guide", () => {
  it("is only for signed-in users", async () => {
    expectStatus(await request(t.app.getHttpServer()).get("/api/help/guide"), 401);
  });

  it("is a self-contained page the web app may frame, and nothing else", async () => {
    const { client } = await userAndClient(t, ["salesperson"]);
    const res = expectStatus(await client.get("/help/guide"), 200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toMatch(/https?:/);
    expect(res.text).toContain("<title>Utility Optimizer CRM Guide</title>");
  });
});
