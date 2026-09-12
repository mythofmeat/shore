import { TOKEN_ENV, TOKEN_FILE } from "../config/token.ts";
import { setTimeout as timerDelay } from "node:timers/promises";
import type { CharacterInfo } from "../protocol/CharacterInfo";
import type { ClientMessage } from "../protocol/ClientMessage";
import type { Message } from "../protocol/Message";
import type { ServerMessage } from "../protocol/ServerMessage";
import type { RecvResult, Subscription } from "./broadcast";
import { AdmissionError, admitClientMessage } from "./admission.ts";
import {
  MAX_PRE_AUTH_WIRE_MESSAGE_SIZE,
  MAX_WIRE_MESSAGE_SIZE,
  WireError,
  WireReader,
  writeMessage,
  type ByteSink,
} from "./framing";
import {
  eventMatchesSession,
  msgTypeName,
  resolveHandshakeCharacter,
  routeClientMessage,
} from "./routing";
import { sessionMetaOf, type ClientInfo, type RoutedMessage, type SessionMeta, type SessionRouter } from "./session";

export const SWP_V1 = 1;

export const PING_INTERVAL_MS = 30_000;

export const MAX_CONSECUTIVE_LAGS = 3;

export interface HelloSnapshot {
  readonly characters: readonly CharacterInfo[];
  readonly selected?: string | undefined;
}

export interface HistorySnapshot {
  readonly messages: readonly Message[];
  readonly activeStart: number;
  readonly config: unknown;
  readonly selectedCharacter: string | null;
  readonly selectedThread: string | null;
  readonly revision: number;
}

export interface HandshakeProvider {
  hello(): Promise<HelloSnapshot>;
  history(selectedCharacter: string | null, selectedThread?: string | null): Promise<HistorySnapshot>;
}

export const DEFAULT_HANDSHAKE: HandshakeProvider = {
  hello: () => Promise.resolve({ characters: [{ name: "default" }] }),
  history: (selectedCharacter) =>
    Promise.resolve({
      messages: [],
      activeStart: 0,
      config: {},
      selectedCharacter,
      selectedThread: null,
      revision: 0,
    }),
};

export interface Duplex {
  readonly input: AsyncIterable<Uint8Array>;
  readonly output: ByteSink;
}

export interface ConnectionContext {
  readonly clientId: number;
  readonly serverName: string;
  readonly router: SessionRouter;
  readonly events: Subscription;
  readonly handshake: HandshakeProvider;
  readonly authenticate: (token: string | null | undefined) => boolean;
  readonly peer?: string;
  readonly route: (msg: RoutedMessage) => Promise<void>;
  readonly shutdown: Promise<void>;
  readonly pingIntervalMs?: number;
  readonly log?: Logger;
}

export interface Logger {
  info?(msg: string, fields?: Record<string, unknown>): void;
  warn?(msg: string, fields?: Record<string, unknown>): void;
  error?(msg: string, fields?: Record<string, unknown>): void;
}

class HandshakeError extends Error {
  override readonly name = "HandshakeError";
}

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
    await writeMessage(sink, {
      type: "error",
      code: "protocol_error",
      message: `Expected hello, got ${JSON.stringify(msgTypeName(first))}`,
    });
    throw new HandshakeError("Protocol error: expected hello");
  }

  if (!ctx.authenticate(first.token)) {
    ctx.log?.warn?.("Client rejected: bad or missing token", {
      addr: ctx.peer ?? "",
      client_name: first.client_name,
      had_token: first.token !== undefined && first.token !== null,
    });
    await writeMessage(sink, {
      type: "error",
      code: "unauthorized",
      message:
        first.token === undefined || first.token === null
          ? `This client sent no token. Set $${TOKEN_ENV}, or run it where it can read ${TOKEN_FILE} in the daemon's config directory.`
          : `The token this client sent was rejected. Check $${TOKEN_ENV}, or copy ${TOKEN_FILE} from the daemon's config directory.`,
    });
    throw new HandshakeError("Unauthorized: bad or missing token");
  }
  reader.setMaxMessageSize(MAX_WIRE_MESSAGE_SIZE);

  let admitted: ClientMessage;
  try {
    admitted = admitClientMessage(first);
  } catch (e) {
    if (!(e instanceof AdmissionError)) throw e;
    await writeMessage(sink, { type: "error", code: "invalid_request", message: e.message });
    throw new HandshakeError(e.message);
  }
  if (admitted.type !== "hello") throw new HandshakeError("Protocol error: expected hello");

  const requested = admitted.character ?? null;
  const selected = resolveHandshakeCharacter(requested, hello.characters, hello.selected ?? null);
  if (requested !== null && selected === null) {
    ctx.log?.warn?.("Connect-time character selection is not available", { requested });
  }

  const requestedThread = admitted.thread ?? null;

  let history: HistorySnapshot;
  try {
    history = await ctx.handshake.history(selected, requestedThread);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.log?.warn?.("Could not build the connect-time history snapshot", {
      requested: selected ?? "",
      error: message,
    });
    await writeMessage(sink, { type: "error", code: "internal_error", message });
    throw new HandshakeError(message);
  }

  const client: ClientInfo = {
    id: ctx.clientId,
    clientType: admitted.client_type,
    clientName: admitted.client_name,
    capabilities: admitted.capabilities,
    character: history.selectedCharacter,
    thread: history.selectedThread,
  };
  ctx.router.registerSession(client, (msg) => writeMessage(sink, msg));

  await writeMessage(sink, historyMessage(history));

  return sessionMetaOf(client);
}

