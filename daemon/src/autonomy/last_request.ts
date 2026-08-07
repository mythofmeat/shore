/**
 * The one thing an autonomy action still has to remember: a request body worth
 * replaying.
 *
 * Ported from `AutonomyState::last_request`, `cache_last_request`,
 * `invalidate_cached_request`, `reprime_decision` and
 * `reprime_keepalive_from_tick` in `crates/daemon/src/autonomy/manager.rs`,
 * pinned by `tests/autonomy_fixtures/last_request_parity.json`.
 *
 * # This is the bridge, and this is where it dies
 *
 * The daemon held this body and pushed it here over `POST /v1/keepalive/prefix`,
 * because it was assembled from Rust's own persisted content blocks and one
 * divergent byte turns a 0.1× cache read into a 2.0× write silently. #12 called
 * that the last bridge still standing and said it dies when conversation state
 * moves. It has moved — `handler/turn.ts` writes `active.jsonl` — so the push
 * becomes a function call and the endpoint goes.
 *
 * # Not persisted, and that is deliberate
 *
 * It is rebuilt from disk when absent (`rebuild.ts`), which is what makes it
 * safe to drop on a restart and safe to invalidate on compaction. A persisted
 * copy would be a second thing to keep in step with `active.jsonl`, and the
 * whole reason the rebuild exists is that the file is the truth.
 */

import type { LoadedConfig } from "../config/loader.ts";
import type { SidecarRequest } from "../llm/types.ts";
import type { KeepalivePrefix, KeepaliveService } from "./keepalive.ts";
import { rebuildRequestFromDisk, type RebuildDeps } from "./rebuild.ts";

/**
 * Why a cached body was dropped.
 *
 * The Rust enumerated these so cache-sensitive behaviour stayed searchable, and
 * the reason reaches nothing but a log line. Kept for the same reason: a new
 * path that clears the body should have to name itself here.
 */
export type InvalidationReason =
  | "compaction"
  | "idle_compaction"
  | "deep_idle_archive"
  | "prompt_reload";

/** What to tell the keepalive after the cached body changed. */
export type KeepaliveReprime =
  | { kind: "push"; request: SidecarRequest }
  | { kind: "disarm" };

/**
 * Push the rebuilt body, or stand down.
 *
 * A pure function because the *choice* is the behaviour worth pinning, not the
 * call that follows it. Keeping the schedule alive across a compaction is the
 * whole reason invalidation does not simply disarm — the conversation changed,
 * but there is still a prefix worth protecting, and it is the rebuilt one. A
 * rebuild that produced nothing must disarm rather than leave the
 * pre-invalidation body armed: pinging a prefix the next real turn will not
 * reuse spends money warming the wrong thing.
 */
export function reprimeDecision(rebuilt: SidecarRequest | undefined): KeepaliveReprime {
  return rebuilt === undefined ? { kind: "disarm" } : { kind: "push", request: rebuilt };
}

/**
 * The cached body, per character.
 *
 * A class rather than a module-level map because two of these exist in a test
 * run and sharing one between them is how a fixture starts passing for the
 * wrong reason.
 */
export class LastRequestCache {
  readonly #bodies = new Map<string, SidecarRequest>();
  readonly #keepalive: KeepaliveService | undefined;

  constructor(keepalive?: KeepaliveService) {
    this.#keepalive = keepalive;
  }

  /** The body a chat turn last sent, if one has. */
  get(character: string): SidecarRequest | undefined {
    return this.#bodies.get(character);
  }

  /**
   * A real call landed: remember its body and arm the keepalive from it.
   *
   * The Rust cached under the state lock and pushed to the sidecar after
   * releasing it, in that order, because the push was an HTTP call it did not
   * want to hold a lock across. In one process the order is still the one that
   * matters — cache first, then arm — because arming is what reads the cadence
   * off the body.
   */
  set(character: string, request: SidecarRequest, keepaliveIntervalMs?: number): void {
    this.#bodies.set(character, request);
    this.#keepalive?.arm(toPrefix(character, request, keepaliveIntervalMs));
  }

  /**
   * The body is no longer the one the next turn will send.
   *
   * Dropping it is the whole of the state change; what to do about the
   * keepalive is {@link reprimeFromDisk}'s, and it is a separate call because it
   * reads `active.jsonl` and the Rust deliberately did that after releasing the
   * state lock.
   */
  invalidate(character: string, reason: InvalidationReason): void {
    const had = this.#bodies.delete(character);
    console.debug(
      `shore: invalidated the cached request for ${character} (reason=${reason}, had=${had})`,
    );
  }

  /**
   * Re-point the keepalive at a body rebuilt from what is now on disk.
   *
   * Called after {@link invalidate}, and separately because the rebuild reads
   * the conversation the invalidating write just changed.
   */
  async reprimeFromDisk(
    character: string,
    dataDir: string,
    config: LoadedConfig,
    deps: RebuildDeps & { keepaliveIntervalMs?: number } = {},
  ): Promise<KeepaliveReprime> {
    const decision = reprimeDecision(
      await rebuildRequestFromDisk(character, dataDir, config, deps),
    );
    if (decision.kind === "push") {
      this.#bodies.set(character, decision.request);
      this.#keepalive?.arm(toPrefix(character, decision.request, deps.keepaliveIntervalMs));
    } else {
      this.#keepalive?.disarm(character);
    }
    return decision;
  }
}

/**
 * A request as the keepalive wants it.
 *
 * The wire shape `POST /v1/keepalive/prefix` carried, minus the wire. Two
 * fields the endpoint added and this has to add too:
 *
 * - **`context.character`**, which is what keys the schedule. Already on every
 *   real call's context, so this only fills it in for a body that arrived
 *   without one.
 * - **`keepalive_interval_ms`**, the model's resolved `cache_keepalive`.
 *   Absent means keepalive is off for this model, which disarms rather than
 *   leaving a stale cadence running. It comes from the caller because it is a
 *   property of the *model*, and the Rust read it off a field of `LlmRequest`
 *   that never crossed the wire.
 *
 * What this does *not* do is stamp `call_type`. The Rust built a fresh
 * keepalive-typed context here; `buildKeepalivePing` re-stamps it on the way
 * out anyway, so doing it twice only creates somewhere for the two to disagree.
 */
function toPrefix(
  character: string,
  request: SidecarRequest,
  keepaliveIntervalMs?: number,
): KeepalivePrefix {
  const context = request.context;
  return {
    ...request,
    context:
      context === undefined
        ? { character, call_type: "keepalive", thinking_enabled: false }
        : { ...context, character },
    ...(keepaliveIntervalMs === undefined ? {} : { keepalive_interval_ms: keepaliveIntervalMs }),
  };
}
