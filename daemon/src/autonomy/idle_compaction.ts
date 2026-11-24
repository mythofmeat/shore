import { homeThreadOf } from "../engine/threads.ts";
import type { CompactionCompletion } from "../memory/compaction/background.ts";
import { shoreLog } from "../log.ts";

import { runCompaction } from "../memory/compaction/run.ts";
import { repoint, type PostArchiveDeps } from "./post_archive.ts";
import type { AutonomyActionResult } from "./runner.ts";

export async function runIdleCompaction(
  character: string,
  deps: PostArchiveDeps,
): Promise<AutonomyActionResult> {
  const selected = await homeThreadOf(deps.config.dirs.data, character);
  shoreLog.info(`shore: autonomy tick: running idle-triggered compaction for ${character}`);

  let completion: CompactionCompletion;
  try {
    completion = await runCompaction(character, {
      config: deps.config,
      afterArchive: async () => await repoint(character, deps, "idle_compaction"),
    }, { thread: selected });
  } catch (e) {
    shoreLog.warn(
      `shore: idle compaction for ${character} failed, will retry on the next idle tick: ` +
        String(e),
    );
    return { events: [], failed: e instanceof Error ? e.message : String(e) };
  }

  if (completion.kind !== "completed") return { events: [], failed: `Compaction skipped: ${completion.reason}` };
  const retained = completion.retained;
  shoreLog.info(`shore: idle compaction complete for ${character}, state reset (retained=${retained})`);
  return { turnCount: retained, events: [] };
}
