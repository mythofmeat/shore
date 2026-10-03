import type { ConversationEngine } from "../../src/engine/conversation.ts";
import { mergeToolLoopMessages } from "../../src/engine/merge.ts";
import type { SegmentRecord } from "../../src/engine/segments.ts";
import type { Message } from "../../src/engine/types.ts";

export interface DisplayScope {
  messages: Message[];
  offset: number;
  segment: SegmentRecord | undefined;
  previous: SegmentRecord | undefined;
  next: SegmentRecord | undefined;
}

export async function displayHistoryOf(engine: ConversationEngine): Promise<Message[]> {
  const archived: Message[] = [];
  for (const entry of engine.segments().entries()) {
    archived.push(...mergeToolLoopMessages(await engine.segments().readSegment(entry.idx)));
  }
  return [...archived, ...mergeToolLoopMessages([...engine.messages()])];
}

export async function displayScopeOf(
  engine: ConversationEngine,
  segment: number | undefined,
): Promise<DisplayScope | undefined> {
  const segments = engine.segments();
  if (segment === undefined) {
    return {
      messages: mergeToolLoopMessages([...engine.messages()]),
      offset: 0,
      segment: undefined,
      previous: segments.latestEntry(),
      next: undefined,
    };
  }
  const record = segments.entry(segment);
  if (record === undefined) return undefined;
  return {
    messages: mergeToolLoopMessages(await segments.readSegment(segment)),
    offset: segments.displayBounds(segment)?.start ?? 0,
    segment: record,
    previous: segments.entryBefore(segment),
    next: segments.entryAfter(segment),
  };
}
