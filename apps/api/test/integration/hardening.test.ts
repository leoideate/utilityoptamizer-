import { Logger } from "@nestjs/common";
import request from "supertest";
import { ORIGIN, PASSWORD, type TestApp, createTestApp, expectStatus, login, userAndClient } from "../support/app";
import { createOpportunity } from "../support/fixtures";

/* eslint-disable @typescript-eslint/no-require-imports */
const { totpAt } = require("../../src/auth/totp") as typeof import("../../src/auth/totp");
const { apiDocsEnabled } = require("../../src/bootstrap") as typeof import("../../src/bootstrap");
const { uploadLimitBytes } = require("../../src/documents/documents.controller") as typeof import("../../src/documents/documents.controller");
/* eslint-enable @typescript-eslint/no-require-imports */

/** Regression tests for the fixes from the security review (see docs/security-assessment.md). */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe("password changes (F1)", () => {
  it("needs the current password, and ends the user's other sessions", async () => {
    const { user, client } = await userAndClient(t, ["salesperson"]);
    const other = await login(t, user.email);
    expectStatus(await client.post("/auth/password", { currentPassword: "not-my-password", newPassword: "Brand-New-Password-1" }), 403);
    expectStatus(await client.post("/auth/password", { currentPassword: PASSWORD, newPassword: "short" }), 400);
    expectStatus(await client.post("/auth/password", { currentPassword: PASSWORD, newPassword: PASSWORD }), 422);
    expectStatus(await client.post("/auth/password", { currentPassword: PASSWORD, newPassword: "Brand-New-Password-1" }), 204);
    expectStatus(await client.get("/auth/me"), 200); // this session continues
    expectStatus(await other.get("/opportunities"), 401); // the other one is ended
    const anon = request(t.app.getHttpServer());
    expectStatus(await anon.post("/api/auth/login").set("Origin", ORIGIN).send({ email: user.email, password: PASSWORD }), 403);
    expectStatus(await anon.post("/api/auth/login").set("Origin", ORIGIN).send({ email: user.email, password: "Brand-New-Password-1" }), 200);
    expect(await t.prisma.auditLog.count({ where: { action: "auth.password_change_failed", entityId: user.id } })).toBe(1);
  });

  it("the admin reset endpoint is for administrators only, even on your own account", async () => {
    const { user, client } = await userAndClient(t, ["salesperson"]);
    expectStatus(await client.post(`/admin/users/${user.id}/password`, { password: "Hijacked-Password-1" }), 403);
    const admin = await userAndClient(t, ["administrator"]);
    expectStatus(await admin.client.post(`/admin/users/${user.id}/password`, { password: "Reset-By-Admin-Pass-1" }), 204);
  });
});

describe("two-factor codes (F8)", () => {
  it("each authenticator code works once", async () => {
    const { user, client } = await userAndClient(t, ["salesperson"]);
    const { secret } = expectStatus(await client.post("/auth/mfa/setup"), 201).body as { secret: string };
    expectStatus(await client.post("/auth/mfa/confirm", { code: totpAt(secret, Date.now()) }), 204);

    const anon = request(t.app.getHttpServer());
    const code = totpAt(secret, Date.now());
    const first = await anon.post("/api/auth/login").set("Origin", ORIGIN).send({ email: user.email, password: PASSWORD, totp: code });
    expect(first.status).toBe(200);
    // An attacker who saw the code (shoulder-surfing, phishing proxy) can't use it again.
    const replay = await anon.post("/api/auth/login").set("Origin", ORIGIN).send({ email: user.email, password: PASSWORD, totp: code });
    expect(replay.status).toBe(403);
    expect(await t.prisma.auditLog.count({ where: { action: "auth.mfa_failed", entityId: user.id, summary: "Authenticator code reused" } })).toBe(1);
  });
});

