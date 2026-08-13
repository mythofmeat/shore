import { join } from "node:path";

import { MessageStore, isToolResultOnly } from "../../engine/message_store";
import type { Message } from "../../engine/types";
import type { CompactionOutcome, ConversationMessage } from "./types";

const ACTIVE_JSONL_FILE = "active.jsonl";

export interface LoadedConversation {
  store: MessageStore;
  characterDir: string;
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
  };
}

export async function loadMessagesForCompaction(
  dataDir: string,
  character: string,
): Promise<LoadedConversation> {
  const characterDir = join(dataDir, character);
  const { store, raw } = await MessageStore.loadWithRaw(join(characterDir, ACTIVE_JSONL_FILE));
  return {
    store,
    characterDir,
    rawContent: raw,
    messages: store.messages().map(toConversationMessage),
  };
}

export type Notify = (title: string, body: string) => void;

export function handleCompactionOutcome(
  character: string,
  notify: Notify,
  outcome: CompactionOutcome,
): number {
  if (outcome.kind === "compacted") {
    console.info(
      `shore: background compaction completed for ${character} ` +
        `(entries=${outcome.memoryFilesWritten.length}, compacted_turns=${outcome.compactedTurns}, ` +
        `retained_turns=${outcome.retainedTurns}, tool_rounds=${outcome.toolRounds})`,
    );
    notify(
      `Shore — ${character}`,
      `Compaction complete: ${outcome.memoryFilesWritten.length} entries from ` +
        `${outcome.compactedTurns} turns`,
    );
    return outcome.retainedTurns;
  }

  if (outcome.kind === "no_memory_writes") {
    console.warn(
      `shore: background compaction produced no memory writes for ${character} — conversation ` +
        `NOT archived (tool_rounds=${outcome.toolRounds}, rejected=${outcome.rejectedPaths.length}, ` +
        `max_rounds_hit=${outcome.maxRoundsHit}, tools_called=${JSON.stringify(outcome.toolsCalled)})`,
    );
    notify(
      `Shore — ${character}`,
      `Compaction ran but wrote no memory (${outcome.toolRounds} tool round` +
        `${outcome.toolRounds === 1 ? "" : "s"}). Conversation kept; will retry on next trigger.`,
    );
    return 0;
  }

  if (outcome.kind === "truncated") {
    console.warn(
      `shore: background compaction for ${character} was cut off at the token ceiling ` +
        `(truncated_turns=${outcome.truncatedTurns}, tool_rounds=${outcome.toolRounds}, ` +
        `partial_writes=${JSON.stringify(outcome.partialWrites)}) — conversation NOT archived`,
    );
    notify(
      `Shore — ${character}`,
      `Compaction was cut off at the token ceiling and wrote only part of its summary. ` +
        `Conversation kept; will retry on next trigger.`,
    );
    return 0;
  }

  if (outcome.kind === "paused") {
    console.warn(
      `shore: background compaction paused for ${character} ` +
        `(checkpoint=${outcome.checkpointId}, rounds=${outcome.toolRounds}, reason=${outcome.reason})`,
    );
    return 0;
  }

  return 0;
}

export async function pushAfterCompaction(
  gitPushEnabled: boolean,
  outcome: CompactionOutcome,
  push: () => Promise<void>,
): Promise<void> {
  if (!gitPushEnabled || outcome.kind !== "compacted") return;
  await push();
}
