/**
 * The transport's decisions: which character a handshake resolves to, where a
 * frame goes, and which sessions an event reaches.
 *
 * Ported from `resolve_handshake_character`, `route_client_message`,
 * `event_matches_session` and `msg_type_name` in
 * `crates/daemon/src/swp_server/mod.rs`, pinned by
 * `tests/swp_fixtures/swp_parity.json`.
 *
 * Everything here is a pure function. The Rust interleaved these decisions
 * with writing to the socket — `route_client_message` took the writer so it
 * could emit the duplicate-hello error itself. Separating the decision from
 * the I/O is the one structural change in this file: {@link routeClientMessage}
 * returns *what should happen* and the caller performs it, which is what lets
 * every branch be replayed against the fixture without a socket.
 */

import type { CharacterInfo } from "../protocol/CharacterInfo";
import type { ClientMessage } from "../protocol/ClientMessage";
import type { ServerMessage } from "../protocol/ServerMessage";
import type { RequestKind, RequestMeta, RoutedMessage, SessionMeta } from "./session";
import { withSelectedCharacter } from "./session";

/** Human-readable variant name, matching the Rust's `msg_type_name`. */
export function msgTypeName(msg: ClientMessage): string {
  return msg.type;
}

/**
 * Decide which character a connecting client is talking to.
 *
 * The asymmetry here is deliberate in the Rust and reproduced: an *unknown*
 * requested character resolves to `null` rather than being rejected, so a
 * client naming a character that has since been deleted still connects and
 * sees the character list, instead of failing the handshake outright.
 *
 * Defaulting to the sole character when none was requested only fires when
 * there is exactly one; with two or more the client has to choose, because
 * picking for it would silently bind the session to whichever happened to sort
 * first.
 */
export function resolveHandshakeCharacter(
  requested: string | null,
  characters: readonly CharacterInfo[],
): string | null {
  if (requested !== null) {
    return characters.some((character) => character.name === requested) ? requested : null;
  }
  return characters.length === 1 ? (characters[0]?.name ?? null) : null;
}

/** What the transport should do with one understood client frame. */
export type RouteOutcome =
  /** Hand it downstream. */
  | { readonly action: "route"; readonly routed: RoutedMessage }
  /** Answer the client directly without routing anything. */
  | { readonly action: "reply"; readonly reply: ServerMessage };

/**
 * Route one post-handshake client frame.
 *
 * `character` is the session's *live* selected character, read from the client
 * registry rather than from `session`, because a command can move the session
 * to a different character after the handshake captured it.
 */
export function routeClientMessage(
  msg: ClientMessage,
  session: SessionMeta,
  character: string | null,
): RouteOutcome {
  if (msg.type === "hello") {
    // A second hello is a protocol error. The connection survives it: the Rust
    // writes the error and keeps looping rather than dropping the client.
    // `rid` is omitted rather than null: every optional field on the wire
    // carries `skip_serializing_if = "Option::is_none"`, so the Rust never
    // writes an explicit null and a client can tell "absent" from "null".
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
      // `Cancel` carries no rid on the wire, so the request is unattributed
      // even though the other three engine paths propagate one.
      return { action: "route", routed: { kind: "engine", msg, meta: meta("cancel", null) } };
    case "command":
      return {
        action: "route",
        routed: { kind: "command", cmd: msg, meta: meta("command", msg.rid ?? null) },
      };
  }
}

/**
 * Frames every session receives regardless of registration state.
 *
 * These are broadcast and lifecycle frames. `shutdown` and `ping` in
 * particular have to reach a session that is already being torn down, which is
 * why registration is not consulted for them.
 */
const UNCONDITIONAL_EVENTS = new Set([
  "hello",
  "new_message",
  "history",
  "shutdown",
  "ping",
  "cache_warning",
]);

/**
 * Whether a broadcast event should be written to this session.
 *
 * Request-scoped frames — stream frames, tool frames, errors, warnings — only
 * go to a session that is still registered, so a disconnecting client stops
 * receiving the tail of a generation it can no longer render.
 *
 * `unknown` is never routed. It exists only so an *older client* can skip a
 * frame from a newer daemon; the server never constructs one, so a frame
 * arriving here as `unknown` means something upstream is wrong and forwarding
 * it would put a frame on the wire that no client can interpret.
 */
export function eventMatchesSession(msg: ServerMessage, sessionRegistered: boolean): boolean {
  if (msg.type === "unknown") return false;
  if (UNCONDITIONAL_EVENTS.has(msg.type)) return true;
  return sessionRegistered;
}
