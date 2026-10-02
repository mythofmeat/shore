import type { ConversationEngine } from "../../src/engine/conversation.ts";
import { mergeToolLoopMessages } from "../../src/engine/merge.ts";
import type { Message } from "../../src/engine/types.ts";

export async function displayHistoryOf(
  engine: ConversationEngine,
): Promise<{ messages: Message[]; activeStart: number }> {
  const archivedRaw: Message[] = [];
  for (let index = 0; index < engine.segments().segmentCount(); index += 1) {
    try {
      archivedRaw.push(...(await engine.segments().readSegment(index)));
    } catch {
      continue;
    }
  }
  const archived = mergeToolLoopMessages(archivedRaw);
  return {
    messages: [...archived, ...mergeToolLoopMessages([...engine.messages()])],
    activeStart: archived.length,
  };
}
