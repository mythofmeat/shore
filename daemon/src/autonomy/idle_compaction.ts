import { threadDataDir } from "../config/dirs.ts";
import { homeThreadOf } from "../engine/threads.ts";
import { withConversation } from "../engine/lifecycle.ts";
import type { CompactionCompletion } from "../memory/compaction/background.ts";
import { shoreLog } from "../log.ts";

import { runCompaction, type CompactionRunDeps } from "../memory/compaction/run.ts";
import { reloadAndApplyDeferred, repoint, type PostArchiveDeps } from "./post_archive.ts";
import type { AutonomyActionResult } from "./runner.ts";
import { CompactionPaused } from "../memory/compaction/types.ts";

export interface IdleCompactionDeps extends PostArchiveDeps {
  run?: Omit<CompactionRunDeps, "config">;
}

export async function runIdleCompaction(
  character: string,
  deps: IdleCompactionDeps,
): Promise<AutonomyActionResult> {
  const selected = await homeThreadOf(deps.config.dirs.data, character);
  return await withConversation(threadDataDir(deps.config.dirs.data, character, selected), "update", async () => {
    if (deps.run === undefined) {
      return { events: [], failed: "idle compaction has no compaction dependencies" };
    }

    shoreLog.info(`shore: autonomy tick: running idle-triggered compaction for ${character}`);

    let completion: CompactionCompletion;
    try {
      completion = await runCompaction(character, {
        ...deps.run,
        config: deps.config,
      }, "idle");
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
    await reloadAndApplyDeferred(character, deps, "Idle compaction");
    shoreLog.info(`shore: idle compaction complete for ${character}, state reset (retained=${retained})`);
    await repoint(character, deps, "idle_compaction");

    return { turnCount: retained, events: [] };
  });
}