describe("idle sessions (F6)", () => {
  it("ends a session that has been idle longer than SESSION_IDLE_MINUTES", async () => {
    const { user, client } = await userAndClient(t, ["salesperson"]);
    expectStatus(await client.get("/opportunities"), 200);
    const idle = Number(process.env.SESSION_IDLE_MINUTES) || 60;
    await t.prisma.session.updateMany({ where: { userId: user.id }, data: { lastSeenAt: new Date(Date.now() - (idle + 1) * 60_000) } });
    expectStatus(await client.get("/opportunities"), 401);
    expect(await t.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("activity keeps a session alive", async () => {
    const { user, client } = await userAndClient(t, ["salesperson"]);
    const idle = Number(process.env.SESSION_IDLE_MINUTES) || 60;
    await t.prisma.session.updateMany({ where: { userId: user.id }, data: { lastSeenAt: new Date(Date.now() - (idle - 1) * 60_000) } });
    expectStatus(await client.get("/opportunities"), 200);
    await new Promise((r) => setTimeout(r, 100));
    const s = await t.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(Date.now() - s.lastSeenAt.getTime()).toBeLessThan(60_000);
  });
});

describe("upload limits (F3)", () => {
  it("rejects files over MAX_UPLOAD_MB with 413 before they are processed", async () => {
    const { client } = await userAndClient(t, ["salesperson"]);
    const opp = await createOpportunity(client, "electricity");
    const item = expectStatus(await client.post(`/opportunities/${opp}/documents`, { documentType: "energy_bill" }), 201).body;
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(uploadLimitBytes() + 1024, 0x20)]);
    const res = await client.upload(`/documents/${item.id}/versions`, big, "huge.pdf", "application/pdf");
    expect(res.status).toBe(413);
    expect(await t.prisma.documentVersion.count({ where: { itemId: item.id } })).toBe(0);
  });

  it("rejects request bodies over the JSON limit with 413, not a server error", async () => {
    const { client } = await userAndClient(t, ["salesperson"]);
    const res = await client.post("/opportunities", { name: "x".repeat(200_000), serviceType: "gas" });
    expect(res.status).toBe(413);
    expect(res.body.message).toBe("That request is too large.");
  });
});

describe("API documentation (F7)", () => {
  it("is off in production unless explicitly enabled", () => {
    expect(apiDocsEnabled({ NODE_ENV: "production", ENABLE_API_DOCS: undefined })).toBe(false);
    expect(apiDocsEnabled({ NODE_ENV: "production", ENABLE_API_DOCS: "true" })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: "development", ENABLE_API_DOCS: undefined })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: "development", ENABLE_API_DOCS: "false" })).toBe(false);
  });
});

describe("customer least privilege (F2)", () => {
  it("salespeople see only their customers; managers see all", async () => {
    const alice = await userAndClient(t, ["salesperson"]);
    const bob = await userAndClient(t, ["salesperson"]);
    const manager = await userAndClient(t, ["manager"]);
    const mine = expectStatus(await alice.client.post("/customers?confirmNew=true", { legalName: "Alice Only Ltd" }), 201).body.id;
    expectStatus(await alice.client.get(`/customers/${mine}`), 200);
    expectStatus(await bob.client.get(`/customers/${mine}`), 404);
    expectStatus(await bob.client.get(`/customers/${mine}/timeline`), 404);
    expectStatus(await bob.client.patch(`/customers/${mine}`, { legalName: "Bob Was Here" }), 404);
    expectStatus(await bob.client.post(`/customers/${mine}/contacts`, { firstName: "Bob" }), 404);
    const list = expectStatus(await bob.client.get("/customers?q=Alice"), 200).body;
    expect(list.total).toBe(0);
    expect(expectStatus(await manager.client.get("/customers?q=Alice"), 200).body.total).toBe(1);
  });

  it("an unowned deal's customer is visible to every salesperson (shared pool)", async () => {
    const manager = await userAndClient(t, ["manager"]);
    const bob = await userAndClient(t, ["salesperson"]);
    const opp = await createOpportunity(manager.client, "gas", { companyName: "Pool Customer Ltd" });
    const cust = expectStatus(await manager.client.post(`/opportunities/${opp}/customer/create`), 201).body.customerId;
    expectStatus(await bob.client.get(`/customers/${cust}`), 200);
  });
});

describe("access denials are logged (F9)", () => {
  it("logs a warning with user, route and IP for 401/403", async () => {
    const { user, client } = await userAndClient(t, ["salesperson"]);
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const res = expectStatus(await client.get("/admin/audit-log?x=1"), 403);
      expect(res.body).toEqual({ statusCode: 403, message: expect.any(String) });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ status: 403, method: "GET", path: "/api/admin/audit-log", userId: user.id, ip: expect.any(String) }), "Access denied");
    } finally {
      warn.mockRestore();
    }
  });
});
