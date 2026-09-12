import { Cookie, CookieMap } from "bun";
import { createHash, randomBytes } from "node:crypto";

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
  #closed = false;

  constructor(origin: string, capacity: number, lifetime: number) {
    this.#secure = origin.startsWith("https:");
    this.#name = `${this.#secure ? "__Host-" : ""}shore_web_${createHash("sha256").update(origin).digest("hex").slice(0, 12)}`;
    this.#capacity = capacity;
    this.#lifetime = lifetime;
  }

  read(request: Request): WebSession | undefined {
    const id = new CookieMap(request.headers.get("cookie") ?? "").get(this.#name);
    if (id === null || id === undefined || !/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
    const session = this.#sessions.get(id);
    if (session !== undefined && session.expiresAt <= Date.now()) {
      this.revoke(session);
      return undefined;
    }
    return session;
  }

  create(): WebSession | undefined {
    if (this.#closed || this.#sessions.size >= this.#capacity) return undefined;
    const id = randomBytes(32).toString("base64url");
    const controller = new AbortController();
    const session: StoredSession = {
      id, controller, signal: controller.signal,
      expiresAt: Date.now() + this.#lifetime,
      timer: setTimeout(() => { this.revoke(session); }, this.#lifetime),
    };
    this.#sessions.set(id, session);
    return session;
  }

  cookie(session?: WebSession): string {
    return new Cookie(this.#name, session?.id ?? "", {
      httpOnly: true, sameSite: "strict", secure: this.#secure, path: "/",
      ...(session === undefined ? { maxAge: 0 } : { expires: new Date(session.expiresAt) }),
    }).toString();
  }

  revoke(session: WebSession): void {
    const stored = this.#sessions.get(session.id);
    if (stored === undefined) return;
    this.#sessions.delete(session.id);
    clearTimeout(stored.timer);
    stored.controller.abort(new Error("Browser sign-in expired or was revoked"));
  }

  close(): void {
    this.#closed = true;
    for (const session of this.#sessions.values()) this.revoke(session);
  }
}
