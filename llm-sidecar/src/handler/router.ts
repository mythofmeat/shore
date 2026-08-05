/**
 * The message handler: what a routed message causes.
 *
 * Ported from `crates/daemon/src/handler/mod.rs` — `MessageHandler::run`,
 * `handle_routed_message`, `handle_engine_message`, `launch_generation`,
 * `spawn_generation_task`, `resolve_engine_message_character`, and
 * `cancel_generation` from `command_dispatch.rs`. Pinned by
 * `tests/handler_fixtures/router_parity.json`.
 *
 * This is the consumer `swp/server.ts` has been waiting for. `Server.routes()`
 * already yields `RoutedMessage` in arrival order and `SessionRouter` already
 * delivers to one session; what was missing is the thing in between that turns
 * one into the other. Everything it reaches — the dispatcher, the lease, the
 * turn driver, the tool phase — is already here.
 *
 * # Two speeds, deliberately
 *
 * A command answers inline: it does no LLM I/O, so making the loop wait for it
 * costs nothing and keeps the reply ordered against the request. A generation
 * is started and left to run, because it streams for as long as a model takes
 * to think, and a loop that waited for one would stall every other session.
 *
 * The consequence is the only concurrency rule here: **one generation per
 * session**, and a new one aborts the one before it. That is not a resource
 * limit, it is what a client means by sending a second message before the first
 * finished.
 *
 * # What is injected rather than held
 *
 * `runGeneration` — `handler/generation.rs`, still Rust. This module owns the
 * orchestration *around* a generation (which session, which recipients, what
 * happens when it throws), which is separable from the generation itself and is
 * what the fixture pins. Config hot-reload (`HandlerControl`, the
 * `apply_reloaded_config` path) is deliberately not here: it drives the
 * autonomy manager and the character registry's runtime reload, and neither has
 * been ported.
 */

import type { ClientMessage } from "../protocol/ClientMessage.ts";
import type { Command } from "../protocol/Command.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type {
  DirectSender,
  RequestMeta,
  RoutedMessage,
  SessionRouter,
} from "../swp/session.ts";
import type { LeaseRouter, StreamLeases } from "./lease.ts";

// ── the frames this module mints ────────────────────────────────────────

/**
 * Set `rid` on the frames that carry one, leaving the rest alone.
 *
 * `ServerMessage::with_rid` in the Rust, which matches every variant so the
 * compiler catches a new one that forgot. Here the field is simply absent from
 * the variants that have none, so assigning it would invent a key the client
 * does not expect — hence the list.
 */
const RID_BEARING: ReadonlySet<string> = new Set([
  "history",
  "command_output",
  "error",
  "stream_start",
  "stream_chunk",
  "stream_end",
  "phase",
  "tool_call",
  "tool_result",
  "send_image",
  "provider_fallback_warning",
  "usage_warning",
]);

export function withRid(msg: ServerMessage, rid: string | null): ServerMessage {
  if (rid === null || !RID_BEARING.has(msg.type)) return msg;
  // The set above is the enumeration the Rust wrote as a match; TypeScript
  // cannot correlate a runtime membership test with the union, so the cast is
  // what the set is standing in for.
  return { ...msg, rid } as ServerMessage;
}

/**
 * The `stream_end` that closes a cancelled turn.
 *
 * Zeroed rather than omitted: the frame's shape is what a client parses, and a
 * cancel has to look like an ending or the client waits forever. `cancelled` is
 * the finish reason a TUI renders as an interrupted turn.
 */
function cancelledStreamEnd(rid: string | null): ServerMessage {
  return withRid(
    {
      type: "stream_end",
      // `subagent`, `msg_id` and `revision` are omitted rather than nulled,
      // which is what `skip_serializing_if = "Option::is_none"` does on the
      // Rust side. A cancelled turn has no sub-agent, minted no message, and
      // produced no revision — and a client reading `null` for any of them
      // would be reading a value Shore never sent.
      content: "",
      metadata: {
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        timing: { total_ms: 0, ttft_ms: 0 },
        model: "",
      },
      finish_reason: "cancelled",
      is_final: true,
    },
    rid,
  );
}

// ── injected surfaces ───────────────────────────────────────────────────

/** The character registry, as this module reads it. */
export interface HandlerRegistry {
  /**
   * The character a request is for, or why it could not be decided.
   *
   * The Rust returned `Result<String, _>` and the error became an
   * `invalid_request` frame; both halves are the caller's here so the message
   * is the registry's own.
   */
  resolveCharacter(selected: string | null): { name: string } | { error: string };
}

/** What starts a generation and resolves when it is over. */
export type RunGeneration = (params: GenerationParams) => Promise<void>;

