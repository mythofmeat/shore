/**
 * The `keepalive_ping_now` diagnostic: ping now, and say what it read.
 *
 * Ported from `AutonomyManager::keepalive_ping_now` in
 * `crates/daemon/src/autonomy/manager.rs` and its rendering in
 * `crates/daemon/src/commands/state/status.rs`, pinned by
 * `tests/autonomy_fixtures/last_request_parity.json`.
 *
 * # The point is the usage, not the ping
 *
 * A ping that reads nothing and pays a write did not keep anything warm. Without
 * this command that is only observable by waiting for the scheduler and reading
 * the ledger afterwards, which is a slow way to learn that a subsystem whose
 * whole purpose is saving money has been spending it.
 *
 * # `source` is the whole reason this could not port earlier
 *
 * `cached_last_request` versus `rebuilt_from_disk` is the distinction the
 * command exists to draw, and it was made in the rebuild-and-push path that
 * `POST /v1/keepalive/prefix` served. A *rebuilt* body that reads cold may
 * simply mean nothing was cached yet; a *cached* one that reads cold means the
 * prefix it was protecting is gone, which is the finding. With the rebuild in
 * this process the round trip collapses into a call and a retry.
 *
 * # Measuring must not move what is measured
 *
 * `pingNow` deliberately leaves the schedule alone — no backoff, no disarm on a
 * cold read. Arming from a rebuild is the exception and it is not a measurement:
 * there was no prefix at all, so there is no schedule to disturb.
 */

import type { LoadedConfig } from "../config/loader.ts";
import type { LastRequestCache } from "../autonomy/last_request.ts";
import type { KeepaliveService, PingNowOutcome } from "../autonomy/keepalive.ts";
import type { RebuildDeps } from "../autonomy/rebuild.ts";
import { internalError } from "./errors.ts";

/** What an on-demand ping did, before the command renders it. */
export type KeepalivePing =
  | {
      kind: "sent";
      /**
       * True when the ping went out against a body the keepalive already held.
       * False when there was none and one had to be rebuilt from disk first.
       */
      fromCachedRequest: boolean;
      /** Read nothing, paid a write. */
      cold: boolean;
      usage: { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
    }
  | { kind: "failed"; detail: string }
  | { kind: "skipped"; detail: string };

/** What the command needs beyond the character. */
export interface KeepalivePingContext {
  keepalive: KeepaliveService;
  lastRequest: LastRequestCache;
  config: LoadedConfig;
  dataDir: string;
  rebuild?: RebuildDeps & { keepaliveIntervalMs?: number };
}

/**
 * Ping, rebuilding and re-asking once if there was nothing to ping.
 *
 * `no_prefix` is matched rather than the prose beside it: it is the machine-
 * readable half of the skip and it is what tells this side to rebuild. Only one
 * retry — a second `no_prefix` after a successful arm would mean the arm did
 * not take, and asking again would not fix that.
 */
export async function pingNow(
  character: string,
  ctx: KeepalivePingContext,
): Promise<KeepalivePing> {
  let outcome = await ctx.keepalive.pingNow(character);

  let fromCachedRequest = true;
  if (outcome.reason === "no_prefix") {
    fromCachedRequest = false;
    const decision = await ctx.lastRequest.reprimeFromDisk(
      character,
      ctx.dataDir,
      ctx.config,
      ctx.rebuild ?? {},
    );
    if (decision.kind === "disarm") {
      return { kind: "skipped", detail: "no cached or rebuildable request" };
    }
    outcome = await ctx.keepalive.pingNow(character);
  }

  return classify(fromCachedRequest, outcome);
}

/**
 * The ping's outcome as the command sees it.
 *
 * Three statuses, and everything unrecognised falls in with `skipped` rather
 * than raising — a ping is a diagnostic, and a diagnostic that fails because it
 * did not recognise its own answer is worse than one that reports the answer.
 * `detail` is the empty string when the ping did not supply one, which is the
 * Rust's `unwrap_or_default` and not a missing field.
 */
export function classify(
  fromCachedRequest: boolean,
  outcome: PingNowOutcome,
): KeepalivePing {
  const detail = outcome.detail ?? "";
  if (outcome.status === "sent") {
    const usage = outcome.usage;
    return {
      kind: "sent",
      fromCachedRequest,
      cold: outcome.cold,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_tokens ?? 0,
        cacheCreationTokens: usage?.cache_creation_tokens ?? 0,
      },
    };
  }
  if (outcome.status === "failed") return { kind: "failed", detail };
  return { kind: "skipped", detail };
}

/**
 * The command's answer.
 *
 * The three `note` strings are the whole product of this command and they are
 * reproduced exactly. The middle one matters most and is the least obvious: a
 * read of zero with *no* write is not a cold prefix, it is a model with caching
 * off or a non-cached fallback answering, and reporting that as a cold write
 * would send someone hunting a cache bug that is not there.
 */
export async function keepalivePingNowCommand(
  character: string,
  ctx: KeepalivePingContext,
): Promise<unknown> {
  const ping = await pingNow(character, ctx);

  if (ping.kind === "failed") {
    throw internalError(`keepalive ping failed: ${ping.detail}`);
  }
  if (ping.kind === "skipped") {
    return { status: "skipped", character, reason: ping.detail };
  }

  return {
    status: ping.cold ? "cold" : "warm",
    character,
    source: ping.fromCachedRequest ? "cached_last_request" : "rebuilt_from_disk",
    input_tokens: ping.usage.inputTokens,
    cache_read_tokens: ping.usage.cacheReadTokens,
    cache_creation_tokens: ping.usage.cacheCreationTokens,
    note: ping.cold
      ? "Read 0 and paid a write: this ping recreated the prefix at full " +
        "price rather than refreshing it. The autonomous keepalive treats " +
        "this as proof the prefix is gone and disarms."
      : ping.usage.cacheReadTokens === 0
        ? "Read 0 with no write — caching is off for this model, or a " +
          "non-cached fallback answered. Not a cold write."
        : "Read the cached prefix, which is what the keepalive exists to do.",
  };
}
