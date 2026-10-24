import { LocalRealtimeBus, REALTIME_BUS } from "../../src/realtime/realtime";
import { type Client, type TestApp, createTestApp, expectStatus, pdf, userAndClient } from "../support/app";
import { createOpportunity } from "../support/fixtures";

let t: TestApp;
let sarah: { user: { id: string }; client: Client };
let sean: { user: { id: string }; client: Client };
let manager: { user: { id: string }; client: Client };
let admin: { user: { id: string }; client: Client };
let bus: LocalRealtimeBus;

beforeAll(async () => {
  t = await createTestApp();
  sarah = await userAndClient(t, ["salesperson"], "Sarah Sales");
  sean = await userAndClient(t, ["salesperson"], "Sean Sales");
  manager = await userAndClient(t, ["manager"], "Michael Manager");
  admin = await userAndClient(t, ["administrator"], "Aisling Admin");
  bus = t.app.get(REALTIME_BUS);
});
afterAll(() => t.close());

const channelsOf = async (c: Client) => expectStatus(await c.get("/chat/channels"), 200).body;
const send = (c: Client, channelId: string, body: string, mentions: string[] = []) => c.post(`/chat/channels/${channelId}/messages`, { body, mentions });

describe("direct messages", () => {
  it("one conversation per pair, unread counts, read receipts and privacy", async () => {
    const dm = expectStatus(await sarah.client.post(`/chat/direct/${sean.user.id}`), 201).body;
    const again = expectStatus(await sean.client.post(`/chat/direct/${sarah.user.id}`), 201).body;
    expect(again.id).toBe(dm.id);

    expectStatus(await send(sarah.client, dm.id, "Can you cover my 3pm call?"), 201);
    const seanList = await channelsOf(sean.client);
    const conv = seanList.channels.find((c: { id: string }) => c.id === dm.id);
    expect(conv).toMatchObject({ kind: "direct", title: "Sarah Sales", unread: 1 });
    expect(seanList.totalUnread).toBeGreaterThanOrEqual(1);
    expect(bus.published.at(-1)).toMatchObject({ userIds: expect.arrayContaining([sarah.user.id, sean.user.id]), event: { type: "chat.message", data: { channelId: dm.id, preview: "Can you cover my 3pm call?" } } });

    expectStatus(await sean.client.post(`/chat/channels/${dm.id}/read`), 204);
    expect((await channelsOf(sean.client)).channels.find((c: { id: string }) => c.id === dm.id).unread).toBe(0);
    // Nobody else can read it, not even a manager.
    expectStatus(await manager.client.get(`/chat/channels/${dm.id}/messages`), 404);
    expectStatus(await send(manager.client, dm.id, "hi"), 404);
  });
});

describe("team channels", () => {
  it("managers create channels; public ones are open to all staff, private ones to members only", async () => {
    expectStatus(await sarah.client.post("/chat/channels", { name: "sales-team" }), 403);
    const pub = expectStatus(await manager.client.post("/chat/channels", { name: "sales-team", description: "Daily sales chat" }), 201).body;
    expectStatus(await manager.client.post("/chat/channels", { name: "sales-team" }), 409);
    const priv = expectStatus(await manager.client.post("/chat/channels", { name: "managers", isPrivate: true }), 201).body;
    expect(expectStatus(await manager.client.post("/chat/channels", { name: "Bad Name!" }), 400).body.issues[0]).toMatch(/lowercase letters/);

    const list = await channelsOf(sarah.client);
    expect(list.joinable.map((c: { title: string }) => c.title)).toContain("#sales-team");
    expect(list.joinable.map((c: { title: string }) => c.title)).not.toContain("#managers");
    expectStatus(await sarah.client.get(`/chat/channels/${pub.id}/messages`), 200);
    expectStatus(await sarah.client.get(`/chat/channels/${priv.id}/messages`), 404);

    // Posting in a public channel joins it.
    expectStatus(await send(sarah.client, pub.id, "Morning all"), 201);
    expect((await channelsOf(sarah.client)).channels.map((c: { id: string }) => c.id)).toContain(pub.id);

    expectStatus(await manager.client.post(`/chat/channels/${priv.id}/members`, { userIds: [sean.user.id] }), 204);
    expectStatus(await sean.client.get(`/chat/channels/${priv.id}/messages`), 200);

    expectStatus(await manager.client.post(`/chat/channels/${pub.id}/archive`, { archived: true }), 204);
    expect(expectStatus(await send(sarah.client, pub.id, "still there?"), 422).body.message).toBe("This channel is archived.");
  });
});

