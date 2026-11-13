import { join } from "node:path";

import { MAIN_THREAD, threadDataDir } from "../../config/dirs.ts";
import { CharacterHistoryReader } from "../../engine/character_history.ts";
import { HISTORY_DB_FILE } from "../../engine/history_store.ts";
import { localRfc3339 } from "../../util/time.ts";

export interface DreamConversation {
  thread: string;
  segment: number;
  from: string | undefined;
  to: string | undefined;
  turns: number;
  label?: string;
  memoryBefore?: string;
  memoryAfter?: string;
}

export async function conversationsSince(
  dataDir: string,
  character: string,
  sinceMs: number,
): Promise<DreamConversation[]> {
  const reader = await CharacterHistoryReader.load({
    character,
    dbPath: join(dataDir, HISTORY_DB_FILE),
    mainConversationDir: threadDataDir(dataDir, character, MAIN_THREAD),
  });
  try {
    const found: DreamConversation[] = [];
    for (const entry of reader.entries()) {
      const thread = entry.archiveKey === character ? MAIN_THREAD : entry.archiveKey.slice(character.length + 1);
      if (entry.excluded === true) continue;
      const compacted = Date.parse(entry.compacted_at);
      if (Number.isNaN(compacted) || compacted <= sinceMs) continue;
      found.push({
        thread,
        segment: entry.idx,
        from: entry.first_message_at ?? undefined,
        to: entry.last_message_at ?? undefined,
        turns: entry.turn_count,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(entry.memory_before === undefined ? {} : { memoryBefore: entry.memory_before }),
        ...(entry.memory_after === undefined ? {} : { memoryAfter: entry.memory_after }),
      });
    }
    return found.sort((a, b) => (Date.parse(a.from ?? "") || 0) - (Date.parse(b.from ?? "") || 0));
  } finally {
    reader.close();
  }
}

function localTime(raw: string | undefined): string {
  const ms = Date.parse(raw ?? "");
  return Number.isNaN(ms) ? "?" : localRfc3339(new Date(ms));
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function compactionChanges(conversation: DreamConversation): string {
  const { memoryBefore, memoryAfter } = conversation;
  if (memoryAfter === undefined) return "";
  if (memoryBefore === memoryAfter) return " Its compaction changed nothing.";
  if (memoryBefore === undefined) return ` Its compaction ended at commit ${shortSha(memoryAfter)}.`;
  return ` Its compaction's commits: ${shortSha(memoryBefore)}..${shortSha(memoryAfter)}.`;
}

export function conversationLines(
  conversations: readonly DreamConversation[],
  changesSince: string | undefined,
): string {
  const lines = conversations.map((conversation) => {
    const label = conversation.label === undefined ? "" : ` (${conversation.label})`;
    const turns = conversation.turns === 1 ? "1 turn" : `${String(conversation.turns)} turns`;
    return `- thread \`${conversation.thread}\`${label}, ${localTime(conversation.from)} to ${localTime(conversation.to)}: ` +
      `${turns}.${compactionChanges(conversation)}`;
  });
  if (lines.length === 0) lines.push("- nothing new has been archived since the last dream");
  if (changesSince !== undefined) lines.push(`- every change to the workspace since then: \`git log --stat ${changesSince}\``);
  return lines.join("\n");
}
