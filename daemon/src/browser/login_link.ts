export const DEFAULT_WEB_PORT = 7340;

export function loginLink(origin: string, code: string): string {
  return `${origin}/#login=${code}`;
}

export function loginCodeIn(hash: string): string | undefined {
  return /^#login=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1];
}

export function deviceOrigin(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url: URL;
  try { url = new URL(explicit ? trimmed : `http://${trimmed}`); } catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" || !["", "/"].includes(url.pathname) || url.search !== "" || url.hash !== "") return undefined;
  if (!explicit && url.port === "") url.port = String(DEFAULT_WEB_PORT);
  return url.origin;
}

export function loopbackOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}
