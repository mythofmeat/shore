import type { ClientMessage } from "../protocol/ClientMessage";
import type { Command } from "../protocol/Command";
import type { ServerMessage } from "../protocol/ServerMessage";

export type RequestKind = "message" | "regen" | "command" | "cancel";

export const ALL_CHARACTERS_CAPABILITY = "all_characters";

export interface ClientInfo {
  readonly id: number;
  readonly clientType: string;
  readonly clientName: string;
  readonly capabilities: readonly string[];
  character: string | null;
  thread: string | null;
}

export interface SessionMeta {
  readonly clientId: number;
  readonly sessionId: number;
  readonly clientType: string;
  readonly clientName: string;
  readonly capabilities: readonly string[];
  readonly selectedCharacter: string | null;
  readonly selectedThread: string | null;
}

export interface RequestMeta {
  readonly session: SessionMeta;
  readonly rid: string | null;
  readonly kind: RequestKind;
}

export type RoutedMessage =
  | { readonly kind: "engine"; readonly msg: ClientMessage; readonly meta: RequestMeta }
  | { readonly kind: "command"; readonly cmd: Command; readonly meta: RequestMeta }
  | { readonly kind: "session_disconnected"; readonly sessionId: number }
  | { readonly kind: "all_clients_disconnected" };

export type ControlRoutedMessage =
  | {
      readonly kind: "engine";
      readonly msg: Extract<ClientMessage, { readonly type: "cancel" }>;
      readonly meta: RequestMeta;
    }
  | { readonly kind: "session_disconnected"; readonly sessionId: number }
  | { readonly kind: "all_clients_disconnected" };

export function isControlRoutedMessage(msg: RoutedMessage): msg is ControlRoutedMessage {
  return msg.kind === "all_clients_disconnected" ||
    msg.kind === "session_disconnected" ||
    (msg.kind === "engine" && msg.msg.type === "cancel");
}

export function sessionMetaOf(client: ClientInfo): SessionMeta {
  return {
    clientId: client.id,
    sessionId: client.id,
    clientType: client.clientType,
    clientName: client.clientName,
    capabilities: [...client.capabilities],
    selectedCharacter: client.character,
    selectedThread: client.thread,
  };
}

export function withSelectedCharacter(
  session: SessionMeta,
  selectedCharacter: string | null,
): SessionMeta {
  return session.selectedCharacter === selectedCharacter
    ? session
    : { ...session, selectedCharacter, selectedThread: null };
}

export type DirectSender = (msg: ServerMessage) => Promise<void>;

export class SessionRouter {
  readonly #clients = new Map<number, ClientInfo>();
  readonly #senders = new Map<number, DirectSender>();

  registerSession(client: ClientInfo, send: DirectSender): void {
    this.#clients.set(client.id, client);
    this.#senders.set(client.id, send);
  }

  unregisterSession(sessionId: number): { readonly allGone: boolean } {
    this.#clients.delete(sessionId);
    this.#senders.delete(sessionId);
    return { allGone: this.#clients.size === 0 };
  }

  has(sessionId: number): boolean {
    return this.#clients.has(sessionId);
  }

  client(sessionId: number): ClientInfo | undefined {
    return this.#clients.get(sessionId);
  }

  characterFor(sessionId: number): string | null {
    return this.#clients.get(sessionId)?.character ?? null;
  }

  threadFor(sessionId: number): string | null {
    return this.#clients.get(sessionId)?.thread ?? null;
  }

  receivesAllCharacters(sessionId: number): boolean {
    return this.#clients.get(sessionId)?.capabilities.includes(ALL_CHARACTERS_CAPABILITY) ?? false;
  }

  senderFor(sessionId: number): DirectSender | undefined {
    return this.#senders.get(sessionId);
  }

  async sendToSession(sessionId: number, msg: ServerMessage): Promise<void> {
    await this.#senders.get(sessionId)?.(msg);
  }

  setSelectedCharacter(sessionId: number, selectedCharacter: string | null): boolean {
    const client = this.#clients.get(sessionId);
    if (client === undefined) return false;
    if (client.character !== selectedCharacter) client.thread = null;
    client.character = selectedCharacter;
    return true;
  }

  setSelectedThread(sessionId: number, selectedThread: string | null): boolean {
    const client = this.#clients.get(sessionId);
    if (client === undefined) return false;
    client.thread = selectedThread;
    return true;
  }

  sessions(): Array<readonly [number, string | null]> {
    return [...this.#clients.values()].map((client) => [client.id, client.character] as const);
  }
}
