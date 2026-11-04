# Alice Chat Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Alice's `index.html` into a live private 1-to-1 web chat for 5-10 friends on Cloudflare's free tier.

**Architecture:** One Worker serves the static page and forwards `/api/*` and `/ws` to one SQLite-backed Durable Object, `ChatHub`, which stores members, sessions and messages and pushes events over hibernating WebSockets. Spec: `docs/superpowers/specs/2026-11-04-chat-infrastructure-design.md`.

**Tech Stack:** JavaScript (no build step), Cloudflare Workers, Durable Objects, Wrangler 4, Vitest 5 with `@cloudflare/vitest-plugin`, Playwright for end-to-end checks.

## Global Constraints

- Workers Free plan only; no paid features and no billing changes.
- PIN: 4-8 digits. PBKDF2-SHA256, 100,000 iterations. 5 wrong tries locks for 15 minutes.
- Session cookie: `HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`.
- Never commit secrets. `.dev.vars` stays ignored.
- Keep Alice's look and Russian interface text.
- Git commits and pushes happen only when the owner asks, so this plan has no commit steps.

## File Structure

- `package.json`, `wrangler.jsonc`, `vitest.config.js`, `.gitignore`: project setup
- `src/index.js`: Worker entry and routing
- `src/validate.js`: input rules and `HttpError`
- `src/auth.js`: PIN hashing, tokens
- `src/chat-hub.js`: the Durable Object with all API routes and events
- `test/helpers.js`, `test/validate.test.js`, `test/auth.test.js`, `test/chat.test.js`: automated tests
- `public/index.html`: Alice's page, moved from the repo root
- `public/app.js`: page logic, moved out of the inline script

Files below are marked `<!-- file: path -->` immediately before their code block.

---

### Task 1: Project setup and input rules

**Files:** create `package.json`, `wrangler.jsonc`, `vitest.config.js`, `.gitignore`, `src/validate.js`, `src/auth.js`, `test/validate.test.js`

**Interfaces produced:**
- `HttpError(status, code)`; `normalizeUsername(v)`, `validDisplayName(v)`, `validPin(v)`, `validText(v)`; `chatId(a, b)`; `otherParticipant(chat, me)`
- `hashPin(pin, salt)` returns hex; `randomHex(bytes)`; `sha256Hex(text)`

- [ ] **Step 1: Create the project files**

<!-- file: package.json -->
```json
{
  "name": "alice-chat",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run --max-workers=1 --no-isolate"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "^1.0.0",
    "vitest": "^5.1.0",
    "wrangler": "^4.157.0"
  }
}
```

<!-- file: wrangler.jsonc -->
```json
{
  "name": "alice-chat",
  "main": "src/index.js",
  "compatibility_date": "2026-11-01",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*", "/ws"]
  },
  "durable_objects": {
    "bindings": [{ "name": "CHAT_HUB", "class_name": "ChatHub" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChatHub"] }]
}
```

<!-- file: vitest.config.js -->
```js
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { SETUP_SECRET: "test-setup-secret" } },
    }),
  ],
});
```

<!-- file: .gitignore -->
```
node_modules/
.wrangler/
.dev.vars
```

Move the page and install: `mkdir -p public && mv index.html public/index.html && npm install`

- [ ] **Step 2: Write the failing test**

<!-- file: test/validate.test.js -->
```js
import { describe, it, expect } from "vitest";
import { normalizeUsername, validDisplayName, validPin, validText, chatId, otherParticipant } from "../src/validate.js";
import { hashPin } from "../src/auth.js";

describe("normalizeUsername", () => {
  it("accepts names, phone numbers and ids, and lowercases", () => {
    expect(normalizeUsername("  Alice ")).toBe("alice");
    expect(normalizeUsername("+995555123456")).toBe("+995555123456");
    expect(normalizeUsername("Маша_7")).toBe("маша_7");
  });
  it("rejects empty, too long and punctuation", () => {
    for (const bad of ["", "   ", "a".repeat(33), "a b", "a\nb", "<x>", 5, null]) {
      expect(() => normalizeUsername(bad)).toThrow();
    }
  });
});

describe("other rules", () => {
  it("validates display names", () => {
    expect(validDisplayName(" Маша ")).toBe("Маша");
    expect(() => validDisplayName("")).toThrow();
    expect(() => validDisplayName("x".repeat(51))).toThrow();
  });
  it("validates PINs as 4-8 digits", () => {
    expect(validPin("1234")).toBe("1234");
    expect(validPin("12345678")).toBe("12345678");
    for (const bad of ["123", "123456789", "12a4", 1234]) expect(() => validPin(bad)).toThrow();
  });
  it("validates message text", () => {
    expect(validText("  hi ")).toBe("hi");
    expect(() => validText("   ")).toThrow();
    expect(() => validText("x".repeat(2001))).toThrow();
  });
  it("gives a pair one chat id in either order", () => {
    expect(chatId("bob", "ann")).toBe(chatId("ann", "bob"));
    expect(otherParticipant(chatId("ann", "bob"), "ann")).toBe("bob");
    expect(otherParticipant(chatId("ann", "bob"), "bob")).toBe("ann");
  });
  it("hashes a PIN repeatably, and differently per salt", async () => {
    expect(await hashPin("1234", "aa")).toBe(await hashPin("1234", "aa"));
    expect(await hashPin("1234", "aa")).not.toBe(await hashPin("1234", "bb"));
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npm test` (needs a stub `src/index.js` and `src/chat-hub.js` only once Task 2 adds them; until then expect failure on missing modules.)

