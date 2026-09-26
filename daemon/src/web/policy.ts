import type { WebConfig } from "../config/app.ts";

export const WEB_LIMITS = {
  loginBytes: 4096,
  helloBytes: 64 * 1024,
  messageBytes: 32 * 1024 * 1024,
  queuedMessages: 128,
  pendingRequests: 32,
  requestsPerSecond: 128,
  loginAttemptsPerMinute: 60,
  handshakeTimeoutMs: 10_000,
  drainTimeoutMs: 10_000,
} as const;

export function webBinding(config: WebConfig): { hostname: string; port: number; secure: boolean } {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(config.bind_addr);
  if (match === null) throw new Error("daemon.web.bind_addr must be host:port");
  const hostname = (match[1] ?? "").replace(/^\[|\]$/g, "");
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid daemon.web port");
  const tls = config.tls_key !== undefined && config.tls_cert !== undefined;
  if ((config.tls_key === undefined) !== (config.tls_cert === undefined)) throw new Error("Set both daemon.web.tls_cert and daemon.web.tls_key");
  if (!Number.isSafeInteger(config.max_connections) || config.max_connections < 1 || config.max_connections > 256) {
    throw new Error("daemon.web.max_connections must be between 1 and 256");
  }
  if (!Number.isSafeInteger(config.max_queued_bytes) || config.max_queued_bytes < 1024 || config.max_queued_bytes > 128 * 1024 * 1024) {
    throw new Error("daemon.web.max_queued_bytes must be between 1024 and 134217728");
  }
  const lifetime = config.session_lifetime.asMillisExact();
  if (lifetime < 60_000n || lifetime > 365n * 86_400_000n) throw new Error("daemon.web.session_lifetime must be between 1m and 365d");
  let origin: URL | undefined;
  if (config.public_origin !== undefined) {
    origin = new URL(config.public_origin);
    if (origin.origin !== config.public_origin || !["http:", "https:"].includes(origin.protocol)) {
      throw new Error("daemon.web.public_origin must be an exact HTTP(S) origin without a path");
    }
  }
  return { hostname, port, secure: tls || origin?.protocol === "https:" };
}

export function webRequestOrigin(url: URL, publicOrigin: string | undefined): string {
  return publicOrigin !== undefined && url.host === new URL(publicOrigin).host ? publicOrigin : url.origin;
}

export function sameOrigin(request: Request, origin: string): boolean {
  return request.headers.get("origin") === origin &&
    new URL(request.url).host === new URL(origin).host &&
    !["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "");
}

export function securityHeaders(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  });
}

export class WebBodyTooLarge extends Error {
  constructor() { super("Request body is too large"); }
}

export async function readSmallJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("Expected application/json");
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) throw new WebBodyTooLarge();
  const reader = request.body?.getReader();
  if (reader === undefined) throw new Error("Expected a JSON body");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("Expected a byte stream");
      bytes += chunk.byteLength;
      if (bytes > limit) throw new WebBodyTooLarge();
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
