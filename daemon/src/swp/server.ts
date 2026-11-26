import { OutboundQueue, type QueueLimits } from "./outbound.ts";
import { contentForClient } from "./content_projection.ts";
import { HistoryMediaDelivery } from "./history_media.ts";
import { abortRejection } from "../llm/abort.ts";

import type { CharacterInfo } from "../protocol/CharacterInfo";
import type { ClientMessage } from "../protocol/ClientMessage";
import type { ServerMessage } from "../protocol/ServerMessage";
import { AdmissionError, admitCapabilities, admitClientMessage } from "./admission.ts";
import { Broadcast } from "./broadcast";
import {
  DEFAULT_HANDSHAKE,
  historyMessage,
  type HandshakeProvider,
  type HistorySnapshot,
  type Logger,
  type Selection,
} from "./handshake.ts";
import {
  resolveHandshakeCharacter,
  routeClientMessage,
  sessionReceives,
} from "./routing";
import {
  sessionMetaOf,
  SessionRouter,
  type ClientInfo,
  type RoutedMessage,
  type SessionMeta,
} from "./session";

export interface ServerConfig {
  readonly handshake?: HandshakeProvider;
  readonly log?: Logger;
}

class RouteQueue {
  readonly #items: RoutedMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(msg: RoutedMessage): void {
    this.#items.push(msg);
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  close(): void {
    this.#closed = true;
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async *drain(): AsyncGenerator<RoutedMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

export interface LocalClientOptions {
  readonly archiveLimits?: import("../commands/archive.ts").ArchiveLimits;
  readonly clientType: string;
  readonly clientName: string;
  readonly capabilities?: readonly string[];
  readonly owner?: string;
  readonly character?: string | null | undefined;
  readonly thread?: string | undefined;
  readonly history?: boolean;
  readonly broadcasts?: boolean;
  readonly onLag?: (skipped: number) => void;
  readonly signal?: AbortSignal;
  readonly prepareMessage?: (message: ServerMessage) => ServerMessage;
  readonly outboundLimits?: QueueLimits & {
    readonly onOverflow: () => void;
  };
}

export interface LocalPeer {
  readonly session: SessionMeta;
  readonly characters: readonly CharacterInfo[];
  readonly history: HistorySnapshot | undefined;
  send(msg: ClientMessage, beforeDispatch?: () => void): Promise<void>;
  events(): AsyncGenerator<ServerMessage, void>;
  detach(): Promise<void>;
}

async function whileAttached<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const rejection = abortRejection(signal);
  try {
    return await Promise.race([work, rejection.promise]);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    rejection.dispose();
  }
}

class Inbox {
  readonly #queue: OutboundQueue;
  #wake: (() => void) | null = null;
  #closed = false;

  constructor(limits: LocalClientOptions["outboundLimits"]) {
    this.#queue = new OutboundQueue(limits);
  }

