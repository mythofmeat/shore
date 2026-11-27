import { withConversation } from "../../engine/lifecycle.ts";
import { threadDataDir } from "../../config/dirs.ts";

import { shoreLog } from "../../log.ts";

import { join } from "node:path";

import type { LoadedConfig } from "../../config/loader.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../../engine/history_store.ts";
import { loadCharacterConfig } from "../../config/loader.ts";
import { archiveKey, characterDataDir } from "../../config/dirs.ts";
import { readThreadsIndex, homeThreadOf, wakesThread } from "../../engine/threads.ts";
import type { Message } from "../../engine/types.ts";
import type { LastRequestCache } from "../../cache/last_request.ts";
import type { RebuildDeps } from "../../cache/rebuild.ts";
import { saveWorkspaceAtArchive } from "../../tools/workspace.ts";
import { characterWorkspace } from "../../tools/character_workspace.ts";
import type { ToolContextDeps } from "../../handler/tool_context.ts";
import { applyDeferredEdits } from "../deferred_edits.ts";
import type { CompactionRunner } from "../../handler/turn.ts";
import { conversationManager } from "./archive.ts";
import { type CompactionCompletion, alongsidePasses, handleCompactionOutcome, loadMessagesForCompaction } from "./background.ts";
import { tryBeginCompaction } from "./manager.ts";
import { CompactionError, type CompactionOutcome } from "./types.ts";
import { countTurns, openArchivalCommit, readLiveSource, resolveArchivalPlan, type ArchivalPlan } from "./plan.ts";

export interface CompactionRunDeps {
  env?: NodeJS.ProcessEnv;
  config: LoadedConfig;
  notify?: (title: string, body: string) => void;
  tools?: ToolContextDeps;
  now?: () => string;
  newId?: () => string;
  afterArchive?: (thread: string) => Promise<void>;
}

export type ArchiveDeps = Pick<CompactionRunDeps, "config" | "notify" | "now" | "newId" | "afterArchive">;

export interface CompactionRunOptions {
  thread?: string;
  dryRun?: boolean;
  keepTurnsOverride?: number;
  retainTrailingAutonomous?: boolean;
}

export async function runCompaction(
  character: string,
  deps: ArchiveDeps,
  options: Omit<CompactionRunOptions, "dryRun"> = {},
): Promise<CompactionCompletion> {
  const outcome = await runCompactionPass(character, deps, options);
  if (outcome === undefined) return { kind: "skipped", reason: "empty_or_changed" };
  return handleCompactionOutcome(character, deps.notify ?? (() => {}), outcome);
}

export async function saveWorkspaceAfterArchive(config: LoadedConfig, effective: LoadedConfig, character: string): Promise<void> {
  await saveWorkspaceAtArchive(characterWorkspace(config, character), character, effective.app.compaction.git_push ? alongsidePasses : undefined);
}

async function rotate(
  character: string,
  thread: string,
  deps: ArchiveDeps,
  effective: LoadedConfig,
  plan: ArchivalPlan,
  conversationDir: string,
  dryRun: boolean,
  liveContent: string,
): Promise<CompactionOutcome | undefined> {
  const dataDir = effective.dirs.data;
  const commit = openArchivalCommit(plan, liveContent);
  if (commit === undefined) {
    shoreLog.warn(
      `shore: not rotating ${character}/${thread}: the conversation was rewritten under the ` +
        `plan that resolved this range, so archiving it would commit a range nobody resolved`,
    );
    return undefined;
  }

  if (!dryRun) {
    await conversationManager(
      conversationDir,
      {
        dbPath: join(dataDir, HISTORY_DB_FILE),
        archiveKey: archiveKey(character, thread),
      },
      deps.now ?? (() => new Date().toISOString()),
      deps.newId ?? (() => crypto.randomUUID()),
    ).archiveAndRetain("archive-only", {
      keepLastN: commit.retained,
      activeContent: commit.liveContent,
    });
  }

  return {
    conversationId: character,
    dryRun,
    compactedTurns: countTurns([...plan.conversation].slice(0, plan.splitAt)),
    retainedTurns: commit.retainedTurns,
  };
}


