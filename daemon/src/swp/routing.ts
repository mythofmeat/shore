import type { CharacterInfo } from "../protocol/CharacterInfo";
import type { ClientMessage } from "../protocol/ClientMessage";
import type { ServerMessage } from "../protocol/ServerMessage";
import type { RequestKind, RequestMeta, RoutedMessage, SessionMeta } from "./session";
import { withSelectedCharacter } from "./session";

export function msgTypeName(msg: ClientMessage): string {
  return msg.type;
}

export function resolveHandshakeCharacter(
  requested: string | null,
  characters: readonly CharacterInfo[],
): string | null {
  if (requested !== null) {
    return characters.some((character) => character.name === requested) ? requested : null;
  }
  return characters.length === 1 ? (characters[0]?.name ?? null) : null;
}

export type RouteOutcome =
  | { readonly action: "route"; readonly routed: RoutedMessage }
  | { readonly action: "reply"; readonly reply: ServerMessage };

export function routeClientMessage(
  msg: ClientMessage,
  session: SessionMeta,
  character: string | null,
): RouteOutcome {
  if (msg.type === "hello") {
    return {
      action: "reply",
      reply: { type: "error", code: "protocol_error", message: "Duplicate hello" },
    };
  }

  const meta = (kind: RequestKind, rid: string | null): RequestMeta => ({
    session: withSelectedCharacter(session, character),
    rid,
    kind,
  });

  switch (msg.type) {
    case "message":
      return { action: "route", routed: { kind: "engine", msg, meta: meta("message", msg.rid ?? null) } };
    case "regen":
      return { action: "route", routed: { kind: "engine", msg, meta: meta("regen", msg.rid ?? null) } };
    case "cancel":
      return { action: "route", routed: { kind: "engine", msg, meta: meta("cancel", null) } };
    case "command":
      return {
        action: "route",
        routed: { kind: "command", cmd: msg, meta: meta("command", msg.rid ?? null) },
      };
  }
}

const UNCONDITIONAL_EVENTS = new Set(["hello", "shutdown", "ping", "cache_warning"]);

const UNROUTABLE_EVENTS = new Set(["unknown"]);

export function eventMatchesSession(
  msg: ServerMessage,
  selectedCharacter: string | null,
  sessionRegistered: boolean,
): boolean {
  if (UNROUTABLE_EVENTS.has(msg.type)) return false;
  if (UNCONDITIONAL_EVENTS.has(msg.type)) return true;
  if (!sessionRegistered || selectedCharacter === null) return false;
  if (msg.type === "history") return msg.selected_character === selectedCharacter;
  if (msg.type === "new_message") return msg.character === selectedCharacter;
  return sessionRegistered;
}
