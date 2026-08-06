/**
 * The deep-idle archive: what happens to a conversation nobody came back to.
 *
 * Ported from `execute_deep_idle_archive`, `execute_deep_archive_pure`,
 * `execute_deep_archive_compaction` and `reload_engine_and_apply_deferred` in
 * `crates/daemon/src/autonomy/manager.rs`, pinned by
 * `tests/autonomy_fixtures/deep_archive_parity.json`.
 *
 * After `archive_after` of silence, whatever is left of the active conversation
 * is moved out so the next exchange starts clean. `runner.ts` decides *when*;
 * this decides *how*, and there are two answers.
 *
 * # Coverage picks the arm, and it is the expensive question
 *
 * Every user turn already covered by memory means the conversation can go
 * straight to a segment file — no model, no tokens. That deliberately steps past
 * compaction's "wrote no memory, so do not archive" guard, because that guard
 * protects *uncovered* content and coverage was established by the pass that ran
 * over the full conversation earlier. The keep-N split only decides what stays
 * in `active.jsonl`; it is not what the compaction model was shown.
 *
 * Anything else — a conversation that never reached `min_turns`, or a short
 * exchange after the last pass — runs a real keep-0 compaction first, so those
 * turns reach memory before the file is emptied.
 *
 * The comparison is **strict equality**, and the fixture holds a case where the
 * covered count is *above* the on-disk one. Both directions mean coverage is
 * uncertain, and the safe direction is always the LLM pass.
 *
 * # The trailing autonomous run is retained
 *
 * A heartbeat's `<sendMessage>` output that the user has not answered stays in
 * `active.jsonl`, so it is still there when they come back. That is the whole
 * job of the `tail` count, and it becomes `keepLastN` unchanged.
 *
 * # What it reports, and the one thing the runner could not see before
 *
 * The Rust set its own state at the end of each arm. Here that state is the
 * runner's, so an arm reports and the runner folds it in — with one field that
 * had no way to travel: `deepArchiveDone`. The Rust sets it in the pure arm and
 * on the quiesce, and **deliberately does not** in the LLM arm, because a pass
 * that wrote no memory returns the same zero a successful one does. Leaving it
 * unset is what lets the next firing retry against a conversation that is still
 * intact. `runner.ts` was inferring it from "did not fail", which marked the
 * idle period finished after a pass that had archived nothing.
 *
 * # One recorded difference from the Rust
 *
 * The quiesce arm releases the latch and sets `deepArchiveDone`, but the Rust
 * left `last_compaction_activity` alone where {@link AutonomyActionResult} lands
 * it on `onCompactionFailed`, which moves it. It is unobservable: quiesce means
 * an empty conversation or nothing but an unanswered autonomous tail, so there
 * is nothing for the idle-compaction trigger the clock feeds to act on, and
 * `deepArchiveDone` stops this trigger regardless. Recorded rather than
 * engineered around.
 */

import { join } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import { MessageStore, isToolResultOnly } from "../engine/message_store.ts";
import type { Message } from "../engine/types.ts";
import { applyDeferredEdits } from "../memory/deferred_edits.ts";
import { conversationManager } from "../memory/compaction/archive.ts";
import { tryBeginCompaction } from "../memory/compaction/manager.ts";
import { runCompaction, type CompactionRunDeps } from "../memory/compaction/run.ts";
import type { AutonomyActionResult } from "./runner.ts";
import type { LastRequestCache } from "./last_request.ts";
import type { RebuildDeps } from "./rebuild.ts";

const ACTIVE_JSONL_FILE = "active.jsonl";

/** What the deep-idle archive decided to do about the conversation on disk. */
export type DeepArchivePlan =
  | { arm: "quiesce"; tail: number }
  | { arm: "pure"; tail: number; archivable: number }
  | { arm: "compaction"; tail: number; archivable: number };

/**
 * Choose the arm.
 *
 * Three counts, and each is narrower than it looks:
 *
 * - **`tail`** is the trailing run of assistant messages the *heartbeat* wrote.
 *   Origin is what distinguishes them from a prompted reply, so a normal
 *   assistant turn at the end stops the run at zero.
 * - **`archivable`** is everything else. Zero means there is nothing worth
 *   archiving — an empty conversation, or one already archived down to an
 *   unanswered tail — and the trigger quiesces until real activity re-arms it.
 * - **`userTurns`** counts only *real* user turns. A tool-result-only message is
 *   a tool-loop intermediate, and counting one would inflate the on-disk number
 *   past the covered count and send an already-covered conversation through the
 *   model for nothing.
 */
