# Alice Chat: infrastructure design

## Goal

Make Alice's existing `index.html` a real web chat for 5-10 friends, using only free tiers. Private 1-to-1 text chats, delivered instantly between devices. The visual design stays as it is except where this document says otherwise.

## Architecture

One Cloudflare Worker on the Workers Free plan, published at a `*.workers.dev` address.

- **Static assets:** `public/index.html` (Alice's page, moved from the repo root) is served for free as a static asset.
- **Worker:** routes `/api/*` and `/ws` to the Durable Object.
- **One Durable Object, `ChatHub`, SQLite-backed:** a single named instance (`idFromName("main")`) holds all data and all WebSocket connections. It uses the WebSocket Hibernation API so idle connections incur no duration usage.

Free-plan limits that apply: 100,000 requests/day (shared across the Cloudflare account), 13,000 GB-s/day of Durable Object duration, 1 GB per Durable Object. Exceeding a limit causes errors until 00:00 UTC, never a charge.

## Data model

- `members`: `username` (primary key, trimmed and lowercased), `display_name`, `pin_hash`, `pin_salt`, `is_admin`, `failed_attempts`, `locked_until`, `created_at`
- `sessions`: `token_hash` (primary key), `username`, `created_at`
- `messages`: `id` (autoincrement primary key), `chat_id`, `sender`, `text`, `created_at`, `edited_at`

`chat_id` is the two usernames sorted and joined with `\n`, so a pair of members always has exactly one chat. Messages are indexed by `(chat_id, id)`.

## Validation

- Username: 1-32 characters after trimming and lowercasing; letters of any alphabet, digits, `_`, `-`, `+`. This allows names, phone numbers and IDs.
- Display name: 1-50 characters.
- PIN: 4-8 digits.
- Message: 1-2000 characters after trimming.

## Authentication

- **First administrator:** `POST /api/setup` takes the `SETUP_SECRET` Worker secret plus username, display name and PIN. It works only while `members` is empty.
- **Members:** only an administrator can create accounts. There is no self-registration.
- **PIN storage:** PBKDF2-SHA256, 100,000 iterations, random per-member salt.
- **Lockout:** 5 consecutive wrong PINs locks the username for 15 minutes. Unknown usernames return the same error as wrong PINs.
- **Sessions:** login creates a random 32-byte token. The browser holds it in a cookie (`HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`); the server stores only its SHA-256 hash.
- **WebSocket:** authenticated by the same cookie, and the upgrade is rejected unless `Origin` matches the Worker's own host.
- **Resetting a PIN or removing a member** deletes that member's sessions and closes their sockets.

## HTTP API

All bodies are JSON. Errors return `{ "error": "<code>" }` with a 4xx status.

| Method and path | Who | Purpose |
|---|---|---|
| `POST /api/setup` | Holder of setup secret | Create first administrator |
| `POST /api/login` | Anyone | Sign in with username and PIN |
| `POST /api/logout` | Member | End this session |
| `GET /api/me` | Member | Current member |
| `GET /api/members` | Member | All members (username, display name, latest message id and sender of your chat with them) |
| `GET /api/chats/:username/messages?before=<id>` | Member | Latest 100 messages with that member, oldest first; `before` pages further back |
| `POST /api/chats/:username/messages` | Member | Send a message |
| `PATCH /api/messages/:id` | Sender only | Edit own message |
| `DELETE /api/messages/:id` | Sender only | Delete own message |
| `POST /api/admin/members` | Administrator | Add a member |
| `POST /api/admin/members/:username/pin` | Administrator | Reset a PIN |
| `DELETE /api/admin/members/:username` | Administrator | Remove a member and all chats they took part in |

An administrator cannot remove their own account. Administrators have no endpoint that reads other members' messages.

## Real-time events

`GET /ws` opens a WebSocket. The server sends JSON events only to the two participants of the chat concerned (a member may have several open devices):

- `{ "type": "message.new", "message": {...} }`
- `{ "type": "message.edit", "message": {...} }`
- `{ "type": "message.delete", "id": <id>, "chatWith": "<username>" }`
- `{ "type": "members.changed" }`, sent to everyone when the member list changes

Clients send nothing over the socket; all writes go through HTTP. On disconnect the client reconnects with increasing delay (1 s up to 30 s) and reloads the open chat, so nothing is missed. It also reconnects when the page becomes visible again, which matters on phones.

## Page changes (`public/index.html`)

Kept: bubbles, colours, long-press menu, layout, Russian text.

- **Sign-in screen:** username and PIN, shown when `GET /api/me` returns 401.
- **Menu:** lists members from the server. Tapping one opens that chat. Adds a "sign out" item.
- **Header:** shows the name of the person you are chatting with.
- **Empty state:** with no chat open, the page asks the user to pick a friend from the menu.
- **Admin section:** visible to administrators only, in the menu: add member, reset any PIN including their own, remove member (long-press a member).
- **Unread dots:** a dot on a member in the menu and on the menu button when that chat has a newer message from them. `GET /api/members` returns `lastMessageId` and `lastSender` per chat; the last-read id is stored per browser in `localStorage`, so a new device shows existing chats as unread.
- **Older messages:** scrolling to the top of a chat loads the previous 100.
- **Page logic** moves from an inline script to `public/app.js`.
- **Message layer:** the `claude.use('db')` code and the local fallback are replaced with calls to the API above.
- **Removed:** the "new chat" number keypad and the phone-only contact list (`localStorage` key `cts`), replaced by the member list.
- **Unchanged and still non-functional:** the voice recording control and the + button.

## Error handling

- A failed send restores the text to the input box and shows a short message in the `#note` area.
- A 401 from any call returns the user to the sign-in screen.
- `SQLITE_FULL` or exhausted free-tier limits show the same send failure; nothing is lost that was already stored.

## Testing

- **Automated:** Vitest with `@cloudflare/vitest-pool-workers`, covering login, lockout, administrator-only routes, setup locking itself after first use, chat privacy (a third member cannot read or modify a chat), and WebSocket delivery to the correct members only.
- **Local end-to-end:** two browser sessions against `wrangler dev`, confirming a message appears on the other side without reloading.
- **After deployment:** the same two-session check against the live address.

## Out of scope for this version

Push notifications, voice messages, attachments, the + button, group chats, read receipts, typing indicators, end-to-end encryption, a custom domain.

## Known limitations

- Whoever controls the Cloudflare account could technically read stored messages.
- Usernames are not verified; a phone number used as a username is only a label.
- No notifications arrive while the app is closed.
