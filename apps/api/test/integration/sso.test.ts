import request from "supertest";
import { MockOidcProvider } from "../support/mock-oidc";

jest.setTimeout(60_000);

// Providers must be configured before the app (and its validated config) is created.
const google = new MockOidcProvider("/google", "google-client");
const microsoft = new MockOidcProvider("/ms", "ms-client");

/* eslint-disable @typescript-eslint/no-require-imports */
type AppSupport = typeof import("../support/app");
let support: AppSupport;
let t: Awaited<ReturnType<AppSupport["createTestApp"]>>;

beforeAll(async () => {
  await google.start();
  await microsoft.start();
  Object.assign(process.env, {
    SSO_GOOGLE_CLIENT_ID: google.clientId,
    SSO_GOOGLE_CLIENT_SECRET: google.clientSecret,
    SSO_GOOGLE_ISSUER: google.issuer,
    SSO_MICROSOFT_CLIENT_ID: microsoft.clientId,
    SSO_MICROSOFT_CLIENT_SECRET: microsoft.clientSecret,
    SSO_MICROSOFT_ISSUER: microsoft.issuer,
    SSO_ALLOWED_DOMAINS: "test.local, utilityoptimizer.ie",
  });
  support = require("../support/app") as AppSupport;
  t = await support.createTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
  await google.stop();
  await microsoft.stop();
});

/** Runs the browser side of the flow: start → provider → callback. Returns the agent and final redirect. */
async function signIn(provider: MockOidcProvider, id: "google" | "microsoft", claims: Record<string, unknown>, opts: { tamper?: "signature"; badState?: boolean; next?: string } = {}) {
  const agent = request.agent(t.app.getHttpServer());
  const start = await agent.get(`/api/auth/sso/${id}/start?next=${encodeURIComponent(opts.next ?? "/pipeline")}`);
  expect(start.status).toBe(302);
  const authorizeUrl = start.headers.location as string;
  const { code, state } = provider.issueCode(authorizeUrl, claims, opts.tamper);
  const cb = await agent.get(`/api/auth/sso/${id}/callback?code=${code}&state=${opts.badState ? "forged" : state}`);
  expect(cb.status).toBe(302);
  return { agent, location: cb.headers.location as string, authorizeUrl };
}

