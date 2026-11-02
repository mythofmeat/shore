import type { ConversationEngine } from "../engine/conversation.ts";
import { threadActivities } from "../engine/threads.ts";
import { toRfc3339 } from "../ledger/zoned.ts";
import { runningPass, type RunningPassView } from "../memory/compaction/activity.ts";
import type { RunningCompaction } from "../protocol/RunningCompaction.ts";
import { internalError } from "./errors.ts";
import type { CommandDeps, CommandSession } from "./dispatch.ts";
import type { ThreadContext } from "./threads.ts";
import type { ArchiveContext } from "./archive.ts";

type SnapshotRunner = <T>(run: () => Promise<T>) => Promise<T>;

function guardedSnapshot(
  withSnapshot: SnapshotRunner,
  signal: AbortSignal | undefined,
): SnapshotRunner {
  if (signal === undefined) return withSnapshot;
  return async <T>(run: () => Promise<T>): Promise<T> =>
    await withSnapshot(async () => {
      signal.throwIfAborted();
      return await run();
    });
}

export function threadContext(
  deps: CommandDeps,
  engine: ConversationEngine,
  signal?: AbortSignal,
): ThreadContext {
  const registry = deps.threads;
  if (registry === undefined) {
    throw internalError("thread commands need a character registry, and this one has none");
  }
  return {
    registry,
    character: engine.characterName,
    current: engine.thread,
    ...(signal === undefined ? {} : { signal }),
  };
}

export async function threadListingContext(
  deps: CommandDeps,
  engine: ConversationEngine,
  session: CommandSession,
): Promise<ThreadContext> {
  const base = threadContext(deps, engine, session.signal);
  const warm = deps.keepalive?.keepalive.warmThread(base.character);
  const pass = runningPass(session.dataDir, base.character);
  const archive = deps.archive;
  return {
    ...base,
    ...(archive === undefined
      ? {}
      : {
          withSnapshot: guardedSnapshot(
            async <T>(run: () => Promise<T>) => await archive.withSnapshot(run),
            session.signal,
          ),
        }),
    activity: await threadActivities(
      session.dataDir,
      base.character,
      base.registry.listThreads(base.character).map((t) => t.id),
    ),
    ...(warm === undefined ? {} : { warm }),
    ...(pass === undefined ? {} : { compaction: runningCompaction(pass) }),
  };
}

function runningCompaction(pass: RunningPassView): RunningCompaction {
  return {
    thread: pass.thread,
    trigger: pass.trigger,
    started_at: toRfc3339(pass.startedAt),
    ...(pass.scope === undefined ? {} : { turns: pass.scope.turns }),
    ...(pass.scope?.firstAt === undefined ? {} : { first_at: pass.scope.firstAt }),
    ...(pass.scope?.lastAt === undefined ? {} : { last_at: pass.scope.lastAt }),
  };
}

export function archiveWithSignal(
  archive: ArchiveContext,
  signal: AbortSignal | undefined,
): ArchiveContext {
  if (signal === undefined) return archive;
  return {
    ...archive,
    withSnapshot: guardedSnapshot(
      async <T>(run: () => Promise<T>) => await archive.withSnapshot(run),
      signal,
    ),
  };
}