export function deepArchivePlan(
  messages: readonly Message[],
  coveredTurnCount: number,
): DeepArchivePlan {
  let tail = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined || m.role !== "assistant" || m.origin !== "autonomous") break;
    tail += 1;
  }

  const archivable = Math.max(messages.length - tail, 0);
  if (archivable === 0) return { arm: "quiesce", tail };

  const userTurns = messages.filter((m) => m.role === "user" && !isToolResultOnly(m)).length;
  return userTurns === coveredTurnCount
    ? { arm: "pure", tail, archivable }
    : { arm: "compaction", tail, archivable };
}

/** The desktop notification a pure archive sends. */
export function deepArchiveNotification(
  character: string,
  archivable: number,
): { title: string; body: string } {
  return {
    title: `Shore — ${character}`,
    body: `Idle conversation archived (${archivable} messages, no LLM pass needed)`,
  };
}

/** The conversation engine, for the reload that follows an archive. */
export interface DeepArchiveEngine {
  reload(character: string): Promise<void>;
}

/** What the action needs beyond the config. */
export interface DeepArchiveDeps {
  /** The character-effective config. `dirs.data` is the root it reads and locks under. */
  config: LoadedConfig;
  /** The cached request body, which this invalidates and then re-points. */
  cache: LastRequestCache;
  /**
   * The LLM arm's dependencies. Absent means the arm cannot run — the Rust
   * returned early on a missing client, config or notifier — and the trigger is
   * released rather than the conversation touched.
   */
  run?: Omit<CompactionRunDeps, "config" | "cachedRequest">;
  /** A desktop notification. */
  notify?: (title: string, body: string) => void;
  /** Reloaded after an archive, so the cached prompt is not the pre-archive one. */
  engine?: DeepArchiveEngine;
  /** What the keepalive reprime rebuilds with. */
  rebuild?: RebuildDeps & { keepaliveIntervalMs?: number };
  /** Injected so a replay can pin the manifest's stamp and the new id. */
  now?: () => string;
  newId?: () => string;
}

/**
 * Archive a conversation nobody came back to.
 *
 * Never throws: every failure lands as a result with `failed` set, because a
 * deep archive that could not run still has to release the latch it was holding
 * and let the next `archive_after` window try again.
 */
export async function runDeepIdleArchive(
  character: string,
  deps: DeepArchiveDeps,
  coveredTurnCount: number,
): Promise<AutonomyActionResult> {
  const dataDir = deps.config.dirs.data;
  const characterDir = join(dataDir, character);

  let loaded: { store: MessageStore; raw: string };
  try {
    loaded = await MessageStore.loadWithRaw(join(characterDir, ACTIVE_JSONL_FILE));
  } catch (e) {
    console.warn(
      `shore: deep-idle archive for ${character} failed to read the active conversation: ${String(e)}`,
    );
    return { events: [], failed: message(e), deepArchiveDone: false };
  }

  const plan = deepArchivePlan(loaded.store.messages(), coveredTurnCount);

  if (plan.arm === "quiesce") {
    // Empty, or nothing but an unanswered autonomous tail — a previous archive
    // already ran and the heartbeat has spoken since. Nothing to do until real
    // activity re-arms the trigger.
    console.debug(
      `shore: deep-idle archive for ${character} has nothing to archive (tail=${plan.tail})`,
    );
    return { events: [], deepArchiveDone: true };
  }

  if (plan.arm === "pure") {
    return await pureArchive(character, deps, loaded.raw, plan.tail, plan.archivable);
  }
  return await compactionArchive(character, deps);
}

/**
 * Every user turn is covered: move the file, keep the tail, spend nothing.
 *
 * The bytes archived are the ones this call read, not whatever is on disk by the
 * time the write happens — `archiveAndRetain`'s own header explains why, and the
 * raw content is threaded from the load above for exactly that reason.
 */