export function historyMessage(history: HistorySnapshot, rid?: string): ServerMessage {
  return {
    type: "history",
    ...(rid === undefined ? {} : { rid }),
    messages: history.messages as Message[],
    ...(history.activeStart === 0 ? {} : { active_start: history.activeStart }),
    config: history.config,
    ...(history.selectedThread === null ? {} : { selected_thread: history.selectedThread }),
    ...(history.selectedCharacter === null
      ? {}
      : { selected_character: history.selectedCharacter }),
    revision: history.revision,
  };
}

export async function handleConnection(duplex: Duplex, ctx: ConnectionContext): Promise<void> {
  const sink = serialSink(duplex.output);
  const reader = new WireReader(duplex.input, MAX_PRE_AUTH_WIRE_MESSAGE_SIZE);
  let session: SessionMeta | null = null;

  try {
    session = await performHandshake(reader, sink, ctx);
    await messageLoop(reader, sink, session, ctx);
  } finally {
    ctx.events.unsubscribe();
    if (session !== null) {
      const { allGone } = ctx.router.unregisterSession(session.sessionId);
      ctx.log?.info?.("Client disconnected", { client_id: ctx.clientId });
      await ctx.route({ kind: "session_disconnected", sessionId: session.sessionId });
      if (allGone) {
        await ctx.route({ kind: "all_clients_disconnected" });
      }
    }
  }
}

type LoopWake =
  | { readonly src: "client"; readonly value: ClientMessage | null }
  | { readonly src: "client_error"; readonly error: unknown }
  | { readonly src: "ping" }
  | { readonly src: "event"; readonly value: RecvResult }
  | { readonly src: "shutdown" };

export async function messageLoop(
  reader: WireReader,
  sink: ByteSink,
  session: SessionMeta,
  ctx: ConnectionContext,
): Promise<void> {
  const lifetime = new AbortController();
  try { await runMessageLoop(reader, sink, session, ctx, lifetime.signal); }
  finally { lifetime.abort(); }
}

async function runMessageLoop(
  reader: WireReader,
  sink: ByteSink,
  session: SessionMeta,
  ctx: ConnectionContext,
  signal: AbortSignal,
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
    pendingClient ??= reader.readMessage().then(
      (value) => ({ src: "client", value }) as const,
      (error: unknown) => ({ src: "client_error", error }) as const,
    );
    pendingEvent ??= ctx.events.recv().then((value) => ({ src: "event", value }) as const);
    pendingPing ??= sleepUntil(nextTick(started, period, tick), signal).then(() => ({ src: "ping" }) as const);

    const wake = await Promise.race([pendingClient, pendingEvent, pendingPing, pendingShutdown]);

    switch (wake.src) {
      case "client": {
        pendingClient = null;
        if (wake.value === null) return;
        let admitted: ClientMessage;
        try {
          admitted = admitClientMessage(wake.value);
        } catch (e) {
          if (!(e instanceof AdmissionError)) throw e;
          await writeMessage(sink, { type: "error", code: "invalid_request", message: e.message });
          break;
        }
        const outcome = routeClientMessage(
          admitted,
          { ...session, selectedThread: ctx.router.threadFor(session.sessionId) },
          ctx.router.characterFor(session.sessionId),
        );
        if (outcome.action === "reply") {
          await writeMessage(sink, outcome.reply);
        } else {
          await ctx.route(outcome.routed);
        }
        break;
      }

      case "client_error":
        pendingClient = null;
        if (!(wake.error instanceof WireError)) throw wake.error;
        await writeMessage(sink, {
          type: "error",
          code: "invalid_request",
          message: wake.error.message,
        });
        break;

      case "ping": {
        pendingPing = null;
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
        consecutiveLags = 0;
        if (
          eventMatchesSession(
            result.msg,
            ctx.router.characterFor(session.sessionId),
            ctx.router.has(session.sessionId),
            ctx.router.receivesAllCharacters(session.sessionId),
            ctx.router.threadFor(session.sessionId),
          )
        ) {
          const message = result.msg.type === "history" && (result.msg.delta !== undefined && result.msg.delta !== null) && !session.capabilities.includes("history-deltas")
            ? historyMessage(await (ctx.handshake ?? DEFAULT_HANDSHAKE).history(result.msg.selected_character ?? null, result.msg.selected_thread ?? null))
            : result.msg;
          await writeMessage(sink, message);
        }
        break;
      }

      case "shutdown":
        await writeMessage(sink, { type: "shutdown" });
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

function sleepUntil(deadline: number, signal: AbortSignal): Promise<void> {
  const delay = Math.max(0, deadline - Date.now());
  return timerDelay(delay, undefined, { signal });
}
