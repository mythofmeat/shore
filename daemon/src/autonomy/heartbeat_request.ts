/**
 * The body a heartbeat tick runs, and the model it runs on.
 *
 * Ported from `prepare_heartbeat_request` and `apply_heartbeat_model_override`
 * in `crates/daemon/src/autonomy/manager.rs`. The four `heartbeat_override_*`
 * tests there are the specification for the override and are carried across
 * whole in `tests/heartbeat_request.test.ts`.
 *
 * A heartbeat does not build a request from scratch. It takes the body chat
 * last sent — still warm against the provider's prompt cache — and appends one
 * instruction to it. Everything here exists to make that append safe.
 *
 * # The cached body is chat's, and is never written to
 *
 * `LastRequestCache` hands back the object it is holding, and that object is
 * what the next chat turn and every keepalive ping extend. The tick appends an
 * inline system entry and then a turn per tool round; doing that to the cached
 * object would rewrite chat's history in place and leave a prefix no real turn
 * reuses. The Rust cloned under the lock for exactly this reason. So does this
 * — see {@link copyForTick}.
 *
 * # Why the override is stricter than every other background task
 *
 * `resolveBackgroundModel` falls back to the chat model when a configured name
 * does not resolve, and for compaction or dreaming that is right: some model
 * beats none. A heartbeat checks the effective catalog *first* and keeps the
 * chat model when the check fails, so a typo'd pin is a warning rather than a
 * silent demotion to whichever model the catalog happens to return. The check
 * goes through the effective catalog and not the static one because pins are
 * written `provider:model_id` with no `[chat.*]` entry behind them — the static
 * lookup rejected every valid pin, and heartbeat silently never left the chat
 * model at all.
 */

import { join } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import {
  configView,
  resolveBackgroundModel,
  resolveChatModelForCharacter,
} from "../config/preferences.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { toRequestModel, type ResolvedModel } from "../config/models.ts";
import { resolveDisplayName } from "../config/app.ts";
import { credentialEntry } from "../handler/tool_context.ts";
import { formatWallClock } from "../engine/prompt.ts";
import { hostZone } from "../ledger/zoned.ts";
import { buildRequestWithProviderKeys, pushInlineSystem } from "../llm/request.ts";
import type { SidecarRequest } from "../llm/types.ts";
import { ensureActivePromptSnapshot } from "../memory/deferred_edits.ts";
import { buildHeartbeatPrompt } from "./heartbeat_shape.ts";
import type { LastRequestCache } from "./last_request.ts";
import { rebuildRequestFromDisk, type RebuildDeps } from "./rebuild.ts";

const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3600n;

/**
 * A shallow copy the tick may append to.
 *
 * Shallow is the whole intent: `messages` becomes a new array so pushes land
 * here, and the message objects inside stay shared because nothing ever mutates
 * one. `tools` and `system` are passed through by reference for the same
 * reason, and because sharing them is what keeps them byte-identical to chat's
 * — a rebuilt tool array would render different bytes and give up the cache
 * prefix this module exists to reuse.
 */
function copyForTick(request: SidecarRequest): SidecarRequest {
  const copy: SidecarRequest = { ...request, messages: [...request.messages] };
  // The stale request id from the chat turn that seeded this body. Reusing one
  // across heartbeat rounds confuses OpenRouter's routing and dedup, which
  // surfaces as unexplained cache misses rather than as an error.
  if (copy.context !== undefined) {
    const { rid: _rid, ...rest } = copy.context;
    copy.context = rest;
  }
  return copy;
}

/**
 * How the fallback interval is said in the prompt.
 *
 * Whole hours read as hours and everything else reads as minutes, both by
 * truncating integer division — 90 minutes is "1 minutes", and anything under a
 * minute is "0 minutes". Faithful to the Rust, and reachable only from a
 * config that asked for it.
 */
export function fallbackIntervalPhrase(secs: bigint): string {
  if (secs >= SECONDS_PER_HOUR && secs % SECONDS_PER_HOUR === 0n) {
    const hours = secs / SECONDS_PER_HOUR;
    return hours === 1n ? "1 hour" : `${hours} hours`;
  }
  return `${secs / SECONDS_PER_MINUTE} minutes`;
}

/** What the override concluded. */
export interface HeartbeatModelChoice {
  /** The body to run. The caller's own when no override applied. */
  request: SidecarRequest;
  /**
   * The heartbeat model, when one was applied. `undefined` means the chat model
   * stands — which is also what a misconfigured pin and a failed build produce,
   * because in both cases running on chat's model beats not ticking.
   */
  override: ResolvedModel | undefined;
}

/** Injected so a test can drive the resolution without a catalog on disk. */
export interface HeartbeatModelDeps {
  env?: NodeJS.ProcessEnv;
}

/**
 * Swap the request onto the configured heartbeat model, or leave it alone.
 *
 * Returns the request to run rather than editing the caller's, because the swap
 * replaces the whole body: credentials, base URL, sampler settings and token
 * caps all come from the new model, and the only things carried over are the
 * three that decide the cache prefix — `messages`, `system` and `tools`.
 *
 * Four ways to end up on the chat model, and only one of them is a problem:
 * nothing configured, the name does not resolve (warns), the configured model
 * *is* the one the request already uses, or the build failed for want of a key
 * (warns).
 */