- [ ] **Step 4: Implement**

<!-- file: src/validate.js -->
```js
export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function normalizeUsername(value) {
  if (typeof value === "string") {
    const username = value.normalize("NFC").trim().toLowerCase();
    if (/^[\p{L}\p{M}\p{N}_+\-]{1,32}$/u.test(username)) return username;
  }
  throw new HttpError(400, "invalid_username");
}

export function validDisplayName(value) {
  if (typeof value === "string") {
    const name = value.trim();
    if ([...name].length >= 1 && [...name].length <= 50) return name;
  }
  throw new HttpError(400, "invalid_display_name");
}

export function validPin(value) {
  if (typeof value === "string" && /^[0-9]{4,8}$/.test(value)) return value;
  throw new HttpError(400, "invalid_pin");
}

export function validText(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length >= 1 && text.length <= 2000) return text;
  }
  throw new HttpError(400, "invalid_text");
}

export function chatId(a, b) {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

export function otherParticipant(chat, me) {
  const [a, b] = chat.split("\n");
  return a === me ? b : a;
}
```

<!-- file: src/auth.js -->
```js
const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));

export function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(salt), iterations: 100000 },
    key,
    256,
  );
  return toHex(bits);
}
```

---

### Task 2: Server (Worker and ChatHub)

**Files:** create `src/index.js`, `src/chat-hub.js`, `test/helpers.js`, `test/auth.test.js`, `test/chat.test.js`

**Interfaces produced:** the HTTP API and events in the spec. `POST /api/login` and `GET /api/me` return `{ member: { username, displayName, isAdmin } }`. Messages are `{ id, sender, recipient, text, createdAt, editedAt }`.

- [ ] **Step 1: Write the failing tests**

<!-- file: test/helpers.js -->
```js
import { env } from "cloudflare:workers";

export const SECRET = "test-setup-secret";
export const BASE = "https://chat.test";

// Each test gets its own Durable Object, so tests never share data.
export const newHub = () => env.CHAT_HUB.getByName(crypto.randomUUID());

export async function call(hub, method, path, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await hub.fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get("set-cookie") };
}

export async function login(hub, username, pin = "1234") {
  const res = await call(hub, "POST", "/api/login", { body: { username, pin } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return res.setCookie.split(";")[0];
}

// Creates administrator "admin" plus the named members, all with PIN 1234.
// Returns a map of username to session cookie.
export async function seed(hub, ...usernames) {
  await call(hub, "POST", "/api/setup", {
    body: { secret: SECRET, username: "admin", displayName: "Admin", pin: "1234" },
  });
  const cookies = { admin: await login(hub, "admin") };
  for (const username of usernames) {
    await call(hub, "POST", "/api/admin/members", {
      cookie: cookies.admin,
      body: { username, displayName: username.toUpperCase(), pin: "1234" },
    });
    cookies[username] = await login(hub, username);
  }
  return cookies;
}

export async function socket(hub, cookie, origin = BASE) {
  const res = await hub.fetch(`${BASE}/ws`, { headers: { Upgrade: "websocket", Origin: origin, Cookie: cookie } });
  if (res.status !== 101) return { status: res.status };
  const ws = res.webSocket;
  ws.accept();
  const events = [];
  const closed = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(e.data)));
  ws.addEventListener("close", (e) => closed.push(e.code));
  return { status: 101, ws, events, closed };
}
```

<!-- file: test/auth.test.js -->
```js
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
```

<!-- file: test/chat.test.js -->
```js
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test`
Expected: FAIL, because `src/index.js` does not exist.

- [ ] **Step 3: Implement**

<!-- file: src/index.js -->
```js
export { ChatHub } from "./chat-hub.js";

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/") || pathname === "/ws") {
      return env.CHAT_HUB.getByName("main").fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
```

<!-- file: src/chat-hub.js -->
```js
import { DurableObject } from "cloudflare:workers";
import { hashPin, randomHex, sha256Hex } from "./auth.js";
import { HttpError, chatId, normalizeUsername, otherParticipant, validDisplayName, validPin, validText } from "./validate.js";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const PAGE_SIZE = 100;
const REVOKED = 4001;
const DUMMY_SALT = "00".repeat(16);

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

const sessionCookie = (token, maxAge) =>
  `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

const publicMember = (row) => ({ username: row.username, displayName: row.display_name, isAdmin: !!row.is_admin });

const publicMessage = (row) => ({
  id: row.id,
  sender: row.sender,
  recipient: otherParticipant(row.chat_id, row.sender),
  text: row.text,
  createdAt: row.created_at,
  editedAt: row.edited_at,
});

async function readJson(request) {
  try {
    const body = await request.json();
    if (body && typeof body === "object") return body;
  } catch {
    // Reported below.
  }
  throw new HttpError(400, "invalid_json");
}

function readToken(request) {
  const match = /(?:^|;\s*)session=([0-9a-f]{64})(?:;|$)/.exec(request.headers.get("Cookie") || "");
  return match ? match[1] : null;
}

