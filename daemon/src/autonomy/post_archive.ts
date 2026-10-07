import { shoreLog } from "../log.ts";

import { join } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import { beginCompaction } from "../memory/compaction/manager.ts";
import { applyDeferredEdits } from "../memory/deferred_edits.ts";
import type { InvalidationReason, LastRequestCache } from "../cache/last_request.ts";
import type { RebuildDeps } from "../cache/rebuild.ts";

export interface PostArchiveEngine {
  reload(character: string): Promise<void>;
}

export interface PostArchiveDeps {
  config: LoadedConfig;
  cache: LastRequestCache;
  engine?: PostArchiveEngine;
  rebuild: RebuildDeps;
}

export async function reloadAndApplyDeferred(
  character: string,
  deps: PostArchiveDeps,
  context: string,
): Promise<void> {
  const guard = await beginCompaction(deps.config.dirs.data, character);
  try {
    if (deps.engine !== undefined) {
      try {
        await deps.engine.reload(character);
      } catch (e) {
        shoreLog.warn(`shore: ${context}: engine reload failed for ${character}: ${String(e)}`);
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
      shoreLog.warn(
        `shore: ${context}: failed to apply deferred edits for ${character}: ${String(e)}`,
      );
    }
  } finally {
    guard.release();
  }
}

export async function repoint(
  character: string,
  deps: PostArchiveDeps,
  reason: InvalidationReason,
): Promise<void> {
  deps.cache.invalidate(character, reason);
  await deps.cache.reprimeFromDisk(character, deps.config.dirs.data, deps.config, deps.rebuild);
}
