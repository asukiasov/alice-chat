import { describe, it, expect } from "vitest";
import { exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { newHub, call, login, seed, SECRET } from "./helpers.js";

const setupBody = { secret: SECRET, username: "admin", displayName: "Admin", pin: "1234" };

describe("setup", () => {
  it("rejects a wrong secret", async () => {
    const res = await call(newHub(), "POST", "/api/setup", { body: { ...setupBody, secret: "nope" } });
    expect(res.status).toBe(403);
  });
  it("works once only", async () => {
    const hub = newHub();
    expect((await call(hub, "POST", "/api/setup", { body: setupBody })).status).toBe(201);
    expect((await call(hub, "POST", "/api/setup", { body: { ...setupBody, username: "evil" } })).status).toBe(403);
  });
});

describe("login", () => {
  it("sets a safe cookie and identifies the member", async () => {
    const hub = newHub();
    await seed(hub);
    const res = await call(hub, "POST", "/api/login", { body: { username: " ADMIN ", pin: "1234" } });
    expect(res.status).toBe(200);
    expect(res.setCookie).toMatch(/HttpOnly/);
    expect(res.setCookie).toMatch(/Secure/);
    expect(res.setCookie).toMatch(/SameSite=Strict/);
    const me = await call(hub, "GET", "/api/me", { cookie: res.setCookie.split(";")[0] });
    expect(me.body.member).toEqual({ username: "admin", displayName: "Admin", isAdmin: true });
  });
  it("answers the same for unknown username and wrong PIN", async () => {
    const hub = newHub();
    await seed(hub);
    const wrong = await call(hub, "POST", "/api/login", { body: { username: "admin", pin: "9999" } });
    const unknown = await call(hub, "POST", "/api/login", { body: { username: "ghost", pin: "9999" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });
  it("locks after 5 wrong tries, even for the right PIN, and unlocks later", async () => {
    const hub = newHub();
    await seed(hub);
    for (let i = 0; i < 5; i++) {
      expect((await call(hub, "POST", "/api/login", { body: { username: "admin", pin: "9999" } })).status).toBe(401);
    }
    const locked = await call(hub, "POST", "/api/login", { body: { username: "admin", pin: "1234" } });
    expect(locked.status).toBe(429);
    await runInDurableObject(hub, (_i, state) => {
      state.storage.sql.exec("UPDATE members SET locked_until = 1 WHERE username = 'admin'");
    });
    expect((await call(hub, "POST", "/api/login", { body: { username: "admin", pin: "1234" } })).status).toBe(200);
  });
  it("counts parallel guesses so a burst cannot beat the lock", async () => {
    const hub = newHub();
    await seed(hub);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call(hub, "POST", "/api/login", { body: { username: "admin", pin: "9999" } })),
    );
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
  });
  it("logout ends the session", async () => {
    const hub = newHub();
    const { admin } = await seed(hub);
    expect((await call(hub, "POST", "/api/logout", { cookie: admin })).status).toBe(200);
    expect((await call(hub, "GET", "/api/me", { cookie: admin })).status).toBe(401);
  });
  it("rejects missing and made-up sessions", async () => {
    const hub = newHub();
    expect((await call(hub, "GET", "/api/me")).status).toBe(401);
    expect((await call(hub, "GET", "/api/members", { cookie: "session=abc" })).status).toBe(401);
  });
});

describe("administration", () => {
  it("is for administrators only", async () => {
    const hub = newHub();
    const { ann } = await seed(hub, "ann");
    const body = { username: "new", displayName: "New", pin: "1234" };
    expect((await call(hub, "POST", "/api/admin/members", { cookie: ann, body })).status).toBe(403);
    expect((await call(hub, "POST", "/api/admin/members/admin/pin", { cookie: ann, body: { pin: "0000" } })).status).toBe(403);
    expect((await call(hub, "DELETE", "/api/admin/members/admin", { cookie: ann })).status).toBe(403);
  });
  it("refuses duplicate usernames", async () => {
    const hub = newHub();
    const { admin } = await seed(hub, "ann");
    const body = { username: "ANN", displayName: "Ann 2", pin: "1234" };
    expect((await call(hub, "POST", "/api/admin/members", { cookie: admin, body })).status).toBe(409);
  });
  it("resetting a PIN ends old sessions and changes the PIN", async () => {
    const hub = newHub();
    const { admin, ann } = await seed(hub, "ann");
    const res = await call(hub, "POST", "/api/admin/members/ann/pin", { cookie: admin, body: { pin: "5555" } });
    expect(res.status).toBe(200);
    expect((await call(hub, "GET", "/api/me", { cookie: ann })).status).toBe(401);
    expect(await login(hub, "ann", "5555")).toBeTruthy();
  });
  it("removing a member deletes their account, sessions and chats", async () => {
    const hub = newHub();
    const { admin, ann, bob } = await seed(hub, "ann", "bob");
    await call(hub, "POST", "/api/chats/bob/messages", { cookie: ann, body: { text: "hi" } });
    expect((await call(hub, "DELETE", "/api/admin/members/ann", { cookie: admin })).status).toBe(200);
    expect((await call(hub, "GET", "/api/me", { cookie: ann })).status).toBe(401);
    const left = await runInDurableObject(hub, (_i, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n);
    expect(left).toBe(0);
    const members = await call(hub, "GET", "/api/members", { cookie: bob });
    expect(members.body.members.map((m) => m.username).sort()).toEqual(["admin", "bob"]);
  });
  it("an administrator cannot remove their own account", async () => {
    const hub = newHub();
    const { admin } = await seed(hub);
    expect((await call(hub, "DELETE", "/api/admin/members/admin", { cookie: admin })).status).toBe(400);
  });
});

describe("worker routing", () => {
  it("sends /api to the hub", async () => {
    const res = await exports.default.fetch("https://chat.test/api/me");
    expect(res.status).toBe(401);
  });
});