  push(msg: ServerMessage, catchUp?: boolean): boolean {
    if (this.#closed) return true;
    if (!this.#queue.push(msg, catchUp)) return false;
    this.#wake?.();
    return true;
  }

  close(discard = false): void {
    this.#closed = true;
    if (discard) {
      this.#queue.clear();
    }
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async *drain(): AsyncGenerator<ServerMessage, void> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

export class Server {
  readonly #config: ServerConfig;
  readonly #router = new SessionRouter();
  readonly #events = new Broadcast();
  readonly #routes = new RouteQueue();
  readonly #stopController = new AbortController();
  #handshake: HandshakeProvider | undefined;
  #nextId = 1;

  constructor(config: ServerConfig = {}) {
    this.#config = config;
    this.#handshake = config.handshake;
  }

  setHandshakeProvider(handshake: HandshakeProvider): void {
    this.#handshake = handshake;
  }

  get sessionRouter(): SessionRouter {
    return this.#router;
  }

  async characters(): Promise<readonly CharacterInfo[]> {
    const provider = this.#handshake ?? DEFAULT_HANDSHAKE;
    return (await provider.hello()).characters;
  }

  async selection(character: string | null | undefined, thread: string | undefined): Promise<Selection & { readonly characters: readonly CharacterInfo[] }> {
    const provider = this.#handshake ?? DEFAULT_HANDSHAKE;
    const { characters } = await provider.hello();
    const resolved = character === null ? null : resolveHandshakeCharacter(character ?? null, characters);
    return { characters, ...await provider.select(resolved, thread ?? null) };
  }

  routes(): AsyncGenerator<RoutedMessage> {
    return this.#routes.drain();
  }

  broadcast(msg: ServerMessage): void {
    this.#events.send(msg);
  }

  async attachLocal(options: LocalClientOptions): Promise<LocalPeer> {
    const limits = options.outboundLimits;
    if (limits !== undefined && (!Number.isSafeInteger(limits.messages) || limits.messages < 1 ||
      !Number.isSafeInteger(limits.bytes) || limits.bytes < 1)) {
      throw new Error("Local outbound limits must be positive safe integers");
    }
    const signal = AbortSignal.any([this.#stopController.signal, ...(options.signal === undefined ? [] : [options.signal])]);
    const provider = this.#handshake ?? DEFAULT_HANDSHAKE;
    const hello = await whileAttached(provider.hello(), signal);
    const character = options.character === null ? null : resolveHandshakeCharacter(options.character ?? null, hello.characters);
    const history = options.history === false ? undefined : await whileAttached(provider.history(character, options.thread ?? null), signal);
    const selection = history === undefined
      ? await whileAttached(provider.select(character, options.thread ?? null), signal)
      : { character: history.selectedCharacter, thread: history.selectedThread };
    signal.throwIfAborted();

    const clientId = this.#nextId;
    this.#nextId += 1;
    const capabilities = admitCapabilities(options.capabilities ?? []);
    const client: ClientInfo = {
      ...(options.archiveLimits === undefined ? {} : { archiveLimits: options.archiveLimits }),
      id: clientId,
      clientType: options.clientType,
      clientName: options.clientName,
      capabilities,
      ...(options.owner === undefined ? {} : { owner: options.owner }),
      character: selection.character,
      thread: selection.thread,
    };

    const inbox = new Inbox(limits);
    const media = new HistoryMediaDelivery();
    const subscription = options.broadcasts === false ? undefined : this.#events.subscribe(limits, this.#queuedFor(clientId));
    let detached = false;
    let detachment: Promise<void> | undefined;
    const detach = (): Promise<void> => {
      if (detachment !== undefined) return detachment;
      detached = true;
      inbox.close(true);
      subscription?.unsubscribe();
      this.#router.unregisterSession(clientId);
      this.#config.log?.info?.("Local client detached", { client_id: clientId });
      detachment = this.#route({ kind: "session_disconnected", sessionId: clientId });
      return detachment;
    };
    const aborted = (): void => {
      void detach().catch((error: unknown) => {
        this.#config.log?.warn?.("Local client cleanup failed", { client_id: clientId, error: String(error) });
      });
    };
    const deliver = (msg: ServerMessage, catchUp?: boolean): void => {
      if (detached) return;
      const prepared = options.prepareMessage?.(msg) ?? msg;
      if (!inbox.push(media.prepare(contentForClient(prepared, capabilities)), catchUp)) {
        aborted();
        limits?.onOverflow();
      }
    };
    this.#router.registerSession(client, async (msg, catchUp) => {
      deliver(msg, catchUp);
    });
    signal.addEventListener("abort", aborted);
    if (history !== undefined) deliver(historyMessage(history), true);

    if (subscription !== undefined) void (async () => {
      for (let result = await subscription.recv(); result.kind !== "closed"; result = await subscription.recv()) {
        if (result.kind === "lagged") {
          options.onLag?.(result.skipped);
          this.#config.log?.warn?.("Local client lagged on broadcast", {
            client_id: clientId,
            skipped: result.skipped,
          });
          if (limits !== undefined) {
            aborted();
            limits.onOverflow();
          }
        } else if (sessionReceives(this.#router, clientId, result.msg)) {
          const message = result.msg.type === "history" && (result.msg.delta !== undefined && result.msg.delta !== null) && !capabilities.includes("history-deltas")
            ? historyMessage(await whileAttached(provider.history(result.msg.selected_character ?? null, result.msg.selected_thread ?? null), signal))
            : result.msg;
          if (sessionReceives(this.#router, clientId, message)) deliver(message);
        }
      }
    })().catch((error: unknown) => {
      if (!detached) this.#config.log?.warn?.("Local client event relay failed", { client_id: clientId, error: String(error) });
      aborted();
    });

    if (!detached) await this.#route({ kind: "session_connected", sessionId: clientId });

    this.#config.log?.info?.("Local client attached", {
      client_id: clientId,
      client_name: options.clientName,
    });

    return {
      session: sessionMetaOf(client),
      characters: hello.characters,
      history,
      send: async (msg, beforeDispatch) => {
        if (detached) throw new Error("Local peer is detached");
        let admitted: ClientMessage;
        try {
          admitted = admitClientMessage(msg);
        } catch (e) {
          if (!(e instanceof AdmissionError)) throw e;
          deliver({ type: "error", code: "invalid_request", message: e.message });
          return;
        }
        const outcome = routeClientMessage(
          admitted,
          sessionMetaOf(client),
          this.#router.characterFor(clientId),
        );
        if (outcome.action === "reply") deliver(outcome.reply);
        else { beforeDispatch?.(); await this.#route(outcome.routed); }
      },
      events: () => inbox.drain(),
      detach,
    };
  }

  stopped(): Promise<void> {
    const signal = this.#stopController.signal;
    return signal.aborted ? Promise.resolve() : new Promise((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
  }

  stop(): void {
    if (this.#stopController.signal.aborted) return;
    this.#config.log?.info?.("Server shutting down");
    this.#stopController.abort();
    this.#routes.close();
  }

  #queuedFor(clientId: number): (msg: ServerMessage) => boolean {
    return (msg) => !this.#router.has(clientId) || sessionReceives(this.#router, clientId, msg);
  }

  async #route(msg: RoutedMessage): Promise<void> {
    this.#routes.push(msg);
  }
}
