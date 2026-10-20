import { MockMailProvider } from "../support/mock-mail";

jest.setTimeout(60_000);

const ms = new MockMailProvider("microsoft");
const gm = new MockMailProvider("google");

/* eslint-disable @typescript-eslint/no-require-imports */
type AppSupport = typeof import("../support/app");
type Fixtures = typeof import("../support/fixtures");
type Person = Awaited<ReturnType<AppSupport["userAndClient"]>>;
let support: AppSupport;
let fx: Fixtures;
let t: Awaited<ReturnType<AppSupport["createTestApp"]>>;
let mailboxes: import("../../src/mailboxes/mailboxes.service").MailboxesService;
let integrations: import("../../src/integrations/integrations.service").IntegrationsService;
let bus: import("../../src/realtime/realtime").LocalRealtimeBus;

beforeAll(async () => {
  await ms.start();
  await gm.start();
  Object.assign(process.env, {
    SSO_MICROSOFT_CLIENT_ID: ms.clientId,
    SSO_MICROSOFT_CLIENT_SECRET: ms.clientSecret,
    SSO_MICROSOFT_ISSUER: ms.issuer,
    SSO_GOOGLE_CLIENT_ID: gm.clientId,
    SSO_GOOGLE_CLIENT_SECRET: gm.clientSecret,
    SSO_GOOGLE_ISSUER: gm.issuer,
    MAIL_GRAPH_URL: ms.apiBase,
    MAIL_GMAIL_URL: gm.apiBase,
    SMTP_URL: "",
  });
  support = require("../support/app") as AppSupport;
  fx = require("../support/fixtures") as Fixtures;
  t = await support.createTestApp();
  const { MailboxesService } = require("../../src/mailboxes/mailboxes.service") as typeof import("../../src/mailboxes/mailboxes.service");
  const { IntegrationsService } = require("../../src/integrations/integrations.service") as typeof import("../../src/integrations/integrations.service");
  const { REALTIME_BUS } = require("../../src/realtime/realtime") as typeof import("../../src/realtime/realtime");
  mailboxes = t.app.get(MailboxesService);
  integrations = t.app.get(IntegrationsService);
  bus = t.app.get(REALTIME_BUS);
}, 120_000);
afterAll(async () => {
  await t?.close();
  await ms.stop();
  await gm.stop();
});

/** The browser side of connecting: start → provider consent → callback. Returns where it lands. */
async function connect(p: Person, mock: MockMailProvider, address = p.user.email, opts: { badState?: boolean } = {}) {
  const provider = mock.kind;
  const start = await p.client.agent.get(`/api/mailboxes/${provider}/connect`);
  expect(start.status).toBe(302);
  const { code, state } = mock.issueCode(start.headers.location as string, address);
  const cb = await p.client.agent.get(`/api/mailboxes/${provider}/callback?code=${code}&state=${opts.badState ? "forged" : state}`);
  expect(cb.status).toBe(302);
  const mailbox = await t.prisma.mailbox.findFirst({ where: { userId: p.user.id, provider } });
  return { location: cb.headers.location as string, mailbox, authorizeUrl: new URL(start.headers.location as string) };
}

let n = 0;
/** A deal with a customer whose email is unique to this test. */
async function deal(p: Person, email = `buyer${++n}@customer${n}.ie`) {
  const oppId = await fx.createOpportunity(p.client, "electricity", { email, companyName: `Customer ${n} Ltd` });
  const { customerId } = support.expectStatus(await p.client.post(`/opportunities/${oppId}/customer/create`), 201).body as { customerId: string };
  await t.prisma.customer.update({ where: { id: customerId }, data: { email } });
  return { oppId, customerId, email };
}

const emailTimeline = (opportunityId: string) => t.prisma.timelineEntry.findMany({ where: { opportunityId, kind: "email" }, orderBy: { occurredAt: "asc" } });

