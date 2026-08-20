import { shoreLog } from "../log.ts";

import { join } from "node:path";

import { HISTORY_DB_FILE } from "../engine/history_store.ts";
import { MessageStore, isToolResultOnly } from "../engine/message_store.ts";
import type { Message } from "../engine/types.ts";
import { conversationManager } from "../memory/compaction/archive.ts";
import { tryBeginCompaction } from "../memory/compaction/manager.ts";
import { runCompaction, type CompactionRunDeps } from "../memory/compaction/run.ts";
import { reloadAndApplyDeferred, repoint, type PostArchiveDeps } from "./post_archive.ts";
import type { AutonomyActionResult } from "./runner.ts";
import { CompactionPaused } from "../memory/compaction/types.ts";

const ACTIVE_JSONL_FILE = "active.jsonl";

export type DeepArchivePlan =
  | { arm: "quiesce"; tail: number }
  | { arm: "pure"; tail: number; archivable: number }
  | { arm: "compaction"; tail: number; archivable: number };

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

export function deepArchiveNotification(
  character: string,
  archivable: number,
): { title: string; body: string } {
  return {
    title: `Shore — ${character}`,
    body: `Idle conversation archived (${archivable} messages, no LLM pass needed)`,
  };
}

export interface DeepArchiveDeps extends PostArchiveDeps {
  run?: Omit<CompactionRunDeps, "config">;
  notify?: (title: string, body: string) => void;
  now?: () => string;
  newId?: () => string;
}

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
    shoreLog.warn(
      `shore: deep-idle archive for ${character} failed to read the active conversation: ${String(e)}`,
    );
    return {
      events: [],
      failed: message(e),
      deepArchiveDone: false,
    };
  }

  const plan = deepArchivePlan(loaded.store.messages(), coveredTurnCount);

  if (plan.arm === "quiesce") {
    shoreLog.debug(
      `shore: deep-idle archive for ${character} has nothing to archive (tail=${plan.tail})`,
    );
    return { events: [], deepArchiveDone: true };
  }

  if (plan.arm === "pure") {
    return await pureArchive(character, deps, loaded.raw, plan.tail, plan.archivable);
  }
  return await compactionArchive(character, deps);
}

async function pureArchive(
  character: string,
  deps: DeepArchiveDeps,
  activeContent: string,
  tail: number,
  archivable: number,
): Promise<AutonomyActionResult> {
  const dataDir = deps.config.dirs.data;

  const guard = tryBeginCompaction(dataDir, character);
  if (guard === undefined) {
    shoreLog.debug(`shore: deep-idle archive for ${character} — a compaction is already in flight`);
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
      { dbPath: join(dataDir, HISTORY_DB_FILE), character },
    ).archiveAndRetain("deep-idle", { keepLastN: tail, activeContent });
  } catch (e) {
    shoreLog.warn(
      `shore: deep-idle archive for ${character} failed, will retry after the next ` +
        `archive_after window: ${String(e)}`,
    );
    return {
      events: [],
      failed: message(e),
      deepArchiveDone: false,
      ...(e instanceof CompactionPaused && e.resumeAt !== undefined
        ? { retryAt: Date.parse(e.resumeAt) }
        : {}),
    };
  } finally {
    guard.release();
  }

  await reloadAndApplyDeferred(character, deps, "Deep-idle archive");

  const { title, body } = deepArchiveNotification(character, archivable);
  deps.notify?.(title, body);

  shoreLog.info(
    `shore: deep-idle archive complete for ${character} (pure archive, ` +
      `archivable=${archivable}, tail=${tail})`,
  );
  await repoint(character, deps, "deep_idle_archive");

  return { turnCount: 0, events: [], deepArchiveDone: true };
}

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

  shoreLog.info(
    `shore: deep-idle archive for ${character} — running a keep-0 compaction over uncovered turns`,
  );

  let retained: number;
  try {
    retained = await runCompaction(
      character,
      {
        ...deps.run,
        config: deps.config,
      },
      { keepTurnsOverride: 0, retainTrailingAutonomous: true },
    );
  } catch (e) {
    shoreLog.warn(
      `shore: deep-idle archive compaction for ${character} failed, will retry after the next ` +
        `archive_after window: ${String(e)}`,
    );
    return {
      events: [],
      failed: message(e),
      deepArchiveDone: false,
      ...(e instanceof CompactionPaused && e.resumeAt !== undefined
        ? { retryAt: Date.parse(e.resumeAt) }
        : {}),
    };
  }

  await reloadAndApplyDeferred(character, deps, "Deep-idle archive");
  shoreLog.info(
    `shore: deep-idle archive complete for ${character} (compaction pass, retained=${retained})`,
  );
  await repoint(character, deps, "deep_idle_archive");

  return { turnCount: retained, events: [], deepArchiveDone: false };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
