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
  if (deps.run === undefined) {
    return { events: [], failed: "idle compaction has no compaction dependencies" };
  }

  console.info(`shore: autonomy tick: running idle-triggered compaction for ${character}`);

  let retained: number;
  try {
    retained = await runCompaction(character, {
      ...deps.run,
      config: deps.config,
    });
  } catch (e) {
    console.warn(
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

  await reloadAndApplyDeferred(character, deps, "Idle compaction");
  console.info(`shore: idle compaction complete for ${character}, state reset (retained=${retained})`);
  await repoint(character, deps, "idle_compaction");

  return { turnCount: retained, events: [] };
}
