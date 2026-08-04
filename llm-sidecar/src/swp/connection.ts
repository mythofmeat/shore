/**
 * One client connection: the SWP handshake, then the message loop.
 *
 * Ported from `perform_handshake`, `handle_client` and `message_loop` in
 * `crates/daemon/src/swp_server/mod.rs`, pinned by
 * `tests/swp_fixtures/swp_parity.json`.
 *
 * # The per-session queue is gone
 *
 * The Rust gives every connection an `mpsc::channel(256)` so that other tasks
 * can send it a frame: the socket writer is owned by the connection's task and
 * nothing else can touch it, so a "direct" send has to be a message to that
 * task. Here the router writes to the socket itself, through
 * {@link serialSink}, which serializes concurrent writes onto one promise
 * chain. That preserves the two properties the channel was providing —
 * frames never interleave mid-line, and ordering is stable — without the
 * queue.
 *
 * One arm of the Rust's `select!` disappears with it: `direct_rx.recv()`
 * returning `None` broke the loop when every sender had been dropped. The only
 * way that happened was the session being unregistered, which already means
 * the connection is finished, so nothing observable is lost.
 *
 * The 256-frame bound is *not* lost — it lives on the broadcast side, where it
 * is what the lag policy is built on. The direct path was never the one a slow
 * client could flood.
 */

import type { CharacterInfo } from "../protocol/CharacterInfo";
import type { ClientMessage } from "../protocol/ClientMessage";
import type { Message } from "../protocol/Message";
import type { ServerMessage } from "../protocol/ServerMessage";
import type { RecvResult, Subscription } from "./broadcast";
import { WireReader, writeMessage, type ByteSink } from "./framing";
import { eventMatchesSession, msgTypeName, resolveHandshakeCharacter, routeClientMessage } from "./routing";
import { sessionMetaOf, type ClientInfo, type RoutedMessage, type SessionMeta, type SessionRouter } from "./session";

/** Mirrors `SWP_V1` in `crates/common/src/protocol/mod.rs`. */
export const SWP_V1 = 1;

/** Mirrors `PING_INTERVAL`. */
export const PING_INTERVAL_MS = 30_000;

/** Mirrors `MAX_CONSECUTIVE_LAGS` in `message_loop`. */
export const MAX_CONSECUTIVE_LAGS = 3;

/** What the handshake advertises before the client has chosen a character. */
export interface HelloSnapshot {
  readonly characters: readonly CharacterInfo[];
}

/** The conversation state a client receives on connect. */
export interface HistorySnapshot {
  readonly messages: readonly Message[];
  readonly activeStart: number;
  readonly config: unknown;
  readonly selectedCharacter: string | null;
  readonly revision: number;
}

/**
 * Supplies the two snapshots the handshake needs.
 *
 * The Rust models this as a pair of boxed async closures behind `Arc`, which
 * is how you pass an async callback across task boundaries in Rust and carries
 * no meaning of its own. An interface says the same thing here.
 */
export interface HandshakeProvider {
  hello(): Promise<HelloSnapshot>;
  history(selectedCharacter: string | null): Promise<HistorySnapshot>;
}

/**
 * The fallback used when no provider is wired.
 *
 * The Rust defaults to a single character literally named `default` and an
 * empty history. It is what a daemon with no character configuration serves,
 * and it keeps the transport testable without the rest of the daemon.
 */
export const DEFAULT_HANDSHAKE: HandshakeProvider = {
  hello: () => Promise.resolve({ characters: [{ name: "default" }] }),
  history: (selectedCharacter) =>
    Promise.resolve({ messages: [], activeStart: 0, config: {}, selectedCharacter, revision: 0 }),
};

/** A bidirectional byte stream — a TCP socket, or a test double. */
export interface Duplex {
  readonly input: AsyncIterable<Uint8Array>;
  readonly output: ByteSink;
}

/** Everything one connection needs from the server around it. */
export interface ConnectionContext {
  readonly clientId: number;
  readonly serverName: string;
  readonly router: SessionRouter;
  readonly events: Subscription;
  readonly handshake: HandshakeProvider;
  /** Hand a routed message downstream. */
  readonly route: (msg: RoutedMessage) => Promise<void>;
  /** Resolves when the daemon is shutting down. */
  readonly shutdown: Promise<void>;
  readonly pingIntervalMs?: number;
  readonly log?: Logger;
}

