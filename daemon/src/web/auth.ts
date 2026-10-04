import { Cookie, CookieMap } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { sessionDigest, type WebRecovery } from "./recovery.ts";

const MAX_TIMER_MS = 2 ** 31 - 1;

export interface WebSession {
  readonly id: string;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
}

interface StoredSession extends WebSession {
  expiresAt: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

export class WebSessions {
  readonly #sessions = new Map<string, StoredSession>();
  readonly #name: string;
  readonly #secure: boolean;
  readonly #capacity: number;
  readonly #lifetime: number;
  readonly #cookies = new Map<string, string>();
  #closed = false;

  constructor(origin: string, capacity: number, lifetime: number, readonly recovery?: WebRecovery) {
    this.#secure = origin.startsWith("https:");
    this.#name = `shore_web_${createHash("sha256").update(origin).digest("hex").slice(0, 12)}`;
    this.#capacity = capacity;
    this.#lifetime = lifetime;
    for (const saved of recovery?.sessions() ?? []) {
      if (this.#sessions.size < capacity && /^[a-f0-9]{64}$/.test(saved.id) && Number.isSafeInteger(saved.expires_at) && saved.expires_at > Date.now()) this.#restore(saved.id, saved.expires_at);
      else recovery?.revokeSession(saved.id);
    }
  }

  #presented(request: Request, secure: boolean): string | undefined {
    const token = new CookieMap(request.headers.get("cookie") ?? "").get(`${secure ? "__Host-" : ""}${this.#name}`);
    return token === null || token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token) ? undefined : token;
  }

  read(request: Request, secure = this.#secure): WebSession | undefined {
    const token = this.#presented(request, secure);
    return token === undefined ? undefined : this.get(sessionDigest(token));
  }

  get(id: string): WebSession | undefined {
    const session = this.#sessions.get(id);
    if (session !== undefined && session.expiresAt <= Date.now()) {
      this.revoke(session);
      return undefined;
    }
    return session;
  }

  create(): WebSession | undefined {
    if (this.#closed || this.#capacity < 1) return undefined;
    const token = randomBytes(32).toString("base64url");
    const id = sessionDigest(token);
    const expiresAt = Date.now() + this.#lifetime;
    this.recovery?.saveSession(id, expiresAt);
    while (this.#sessions.size >= this.#capacity) {
      const oldest = this.#sessions.values().next().value;
      if (oldest === undefined) break;
      this.revoke(oldest);
    }
    this.#cookies.set(id, token);
    return this.#restore(id, expiresAt);
  }

  renew(session: WebSession, request: Request, secure = this.#secure): string {
    const stored = this.#sessions.get(session.id);
    const token = this.#presented(request, secure);
    if (stored === undefined || token === undefined || sessionDigest(token) !== stored.id) throw new Error("Only the browser holding a sign-in can renew it");
    const expiresAt = Date.now() + this.#lifetime;
    this.recovery?.renewSession(stored.id, expiresAt);
    stored.expiresAt = expiresAt;
    clearTimeout(stored.timer);
    this.#arm(stored);
    return this.#cookie(token, expiresAt, secure);
  }

  #restore(id: string, expiresAt: number): WebSession {
    const controller = new AbortController();
    const session: StoredSession = { id, controller, signal: controller.signal, expiresAt };
    this.#arm(session);
    this.#sessions.set(id, session);
    return session;
  }

  #arm(session: StoredSession): void {
    const remaining = session.expiresAt - Date.now();
    session.timer = remaining <= MAX_TIMER_MS
      ? setTimeout(() => { this.revoke(session); }, Math.max(1, remaining))
      : setTimeout(() => { this.#arm(session); }, MAX_TIMER_MS);
  }

  cookie(session?: WebSession, secure = this.#secure): string {
    const token = session === undefined ? "" : this.#cookies.get(session.id);
    if (token === undefined) throw new Error("Only a new browser sign-in can issue a cookie");
    return this.#cookie(token, session?.expiresAt, secure);
  }

  #cookie(token: string, expiresAt: number | undefined, secure: boolean): string {
    return new Cookie(`${secure ? "__Host-" : ""}${this.#name}`, token, {
      httpOnly: true, sameSite: "strict", secure, path: "/",
      ...(expiresAt === undefined ? { maxAge: 0 } : { expires: new Date(expiresAt) }),
    }).toString();
  }

  revoke(session: WebSession): void {
    const stored = this.#sessions.get(session.id);
    if (stored === undefined) return;
    this.recovery?.revokeSession(session.id);
    this.#sessions.delete(session.id);
    this.#cookies.delete(session.id);
    clearTimeout(stored.timer);
    stored.controller.abort(new Error("Browser sign-in expired or was revoked"));
  }

  close(): void {
    this.#closed = true;
    for (const session of this.#sessions.values()) {
      clearTimeout(session.timer);
      session.controller.abort(new Error("Browser transport stopped"));
    }
    this.#sessions.clear(); this.#cookies.clear();
  }
}

export class LoginCodes {
  readonly #codes = new Map<string, number>();

  constructor(readonly lifetime: number, readonly capacity: number) {}

  create(): { code: string; expiresAt: number } {
    const now = Date.now();
    for (const [id, expiresAt] of this.#codes) if (expiresAt <= now) this.#codes.delete(id);
    while (this.#codes.size >= this.capacity) {
      const oldest = this.#codes.keys().next().value;
      if (oldest === undefined) break;
      this.#codes.delete(oldest);
    }
    const code = randomBytes(32).toString("base64url");
    const expiresAt = now + this.lifetime;
    this.#codes.set(sessionDigest(code), expiresAt);
    return { code, expiresAt };
  }

  redeem(code: string): boolean {
    const id = sessionDigest(code);
    const expiresAt = this.#codes.get(id);
    this.#codes.delete(id);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  clear(): void { this.#codes.clear(); }
}
