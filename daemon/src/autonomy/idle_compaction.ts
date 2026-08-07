/**
 * Idle-triggered compaction: the pass a tick runs on a conversation that has
 * gone quiet.
 *
 * Ported from `execute_idle_compaction` in
 * `crates/daemon/src/autonomy/manager.rs`. `runner.ts` decides *when* — the idle
 * trigger, the turn ceiling, the token ceiling, all already ported and pinned by
 * `crates/daemon/tests/fixtures/tick_parity.json` — and this runs the pass and
 * puts the world back in step afterwards.
 *
 * # There is no fixture for this one, and that is the finding
 *
 * Everything it does is already pinned somewhere else. The pass is
 * `memory/compaction/run.ts`, pinned by the compaction fixtures; the
 * bookkeeping is `post_archive.ts`, shared with the deep-idle archive; the state
 * writes the Rust made under its mutex are the runner's now, and
 * `#applyCompaction` is what pins them. What is left here is which pieces get
 * called and in what order — behaviour, not data, and a generated fixture would
 * have recorded nothing a test double does not.
 *
 * So this is pinned by tests and a mutation pass rather than a replay, and the
 * one number worth stating outright is the one that is *absent*: no
 * `keepTurnsOverride`. The deep archive's LLM arm passes zero, which empties the
 * conversation. If this passed zero too, every idle window would archive a
 * conversation the user is still in the middle of, and it would look like
 * working code.
 *
 * # What it reports
 *
 * `turnCount` on success, `failed` on a pass that threw — both landing on
 * `#applyCompaction`, which releases the latch either way and moves the activity
 * clock so a failure waits a full window instead of retrying in ten seconds.
 * That is the Rust's two branches exactly: the success arm set
 * `active_turn_count` and `covered_turn_count` to the retained count, the
 * failure arm set neither, and both cleared the latch and stamped the clock.
 *
 * Never `deepArchiveDone` — that field belongs to the archive, and an idle
 * compaction is not the end of an idle period. The conversation it just
 * compacted is one the user can still come back to.
 *
 * # Two recorded differences from the Rust
 *
 * **A missing engine no longer refuses the pass.** The Rust required a
 * `registry` before it would start, with a comment saying the requirement was so
 * the post-pass reload could happen. Here the reload is skipped when there is no
 * engine and the pass still runs: a compaction that happened but whose engine
 * did not reload is strictly better than one that did not happen, and the deep
 * archive port already made the same call for the same reason.
 *
 * **Missing LLM dependencies release the latch instead of wedging it.** The Rust
 * returned early on a missing client or notifier without touching any state,
 * which left `compaction_triggered` set — so nothing compacted that character
 * again until a user message cleared it. Reachable only from a context with no
 * model wired at all, and reproducing a latch leak is not worth it, so this
 * reports `failed` and the next idle window tries again.
 */

import { runCompaction, type CompactionRunDeps } from "../memory/compaction/run.ts";
import { reloadAndApplyDeferred, repoint, type PostArchiveDeps } from "./post_archive.ts";
import type { AutonomyActionResult } from "./runner.ts";

/** What the action needs beyond {@link PostArchiveDeps}. */
export interface IdleCompactionDeps extends PostArchiveDeps {
  /**
   * The pass's dependencies. Absent means it cannot run — the Rust's missing
   * client or notifier — and nothing is touched.
   */
  run?: Omit<CompactionRunDeps, "config" | "cachedRequest">;
}

/**
 * Compact a conversation that has gone idle.
 *
 * Never throws: a failed pass still has to release the latch it was holding and
 * restart the retry window, and both of those are things the *result* does.
 */
export async function runIdleCompaction(
  character: string,
  deps: IdleCompactionDeps,
): Promise<AutonomyActionResult> {
  if (deps.run === undefined) {
    return { events: [], failed: "idle compaction has no compaction dependencies" };
  }

  console.info(`shore: autonomy tick: running idle-triggered compaction for ${character}`);

  // Read per call rather than held: the thing holding it is a conversation's
  // last request, and that moves every turn. Absent takes the branch a cold
  // daemon took — rebuild the chat-shape request from disk, same wire shape,
  // colder prefix.
  const cached = deps.cache.get(character);

  let retained: number;
  try {
    retained = await runCompaction(character, {
      ...deps.run,
      config: deps.config,
      ...(cached === undefined ? {} : { cachedRequest: cached }),
    });
  } catch (e) {
    console.warn(
      `shore: idle compaction for ${character} failed, will retry on the next idle tick: ` +
        String(e),
    );
    return { events: [], failed: e instanceof Error ? e.message : String(e) };
  }

  await reloadAndApplyDeferred(character, deps, "Idle compaction");
  console.info(`shore: idle compaction complete for ${character}, state reset (retained=${retained})`);
  await repoint(character, deps, "idle_compaction");

  return { turnCount: retained, events: [] };
}