/** Everything a generation is told about the request that asked for it. */
export interface GenerationParams {
  readonly meta: RequestMeta;
  readonly body: EngineBody;
  readonly regen: boolean;
  readonly charName: string;
  /** Sanitised — see {@link sanitiseRid}. Not `meta.rid`. */
  readonly rid: string | null;
  /** Delivers to the issuing session and to the lease holder both. */
  readonly send: DirectSender;
  /**
   * Aborts when this generation is cancelled or superseded.
   *
   * The Rust held a `JoinHandle` and called `abort()`, which really does stop
   * a tokio task at its next await point. A promise has no such handle: a
   * generation that ignores this signal runs to completion and keeps streaming
   * into a turn the client has already been told ended. So the signal is the
   * whole of the cancellation contract here, and it is on `GenerationParams`
   * rather than left implicit.
   */
  readonly signal: AbortSignal;
}

/** A `Message` body, or the one a `Regen` is normalised into. */
export interface EngineBody {
  readonly rid: string | null;
  readonly text: string;
  readonly stream: boolean;
  readonly images: readonly string[];
  readonly image_data: readonly unknown[];
  readonly absence_seconds?: number | null;
  readonly overrides?: unknown;
}

/** Desktop notifications, for a generation that failed outright. */
export interface HandlerNotifier {
  notify(event: "error", title: string, body: string): void;
}

export interface MessageHandlerDeps {
  readonly router: SessionRouter & LeaseRouter;
  readonly leases: StreamLeases;
  readonly registry: HandlerRegistry;
  readonly notifier: HandlerNotifier;
  readonly dispatchCommand: (cmd: Command, meta: RequestMeta) => Promise<ServerMessage>;
  readonly runGeneration: RunGeneration;
  readonly log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    error?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

// ── rid sanitisation ────────────────────────────────────────────────────

/**
 * The rid a generation is allowed to echo back, or `null`.
 *
 * A client picks its own rid and Shore only ever reflects it, so the only
 * question is whether it can be put on a frame safely. Non-ASCII and embedded
 * NULs are rejected — `r.is_ascii() && !r.contains('\0')` in the Rust —
 * because a rid ends up in log lines and in the client's own correlation table,
 * and neither wants a frame's worth of arbitrary bytes.
 *
 * Rejection is silent and yields `null`: the frames still go out, they just
 * carry no correlation id. Failing the request would punish a client for a
 * field it can resend.
 */
export function sanitiseRid(rid: string | null | undefined): string | null {
  if (rid === undefined || rid === null) return null;
  // `char.is_ascii()` is `<= 0x7F`, per code point. `\0` is ASCII, so the NUL
  // check is a second condition rather than a narrower range.
  for (const ch of rid) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7f || code === 0) return null;
  }
  return rid;
}

// ── the handler ─────────────────────────────────────────────────────────

/** What a session has in flight. */
interface SessionState {
  /** Aborts the running generation. Absent when nothing is running. */
  abort?: () => void;
}

/**
 * Consumes routed messages until the stream ends.
 *
 * Held as a class because the session map and the lease outlive any one
 * message — the Rust's `MessageHandler` for the same reason.
 */
export class MessageHandler {
  readonly #deps: MessageHandlerDeps;
  readonly #sessions = new Map<number, SessionState>();

  constructor(deps: MessageHandlerDeps) {
    this.#deps = deps;
  }

  /** Drain a route stream. Returns when it closes, which is server shutdown. */
  async run(routes: AsyncIterable<RoutedMessage>): Promise<void> {
    this.#deps.log?.info?.("message handler started");
    for await (const routed of routes) {
      await this.handleRouted(routed);
    }
    this.#deps.log?.info?.("message handler shutting down (route stream closed)");
  }

