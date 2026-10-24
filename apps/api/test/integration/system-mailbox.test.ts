import { MockMailProvider } from "../support/mock-mail";

jest.setTimeout(60_000);

const gm = new MockMailProvider("google");
const MAILBOX = "aamir@utilityoptimizer.com";
const FROM = "Utility Optimizer <sales@utilityoptimizer.com>";

/* eslint-disable @typescript-eslint/no-require-imports */
type AppSupport = typeof import("../support/app");
let support: AppSupport;
let t: Awaited<ReturnType<AppSupport["createTestApp"]>>;
let email: import("../../src/integrations/adapters").EmailSender;
let integrations: import("../../src/integrations/integrations.service").IntegrationsService;

beforeAll(async () => {
  await gm.start();
  Object.assign(process.env, {
    SSO_GOOGLE_CLIENT_ID: gm.clientId,
    SSO_GOOGLE_CLIENT_SECRET: gm.clientSecret,
    SSO_GOOGLE_ISSUER: gm.issuer,
    MAIL_GMAIL_URL: gm.apiBase,
    SMTP_URL: "",
    SYSTEM_MAILBOX: MAILBOX,
    SYSTEM_MAIL_FROM: FROM,
  });
  support = require("../support/app") as AppSupport;
  t = await support.createTestApp();
  const { EMAIL_SENDER } = require("../../src/integrations/adapters") as typeof import("../../src/integrations/adapters");
  const { IntegrationsService } = require("../../src/integrations/integrations.service") as typeof import("../../src/integrations/integrations.service");
  email = t.app.get(EMAIL_SENDER);
  integrations = t.app.get(IntegrationsService);
}, 120_000);
afterAll(async () => {
  await t?.close();
  await gm.stop();
  delete process.env.SYSTEM_MAILBOX;
  delete process.env.SYSTEM_MAIL_FROM;
});

const msg = { to: "client@example.ie", subject: "Please sign: Bord Gais Electricity", text: "Your signing link: https://crm.example/sign/abc", replyTo: "sales@utilityoptimizer.com" };

describe("system email through a connected mailbox (SYSTEM_MAILBOX)", () => {
  it("counts as set up, but refuses to send until that mailbox is connected and there's no SMTP", async () => {
    expect(integrations.emailConfigured).toBe(true);
    await expect(email.send(msg)).rejects.toThrow(/connect the aamir@utilityoptimizer.com mailbox in the CRM, or set SMTP_URL/);
  });

  it("sends signing links from the shared address through whoever connected the mailbox", async () => {
    // A person can only connect their own address.
    const p = await support.userAndClient(t, ["manager"]);
    await t.prisma.user.update({ where: { id: p.user.id }, data: { email: MAILBOX } });
    p.user.email = MAILBOX;
    const start = await p.client.agent.get("/api/mailboxes/google/connect");
    const { code, state } = gm.issueCode(start.headers.location as string, MAILBOX);
    expect((await p.client.agent.get(`/api/mailboxes/google/callback?code=${code}&state=${state}`)).headers.location).toBe("/account?mailbox=connected");

    const sent = await email.send(msg);
    expect(sent.messageId).toBeTruthy();
    const out = gm.mail.find((m) => m.subject === msg.subject)!;
    expect(out).toMatchObject({ folder: "sent", to: ["client@example.ie"], fromHeader: FROM, replyTo: "sales@utilityoptimizer.com", body: msg.text });
  });

  it("falls back to failing clearly when the mailbox needs reconnecting", async () => {
    await t.prisma.mailbox.updateMany({ where: { address: MAILBOX }, data: { status: "reauth_required" } });
    await expect(email.send({ ...msg, subject: "Second" })).rejects.toThrow(/connect the aamir@utilityoptimizer.com mailbox/);
  });
});
