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