describe("deal discussions", () => {
  it("follow the opportunity's permissions, including mentions and reassignment", async () => {
    const opp = await createOpportunity(sarah.client, "electricity");
    const ch = expectStatus(await sarah.client.get(`/chat/opportunities/${opp}`), 200).body;
    expectStatus(await sean.client.get(`/chat/opportunities/${opp}`), 404);
    expectStatus(await sean.client.get(`/chat/channels/${ch.id}/messages`), 404);

    const mentionable = expectStatus(await sarah.client.get(`/chat/channels/${ch.id}/mentionable`), 200).body.map((u: { id: string }) => u.id);
    expect(mentionable).toEqual(expect.arrayContaining([sarah.user.id, manager.user.id, admin.user.id]));
    expect(mentionable).not.toContain(sean.user.id);

    // Sean can't see the deal, so mentioning him is dropped; Michael is notified and joins the discussion.
    const posted = expectStatus(await send(sarah.client, ch.id, "@Michael can you approve today? @Sean FYI", [manager.user.id, sean.user.id]), 201).body;
    const msg = await t.prisma.chatMessage.findUniqueOrThrow({ where: { id: posted.id } });
    expect(msg.mentions).toEqual([manager.user.id]);
    const notes = expectStatus(await manager.client.get("/notifications"), 200).body;
    expect(notes[0].title).toMatch(/^Sarah Sales mentioned you in UO-\d{6} /);
    expect(await t.prisma.notification.count({ where: { userId: sean.user.id } })).toBe(0);
    expect((await channelsOf(manager.client)).channels.find((c: { id: string }) => c.id === ch.id).unread).toBe(1);

    // The discussion is internal: nothing is added to the customer timeline.
    expect(await t.prisma.timelineEntry.count({ where: { opportunityId: opp, body: { contains: "approve today" } } })).toBe(0);

    // Reassigning the deal away from Sarah removes her access to its discussion.
    expectStatus(await manager.client.post(`/opportunities/${opp}/assign`, { ownerId: sean.user.id }), 204);
    expectStatus(await sarah.client.get(`/chat/channels/${ch.id}/messages`), 404);
    expect((await channelsOf(sarah.client)).channels.map((c: { id: string }) => c.id)).not.toContain(ch.id);
    expectStatus(await sean.client.get(`/chat/channels/${ch.id}/messages`), 200);
  });
});

describe("editing, deleting and files", () => {
  it("keeps history of edits and deletions; only authors (or an administrator) can change messages", async () => {
    const dm = expectStatus(await sarah.client.post(`/chat/direct/${manager.user.id}`), 201).body;
    const m = expectStatus(await send(sarah.client, dm.id, "Meeting at 3"), 201).body;
    expectStatus(await manager.client.patch(`/chat/messages/${m.id}`, { body: "hijack" }), 403);
    expectStatus(await sarah.client.patch(`/chat/messages/${m.id}`, { body: "Meeting at 4" }), 204);
    expectStatus(await sarah.client.del(`/chat/messages/${m.id}`), 204);
    const view = expectStatus(await manager.client.get(`/chat/channels/${dm.id}/messages`), 200).body;
    expect(view.messages.find((x: { id: string }) => x.id === m.id)).toMatchObject({ deleted: true, body: null });

    expectStatus(await sarah.client.get(`/chat/messages/${m.id}/revisions`), 403);
    const history = expectStatus(await admin.client.get(`/chat/messages/${m.id}/revisions`), 200).body;
    expect(history.map((r: { body: string }) => r.body)).toEqual(["Meeting at 3", "Meeting at 4"]);
    await expect(t.prisma.chatMessageRevision.updateMany({ where: { messageId: m.id }, data: { body: "x" } })).rejects.toThrow(/append-only/);
    expect(await t.prisma.auditLog.count({ where: { action: "chat.delete", entityId: m.id } })).toBe(1);
  });

  it("shares checked files, scanned before download, visible only in the conversation", async () => {
    const dm = expectStatus(await sarah.client.post(`/chat/direct/${manager.user.id}`), 201).body;
    const bad = await sarah.client.agent.post(`/api/chat/channels/${dm.id}/messages`).set("Origin", "http://localhost:3000").set("X-CSRF-Token", sarah.client.csrf).field("body", "").attach("files", Buffer.from("MZ not a pdf"), { filename: "quote.pdf", contentType: "application/pdf" });
    expect(bad.status).toBe(422);
    const ok = await sarah.client.agent
      .post(`/api/chat/channels/${dm.id}/messages`)
      .set("Origin", "http://localhost:3000")
      .set("X-CSRF-Token", sarah.client.csrf)
      .field("body", "Here's the comparison")
      .field("mentions", JSON.stringify([manager.user.id]))
      .attach("files", pdf("comparison"), { filename: "comparison.pdf", contentType: "application/pdf" });
    expect(ok.status).toBe(201);
    expect(t.queue.jobs.some((j) => j.name === "chat-scan")).toBe(true);
    const view = expectStatus(await manager.client.get(`/chat/channels/${dm.id}/messages`), 200).body;
    const file = view.messages.at(-1).attachments[0];
    expect(file).toMatchObject({ filename: "comparison.pdf", mimeType: "application/pdf", scanStatus: "pending" });
    const url = expectStatus(await manager.client.get(`/chat/attachments/${file.id}/url`), 200).body.url;
    expect(url).toMatch(/\/api\/files\/local\?key=chat%2F/);
    expectStatus(await sean.client.get(`/chat/attachments/${file.id}/url`), 404);
  });
});

// Last: it resets the database for an app started with chat switched off.
describe("switched off", () => {
  it("answers 404 on every chat route and tells the web app to hide chat", async () => {
    await t.close();
    process.env.CHAT_ENABLED = "false";
    t = await createTestApp();
    try {
      const { client } = await userAndClient(t, ["administrator"], "Aisling Admin");
      expect(expectStatus(await client.get("/auth/me"), 200).body.user.features).toEqual({ chat: false });
      expectStatus(await client.get("/chat/channels"), 404);
      expectStatus(await client.post("/chat/channels", { name: "general" }), 404);
    } finally {
      process.env.CHAT_ENABLED = "true";
    }
  });
});
