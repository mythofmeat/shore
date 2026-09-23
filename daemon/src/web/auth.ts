import { Cookie, CookieMap } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { sessionDigest, type WebRecovery } from "./recovery.ts";

export interface WebSession {
  readonly id: string;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
}

interface StoredSession extends WebSession {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
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
    this.#name = `${this.#secure ? "__Host-" : ""}shore_web_${createHash("sha256").update(origin).digest("hex").slice(0, 12)}`;
    this.#capacity = capacity;
    this.#lifetime = lifetime;
    for (const saved of recovery?.sessions() ?? []) {
      if (this.#sessions.size < capacity && /^[a-f0-9]{64}$/.test(saved.id) && Number.isSafeInteger(saved.expires_at) && saved.expires_at > Date.now()) this.#restore(saved.id, saved.expires_at);
      else recovery?.revokeSession(saved.id);
    }
  }

  read(request: Request): WebSession | undefined {
    const id = new CookieMap(request.headers.get("cookie") ?? "").get(this.#name);
    if (id === null || id === undefined || !/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
    return this.get(sessionDigest(id));
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

  #restore(id: string, expiresAt: number): WebSession {
    const controller = new AbortController();
    const session: StoredSession = {
      id, controller, signal: controller.signal,
      expiresAt,
      timer: setTimeout(() => { this.revoke(session); }, Math.max(1, expiresAt - Date.now())),
    };
    this.#sessions.set(id, session);
    return session;
  }

  cookie(session?: WebSession): string {
    const token = session === undefined ? "" : this.#cookies.get(session.id);
    if (token === undefined) throw new Error("Only a new browser sign-in can issue a cookie");
    return new Cookie(this.#name, token, {
      httpOnly: true, sameSite: "strict", secure: this.#secure, path: "/",
      ...(session === undefined ? { maxAge: 0 } : { expires: new Date(session.expiresAt) }),
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