export async function runCompactionPass(
  character: string,
  deps: ArchiveDeps,
  options: CompactionRunOptions = {},
): Promise<CompactionOutcome | undefined> {
  const dataDir = deps.config.dirs.data;

  const thread = options.thread ?? (await homeThreadOf(dataDir, character));
  if (thread === wakesThread(await readThreadsIndex(dataDir, character))) {
    throw CompactionError.wakesThread(character, thread);
  }

  const guard = tryBeginCompaction(dataDir, character);
  if (guard === undefined) throw CompactionError.busy(character);
  try {
    const loaded = await underThread(deps, character, thread)(async () => await loadMessagesForCompaction(dataDir, character, thread));
    if (loaded.messages.length === 0) return undefined;

    const effective = effectiveConfig(character, deps.config);
    const plan = resolveArchivalPlan(dataDir, character, thread, loaded, {
      keepRecentTurns: effective.app.compaction.keep_recent_turns,
      ...(options.keepTurnsOverride === undefined
        ? {}
        : { keepTurnsOverride: options.keepTurnsOverride }),
      retainTrailingAutonomous: options.retainTrailingAutonomous ?? false,
    });
    if (plan === undefined) throw CompactionError.insufficientMessages();
    if (options.dryRun === true) return await rotate(character, thread, deps, effective, plan, loaded.conversationDir, true, plan.sourceContent);

    const outcome = await underThread(deps, character, thread)(async () => {
      const rotated = await rotate(character, thread, deps, effective, plan, loaded.conversationDir, false,
        await readLiveSource(dataDir, character, thread, plan.sourceContent));
      if (rotated !== undefined) await settleArchive(deps, character, thread)();
      return rotated;
    });
    if (outcome !== undefined) await saveWorkspaceAfterArchive(deps.config, effective, character);
    return outcome;
  } finally {
    guard.release();
  }
}

function underThread(deps: ArchiveDeps, character: string, thread: string): <T>(run: () => Promise<T>) => Promise<T> {
  return async (run) => await withConversation(threadDataDir(deps.config.dirs.data, character, thread), "update", async () => await run());
}

function settleArchive(deps: ArchiveDeps, character: string, thread: string): () => Promise<void> {
  return async () => {
    try {
      await applyDeferredEdits(characterDataDir(deps.config.dirs.data, character), characterWorkspace(deps.config, character), thread);
    } catch (e) {
      shoreLog.warn(`shore: failed to apply deferred edits after compacting ${character}/${thread}: ${String(e)}`);
    }
    try {
      await deps.afterArchive?.(thread);
    } catch (e) {
      shoreLog.warn(`shore: failed to repoint the cached request after compacting ${character}/${thread}: ${String(e)}`);
    }
  };
}

export function readArchivedSegment(
  dataDir: string,
  character: string,
  thread: string,
  segment: number,
): Message[] {
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    return store.readSegment(archiveKey(character, thread), segment);
  } finally {
    store.close();
  }
}

export function effectiveConfig(character: string, config: LoadedConfig): LoadedConfig {
  try {
    return loadCharacterConfig(config, character) ?? config;
  } catch (e) {
    shoreLog.warn(
      `shore: character config failed to load for ${character}; ` +
        `compacting under the global config: ${String(e)}`,
    );
    return config;
  }
}

export function compactionRunner(
  deps: Omit<CompactionRunDeps, "config"> & {
    cache?: LastRequestCache;
    rebuild: RebuildDeps;
  },
): CompactionRunner {
  const { cache, rebuild, ...rest } = deps;
  return {
    run: (character, config, thread) => runCompaction(character, {
      ...rest,
      config,
      ...(cache === undefined ? {} : {
        afterArchive: async (compacted: string) => {
          if (compacted !== await homeThreadOf(config.dirs.data, character)) return;
          cache.invalidate(character, "compaction");
          await cache.reprimeFromDisk(character, config.dirs.data, config, { ...rebuild, ...(deps.env === undefined ? {} : { env: deps.env }) });
        },
      }),
    }, thread === undefined ? {} : { thread }),
    applyDeferredEdits: (charDataDir, workspace, thread) =>
      applyDeferredEdits(charDataDir, workspace, thread),
  };
}