describe("single sign-on", () => {
  it("lists configured providers for the login page", async () => {
    const res = await request(t.app.getHttpServer()).get("/api/auth/providers");
    expect(res.body).toEqual([
      { id: "microsoft", label: "Microsoft" },
      { id: "google", label: "Google" },
    ]);
  });

  it("sends the browser to the provider with state, nonce and a PKCE S256 challenge", async () => {
    const res = await request(t.app.getHttpServer()).get("/api/auth/sso/google/start");
    const u = new URL(res.headers.location);
    expect(`${u.origin}${u.pathname}`).toBe(`${google.issuer}/authorize`);
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/sso/google/callback");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(u.searchParams.get("nonce")).toBeTruthy();
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/uo_sso=.*HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/auth\/sso/);
  });

  it("signs in an existing user with a verified Google email and returns to the requested page", async () => {
    const u = await support.createUser(t, ["salesperson"], "Gráinne Google");
    const { agent, location } = await signIn(google, "google", { email: u.email.toUpperCase(), email_verified: true });
    expect(location).toBe("/pipeline");
    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: u.id, roles: ["salesperson"] });
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "auth.login", entityId: u.id } });
    expect(audit.data).toEqual({ method: "sso", provider: "Google" });
    // The PKCE verifier and client secret were sent to the token endpoint.
    const last = google.tokenRequests.at(-1)!;
    expect(last.get("code_verifier")).toBeTruthy();
    expect(last.get("grant_type")).toBe("authorization_code");
  });

  it("signs in with Microsoft using preferred_username when there's no email claim", async () => {
    const u = await support.createUser(t, ["manager"]);
    const { agent, location } = await signIn(microsoft, "microsoft", { preferred_username: u.email, tid: "tenant" });
    expect(location).toBe("/pipeline");
    expect((await agent.get("/api/auth/me")).body.user.id).toBe(u.id);
  });

  it("never creates accounts: unknown and inactive users are refused", async () => {
    expect((await signIn(google, "google", { email: "stranger@test.local", email_verified: true })).location).toBe("/login?error=sso_no_account");
    const u = await support.createUser(t, ["salesperson"]);
    await t.prisma.user.update({ where: { id: u.id }, data: { active: false } });
    expect((await signIn(google, "google", { email: u.email, email_verified: true })).location).toBe("/login?error=sso_no_account");
    expect(await t.prisma.user.count({ where: { email: "stranger@test.local" } })).toBe(0);
    expect(await t.prisma.auditLog.count({ where: { action: "auth.sso_failed" } })).toBeGreaterThanOrEqual(2);
  });

  it("requires a verified Google email and an allowed domain", async () => {
    const u = await support.createUser(t, ["salesperson"]);
    expect((await signIn(google, "google", { email: u.email, email_verified: false })).location).toBe("/login?error=sso_unverified");
    await t.prisma.user.create({ data: { name: "Outside", email: "someone@gmail.com", passwordHash: "x" } });
    expect((await signIn(google, "google", { email: "someone@gmail.com", email_verified: true })).location).toBe("/login?error=sso_domain");
  });

  it("rejects forged state, bad signatures, wrong audience and wrong nonce", async () => {
    const u = await support.createUser(t, ["salesperson"]);
    const ok = { email: u.email, email_verified: true };
    expect((await signIn(google, "google", ok, { badState: true })).location).toBe("/login?error=sso_expired");
    expect((await signIn(google, "google", ok, { tamper: "signature" })).location).toBe("/login?error=sso_failed");
    expect((await signIn(google, "google", { ...ok, aud: "someone-else" })).location).toBe("/login?error=sso_failed");
    expect((await signIn(google, "google", { ...ok, nonce: "replayed" })).location).toBe("/login?error=sso_failed");
    expect((await signIn(google, "google", { ...ok, iss: "https://evil.example" })).location).toBe("/login?error=sso_failed");
    expect((await signIn(google, "google", { ...ok, exp: Math.floor(Date.now() / 1000) - 3600 })).location).toBe("/login?error=sso_failed");
    // A callback without the flow cookie (e.g. a link replayed in another browser) is refused.
    const fresh = request(t.app.getHttpServer());
    const cb = await fresh.get("/api/auth/sso/google/callback?code=x&state=y");
    expect(cb.headers.location).toBe("/login?error=sso_expired");
  });

  it("returns the user to the login page if they cancel at the provider", async () => {
    const res = await request(t.app.getHttpServer()).get("/api/auth/sso/google/callback?error=access_denied");
    expect(res.headers.location).toBe("/login?error=sso_cancelled");
  });

  it("only allows same-site relative return paths", async () => {
    const u = await support.createUser(t, ["salesperson"]);
    for (const next of ["https://evil.example/x", "//evil.example", "/\\evil.example"]) {
      expect((await signIn(google, "google", { email: u.email, email_verified: true }, { next })).location).toBe("/");
    }
  });

  it("still asks users with two-factor for their code, unless Microsoft confirms MFA", async () => {
    const { generateSecret, totpAt } = require("../../src/auth/totp") as typeof import("../../src/auth/totp");
    const { CryptoService } = require("../../src/common/crypto.service") as typeof import("../../src/common/crypto.service");
    const secret = generateSecret();
    const u = await support.createUser(t, ["salesperson"]);
    await t.prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: true, mfaSecretEnc: t.app.get(CryptoService).encrypt(secret) } });

    const { agent, location } = await signIn(google, "google", { email: u.email, email_verified: true }, { next: "/activities" });
    expect(location).toBe("/login?mfa=sso&next=%2Factivities");
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    const wrong = await agent.post("/api/auth/sso/mfa").set("Origin", support.ORIGIN).send({ code: "000000" });
    expect(wrong.status).toBe(403);
    const right = await agent.post("/api/auth/sso/mfa").set("Origin", support.ORIGIN).send({ code: totpAt(secret, Date.now()) });
    expect(right.status).toBe(200);
    expect(right.body).toMatchObject({ next: "/activities", user: { id: u.id } });
    expect((await agent.get("/api/auth/me")).status).toBe(200);
    // The pending step can't be reused without the cookie.
    const anon = await request(t.app.getHttpServer()).post("/api/auth/sso/mfa").set("Origin", support.ORIGIN).send({ code: totpAt(secret, Date.now()) });
    expect(anon.status).toBe(403);

    const ms = await signIn(microsoft, "microsoft", { email: u.email, amr: ["pwd", "mfa"] });
    expect(ms.location).toBe("/pipeline");
  });
});