  async handleRouted(routed: RoutedMessage): Promise<void> {
    switch (routed.kind) {
      case "command": {
        // Inline, and awaited: a command does no LLM I/O, so the reply is
        // ordered against the request that asked for it at no cost.
        const result = await this.#deps.dispatchCommand(routed.cmd, routed.meta);
        await this.#deps.router.sendToSession(routed.meta.session.sessionId, result);
        return;
      }
      case "engine":
        await this.handleEngine(routed.msg, routed.meta);
        return;
      case "all_clients_disconnected": {
        // Nobody is watching, so nothing in flight has anywhere to go. The
        // leases go too: a lease names a session, and there are none.
        for (const sessionId of [...this.#sessions.keys()]) {
          await this.cancelGeneration(sessionId, null, "all clients disconnected");
        }
        this.#deps.leases.clear();
        return;
      }
    }
  }

  /**
   * A `Message`, `Regen` or `Cancel`.
   *
   * `Hello` and `Command` cannot arrive here — routing sends them elsewhere —
   * and are ignored rather than treated as an error, matching the Rust's
   * catch-all arm.
   */
  async handleEngine(msg: ClientMessage, meta: RequestMeta): Promise<void> {
    if (msg.type === "cancel") {
      await this.cancelGeneration(meta.session.sessionId, meta.rid, "user cancelled");
      return;
    }
    if (msg.type !== "message" && msg.type !== "regen") return;

    const resolved = this.#deps.registry.resolveCharacter(meta.session.selectedCharacter);
    if ("error" in resolved) {
      // The rid rides on the error but not on the message that caused it: the
      // client needs to know which request failed.
      await this.#deps.router.sendToSession(
        meta.session.sessionId,
        withRid(
          { type: "error", code: "invalid_request", message: resolved.error },
          meta.rid,
        ),
      );
      return;
    }

    const regen = msg.type === "regen";
    const body: EngineBody = regen
      ? {
          // A regen replaces the last assistant turn, so it carries no user
          // content — the turn it would append is already in the conversation.
          // Only `rid` and `stream` survive from the frame.
          rid: msg.rid ?? null,
          text: "",
          stream: msg.stream,
          images: [],
          image_data: [],
        }
      : {
          rid: msg.rid ?? null,
          text: msg.text,
          stream: msg.stream,
          images: msg.images ?? [],
          image_data: msg.image_data ?? [],
          ...(msg.absence_seconds !== undefined
            ? { absence_seconds: msg.absence_seconds }
            : {}),
          ...(msg.overrides !== undefined ? { overrides: msg.overrides } : {}),
        };

    // Only a real user message takes the lease; `observe` enforces that from
    // `meta.kind`, so this call is unconditional where the Rust's was guarded.
    this.#deps.leases.observe(resolved.name, meta.session.sessionId, meta.kind);

    await this.launchGeneration(meta, body, regen, resolved.name);
  }

  /**
   * Resolve the recipients and start the generation.
   *
   * Returns without starting anything if the session has gone: it asked, then
   * hung up, and there is nobody to stream to.
   */
  async launchGeneration(
    meta: RequestMeta,
    body: EngineBody,
    regen: boolean,
    charName: string,
  ): Promise<void> {
    const issuerSend = this.#deps.router.senderFor(meta.session.sessionId);
    if (issuerSend === undefined) return;

    const rid = sanitiseRid(body.rid);
    const send = this.#deps.leases.fanout(
      charName,
      meta.session.sessionId,
      issuerSend,
      this.#deps.router,
    );

    // A second request supersedes the first. Aborting before starting, not
    // after: the two must not stream to the same session at once.
    const state = this.#session(meta.session.sessionId);
    if (state.abort !== undefined) {
      this.#deps.log?.info?.("aborting previous generation (superseded by new request)");
      state.abort();
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    state.abort = abort;

    const params: GenerationParams = {
      meta,
      body,
      regen,
      charName,
      rid,
      send,
      signal: controller.signal,
    };

    const running = this.#deps
      .runGeneration(params)
      .catch(async (error: unknown) => {
        // An aborted generation is this handler's own doing, not a failure to
        // report: the client already got the cancelled `stream_end`.
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.#deps.log?.error?.("error processing engine message", { error: message });
        await send(withRid({ type: "error", code: "internal_error", message }, rid));
        this.#deps.notifier.notify("error", `Shore - ${charName}`, message);
      })
      .finally(() => {
        // Compared against the handle this launch created, captured above —
        // NOT against `state.abort`, which by now may be a *later* launch's.
        // Reading the field here would make a superseded generation clear its
        // successor's handle on the way out, and the successor would then be
        // uncancellable: `cancelGeneration` would find nothing to abort and
        // send no `stream_end`, so the client would wait forever.
        if (this.#sessions.get(meta.session.sessionId)?.abort === abort) {
          delete state.abort;
        }
      });

    // Deliberately not awaited — that is what makes a generation concurrent
    // with the next routed message. Held only so a caller draining the loop can
    // observe it in a test.
    this.#inFlight.add(running);
    void running.finally(() => this.#inFlight.delete(running));
  }

  /**
   * Stop a session's generation and tell it the turn ended.
   *
   * Does nothing when there is none, including sending no frame: a `cancel` for
   * a turn that already finished is ordinary, and a second `stream_end` would
   * make a client render an ending twice.
   */
  async cancelGeneration(
    sessionId: number,
    rid: string | null,
    reason: string,
  ): Promise<void> {
    const state = this.#sessions.get(sessionId);
    if (state?.abort === undefined) return;
    this.#deps.log?.info?.("cancelling active generation", { reason });
    state.abort();
    delete state.abort;
    await this.#deps.router.sendToSession(sessionId, cancelledStreamEnd(rid));
  }

  /** Settles once nothing is in flight. For shutdown and for tests. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  readonly #inFlight = new Set<Promise<void>>();

  #session(sessionId: number): SessionState {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionState = {};
    this.#sessions.set(sessionId, created);
    return created;
  }
}
