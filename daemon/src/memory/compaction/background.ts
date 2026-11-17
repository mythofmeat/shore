import { threadFile } from "../../storage/files.ts";
import { shoreLog } from "../../log.ts";


import { characterDataDir, threadDataDir } from "../../config/dirs.ts";
import { outsideConversation } from "../../engine/lifecycle.ts";

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
  | { kind: "skipped"; reason: string };

export function handleCompactionOutcome(
  character: string,
  notify: Notify,
  outcome: CompactionOutcome,
): CompactionCompletion {
  shoreLog.info(
    `shore: archived the conversation for ${character} ` +
      `(compacted_turns=${String(outcome.compactedTurns)}, ` +
      `retained_turns=${String(outcome.retainedTurns)})`,
  );
  notify(
    `Shore - ${character}`,
    `Conversation archived (${String(outcome.compactedTurns)} turn${outcome.compactedTurns === 1 ? "" : "s"})`,
  );
  return { kind: "completed", retained: outcome.retainedTurns };
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

export function alongsidePasses(work: Promise<void>): void {
  backgroundPasses.add(work);
  void work.then(() => backgroundPasses.delete(work));
}

export async function stopBackgroundCompactions(dataDir: string): Promise<void> {
  stopping.add(dataDir);
  try {
    while (backgroundPasses.size > 0) await Promise.allSettled(backgroundPasses);
  } finally {
    stopping.delete(dataDir);
  }
}