describe("connecting a mailbox", () => {
  it("connects the person's own Outlook mailbox with PKCE, stores tokens encrypted, and queues a first sync", async () => {
    const p = await support.userAndClient(t, ["salesperson"]);
    const { location, mailbox, authorizeUrl } = await connect(p, ms);
    expect(location).toBe("/account?mailbox=connected");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("scope")).toContain("Mail.Send");
    expect(authorizeUrl.searchParams.get("login_hint")).toBe(p.user.email);
    expect(ms.tokenRequests.at(-1)!.get("code_verifier")).toBeTruthy();

    expect(mailbox).toMatchObject({ address: p.user.email, status: "active" });
    expect(mailbox!.tokensEnc).toMatch(/^v1:/);
    expect(mailbox!.tokensEnc).not.toMatch(/at-|rt-/);
    expect(t.queue.jobs.some((j) => j.queue === "mail" && j.name === "mailbox.sync" && j.data.mailboxId === mailbox!.id)).toBe(true);
    expect(await t.prisma.auditLog.count({ where: { action: "mailbox.connected", entityId: mailbox!.id } })).toBe(1);

    const listed = support.expectStatus(await p.client.get("/mailboxes"), 200).body;
    expect(listed.available).toEqual({ microsoft: true, google: true });
    expect(listed.mailboxes).toEqual([expect.objectContaining({ id: mailbox!.id, provider: "microsoft", address: p.user.email, status: "active" })]);
    expect(JSON.stringify(listed)).not.toMatch(/tokens|at-|rt-/);
  });

  it("refuses someone else's mailbox and forged or expired flows", async () => {
    const p = await support.userAndClient(t, ["salesperson"]);
    expect((await connect(p, ms, "someone.else@test.local")).location).toBe("/account?mailbox=mailbox_wrong_address");
    expect((await connect(p, gm, p.user.email, { badState: true })).location).toBe("/account?mailbox=mailbox_expired");
    expect(await t.prisma.mailbox.count({ where: { userId: p.user.id } })).toBe(0);

    // A callback without the flow cookie (another browser) is refused too.
    const res = await p.client.agent.get(`/api/mailboxes/google/callback?code=x&state=y`).set("Cookie", "");
    expect([302, 401]).toContain(res.status);
  });

  it("disconnects only your own mailbox, and keeps what was synced", async () => {
    const p = await support.userAndClient(t, ["salesperson"]);
    const other = await support.userAndClient(t, ["salesperson"]);
    const { mailbox } = await connect(p, gm);
    gm.deliver({ to: p.user.email, from: "anyone@example.com", subject: "Hello", body: "Hi" });
    await mailboxes.sync(mailbox!.id);

    expect((await other.client.del(`/mailboxes/${mailbox!.id}`)).status).toBe(404);
    support.expectStatus(await p.client.del(`/mailboxes/${mailbox!.id}`), 204);
    const row = await t.prisma.mailbox.findUniqueOrThrow({ where: { id: mailbox!.id } });
    expect(row).toMatchObject({ status: "disconnected", tokensEnc: null });
    expect(await t.prisma.emailMessage.count({ where: { mailboxId: mailbox!.id } })).toBe(1);
    expect(await mailboxes.sync(mailbox!.id)).toEqual({ skipped: true });
  });
});

