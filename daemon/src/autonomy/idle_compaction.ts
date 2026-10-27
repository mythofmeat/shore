import { homeThreadOf } from "../engine/threads.ts";
import type { CompactionCompletion } from "../memory/compaction/background.ts";
import { shoreLog } from "../log.ts";

import { runCompaction, type CompactionRunDeps } from "../memory/compaction/run.ts";
import { repoint, type PostArchiveDeps } from "./post_archive.ts";
import type { AutonomyActionResult } from "./runner.ts";
import { CompactionPaused } from "../memory/compaction/types.ts";
import { compactionHeld } from "../memory/compaction/checkpoint.ts";

export interface IdleCompactionDeps extends PostArchiveDeps {
  run?: Omit<CompactionRunDeps, "config">;
}

export async function runIdleCompaction(
  character: string,
  deps: IdleCompactionDeps,
): Promise<AutonomyActionResult> {
  const selected = await homeThreadOf(deps.config.dirs.data, character);
  if (deps.run === undefined) {
    return { events: [], failed: "idle compaction has no compaction dependencies" };
  }
  if (await compactionHeld(deps.config.dirs.data, character, selected)) {
    return { events: [], failed: "compaction is on hold since the model refused it; `shore compact` retries it" };
  }

  shoreLog.info(`shore: autonomy tick: running idle-triggered compaction for ${character}`);

  let completion: CompactionCompletion;
  try {
    completion = await runCompaction(character, {
      ...deps.run,
      config: deps.config,
      afterArchive: async () => await repoint(character, deps, "idle_compaction"),
    }, "idle", { thread: selected });
  } catch (e) {
    shoreLog.warn(
      `shore: idle compaction for ${character} failed, will retry on the next idle tick: ` +
        String(e),
    );
    return {
      events: [],
      failed: e instanceof Error ? e.message : String(e),
      ...(e instanceof CompactionPaused && e.resumeAt !== undefined
        ? { retryAt: Date.parse(e.resumeAt) }
        : {}),
    };
  }

  if (completion.kind !== "completed") return { events: [], failed: `Compaction skipped: ${completion.reason}`, ...(completion.retryAt === undefined ? {} : { retryAt: completion.retryAt }) };
  const retained = completion.retained;
  shoreLog.info(`shore: idle compaction complete for ${character}, state reset (retained=${retained})`);
  return { turnCount: retained, events: [] };
}