export interface Logger {
  info?(msg: string, fields?: Record<string, unknown>): void;
  warn?(msg: string, fields?: Record<string, unknown>): void;
}

/** Raised when the client breaks the protocol during the handshake. */
export class HandshakeError extends Error {
  override readonly name = "HandshakeError";
}

/**
 * Serialize concurrent writes onto one promise chain.
 *
 * Without this, a broadcast frame and a direct frame written at the same time
 * could interleave their bytes and produce a line no client can parse.
 */
export function serialSink(inner: ByteSink): ByteSink {
  let tail: Promise<void> = Promise.resolve();
  return {
    write(bytes: Uint8Array): Promise<void> {
      tail = tail.then(
        () => inner.write(bytes),
        () => inner.write(bytes),
      );
      return tail;
    },
  };
}

/**
 * Perform the SWP handshake: server hello, client hello, then history.
 *
 * The order matters and is not arbitrary. The server sends its hello — and the
 * character list — *first*, so the client can name a character it learned
 * about in the same exchange. History comes last because which history to send
 * is not known until the character resolves.
 */
export async function performHandshake(
  reader: WireReader,
  sink: ByteSink,
  ctx: ConnectionContext,
): Promise<SessionMeta> {
  const hello = await ctx.handshake.hello();

  await writeMessage(sink, {
    type: "hello",
    v: SWP_V1,
    server_name: ctx.serverName,
    characters: hello.characters as CharacterInfo[],
  });

  const first = await reader.readMessage();
  if (first === null) {
    throw new HandshakeError("Client disconnected before hello");
  }
  if (first.type !== "hello") {
    // The `{:?}` in the Rust's `format!` quotes the variant name, so the
    // client sees `Expected hello, got "message"` — quotes included.
    await writeMessage(sink, {
      type: "error",
      code: "protocol_error",
      message: `Expected hello, got ${JSON.stringify(msgTypeName(first))}`,
    });
    throw new HandshakeError("Protocol error: expected hello");
  }

  const requested = first.character ?? null;
  const selected = resolveHandshakeCharacter(requested, hello.characters);
  if (requested !== null && selected === null) {
    ctx.log?.warn?.("Ignoring unknown connect-time character selection", { requested });
  }

  const history = await ctx.handshake.history(selected);

  const client: ClientInfo = {
    id: ctx.clientId,
    clientType: first.client_type,
    clientName: first.client_name,
    capabilities: first.capabilities ?? [],
    character: history.selectedCharacter,
  };
  ctx.router.registerSession(client, (msg) => writeMessage(sink, msg));

  await writeMessage(sink, historyMessage(history));

  return sessionMetaOf(client);
}

/**
 * A snapshot as the frame that carries it.
 *
 * Field order and omission both follow serde. `active_start` is skipped at zero
 * (`skip_serializing_if = "is_zero"`), not just when absent, and a handshake
 * snapshot is always zero — so the field is normally not on the wire at all.
 *
 * Shared with `handler/command_dispatch.ts`, which pushes one of these after a
 * `switch_character` so the session sees the new character's conversation
 * rather than the old one's. That push carries the command's `rid`; the
 * handshake's does not, because nothing asked for it.
 */
export function historyMessage(history: HistorySnapshot, rid?: string): ServerMessage {
  return {
    type: "history",
    ...(rid === undefined ? {} : { rid }),
    messages: history.messages as Message[],
    ...(history.activeStart === 0 ? {} : { active_start: history.activeStart }),
    config: history.config,
    ...(history.selectedCharacter === null
      ? {}
      : { selected_character: history.selectedCharacter }),
    revision: history.revision,
  };
}

/**
 * Handle one connection end to end.
 *
 * Always unregisters the session, and reports `AllClientsDisconnected` when it
 * was the last one, whether the connection ended cleanly or by error — the
 * Rust does this after `message_loop` returns, before propagating its result.
 */
