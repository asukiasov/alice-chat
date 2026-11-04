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
  ws.addEventListener("message", (e) => { events.push(JSON.parse(e.data)); });
  ws.addEventListener("close", (e) => { closed.push(e.code); });
  return { status: 101, ws, events, closed };
}