describe("syncing and linking email", () => {
  it("links a customer's email to their deal, logs it on the timeline once, and tells the owner", async () => {
    const p = await support.userAndClient(t, ["salesperson"]);
    const { mailbox } = await connect(p, ms);
    const d = await deal(p);
    const inbound = ms.deliver({ to: p.user.email, from: d.email, fromName: "Mary Buyer", subject: "Quote please", body: "<p>Can you send the <b>quote</b>?</p>", html: true });
    ms.deliver({ to: p.user.email, from: "newsletter@shop.example", subject: "Sale", body: "50% off" });

    expect(await mailboxes.sync(mailbox!.id)).toEqual({ added: 2 });
    const linked = await t.prisma.emailMessage.findFirstOrThrow({ where: { mailboxId: mailbox!.id, providerMessageId: inbound.id } });
    expect(linked).toMatchObject({ opportunityId: d.oppId, customerId: d.customerId, direction: "inbound", unread: true, subject: "Quote please", snippet: "Can you send the quote?" });
    expect(linked.bodyEnc).toMatch(/^v1:/);
    const private_ = await t.prisma.emailMessage.findFirstOrThrow({ where: { mailboxId: mailbox!.id, subject: "Sale" } });
    expect(private_).toMatchObject({ opportunityId: null, customerId: null });

    const entries = await emailTimeline(d.oppId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ direction: "inbound", body: `From Mary Buyer <${d.email}>: Quote please\n\nCan you send the quote?`, actorId: p.user.id });
    expect(bus.published.some((e) => e.event.type === "email.received" && e.userIds.includes(p.user.id) && e.event.data.id === linked.id)).toBe(true);

    // Running again changes nothing.
    expect(await mailboxes.sync(mailbox!.id)).toEqual({ added: 0 });
    expect(await emailTimeline(d.oppId)).toHaveLength(1);
    expect(support.expectStatus(await p.client.get("/mailbox/unread-count"), 200).body.count).toBe(2);
  });

  it("keeps replies in a linked thread on that deal, prefers the owner's deal, and ignores staff-only mail", async () => {
    const p = await support.userAndClient(t, ["salesperson"]);
    const colleague = await support.userAndClient(t, ["salesperson"]);
    const { mailbox } = await connect(p, ms);
    const d = await deal(p);
    const first = ms.deliver({ to: p.user.email, from: d.email, subject: "Meters", body: "Two meters" });
    ms.deliver({ to: p.user.email, from: "accountant@unknown.example", subject: "RE: Meters", body: "Adding our accountant", threadId: first.threadId });
    ms.deliver({ to: p.user.email, from: colleague.user.email, subject: "Lunch?", body: "12:30" });

    // A second customer with two open deals: one is p's.
    const shared = `finance${++n}@twodeals.ie`;
    const mine = await deal(p, shared);
    const theirsOpp = await fx.createOpportunity(colleague.client, "gas", { email: shared });
    await t.prisma.opportunity.update({ where: { id: theirsOpp }, data: { customerId: mine.customerId } });
    ms.deliver({ to: p.user.email, from: shared, subject: "Which deal?", body: "Both" });

    await mailboxes.sync(mailbox!.id);
    const bySubject = async (subject: string) => t.prisma.emailMessage.findFirstOrThrow({ where: { mailboxId: mailbox!.id, subject } });
    expect(await bySubject("RE: Meters")).toMatchObject({ opportunityId: d.oppId });
    expect(await bySubject("Lunch?")).toMatchObject({ opportunityId: null, customerId: null });
    expect(await bySubject("Which deal?")).toMatchObject({ opportunityId: mine.oppId, customerId: mine.customerId });
  });

  it("shows linked email to people who can see the deal, and nobody else", async () => {
    const p = await support.userAndClient(t, ["salesperson"]);
    const otherSales = await support.userAndClient(t, ["salesperson"]);
    const manager = await support.userAndClient(t, ["manager"]);
    const { mailbox } = await connect(p, ms);
    const d = await deal(p);
    ms.deliver({ to: p.user.email, from: d.email, subject: "Signed", body: "Attached" });
    ms.deliver({ to: p.user.email, from: "friend@example.com", subject: "Personal", body: "Dinner" });
    await mailboxes.sync(mailbox!.id);
    const linked = await t.prisma.emailMessage.findFirstOrThrow({ where: { mailboxId: mailbox!.id, subject: "Signed" } });
    const personal = await t.prisma.emailMessage.findFirstOrThrow({ where: { mailboxId: mailbox!.id, subject: "Personal" } });

    const own = support.expectStatus(await p.client.get(`/emails/${linked.id}`), 200).body;
    expect(own).toMatchObject({ body: "Attached", isOwner: true, canReply: true, opportunityId: d.oppId, opportunityName: expect.any(String), unread: false });
    expect(JSON.stringify(own)).not.toMatch(/bodyEnc|tokens/);
    expect(t.queue.jobs.some((j) => j.name === "mailbox.markRead" && j.data.emailMessageId === linked.id)).toBe(true);
    await mailboxes.markReadAtProvider(linked.id);
    expect(ms.mail.find((m) => m.subject === "Signed")!.isRead).toBe(true);

    expect(support.expectStatus(await manager.client.get(`/emails/${linked.id}`), 200).body).toMatchObject({ body: "Attached", isOwner: false, canReply: false });
    expect((await manager.client.get(`/emails/${personal.id}`)).status).toBe(404);
    // Salespeople see unassigned deals, so give the deal an owner first.
    await t.prisma.opportunity.update({ where: { id: d.oppId }, data: { ownerId: p.user.id } });
    expect((await otherSales.client.get(`/emails/${linked.id}`)).status).toBe(404);
    expect((await otherSales.client.get(`/emails/${personal.id}`)).status).toBe(404);

    const inbox = support.expectStatus(await p.client.get("/mailbox/messages?folder=inbox"), 200).body;
    expect(inbox.items.map((m: { subject: string }) => m.subject).sort()).toEqual(["Personal", "Signed"]);
    expect(support.expectStatus(await otherSales.client.get("/mailbox/messages?folder=inbox"), 200).body.items).toEqual([]);
  });

  it("imports recent Gmail, then only what's new, as plain text", async () => {
    const p = await support.userAndClient(t, ["salesperson"]);
    gm.deliver({ to: p.user.email, from: "early@example.com", subject: "Before connecting", body: "<div>Hi&nbsp;there<br>Line two</div><script>alert(1)</script>", html: true });
    const { mailbox } = await connect(p, gm);
    expect(await mailboxes.sync(mailbox!.id)).toEqual({ added: 1 });
    const first = await t.prisma.emailMessage.findFirstOrThrow({ where: { mailboxId: mailbox!.id } });
    expect(t.app.get((require("../../src/common/crypto.service") as typeof import("../../src/common/crypto.service")).CryptoService).decrypt(first.bodyEnc)).toBe("Hi there\nLine two");

    gm.deliver({ to: p.user.email, from: "later@example.com", subject: "After", body: "New" });
    expect(await mailboxes.sync(mailbox!.id)).toEqual({ added: 1 });
    const state = (await t.prisma.mailbox.findUniqueOrThrow({ where: { id: mailbox!.id } })).syncState as { historyId: string };
    expect(Number(state.historyId)).toBeGreaterThan(0);
  });
});