export class ChatHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS members (
        username TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        pin_hash TEXT NOT NULL,
        pin_salt TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (username);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        edited_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (chat_id, id);
    `);
  }

  async fetch(request) {
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, error.status);
      if (error instanceof URIError) return json({ error: "invalid_path" }, 400);
      console.error(error);
      return json({ error: "server_error" }, 500);
    }
  }

  async route(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (path === "/ws") return this.openSocket(request, url);
    if (method === "POST" && path === "/api/setup") return this.setup(request);
    if (method === "POST" && path === "/api/login") return this.login(request);

    const session = await this.requireSession(request);
    const me = session.member;
    const parts = path.split("/").slice(2).map(decodeURIComponent);

    if (method === "POST" && path === "/api/logout") return this.logout(session);
    if (method === "GET" && path === "/api/me") return json({ member: publicMember(me) });
    if (method === "GET" && path === "/api/members") return this.listMembers(me);

    if (parts[0] === "chats" && parts[2] === "messages" && parts.length === 3) {
      if (method === "GET") return this.readChat(me, parts[1], url);
      if (method === "POST") return this.sendMessage(me, parts[1], request);
    }
    if (parts[0] === "messages" && parts.length === 2) {
      if (method === "PATCH") return this.editMessage(me, parts[1], request);
      if (method === "DELETE") return this.deleteMessage(me, parts[1]);
    }
    if (parts[0] === "admin" && parts[1] === "members") {
      if (!me.is_admin) throw new HttpError(403, "forbidden");
      if (method === "POST" && parts.length === 2) return this.addMember(request);
      if (method === "POST" && parts.length === 4 && parts[3] === "pin") return this.resetPin(parts[2], request);
      if (method === "DELETE" && parts.length === 3) return this.removeMember(me, parts[2]);
    }
    throw new HttpError(404, "not_found");
  }

  // ---- lookups ----

  findMember(username) {
    return this.sql.exec("SELECT * FROM members WHERE username = ?", username).toArray()[0] || null;
  }

  async requireSession(request) {
    const token = readToken(request);
    if (token) {
      const tokenHash = await sha256Hex(token);
      const row = this.sql.exec("SELECT username FROM sessions WHERE token_hash = ?", tokenHash).toArray()[0];
      const member = row && this.findMember(row.username);
      if (member) return { member, tokenHash };
    }
    throw new HttpError(401, "not_signed_in");
  }

  // ---- setup and sign-in ----

  async setup(request) {
    const body = await readJson(request);
    const expected = this.env.SETUP_SECRET;
    const same = expected && (await sha256Hex(String(body.secret))) === (await sha256Hex(expected));
    if (!same) throw new HttpError(403, "forbidden");
    const username = normalizeUsername(body.username);
    const displayName = validDisplayName(body.displayName);
    const pin = validPin(body.pin);
    const salt = randomHex(16);
    const hash = await hashPin(pin, salt);
    // Checked after the await so two setup calls cannot both succeed.
    if (this.sql.exec("SELECT COUNT(*) AS n FROM members").one().n > 0) throw new HttpError(403, "forbidden");
    this.insertMember(username, displayName, hash, salt, 1);
    return json({ member: { username, displayName, isAdmin: true } }, 201);
  }

  insertMember(username, displayName, hash, salt, isAdmin) {
    this.sql.exec(
      "INSERT INTO members (username, display_name, pin_hash, pin_salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      username, displayName, hash, salt, isAdmin, Date.now(),
    );
  }

  async login(request) {
    const body = await readJson(request);
    const badLogin = new HttpError(401, "bad_credentials");
    let username;
    let pin;
    try {
      username = normalizeUsername(body.username);
      pin = validPin(body.pin);
    } catch {
      throw badLogin;
    }
    const member = this.findMember(username);
    if (!member) {
      await hashPin(pin, DUMMY_SALT); // Same work as a real attempt.
      throw badLogin;
    }
    const now = Date.now();
    if (member.locked_until > now) throw new HttpError(429, "locked");

    // Count the attempt before the slow hash, so parallel guesses cannot slip past the lock.
    const attempts = (member.locked_until ? 0 : member.failed_attempts) + 1;
    this.sql.exec(
      "UPDATE members SET failed_attempts = ?, locked_until = ? WHERE username = ?",
      attempts, attempts >= MAX_ATTEMPTS ? now + LOCK_MS : 0, username,
    );
    if ((await hashPin(pin, member.pin_salt)) !== member.pin_hash) throw badLogin;

    this.sql.exec("UPDATE members SET failed_attempts = 0, locked_until = 0 WHERE username = ?", username);
    const token = randomHex(32);
    this.sql.exec(
      "INSERT INTO sessions (token_hash, username, created_at) VALUES (?, ?, ?)",
      await sha256Hex(token), username, now,
    );
    return json({ member: publicMember(member) }, 200, { "Set-Cookie": sessionCookie(token, 31536000) });
  }

  logout({ tokenHash }) {
    this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
    this.closeSockets(`s:${tokenHash}`);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  // ---- members ----

  listMembers(me) {
    const rows = this.sql.exec("SELECT username, display_name FROM members ORDER BY display_name").toArray();
    const members = rows.map((row) => {
      const last = row.username === me.username
        ? null
        : this.sql.exec(
            "SELECT id, sender FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1",
            chatId(me.username, row.username),
          ).toArray()[0];
      return {
        username: row.username,
        displayName: row.display_name,
        lastMessageId: last ? last.id : 0,
        lastSender: last ? last.sender : null,
      };
    });
    return json({ members });
  }

  async addMember(request) {
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    const displayName = validDisplayName(body.displayName);
    const pin = validPin(body.pin);
    const salt = randomHex(16);
    const hash = await hashPin(pin, salt);
    // Checked after the await so two parallel requests cannot collide.
    if (this.findMember(username)) throw new HttpError(409, "username_taken");
    this.insertMember(username, displayName, hash, salt, 0);
    this.broadcastAll({ type: "members.changed" });
    return json({ member: { username, displayName, isAdmin: false } }, 201);
  }

  async resetPin(rawUsername, request) {
    const username = normalizeUsername(rawUsername);
    const pin = validPin((await readJson(request)).pin);
    const salt = randomHex(16);
    const hash = await hashPin(pin, salt);
    if (!this.findMember(username)) throw new HttpError(404, "not_found");
    this.sql.exec(
      "UPDATE members SET pin_hash = ?, pin_salt = ?, failed_attempts = 0, locked_until = 0 WHERE username = ?",
      hash, salt, username,
    );
    this.endAllSessions(username);
    return json({ ok: true });
  }

  removeMember(me, rawUsername) {
    const username = normalizeUsername(rawUsername);
    if (username === me.username) throw new HttpError(400, "cannot_remove_self");
    if (!this.findMember(username)) throw new HttpError(404, "not_found");
    for (const { username: other } of this.sql.exec("SELECT username FROM members").toArray()) {
      this.sql.exec("DELETE FROM messages WHERE chat_id = ?", chatId(username, other));
    }
    this.sql.exec("DELETE FROM members WHERE username = ?", username);
    this.endAllSessions(username);
    this.broadcastAll({ type: "members.changed" });
    return json({ ok: true });
  }

  endAllSessions(username) {
    this.sql.exec("DELETE FROM sessions WHERE username = ?", username);
    this.closeSockets(`u:${username}`);
  }

  // ---- messages ----

  requirePeer(me, rawUsername) {
    const peer = normalizeUsername(rawUsername);
    if (peer === me.username) throw new HttpError(400, "invalid_recipient");
    if (!this.findMember(peer)) throw new HttpError(404, "not_found");
    return peer;
  }

  readChat(me, rawUsername, url) {
    const chat = chatId(me.username, this.requirePeer(me, rawUsername));
    const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const rows = this.sql.exec(
      "SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
      chat, before, PAGE_SIZE,
    ).toArray();
    return json({ messages: rows.reverse().map(publicMessage) });
  }

  async sendMessage(me, rawUsername, request) {
    const peer = this.requirePeer(me, rawUsername);
    const text = validText((await readJson(request)).text);
    const row = this.sql.exec(
      "INSERT INTO messages (chat_id, sender, text, created_at) VALUES (?, ?, ?, ?) RETURNING *",
      chatId(me.username, peer), me.username, text, Date.now(),
    ).one();
    const message = publicMessage(row);
    this.sendEvent([me.username, peer], { type: "message.new", message });
    return json({ message }, 201);
  }

  ownMessage(me, rawId) {
    const row = this.sql.exec("SELECT * FROM messages WHERE id = ?", Number(rawId)).toArray()[0];
    if (!row) throw new HttpError(404, "not_found");
    if (row.sender !== me.username) throw new HttpError(403, "forbidden");
    return row;
  }

  async editMessage(me, rawId, request) {
    const body = await readJson(request);
    const { id } = this.ownMessage(me, rawId);
    const row = this.sql.exec(
      "UPDATE messages SET text = ?, edited_at = ? WHERE id = ? RETURNING *",
      validText(body.text), Date.now(), id,
    ).one();
    const message = publicMessage(row);
    this.sendEvent([message.sender, message.recipient], { type: "message.edit", message });
    return json({ message });
  }

  deleteMessage(me, rawId) {
    const row = this.ownMessage(me, rawId);
    this.sql.exec("DELETE FROM messages WHERE id = ?", row.id);
    const peer = otherParticipant(row.chat_id, me.username);
    this.sendEvent([me.username], { type: "message.delete", id: row.id, chatWith: peer });
    this.sendEvent([peer], { type: "message.delete", id: row.id, chatWith: me.username });
    return json({ ok: true });
  }

  // ---- live connections ----

  async openSocket(request, url) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "websocket_required");
    let originHost = null;
    try {
      originHost = new URL(request.headers.get("Origin")).host;
    } catch {
      // Missing or malformed Origin is refused below.
    }
    if (originHost !== url.host) throw new HttpError(403, "forbidden");
    const { member, tokenHash } = await this.requireSession(request);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [`u:${member.username}`, `s:${tokenHash}`]);
    return new Response(null, { status: 101, webSocket: client });
  }

  sendEvent(usernames, event) {
    const data = JSON.stringify(event);
    for (const username of new Set(usernames)) {
      for (const ws of this.ctx.getWebSockets(`u:${username}`)) this.safeSend(ws, data);
    }
  }

  broadcastAll(event) {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) this.safeSend(ws, data);
  }

  safeSend(ws, data) {
    try {
      ws.send(data);
    } catch {
      // Already closing; the client reloads when it reconnects.
    }
  }

  closeSockets(tag) {
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.close(REVOKED, "signed_out");
      } catch {
        // Already closed.
      }
    }
  }

  webSocketMessage() {
    // Clients send nothing over the socket; all writes use HTTP.
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
  }

  webSocketError() {
    // The runtime closes the socket; the client reconnects.
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test`
Expected: all tests in `validate`, `auth` and `chat` PASS.

---

### Task 3: Connect Alice's page

**Files:** modify `public/index.html`; create `public/app.js`

**Interfaces consumed:** the HTTP API and events from Task 2.

- [ ] **Step 1: Create the page logic**

Alice's bubble, long-press, palette and recording code is carried over; the keypad, contact list and `claude.use` code are replaced.

<!-- file: public/app.js -->
```js
const $=id=>document.getElementById(id);
const list=$('list'),inp=$('in'),ic=$('ic'),note=$('note');
const WAVE='<path d="M6 8v8M10 5v14M14 8v8M18 10v4"/>',SEND='<path d="M12 19V5M5 12l7-7 7 7"/>';
const ctx=$('ctx'),pal=$('pal'),palBtn=$('palBtn'),lvl=$('lvl');
const HI='Say hi to your friend 👋',PICK='Выбери подругу в меню 👋';
const ERR={bad_credentials:'Неверное имя или PIN',locked:'Слишком много попыток. Подожди 15 минут.',invalid_username:'Имя: только буквы, цифры, _ - +',invalid_display_name:'Введите имя',invalid_pin:'PIN: от 4 до 8 цифр',username_taken:'Такое имя уже есть'};
const errText=e=>ERR[e.message]||'Что-то пошло не так. Попробуй ещё раз.';
const enc=encodeURIComponent;
let me=null,myId=null,peer=null,members=[],msgs=[],editing=null,cur='#8b6cf0',hasMore=false,loadingOlder=false,ws=null,wsDelay=1000,wsTimer=null;

// ---- server ----
async function api(path,method='GET',body){
  const r=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await r.json().catch(()=>({}));
  if(r.ok)return data;
  if(r.status===401&&path!=='/api/login')showLogin();
  throw new Error(data.error||'server_error');
}
const view=m=>({id:m.id,from:m.sender,to:m.recipient,text:m.text});
function say(t){note.textContent=t;note.style.display='block';list.scrollTop=list.scrollHeight}

// ---- unread state, kept per browser ----
function readMap(){try{return JSON.parse(localStorage.getItem('read:'+myId)||'{}')}catch(_){return {}}}
function markRead(u,id){const r=readMap();if((r[u]||0)>=id)return;r[u]=id;try{localStorage.setItem('read:'+myId,JSON.stringify(r))}catch(_){}renderMembers()}
function isUnread(m,r){return m.lastMessageId>(r[m.username]||0)&&m.lastSender!==myId}

// ---- long-press menu ----
function hideCtx(){ctx.classList.remove('show')}
function copyText(t){function fb(){const a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy')}catch(_){}a.remove()}try{navigator.clipboard.writeText(t).catch(fb)}catch(_){fb()}}
function hold(el,cb){
  let t=null,sx=0,sy=0;
  const cancel=()=>{if(t){clearTimeout(t);t=null}};
  el.addEventListener('pointerdown',e=>{el._held=false;sx=e.clientX;sy=e.clientY;t=setTimeout(()=>{t=null;el._held=true;cb()},500)});
  el.addEventListener('pointermove',e=>{if(Math.abs(e.clientX-sx)>10||Math.abs(e.clientY-sy)>10)cancel()});
  ['pointerup','pointerleave','pointercancel'].forEach(n=>el.addEventListener(n,cancel));
  el.addEventListener('contextmenu',e=>e.preventDefault());
}
function fillCtx(items){ctx.innerHTML='';items.forEach(([n,f])=>{const a=document.createElement('a');a.textContent=n;a.onclick=()=>{hideCtx();f()};ctx.appendChild(a)});ctx.classList.add('show')}
function showCtx(el,x){
  const mine=x.from===myId;
  const items=[];
  if(mine)items.push(['Удалить',async()=>{try{await api('/api/messages/'+x.id,'DELETE');removeMsg(x.id)}catch(e){say(errText(e))}}]);
  items.push(['Скопировать',()=>copyText(x.text)]);
  if(mine)items.push(['Изменить',()=>{editing=x;inp.value=x.text;inp.placeholder='Изменить сообщение';ic.innerHTML=SEND;inp.focus()}]);
  fillCtx(items);
  const r=el.getBoundingClientRect(),w=ctx.offsetWidth,h=ctx.offsetHeight;
  let left=mine?r.right-w:r.left;left=Math.max(8,Math.min(left,innerWidth-w-8));
  let top=r.top-h-8;if(top<8)top=r.bottom+8;
  ctx.style.left=left+'px';ctx.style.top=top+'px';
}
document.addEventListener('pointerdown',e=>{if(!ctx.contains(e.target))hideCtx();if(!pal.contains(e.target)&&!palBtn.contains(e.target))pal.classList.remove('show')});

// ---- colours ----
function applyBg(){document.documentElement.style.setProperty('--bg','color-mix(in srgb,'+cur+' '+lvl.value+'%,#fff)')}
['#8b6cf0','#ec6fa8','#ff2a2a','#f5923e','#f2c230','#3fb67a','#2bb5b0','#3b82f6'].forEach((c,i)=>{
  const b=document.createElement('button');b.style.background=c;if(i===0)b.className='on';b.setAttribute('aria-label',c);
  b.onclick=()=>{pal.querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');cur=c;const s=document.documentElement.style;
    s.setProperty('--mine',c);s.setProperty('--btn',c);s.setProperty('--field','color-mix(in srgb,'+c+' 12%,#fff)');s.setProperty('--theirs','color-mix(in srgb,'+c+' 12%,#fff)');s.setProperty('--fg','#241a3a');s.setProperty('--theirsT','#241a3a');applyBg()};
  pal.appendChild(b)});
lvl.oninput=applyBg;
palBtn.onclick=()=>pal.classList.toggle('show');

// ---- messages ----
function render(keepScroll){
  list.querySelectorAll('.m').forEach(e=>e.remove());
  note.textContent=peer?HI:PICK;
  note.style.display=msgs.length?'none':'block';
  msgs.forEach(x=>{const d=document.createElement('div');d.className='m '+(x.from===myId?'me':'fr');d.textContent=x.text;hold(d,()=>showCtx(d,x));list.appendChild(d)});
  if(!keepScroll)list.scrollTop=list.scrollHeight;
}
function upsertMsg(m){
  const v=view(m),i=msgs.findIndex(x=>x.id===v.id);
  if(i>=0)msgs[i]=v;else{msgs.push(v);msgs.sort((a,b)=>a.id-b.id)}
  render(i>=0);
  if(!document.hidden)markRead(peer,v.id);
}
function removeMsg(id){const i=msgs.findIndex(x=>x.id===id);if(i>=0){msgs.splice(i,1);render(true)}}
async function loadChat(){
  const p=peer;
  const r=await api('/api/chats/'+enc(p)+'/messages');
  if(peer!==p)return;
  msgs=r.messages.map(view);hasMore=r.messages.length===100;render();
  if(msgs.length&&!document.hidden)markRead(p,msgs[msgs.length-1].id);
}
list.addEventListener('scroll',async()=>{
  if(list.scrollTop>0||!hasMore||loadingOlder||!peer||!msgs.length)return;
  loadingOlder=true;const p=peer;
  try{
    const r=await api('/api/chats/'+enc(p)+'/messages?before='+msgs[0].id);
    if(peer===p){const h=list.scrollHeight;msgs=r.messages.map(view).concat(msgs);hasMore=r.messages.length===100;render(true);list.scrollTop=list.scrollHeight-h}
  }catch(_){}
  loadingOlder=false;
});
inp.addEventListener('input',()=>{ic.innerHTML=inp.value.trim()?SEND:WAVE});
async function send(){
  const t=inp.value.trim();if(!t||!peer)return;
  inp.value='';ic.innerHTML=WAVE;
  const e=editing;
  try{
    if(e){editing=null;inp.placeholder='Сообщение';upsertMsg((await api('/api/messages/'+e.id,'PATCH',{text:t})).message);return}
    upsertMsg((await api('/api/chats/'+enc(peer)+'/messages','POST',{text:t})).message);
  }catch(err){inp.value=t;ic.innerHTML=SEND;if(e){editing=e;inp.placeholder='Изменить сообщение'}say('Не получилось отправить. Попробуй ещё раз.')}
}

// ---- voice control: looks only, nothing is recorded or sent yet ----
let rtimer=null,rsec=0;const fld=document.querySelector('.field');
let wvT=null,stream=null,an=null,ac=null,buf=null,hist=[];const BARS=30;
function wvTick(){const w=$('wv');let lv;if(an){an.getByteTimeDomainData(buf);let s=0;for(let i=0;i<buf.length;i++){const v=(buf[i]-128)/128;s+=v*v}lv=Math.min(1,Math.sqrt(s/buf.length)*4)}else lv=0.15+Math.random()*0.7;hist.push(lv);if(hist.length>BARS)hist.shift();[...w.children].forEach((el,i)=>{const v=hist[i-(BARS-hist.length)];el.style.height=(4+(v||0)*26)+'px'})}
function wvStart(){hist=[];const w=$('wv');w.innerHTML='';for(let i=0;i<BARS;i++)w.appendChild(document.createElement('i'));wvT=setInterval(wvTick,90);if(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{if(!wvT){s.getTracks().forEach(t=>t.stop());return}stream=s;ac=new (window.AudioContext||window.webkitAudioContext)();const src=ac.createMediaStreamSource(s);an=ac.createAnalyser();an.fftSize=256;buf=new Uint8Array(an.fftSize);src.connect(an)}).catch(()=>{})}
function wvStop(){clearInterval(wvT);wvT=null;try{if(stream)stream.getTracks().forEach(t=>t.stop())}catch(_){}try{if(ac)ac.close()}catch(_){}stream=null;ac=null;an=null}
function recStart(){rsec=0;$('rt').textContent='0:00';fld.classList.add('recing');ic.innerHTML=SEND;wvStart();rtimer=setInterval(()=>{rsec++;$('rt').textContent=Math.floor(rsec/60)+':'+String(rsec%60).padStart(2,'0')},1000)}
function recStop(){wvStop();clearInterval(rtimer);rtimer=null;fld.classList.remove('recing');ic.innerHTML=inp.value.trim()?SEND:WAVE}
$('mic').onclick=recStart;$('rc').onclick=recStop;
$('go').onclick=()=>{if(rtimer){recStop();return}send()};
inp.addEventListener('keydown',e=>{if(e.key==='Enter')send()});

// ---- menu and members ----
const closeMenu=()=>document.body.classList.remove('open');
$('menuBtn').onclick=()=>document.body.classList.add('open');
$('ov').onclick=closeMenu;
function renderMembers(){
  const box=$('members'),r=readMap();box.innerHTML='';let any=false;
  members.filter(m=>m.username!==myId).forEach(m=>{
    const el=document.createElement('div');el.className='ct';
    const b=document.createElement('b');b.textContent=m.displayName;
    if(isUnread(m,r)&&m.username!==peer){const u=document.createElement('span');u.className='un';b.appendChild(u);any=true}
    const p=document.createElement('div');p.className='ph';p.textContent=m.username;
    el.append(b,p);
    el.onclick=()=>{if(el._held){el._held=false;return}openChat(m.username)};
    if(me&&me.isAdmin)hold(el,()=>memberMenu(el,m));
    box.appendChild(el)});
  $('menuBtn').classList.toggle('has',any);
}
async function refreshMembers(){
  members=(await api('/api/members')).members;
  if(peer&&!members.some(m=>m.username===peer))closeChat();
  renderMembers();
}
function closeChat(){peer=null;msgs=[];hasMore=false;$('peer').textContent='';document.body.classList.remove('chatting');render()}
function openChat(u){
  const m=members.find(x=>x.username===u);if(!m)return;
  peer=u;msgs=[];hasMore=false;editing=null;inp.value='';inp.placeholder='Сообщение';ic.innerHTML=WAVE;
  $('peer').textContent=m.displayName;document.body.classList.add('chatting');closeMenu();render();renderMembers();
  loadChat().catch(()=>say('Не получилось загрузить чат.'));
}
async function refresh(){await refreshMembers();if(peer)await loadChat()}

// ---- administrator tools ----
const num=$('num');
function openForm(title,fields,onOk){
  $('formT').textContent=title;const box=$('formF');box.innerHTML='';$('formE').textContent='';
  const vals={};
  fields.forEach(f=>{const i=document.createElement('input');i.placeholder=f.ph;i.autocomplete='off';i.autocapitalize='off';if(f.digits)i.inputMode='numeric';vals[f.key]=i;box.appendChild(i)});
  $('save').onclick=async()=>{const o={};for(const k in vals)o[k]=vals[k].value;
    try{await onOk(o);num.classList.remove('show')}catch(e){$('formE').textContent=errText(e)}};
  num.classList.add('show');
}
num.addEventListener('click',e=>{if(e.target===num)num.classList.remove('show')});
const PINF={key:'pin',ph:'PIN (4-8 цифр)',digits:true};
$('addM').onclick=()=>{closeMenu();openForm('Новая участница',[{key:'username',ph:'Логин (имя, телефон или ID)'},{key:'displayName',ph:'Как показывать имя'},PINF],async o=>{await api('/api/admin/members','POST',o);await refreshMembers()})};
$('myPin').onclick=()=>{closeMenu();openForm('Мой новый PIN',[PINF],o=>api('/api/admin/members/'+enc(myId)+'/pin','POST',o).then(showLogin))};
function memberMenu(el,m){
  const place=()=>{const r=el.getBoundingClientRect(),w=ctx.offsetWidth,h=ctx.offsetHeight;ctx.style.left=Math.max(8,Math.min(r.left+16,innerWidth-w-8))+'px';let top=r.top-h-4;if(top<8)top=r.bottom+4;ctx.style.top=top+'px'};
  fillCtx([
    ['Новый PIN',()=>{closeMenu();openForm('Новый PIN: '+m.displayName,[PINF],o=>api('/api/admin/members/'+enc(m.username)+'/pin','POST',o))}],
    ['Удалить',()=>{fillCtx([['Точно удалить '+m.displayName+'? Чаты тоже исчезнут.',async()=>{try{await api('/api/admin/members/'+enc(m.username),'DELETE');await refreshMembers()}catch(e){say(errText(e))}}],['Отмена',()=>{}]]);place()}],
  ]);
  place();
}

// ---- live connection ----
function onEvent(e){
  if(e.type==='members.changed'){refreshMembers().catch(()=>{});return}
  if(e.type==='message.delete'){if(e.chatWith===peer)removeMsg(e.id);return}
  if(e.type==='message.new'||e.type==='message.edit'){
    const m=e.message,other=m.sender===myId?m.recipient:m.sender;
    if(other===peer)upsertMsg(m);
    if(e.type==='message.new'){const x=members.find(y=>y.username===other);if(x){x.lastMessageId=m.id;x.lastSender=m.sender;renderMembers()}}
  }
}
function openSocket(){
  if(!me||(ws&&ws.readyState<=1))return;
  clearTimeout(wsTimer);
  const s=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');ws=s;
  s.onopen=()=>{wsDelay=1000;refresh().catch(()=>{})};
  s.onmessage=e=>onEvent(JSON.parse(e.data));
  s.onclose=()=>{if(ws!==s||!me)return;ws=null;api('/api/me').catch(()=>{});wsTimer=setTimeout(openSocket,wsDelay);wsDelay=Math.min(wsDelay*2,30000)};
}
document.addEventListener('visibilitychange',()=>{if(document.hidden||!me)return;openSocket();refresh().catch(()=>{})});

// ---- sign-in ----
function showLogin(){
  me=null;myId=null;members=[];peer=null;msgs=[];clearTimeout(wsTimer);
  if(ws){const s=ws;ws=null;s.close()}
  closeMenu();num.classList.remove('show');document.body.classList.remove('chatting');
  $('peer').textContent='';$('admin').hidden=true;$('login').classList.add('show');
}
function start(member){
  me=member;myId=member.username;
  $('login').classList.remove('show');$('admin').hidden=!member.isAdmin;$('me').textContent=member.displayName;
  render();document.body.classList.add('open');
  refreshMembers().catch(()=>{});openSocket();
}
async function doLogin(){
  $('lE').textContent='';
  try{const r=await api('/api/login','POST',{username:$('lU').value,pin:$('lP').value});$('lP').value='';start(r.member)}
  catch(e){$('lE').textContent=errText(e)}
}
$('lGo').onclick=doLogin;
$('lP').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
$('logout').onclick=async()=>{try{await api('/api/logout','POST')}catch(_){}showLogin()};
fetch('/api/me').then(async r=>{if(r.ok)start((await r.json()).member);else showLogin()}).catch(showLogin);
```

- [ ] **Step 2: Update `public/index.html`**

Remove the inline `<script>...</script>` and put `<script src="/app.js"></script>` in its place.

Replace the header's start, the `#dr` nav and the `#num` modal:

```html
<header>
  <button class="ib" id="menuBtn" aria-label="Menu"><svg viewBox="0 0 24 24"><path d="M3 8h18M3 16h18"/></svg></button>
  <div id="peer"></div>
```

```html
<nav id="dr"><h2>Menu</h2><div id="me" class="ph2"></div><div id="members"></div><div id="admin" hidden><a id="addM">Добавить участницу</a><a id="myPin">Сменить мой PIN</a></div><a id="logout">Выйти</a></nav>
<div id="num"><div class="box"><h3 id="formT"></h3><div id="step2"><div id="formF"></div><div id="formE" class="err"></div><button id="save">Готово</button></div></div></div>
<div id="login"><div class="box"><h3>Вход</h3><div id="step2l"><input id="lU" placeholder="Логин" autocomplete="username" autocapitalize="off"><input id="lP" type="password" inputmode="numeric" placeholder="PIN" autocomplete="current-password"><div id="lE" class="err"></div><button id="lGo">Войти</button></div></div></div>
```

Replace the keypad CSS (`.grid*`, `#step2*`, `#num .box.two*`, `#disp*`, and the `#num`, `#num.show`, `#num .box`, `#num h3` rules) with:

```css
#num,#login{position:fixed;inset:0;background:rgba(40,25,80,.45);display:none;align-items:center;justify-content:center;z-index:30}
#login{background:var(--bg);z-index:50}
#num.show,#login.show{display:flex}
#num .box,#login .box{background:var(--bg);border-radius:24px;padding:22px;width:min(86%,320px);box-shadow:0 10px 40px rgba(40,25,80,.35)}
#num h3,#login h3{margin:0 0 16px;text-align:center;font-size:20px}
#step2,#step2l,#formF{display:flex;flex-direction:column;gap:12px}
#step2 input,#step2l input{height:52px;border-radius:16px;border:0;background:var(--field);color:var(--fg);padding:0 16px;font:inherit;font-size:18px;outline:none;width:100%}
#step2 button,#step2l button{height:52px;border-radius:16px;border:0;background:var(--mine);color:#fff;font:600 18px system-ui,sans-serif}
.err{color:#d11a2a;font-size:14px;text-align:center;min-height:18px}
#peer{flex:1;min-width:0;padding:0 14px;font-weight:600;font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ph2{margin:-8px 8px 10px;color:var(--sub);font-size:14px}
body:not(.chatting) footer{visibility:hidden}
.un{display:inline-block;width:10px;height:10px;margin-left:8px;border-radius:50%;background:#ff2a2a;vertical-align:middle}
#menuBtn{position:relative}
#menuBtn.has::after{content:"";position:absolute;top:2px;right:0;width:10px;height:10px;border-radius:50%;background:#ff2a2a}
#admin[hidden]{display:none}
#admin{display:flex;flex-direction:column}
#members .ct{cursor:pointer}
```

Keep the `#dr a` rules; the `#ctx`, `#pal` and message rules are unchanged.

---

### Task 4: End-to-end check on this computer

**Files:** create `.dev.vars` (ignored by git); a Playwright script at `<scratchpad>/e2e.mjs`, outside the repo.

- [ ] **Step 1:** Create `.dev.vars` containing `SETUP_SECRET=local-only` and start `npx wrangler dev --port 8787` in the background.
- [ ] **Step 2:** Install Playwright in the scratchpad and run a script that, in separate browser contexts: creates the administrator with `POST /api/setup`; signs in as administrator; adds two members through the menu form; signs each in; sends a message from one and sees it appear on the other without reloading; checks the unread dot for a closed chat; edits and deletes a message by long-press; signs out; records any console errors or failed requests.
- [ ] **Step 3:** Save screenshots at phone size and look at them to check the design is intact. Fix anything found, re-run `npm test`, then stop the dev server.

---

### Task 5: Deploy to Cloudflare

- [ ] **Step 1:** Run `npm test`. All tests must pass.
- [ ] **Step 2:** Confirm no existing Worker is named `alice-chat`: `npx wrangler deployments list --name alice-chat`. If one exists, stop and ask the owner.
- [ ] **Step 3:** Run `npx wrangler deploy`. Note the `*.workers.dev` address.
- [ ] **Step 4:** Create the administrator. In one command, generate a random setup secret, store it with `wrangler secret put SETUP_SECRET`, call `POST /api/setup` with username `alice`, display name `Alice` and a random 6-digit PIN, then `wrangler secret delete SETUP_SECRET --force`. Never print the secret. Setup cannot be run again after this.
- [ ] **Step 5:** Run the Task 4 browser check against the live address using two temporary members, then remove those members.
- [ ] **Step 6:** Report the address and Alice's sign-in to the owner.
