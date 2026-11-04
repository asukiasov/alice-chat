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