describe("sending as yourself", () => {
  it("sends a deal email through the person's Outlook, and the copy in Sent isn't logged twice", async () => {
    const p = await support.userAndClient(t, ["salesperson"]);
    const d = await deal(p);
    // No mailbox and no SMTP: the person is told to connect their mailbox.
    const refused = await p.client.post(`/opportunities/${d.oppId}/emails`, { to: d.email, subject: "Quote", body: "Attached", idempotencyKey: `k-${Date.now()}-a` });
    expect(refused.status).toBe(422);
    expect(refused.body.issues[0]).toMatch(/Connect your mailbox/);
    expect(support.expectStatus(await p.client.get("/integrations/status"), 200).body).toMatchObject({ email: false, mailbox: null });

    const { mailbox } = await connect(p, ms);
    expect(support.expectStatus(await p.client.get("/integrations/status"), 200).body).toMatchObject({ email: true, mailbox: { address: p.user.email, provider: "microsoft" } });
    const { jobId } = support.expectStatus(await p.client.post(`/opportunities/${d.oppId}/emails`, { to: d.email, subject: "Your quote", body: "Please find it below.", idempotencyKey: `k-${Date.now()}-b` }), 201).body;
    await integrations.execute(jobId, 1, 6);
    expect((await t.prisma.integrationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("succeeded");
    // Sent as HTML with the company email signature (everyone starts with it).
    const out = ms.mail.find((m) => m.folder === "sent" && m.subject === "Your quote")!;
    expect(out.to).toEqual([d.email]);
    expect(out.body).toContain("Please find it below.</div>");
    expect(out.body).toContain("Greenhills Road");

    await mailboxes.sync(mailbox!.id);
    const sent = await t.prisma.emailMessage.findFirstOrThrow({ where: { mailboxId: mailbox!.id, direction: "outbound" } });
    expect(sent).toMatchObject({ opportunityId: d.oppId, customerId: d.customerId, timelineLoggedAt: expect.any(Date) });
    const entries = await emailTimeline(d.oppId);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe(`To ${d.email}: Your quote\n\nPlease find it below.`);
  });

  it("replies from Gmail in the same thread, linked to the same deal", async () => {
    const p = await support.userAndClient(t, ["salesperson"]);
    const other = await support.userAndClient(t, ["salesperson"]);
    const { mailbox } = await connect(p, gm);
    const d = await deal(p);
    const incoming = gm.deliver({ to: p.user.email, from: d.email, subject: "Renewal", body: "Is it due?" });
    await mailboxes.sync(mailbox!.id);
    const msg = await t.prisma.emailMessage.findFirstOrThrow({ where: { mailboxId: mailbox!.id, providerMessageId: incoming.id } });

    expect((await other.client.post(`/emails/${msg.id}/reply`, { body: "x", idempotencyKey: `r-${Date.now()}-0` })).status).toBe(404);
    const { jobId } = support.expectStatus(await p.client.post(`/emails/${msg.id}/reply`, { body: "Yes, in March.", idempotencyKey: `r-${Date.now()}-1` }), 201).body;
    await integrations.execute(jobId, 1, 6);
    const sent = gm.mail.find((m) => m.folder === "sent" && m.body.startsWith("Yes, in March."))!;
    // Plain text with the signature after "-- ", and an HTML part with it too.
    expect(sent.body).toMatch(/^Yes, in March\.\n\n-- \n/);
    expect(sent.sentHtml).toContain("Greenhills Road");
    expect(sent).toMatchObject({ subject: "Re: Renewal", to: [d.email], threadId: incoming.threadId, inReplyTo: incoming.internetMessageId });

    await mailboxes.sync(mailbox!.id);
    expect(await t.prisma.emailMessage.findFirstOrThrow({ where: { mailboxId: mailbox!.id, providerMessageId: sent.id } })).toMatchObject({ opportunityId: d.oppId, threadId: incoming.threadId });
    const entries = await emailTimeline(d.oppId);
    expect(entries.map((e) => e.direction)).toEqual(["inbound", "outbound"]);
  });
});

describe("tokens", () => {
  it("refreshes an expired access token, and asks the person to reconnect when consent is revoked", async () => {
    const p = await support.userAndClient(t, ["salesperson"]);
    const { mailbox } = await connect(p, ms);
    ms.expireAccessTokens();
    ms.deliver({ to: p.user.email, from: "a@example.com", subject: "After expiry", body: "x" });
    expect(await mailboxes.sync(mailbox!.id)).toEqual({ added: 1 });
    expect(ms.tokenRequests.at(-1)!.get("grant_type")).toBe("refresh_token");

    ms.revokeAll();
    expect(await mailboxes.sync(mailbox!.id)).toEqual({ reauth: true });
    expect((await t.prisma.mailbox.findUniqueOrThrow({ where: { id: mailbox!.id } })).status).toBe("reauth_required");
    expect(await t.prisma.notification.count({ where: { userId: p.user.id, title: "Reconnect your mailbox" } })).toBe(1);

    // Sending now fails straight away (dead-lettered, with a message), instead of retrying.
    const d = await deal(p);
    const res = await p.client.post(`/opportunities/${d.oppId}/emails`, { to: d.email, subject: "x", body: "y", idempotencyKey: `k-${Date.now()}-c` });
    expect(res.status).toBe(422);

    // Reconnecting brings it back.
    expect((await connect(p, ms)).mailbox).toMatchObject({ status: "active", lastError: null });
  });
});