export async function handleConnection(duplex: Duplex, ctx: ConnectionContext): Promise<void> {
  const sink = serialSink(duplex.output);
  const reader = new WireReader(duplex.input);
  let session: SessionMeta | null = null;

  try {
    session = await performHandshake(reader, sink, ctx);
    await messageLoop(reader, sink, session, ctx);
  } finally {
    ctx.events.unsubscribe();
    if (session !== null) {
      const { allGone } = ctx.router.unregisterSession(session.sessionId);
      ctx.log?.info?.("Client disconnected", { client_id: ctx.clientId });
      if (allGone) {
        await ctx.route({ kind: "all_clients_disconnected" });
      }
    }
  }
}

type LoopWake =
  | { readonly src: "client"; readonly value: ClientMessage | null }
  | { readonly src: "ping" }
  | { readonly src: "event"; readonly value: RecvResult }
  | { readonly src: "shutdown" };

/**
 * Read frames, forward events, and ping, until any of them says to stop.
 *
 * Each source keeps one pending promise across iterations and only the source
 * that fired is re-armed. Racing freshly-created promises each time would drop
 * whatever the losers had already resolved with — for the client reader that
 * would mean silently losing a frame.
 */
export async function messageLoop(
  reader: WireReader,
  sink: ByteSink,
  session: SessionMeta,
  ctx: ConnectionContext,
): Promise<void> {
  const period = ctx.pingIntervalMs ?? PING_INTERVAL_MS;
  const started = Date.now();
  let tick = 1;
  let consecutiveLags = 0;

  let pendingClient: Promise<LoopWake> | null = null;
  let pendingEvent: Promise<LoopWake> | null = null;
  let pendingPing: Promise<LoopWake> | null = null;
  const pendingShutdown: Promise<LoopWake> = ctx.shutdown.then(() => ({ src: "shutdown" }) as const);

  for (;;) {
    pendingClient ??= reader.readMessage().then((value) => ({ src: "client", value }) as const);
    pendingEvent ??= ctx.events.recv().then((value) => ({ src: "event", value }) as const);
    pendingPing ??= sleepUntil(nextTick(started, period, tick)).then(() => ({ src: "ping" }) as const);

    const wake = await Promise.race([pendingClient, pendingEvent, pendingPing, pendingShutdown]);

    switch (wake.src) {
      case "client": {
        pendingClient = null;
        if (wake.value === null) return; // clean EOF — client closed
        const outcome = routeClientMessage(
          wake.value,
          session,
          ctx.router.characterFor(session.sessionId),
        );
        if (outcome.action === "reply") {
          await writeMessage(sink, outcome.reply);
        } else {
          await ctx.route(outcome.routed);
        }
        break;
      }

      case "ping": {
        pendingPing = null;
        // `MissedTickBehavior::Skip`: advance to the next deadline strictly
        // after now, so a loop that stalled for five periods sends one ping
        // rather than five back to back.
        tick = ticksElapsed(started, period) + 1;
        await writeMessage(sink, { type: "ping" });
        break;
      }

      case "event": {
        pendingEvent = null;
        const result = wake.value;
        if (result.kind === "closed") return;
        if (result.kind === "lagged") {
          consecutiveLags += 1;
          ctx.log?.warn?.("Client lagged on broadcast", {
            client_id: ctx.clientId,
            skipped: result.skipped,
            consecutive: consecutiveLags,
          });
          if (consecutiveLags >= MAX_CONSECUTIVE_LAGS) {
            ctx.log?.warn?.("Disconnecting client after repeated lag", { client_id: ctx.clientId });
            return;
          }
          break;
        }
        // A successful receive clears the streak: the policy targets a client
        // that is persistently behind, not one that stalled once.
        consecutiveLags = 0;
        if (eventMatchesSession(result.msg, ctx.router.has(session.sessionId))) {
          await writeMessage(sink, result.msg);
        }
        break;
      }

      case "shutdown":
        return;
    }
  }
}

function ticksElapsed(started: number, period: number): number {
  return Math.floor((Date.now() - started) / period);
}

function nextTick(started: number, period: number, tick: number): number {
  return started + tick * period;
}

function sleepUntil(deadline: number): Promise<void> {
  const delay = Math.max(0, deadline - Date.now());
  return new Promise((resolve) => setTimeout(resolve, delay));
}
