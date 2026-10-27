import { threadFile } from "../../storage/files.ts";
import { shoreLog } from "../../log.ts";


import { characterDataDir, threadDataDir } from "../../config/dirs.ts";
import { outsideConversation } from "../../engine/lifecycle.ts";
import { cancelAllPasses, passEnded } from "./activity.ts";

import { MessageStore, isToolResultOnly } from "../../engine/message_store";
import type { Message } from "../../engine/types";
import type { CompactionOutcome, ConversationMessage } from "./types";


export interface LoadedConversation {
  store: MessageStore;
  conversationDir: string;
  rawContent: string;
  messages: ConversationMessage[];
}

function toConversationMessage(msg: Message): ConversationMessage {
  return {
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
    isToolResultOnly: isToolResultOnly(msg),
    isAutonomous: msg.origin === "autonomous",
    ...(msg.version === undefined ? {} : { version: msg.version }),
  };
}

export async function loadMessagesForCompaction(
  dataDir: string,
  character: string,
  thread: string,
): Promise<LoadedConversation> {
  const conversationDir = threadDataDir(dataDir, character, thread);
  const { store, raw } = await MessageStore.loadWithRaw(threadFile(dataDir, character, thread, "active.jsonl"));
  return {
    store,
    conversationDir,
    rawContent: raw,
    messages: store.messages().map(toConversationMessage),
  };
}

export type Notify = (title: string, body: string) => void;

export type CompactionCompletion =
  | { kind: "completed"; retained: number }
  | { kind: "skipped"; reason: string; retryAt?: number };

export function handleCompactionOutcome(
  character: string,
  notify: Notify,
  outcome: CompactionOutcome,
): CompactionCompletion {
  if (outcome.kind === "compacted") {
    shoreLog.info(
      `shore: background compaction completed for ${character} ` +
        `(entries=${outcome.memoryFilesWritten.length}, compacted_turns=${outcome.compactedTurns}, ` +
        `retained_turns=${outcome.retainedTurns}, tool_rounds=${outcome.toolRounds})`,
    );
    notify(
      `Shore - ${character}`,
      `Compaction complete: ${outcome.memoryFilesWritten.length} entries from ` +
        `${outcome.compactedTurns} turns`,
    );
    return { kind: "completed", retained: outcome.retainedTurns };
  }

  if (outcome.kind === "rotated" && !outcome.dryRun) {
    shoreLog.info(
      `shore: archive-only rotation completed for ${character} ` +
        `(archived_messages=${String(outcome.archivedMessages)}, ` +
        `retained_turns=${String(outcome.retainedTurns)})`,
    );
    notify(
      `Shore - ${character}`,
      `Conversation rotated into history (${String(outcome.archivedMessages)} messages, ` +
        `no memory write)`,
    );
    return { kind: "completed", retained: outcome.retainedTurns };
  }

  if (outcome.kind === "truncated") {
    shoreLog.warn(
      `shore: background compaction for ${character} was cut off at the token ceiling ` +
        `(truncated_turns=${outcome.truncatedTurns}, tool_rounds=${outcome.toolRounds}, ` +
        `partial_writes=${JSON.stringify(outcome.partialWrites)}) — conversation NOT archived`,
    );
    notify(
      `Shore - ${character}`,
      `Compaction was cut off at the token ceiling and wrote only part of its summary. ` +
        `Conversation kept; will retry on next trigger.`,
    );
    return { kind: "skipped", reason: outcome.kind };
  }

  if (outcome.kind === "paused") {
    shoreLog.warn(
      `shore: background compaction paused for ${character} ` +
        `(checkpoint=${outcome.checkpointId}, rounds=${outcome.toolRounds}, ` +
        `reason=${outcome.reason}, detail=${outcome.detail ?? "none"})`,
    );
    return { kind: "skipped", reason: outcome.kind };
  }

  return { kind: "skipped", reason: outcome.kind };
}

export async function pushAfterCompaction(
  gitPushEnabled: boolean,
  outcome: CompactionOutcome,
  push: () => Promise<void>,
): Promise<void> {
  if (!gitPushEnabled || (outcome.kind !== "compacted" && outcome.kind !== "segment")) return;
  await push();
}

const queuedPasses = new Set<string>();
const characterQueues = new Map<string, Promise<void>>();
const backgroundPasses = new Set<Promise<void>>();
const stopping = new Set<string>();

export function compactLater(dataDir: string, character: string, thread: string, run: () => Promise<void>): boolean {
  const key = JSON.stringify([characterDataDir(dataDir, character), thread]);
  if (stopping.has(dataDir) || queuedPasses.has(key)) return false;
  queuedPasses.add(key);
  const queue = characterDataDir(dataDir, character);
  const previous = characterQueues.get(queue) ?? Promise.resolve();
  const work: Promise<void> = outsideConversation(async () => {
    await previous;
    try {
      await passEnded(dataDir, character);
      if (!stopping.has(dataDir)) await run();
    } catch (e) {
      shoreLog.warn(`shore: background compaction for ${character}/${thread} failed: ${String(e)}`);
    } finally {
      queuedPasses.delete(key);
    }
  });
  characterQueues.set(queue, work);
  backgroundPasses.add(work);
  void work.then(() => {
    backgroundPasses.delete(work);
    if (characterQueues.get(queue) === work) characterQueues.delete(queue);
  });
  return true;
}

export async function stopBackgroundCompactions(dataDir: string, reason: string): Promise<void> {
  stopping.add(dataDir);
  try {
    await cancelAllPasses(dataDir, reason);
    while (backgroundPasses.size > 0) await Promise.allSettled(backgroundPasses);
  } finally {
    stopping.delete(dataDir);
  }
}
