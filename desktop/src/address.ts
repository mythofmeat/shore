export const DEFAULT_WEB_PORT = 7340;

export type ParsedAddress = { ok: true; origin: string } | { ok: false; message: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

export function parseAddress(input: string): ParsedAddress {
  const text = input.trim();
  if (text === "") return { ok: false, message: "Enter the address of the daemon's browser listener." };
  const explicit = SCHEME.test(text);
  let url: URL;
  try { url = new URL(explicit ? text : `http://${text}`); } catch { return { ok: false, message: "That isn't a valid address." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "Use an http:// or https:// address." };
  if (url.username !== "" || url.password !== "") return { ok: false, message: "Leave the user name and password out of the address. You sign in with the daemon's access token next." };
  if (!explicit && url.port === "") url.port = String(DEFAULT_WEB_PORT);
  return { ok: true, origin: url.origin };
}

export function sameOrigin(url: string, origin: string): boolean {
  try { return new URL(url).origin === origin; } catch { return false; }
}

export function needsSecureOverride(origin: string): boolean {
  const url = new URL(origin);
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  return !(host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || LOOPBACK_V4.test(host));
}

export function externalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}
