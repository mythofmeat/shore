import { threadFile } from "../storage/files.ts";
import { withConversation } from "../engine/lifecycle.ts";
import { shoreLog } from "../log.ts";

import { join } from "node:path";

import { archiveKey, threadDataDir } from "../config/dirs.ts";
import { firstUnreadReply, homeThreadOf } from "../engine/threads.ts";

import { HISTORY_DB_FILE } from "../engine/history_store.ts";
import { MessageStore } from "../engine/message_store.ts";
import type { Message } from "../engine/types.ts";
import { conversationManager } from "../memory/compaction/archive.ts";
import { tryBeginCompaction } from "../memory/compaction/manager.ts";
import { archiveSplitIndex, conversationView } from "../memory/compaction/plan.ts";
import { reloadAndApplyDeferred, repoint, type PostArchiveDeps } from "./post_archive.ts";
import type { AutonomyActionResult } from "./runner.ts";


export type DeepArchivePlan =
  | { arm: "quiesce"; tail: number }
  | { arm: "archive"; tail: number; archivable: number };

export function deepArchivePlan(
  messages: readonly Message[],
  firstUnread?: number,
): DeepArchivePlan {
  const archivable = archiveSplitIndex(conversationView(messages), 0, true, firstUnread);
  const tail = messages.length - archivable;
  return archivable === 0 ? { arm: "quiesce", tail } : { arm: "archive", tail, archivable };
}

export function deepArchiveNotification(
  character: string,
  archivable: number,
): { title: string; body: string } {
  return {
    title: `Shore - ${character}`,
    body: `Idle conversation archived (${archivable} messages)`,
  };
}

export interface DeepArchiveDeps extends PostArchiveDeps {
  notify?: (title: string, body: string) => void;
  now?: () => string;
  newId?: () => string;
}

export async function runDeepIdleArchive(
  character: string,
  deps: DeepArchiveDeps,
): Promise<AutonomyActionResult> {
  const selected = await homeThreadOf(deps.config.dirs.data, character);
  return await withConversation(threadDataDir(deps.config.dirs.data, character, selected), "update", async () => {
    const dataDir = deps.config.dirs.data;
    const thread = await homeThreadOf(dataDir, character);

    let loaded: { store: MessageStore; raw: string };
    try {
      loaded = await MessageStore.loadWithRaw(threadFile(dataDir, character, thread, "active.jsonl"));
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

    const messages = loaded.store.messages();
    const plan = deepArchivePlan(messages, firstUnreadReply(dataDir, character, thread, messages));

    if (plan.arm === "quiesce") {
      shoreLog.debug(
        `shore: deep-idle archive for ${character} has nothing to archive (tail=${plan.tail})`,
      );
      return { events: [], deepArchiveDone: true };
    }

    return await archiveIdle(character, thread, deps, loaded.raw, plan.tail, plan.archivable);
  });
}

async function archiveIdle(
  character: string,
  thread: string,
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
    await conversationManager(
      threadDataDir(dataDir, character, thread),
      {
        dbPath: join(dataDir, HISTORY_DB_FILE),
        archiveKey: archiveKey(character, thread),
        unlabelled: true,
      },
      deps.now ?? (() => new Date().toISOString()),
      deps.newId ?? (() => crypto.randomUUID()),
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
    };
  } finally {
    guard.release();
  }

  await reloadAndApplyDeferred(character, deps, "Deep-idle archive");

  const { title, body } = deepArchiveNotification(character, archivable);
  deps.notify?.(title, body);

  shoreLog.info(
    `shore: deep-idle archive complete for ${character} (archivable=${archivable}, tail=${tail})`,
  );
  await repoint(character, deps, "deep_idle_archive");

  return { turnCount: 0, events: [], deepArchiveDone: true };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