async function pureArchive(
  character: string,
  deps: DeepArchiveDeps,
  activeContent: string,
  tail: number,
  archivable: number,
): Promise<AutonomyActionResult> {
  const dataDir = deps.config.dirs.data;

  // The same single-flight guard every other compaction entry point takes.
  const guard = tryBeginCompaction(dataDir, character);
  if (guard === undefined) {
    console.debug(`shore: deep-idle archive for ${character} — a compaction is already in flight`);
    return {
      events: [],
      failed: `Compaction already running for ${character}`,
      deepArchiveDone: false,
    };
  }

  try {
    const characterDir = join(dataDir, character);
    await conversationManager(
      characterDir,
      deps.now ?? (() => new Date().toISOString()),
      deps.newId ?? (() => crypto.randomUUID()),
    ).archiveAndRetain("deep-idle", { keepLastN: tail, activeContent });
  } catch (e) {
    console.warn(
      `shore: deep-idle archive for ${character} failed, will retry after the next ` +
        `archive_after window: ${String(e)}`,
    );
    return { events: [], failed: message(e), deepArchiveDone: false };
  } finally {
    guard.release();
  }

  await reloadAndApplyDeferred(character, deps, "Deep-idle archive");

  const { title, body } = deepArchiveNotification(character, archivable);
  deps.notify?.(title, body);

  console.info(
    `shore: deep-idle archive complete for ${character} (pure archive, ` +
      `archivable=${archivable}, tail=${tail})`,
  );
  await repoint(character, deps);

  // Zero on both counts: the conversation is empty of anything memory does not
  // already hold, so the next turn starts from nothing and covers nothing.
  return { turnCount: 0, events: [], deepArchiveDone: true };
}

/**
 * Uncovered turns exist: run a real keep-0 compaction over them first.
 *
 * `keepTurnsOverride: 0` empties the conversation, and
 * `retainTrailingAutonomous` is what still leaves the unanswered heartbeat run
 * standing — the two are not in conflict, because the retention runs after the
 * split.
 *
 * `deepArchiveDone` stays false on success, which is the Rust's comment made
 * into a field: a pass that wrote no memory returns the same zero a successful
 * one does, so the idle period is not declared finished here. The next firing
 * either finds nothing archivable and quiesces, or retries against a
 * conversation that is still intact.
 */
async function compactionArchive(
  character: string,
  deps: DeepArchiveDeps,
): Promise<AutonomyActionResult> {
  if (deps.run === undefined) {
    return {
      events: [],
      failed: "deep-idle archive has no compaction dependencies",
      deepArchiveDone: false,
    };
  }

  console.info(
    `shore: deep-idle archive for ${character} — running a keep-0 compaction over uncovered turns`,
  );

  const cached = deps.cache.get(character);
  let retained: number;
  try {
    retained = await runCompaction(
      character,
      {
        ...deps.run,
        config: deps.config,
        ...(cached === undefined ? {} : { cachedRequest: cached }),
      },
      { keepTurnsOverride: 0, retainTrailingAutonomous: true },
    );
  } catch (e) {
    console.warn(
      `shore: deep-idle archive compaction for ${character} failed, will retry after the next ` +
        `archive_after window: ${String(e)}`,
    );
    return { events: [], failed: message(e), deepArchiveDone: false };
  }

  await reloadAndApplyDeferred(character, deps, "Deep-idle archive");
  console.info(
    `shore: deep-idle archive complete for ${character} (compaction pass, retained=${retained})`,
  );
  await repoint(character, deps);

  return { turnCount: retained, events: [], deepArchiveDone: false };
}

/**
 * Reload the engine and drain the deferred prompt edits.
 *
 * `reload_engine_and_apply_deferred`, and both halves warn rather than fail: the
 * archive already happened, and a background action has nobody to report a
 * reload failure to. That is the one difference from the `compact` command's
 * completion, where a failed reload *is* the command's answer.
 *
 * The order is the Rust's and it matters — the reload is what busts the cached
 * prompt those edits would otherwise be written behind.
 */
async function reloadAndApplyDeferred(
  character: string,
  deps: DeepArchiveDeps,
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
    );
  } catch (e) {
    console.warn(`shore: ${context}: failed to apply deferred edits for ${character}: ${String(e)}`);
  }
}

/**
 * Drop the cached body and point the keepalive at what is on disk now.
 *
 * Two calls rather than one because the rebuild has to read the file the archive
 * just rewrote — the Rust did the invalidation under the state lock and the
 * reprime after releasing it, for the same reason.
 */
async function repoint(character: string, deps: DeepArchiveDeps): Promise<void> {
  deps.cache.invalidate(character, "deep_idle_archive");
  await deps.cache.reprimeFromDisk(
    character,
    deps.config.dirs.data,
    deps.config,
    deps.rebuild ?? {},
  );
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