export function applyHeartbeatModelOverride(
  request: SidecarRequest,
  config: LoadedConfig,
  character: string,
  deps: HeartbeatModelDeps = {},
): HeartbeatModelChoice {
  const view = configView(config);
  const configuredName = view.app.defaults.backgroundModelName("heartbeat");
  if (configuredName === undefined) return { request, override: undefined };

  // Presence check before resolution, and through the *effective* catalog. A
  // name that does not resolve must not fall through to
  // `resolveBackgroundModel`, whose fallback would quietly hand back a chat
  // model as though the pin had worked.
  try {
    findEffectiveModel(view, config.dirs.cache, configuredName, true);
  } catch (e) {
    console.warn(
      `shore: heartbeat model "${configuredName}" not found in catalog for ${character}; ` +
        `keeping chat model: ${String(e)}`,
    );
    return { request, override: undefined };
  }

  const resolved = resolveBackgroundModel(view, "heartbeat", character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
  if (resolved === undefined) return { request, override: undefined };
  if (resolved.modelId === request.model) {
    // Already the model the body runs on. Nothing to swap, and the chat-model
    // cap the caller resolves is the same number either way.
    return { request, override: undefined };
  }

  const entry = config.providers.get(resolved.providerKey);
  try {
    const built = buildRequestWithProviderKeys(
      toRequestModel(resolved),
      entry === undefined ? undefined : credentialEntry(entry),
      {
        messages: request.messages,
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        replay: request.replay_prior_thinking,
      },
      deps.env,
    );
    console.info(
      `shore: heartbeat for ${character} using configured model ${resolved.name} (${built.request.model})`,
    );
    return { request: built.request, override: resolved };
  } catch (e) {
    console.warn(
      `shore: heartbeat could not build a request on ${resolved.name} for ${character}, ` +
        `falling back to the chat model: ${String(e)}`,
    );
    return { request, override: undefined };
  }
}

/** What preparing a request needs beyond the config. */
export interface PrepareHeartbeatDeps {
  cache: LastRequestCache;
  rebuild?: RebuildDeps & { keepaliveIntervalMs?: number };
  env?: NodeJS.ProcessEnv;
  /** Injected so a replay can pin the prompt's `[Current time: …]` line. */
  now?: () => number;
  timeZone?: string;
}

/** A body ready to run, and the round cap that goes with it. */
export interface PreparedHeartbeat {
  request: SidecarRequest;
  /**
   * Dispatch rounds before the wrap-up nudge. `undefined` is unlimited, leaving
   * the wall-clock deadline as the only bound.
   *
   * Read off the model the request *actually* runs on. Re-resolving it
   * independently could name a different model than the body was built for,
   * because a heartbeat pin resolves only through the effective catalog while
   * the chat lookup does not.
   */
  maxToolIterations: number | undefined;
  /** The heartbeat model, when the override applied. */
  override: ResolvedModel | undefined;
}

/**
 * Assemble the body for one tick.
 *
 * `undefined` means do not tick, for the one reason the rebuild reports:
 * the conversation is mid-turn, or no chat model resolves. Both are states
 * where a heartbeat would build a request the provider rejects.
 *
 * A cold rebuild is cached on the way through. Without that, keepalive pings
 * silently no-op after a restart until the character's next user message —
 * the rebuild is the only thing that produces a body in that window, and
 * throwing it away after one tick means paying for it again every hour.
 */
export async function prepareHeartbeatRequest(
  character: string,
  config: LoadedConfig,
  deps: PrepareHeartbeatDeps,
): Promise<PreparedHeartbeat | undefined> {
  let source = deps.cache.get(character);
  if (source === undefined) {
    source = await rebuildRequestFromDisk(character, config.dirs.data, config, deps.rebuild ?? {});
    if (source === undefined) {
      console.info(
        `shore: heartbeat skipping tick for ${character} (conversation mid-turn or model unresolved)`,
      );
      return undefined;
    }
    deps.cache.set(character, source, deps.rebuild?.keepaliveIntervalMs);
  }

  const { request, override } = applyHeartbeatModelOverride(
    copyForTick(source),
    config,
    character,
    deps.env === undefined ? {} : { env: deps.env },
  );

  const maxToolIterations =
    override !== undefined
      ? override.maxToolIterations
      : resolveChatModelForCharacter(configView(config), character, (v, c, n, h) =>
          findEffectiveModel(v, c, n, h),
        )?.maxToolIterations;

  // The snapshot the workspace tools read the active prompt from. A failure is
  // a warning and not a skip: the tick can still think and still write files,
  // and refusing to run because one file is stale would trade a degraded
  // heartbeat for no heartbeat.
  try {
    await ensureActivePromptSnapshot(
      join(config.dirs.data, character),
      config.dirs.config,
      character,
    );
  } catch (e) {
    console.warn(`shore: heartbeat could not prepare the prompt snapshot for ${character}: ${String(e)}`);
  }

  const nowMs = deps.now?.() ?? Date.now();
  const prompt = buildHeartbeatPrompt(
    formatWallClock(nowMs, deps.timeZone ?? hostZone()),
    resolveDisplayName(config.app.defaults, deps.env),
    fallbackIntervalPhrase(config.app.behavior.autonomy.heartbeat.fallback_heartbeat_interval.asSecs()),
  );

  // Inline at a fixed slot, not appended to `system` and not re-expanded at the
  // tail. The tool loop pushes assistant and tool-result turns after this, so
  // the entry's index must not depend on how long the tail has grown: every
  // byte at or before it stays stable round to round, which is what keeps the
  // content-addressed prefix cache valid across the loop. The removed
  // `system_suffix` affordance re-expanded at the moving tail and busted the
  // cache on every single round.
  //
  // Chat's own prefix is untouched by this. The entry sits *after* chat's
  // messages, so a later chat turn extending the cached body never sees it.
  pushInlineSystem(request, prompt);

  return {
    request,
    maxToolIterations,
    override,
  };
}
