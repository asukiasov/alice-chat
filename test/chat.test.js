import { describe, it, expect, vi } from "vitest";
import { newHub, call, seed, socket } from "./helpers.js";

const send = (hub, cookie, to, text) => call(hub, "POST", `/api/chats/${encodeURIComponent(to)}/messages`, { cookie, body: { text } });
const read = (hub, cookie, withUser, qs = "") => call(hub, "GET", `/api/chats/${encodeURIComponent(withUser)}/messages${qs}`, { cookie });

describe("messages", () => {
  it("both participants see the chat in order", async () => {
    const hub = newHub();
    const { ann, bob } = await seed(hub, "ann", "bob");
    expect((await send(hub, ann, "bob", " hello ")).status).toBe(201);
    await send(hub, bob, "ann", "hi back");
    const seen = await read(hub, bob, "ann");
    expect(seen.body.messages.map((m) => [m.sender, m.recipient, m.text])).toEqual([
      ["ann", "bob", "hello"],
      ["bob", "ann", "hi back"],
    ]);
  });
  it("keeps chats separate: a third member sees nothing", async () => {
    const hub = newHub();
    const { ann, carol } = await seed(hub, "ann", "bob", "carol");
    await send(hub, ann, "bob", "secret");
    expect((await read(hub, carol, "ann")).body.messages).toEqual([]);
    expect((await read(hub, carol, "bob")).body.messages).toEqual([]);
  });
  it("the administrator cannot read other members' chats", async () => {
    const hub = newHub();
    const { admin, ann } = await seed(hub, "ann", "bob");
    await send(hub, ann, "bob", "secret");
    expect((await read(hub, admin, "ann")).body.messages).toEqual([]);
  });
  it("only the sender can edit or delete", async () => {
    const hub = newHub();
    const { admin, ann, bob, carol } = await seed(hub, "ann", "bob", "carol");
    const { id } = (await send(hub, ann, "bob", "one")).body.message;
    for (const cookie of [bob, carol, admin]) {
      expect((await call(hub, "PATCH", `/api/messages/${id}`, { cookie, body: { text: "hacked" } })).status).toBe(403);
      expect((await call(hub, "DELETE", `/api/messages/${id}`, { cookie })).status).toBe(403);
    }
    const edited = await call(hub, "PATCH", `/api/messages/${id}`, { cookie: ann, body: { text: "two" } });
    expect(edited.body.message.text).toBe("two");
    expect(edited.body.message.editedAt).toBeGreaterThan(0);
    expect((await call(hub, "DELETE", `/api/messages/${id}`, { cookie: ann })).status).toBe(200);
    expect((await read(hub, bob, "ann")).body.messages).toEqual([]);
  });
  it("refuses unknown recipients, yourself, and empty text", async () => {
    const hub = newHub();
    const { ann } = await seed(hub, "ann");
    expect((await send(hub, ann, "ghost", "hi")).status).toBe(404);
    expect((await send(hub, ann, "ann", "hi")).status).toBe(400);
    expect((await send(hub, ann, "admin", "   ")).status).toBe(400);
  });
  it("pages back through older messages", async () => {
    const hub = newHub();
    const { ann } = await seed(hub, "ann", "bob");
    for (let i = 1; i <= 105; i++) await send(hub, ann, "bob", `m${i}`);
    const latest = (await read(hub, ann, "bob")).body.messages;
    expect(latest.length).toBe(100);
    expect(latest[0].text).toBe("m6");
    expect(latest[99].text).toBe("m105");
    const older = (await read(hub, ann, "bob", `?before=${latest[0].id}`)).body.messages;
    expect(older.map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });
  it("reports the latest message per chat for unread dots", async () => {
    const hub = newHub();
    const { ann, bob } = await seed(hub, "ann", "bob");
    const { id } = (await send(hub, ann, "bob", "hi")).body.message;
    const seenBy = (await call(hub, "GET", "/api/members", { cookie: bob })).body.members;
    expect(seenBy.find((m) => m.username === "ann")).toMatchObject({ lastMessageId: id, lastSender: "ann" });
    expect(seenBy.find((m) => m.username === "admin")).toMatchObject({ lastMessageId: 0, lastSender: null });
  });
  it("handles usernames with unicode and plus signs", async () => {
    const hub = newHub();
    const { ann } = await seed(hub, "ann", "маша", "+995555");
    expect((await send(hub, ann, "маша", "привет")).status).toBe(201);
    expect((await send(hub, ann, "+995555", "hi")).status).toBe(201);
    expect((await read(hub, ann, "маша")).body.messages[0].text).toBe("привет");
  });
  it("returns 400, not 500, for bad JSON and bad paths", async () => {
    const hub = newHub();
    const { ann } = await seed(hub, "ann");
    const bad = await hub.fetch("https://chat.test/api/login", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
    expect((await call(hub, "GET", "/api/chats/%E0%A4%A/messages", { cookie: ann })).status).toBe(400);
    expect((await call(hub, "GET", "/api/nothing", { cookie: ann })).status).toBe(404);
  });
});

describe("live delivery", () => {
  it("rejects sockets without a session or from another site", async () => {
    const hub = newHub();
    const { ann } = await seed(hub, "ann");
    expect((await socket(hub, "session=abc")).status).toBe(401);
    expect((await socket(hub, ann, "https://evil.example")).status).toBe(403);
  });
  it("delivers only to the two participants, on all their devices", async () => {
    const hub = newHub();
    const { ann, bob, carol } = await seed(hub, "ann", "bob", "carol");
    const annSock = await socket(hub, ann);
    const bobSock1 = await socket(hub, bob);
    const bobSock2 = await socket(hub, bob);
    const carolSock = await socket(hub, carol);
    const { id } = (await send(hub, ann, "bob", "hi")).body.message;
    for (const s of [annSock, bobSock1, bobSock2]) {
      await vi.waitFor(() => expect(s.events[0]).toMatchObject({ type: "message.new", message: { id, text: "hi" } }));
    }
    await call(hub, "PATCH", `/api/messages/${id}`, { cookie: ann, body: { text: "edit" } });
    await vi.waitFor(() => expect(bobSock1.events[1]).toMatchObject({ type: "message.edit", message: { text: "edit" } }));
    await call(hub, "DELETE", `/api/messages/${id}`, { cookie: ann });
    await vi.waitFor(() => expect(bobSock1.events[2]).toEqual({ type: "message.delete", id, chatWith: "ann" }));
    await vi.waitFor(() => expect(annSock.events[2]).toEqual({ type: "message.delete", id, chatWith: "bob" }));
    expect(carolSock.events).toEqual([]);
  });
  it("tells everyone when members change, and disconnects a removed member", async () => {
    const hub = newHub();
    const { admin, ann, bob } = await seed(hub, "ann", "bob");
    const annSock = await socket(hub, ann);
    const bobSock = await socket(hub, bob);
    await call(hub, "DELETE", "/api/admin/members/ann", { cookie: admin });
    await vi.waitFor(() => expect(annSock.closed).toEqual([4001]));
    await vi.waitFor(() => expect(bobSock.events).toEqual([{ type: "members.changed" }]));
  });
  it("logging out closes that session's socket", async () => {
    const hub = newHub();
    const { ann } = await seed(hub, "ann");
    const s = await socket(hub, ann);
    await call(hub, "POST", "/api/logout", { cookie: ann });
    await vi.waitFor(() => expect(s.closed).toEqual([4001]));
  });
});
