import type { ServerMessage } from "../protocol/ServerMessage";
import type { DirectSender, RequestKind } from "../swp/session";

export const LEASE_TTL_MS = 60 * 60 * 1000;

interface Lease {
  readonly sessionId: number;
  readonly expiresAt: number;
}

export interface LeaseRouter {
  senderFor(sessionId: number): DirectSender | undefined;
}

interface LeaseLogger {
  error?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class StreamLeases {
  readonly #leases = new Map<string, Lease>();

  constructor(private readonly log?: LeaseLogger) {}

  observe(character: string, sessionId: number, kind: RequestKind, now = Date.now()): void {
    if (kind !== "message") return;
    this.#leases.set(character, { sessionId, expiresAt: now + LEASE_TTL_MS });
  }

  spectator(
    character: string,
    issuerSession: number,
    router: LeaseRouter,
    now = Date.now(),
  ): DirectSender | undefined {
    const lease = this.#leases.get(character);
    if (lease === undefined) return undefined;
    if (now >= lease.expiresAt) {
      this.#leases.delete(character);
      return undefined;
    }
    if (lease.sessionId === issuerSession) return undefined;
    const send = router.senderFor(lease.sessionId);
    if (send === undefined) this.#leases.delete(character);
    return send;
  }

  fanout(
    character: string,
    issuerSession: number,
    issuerSend: DirectSender,
    router: LeaseRouter,
    now = Date.now(),
  ): DirectSender {
    const spectatorSend = this.spectator(character, issuerSession, router, now);
    return async (msg: ServerMessage) => {
      if (spectatorSend !== undefined) {
        void sendObserved(spectatorSend, msg, this.log, "spectator");
      }
      await issuerSend(msg);
    };
  }

  clear(): void {
    this.#leases.clear();
  }
}

async function sendObserved(
  send: DirectSender,
  msg: ServerMessage,
  log: LeaseLogger | undefined,
  recipient: string,
): Promise<void> {
  try {
    await send(msg);
  } catch (error) {
    log?.error?.("failed to deliver stream frame", {
      recipient,
      frame_type: msg.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
