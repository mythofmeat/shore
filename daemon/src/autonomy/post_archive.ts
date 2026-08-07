/**
 * What a background pass does once it has rewritten the conversation.
 *
 * `reload_engine_and_apply_deferred` from
 * `crates/daemon/src/autonomy/manager.rs`, plus the invalidate-then-reprime pair
 * that followed it on every arm that touched `active.jsonl`. The Rust ran both
 * from two separate function bodies — `execute_deep_archive_pure` and
 * `execute_idle_compaction` — which is exactly why they are one function here:
 * two copies of the same four steps is how a fix to one silently misses the
 * other, and the steps are ordered for reasons that are not locally obvious.
 *
 * # The order is load-bearing, twice
 *
 * **Reload, then apply the deferred edits.** The reload is what busts the cached
 * prompt those edits would otherwise be written behind.
 *
 * **Invalidate, then reprime.** The rebuild has to read the file the pass just
 * rewrote, so it cannot run while the pre-pass body is still cached. The Rust
 * did the invalidation under the state lock and the reprime after releasing it,
 * for the same reason.
 *
 * # Everything here warns rather than fails
 *
 * The pass already happened. A background action has nobody to report a reload
 * failure to, and refusing to finish the bookkeeping would leave the world less
 * in step than a warning does. That is the one difference from the `compact`
 * command's completion, where a failed reload *is* the command's answer.
 */

import { join } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import { applyDeferredEdits } from "../memory/deferred_edits.ts";
import type { InvalidationReason, LastRequestCache } from "./last_request.ts";
import type { RebuildDeps } from "./rebuild.ts";

/** The conversation engine, for the reload that follows a pass. */
export interface PostArchiveEngine {
  reload(character: string): Promise<void>;
}

/** What the bookkeeping needs, and the base every background action's deps carry. */
export interface PostArchiveDeps {
  /** The character-effective config. `dirs.data` is the root it reads and locks under. */
  config: LoadedConfig;
  /** The cached request body, which a pass invalidates and then re-points. */
  cache: LastRequestCache;
  /** Reloaded after a pass, so the cached prompt is not the pre-pass one. */
  engine?: PostArchiveEngine;
  /** What the keepalive reprime rebuilds with. */
  rebuild?: RebuildDeps & { keepaliveIntervalMs?: number };
}

/**
 * Reload the engine and drain the deferred prompt edits.
 *
 * `context` is the phrase the Rust put in front of both warnings — "Idle
 * compaction", "Deep-idle archive" — and it is the only thing that tells the two
 * callers apart in a log.
 */
export async function reloadAndApplyDeferred(
  character: string,
  deps: PostArchiveDeps,
  context: string,
): Promise<void> {
  if (deps.engine !== undefined) {
    try {
      await deps.engine.reload(character);
    } catch (e) {
      console.warn(`shore: ${context}: engine reload failed for ${character}: ${String(e)}`);
    }
  }

  try {
    await applyDeferredEdits(
      join(deps.config.dirs.data, character),
      deps.config.dirs.config,
      character,
      deps.config.dirs.workspace,
    );
  } catch (e) {
    console.warn(`shore: ${context}: failed to apply deferred edits for ${character}: ${String(e)}`);
  }
}

/**
 * Drop the cached body and point the keepalive at what is on disk now.
 *
 * Two calls rather than one, for the ordering reason in the module header. The
 * `reason` reaches nothing but a log line, and is still a parameter because it
 * is the searchable record of which path cleared the body.
 */
export async function repoint(
  character: string,
  deps: PostArchiveDeps,
  reason: InvalidationReason,
): Promise<void> {
  deps.cache.invalidate(character, reason);
  await deps.cache.reprimeFromDisk(character, deps.config.dirs.data, deps.config, deps.rebuild ?? {});
}
