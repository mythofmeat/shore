import type { ServerMessage } from "../protocol/ServerMessage";
import type { DirectSender, RequestKind } from "../swp/session";

export const LEASE_TTL_MS = 60 * 60 * 1000;

interface Lease {
  readonly sessionId: number;
  readonly expiresAt: number;
}

export interface LeaseRouter {
  senderFor(sessionId: number): DirectSender | undefined;
  threadFor?(sessionId: number): string | null;
  characterFor?(sessionId: number): string | null;
}

interface LeaseLogger {
  error?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class StreamLeases {
  readonly #leases = new Map<string, Lease>();

  constructor(private readonly log?: LeaseLogger) {}

  observe(character: string, sessionId: number, kind: RequestKind, now = Date.now(), thread: string | null = null): void {
    if (kind !== "message") return;
    this.#leases.set(JSON.stringify([character, thread]), { sessionId, expiresAt: now + LEASE_TTL_MS });
  }

  spectator(
    character: string,
    issuerSession: number,
    router: LeaseRouter,
    now = Date.now(),
    thread: string | null = null,
  ): DirectSender | undefined {
    const key = JSON.stringify([character, thread]);
    const lease = this.#leases.get(key);
    if (lease === undefined) return undefined;
    if (now >= lease.expiresAt) {
      this.#leases.delete(key);
      return undefined;
    }
    if (lease.sessionId === issuerSession) return undefined;
    const send = router.senderFor(lease.sessionId);
    if (send === undefined) this.#leases.delete(key);
    if (send === undefined) return undefined;
    return async (msg) => {
      const selected = router.characterFor?.(lease.sessionId);
      if (selected !== undefined && selected !== null && selected !== character) return;
      if (router.threadFor !== undefined && router.threadFor(lease.sessionId) !== thread) return;
      await send(msg);
    };
  }

  fanout(
    character: string,
    issuerSession: number,
    issuerSend: DirectSender,
    router: LeaseRouter,
    now = Date.now(),
    thread: string | null = null,
  ): DirectSender {
    const spectatorSend = this.spectator(character, issuerSession, router, now, thread);
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
