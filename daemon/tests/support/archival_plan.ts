import { required } from "../../src/util/required.ts";
import { loadMessagesForCompaction } from "../../src/memory/compaction/background.ts";
import type { Message } from "../../src/engine/types.ts";
import {
  archivalPlanInput,
  buildArchivalPlan,
  resolveArchivalPlan,
  type ArchivalPlan,
  type ArchivalPlanSettings,
} from "../../src/memory/compaction/plan.ts";

export async function planFor(
  dataDir: string,
  character: string,
  thread: string,
  settings: Partial<ArchivalPlanSettings> & { keepRecentTurns: number },
): Promise<ArchivalPlan> {
  const loaded = await loadMessagesForCompaction(dataDir, character, thread);
  return required(
    await resolveArchivalPlan(dataDir, character, thread, loaded, {
      maxContextTokens: 0,
      ...settings,
    }),
  );
}

export function jsonlOf(messages: readonly Message[]): string {
  return messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
}

export function maybePlanOf(
  messages: readonly Message[],
  settings: Partial<ArchivalPlanSettings> & { keepRecentTurns: number },
): ArchivalPlan | undefined {
  return buildArchivalPlan(
    archivalPlanInput(jsonlOf(messages)),
    { maxContextTokens: 0, ...settings },
    undefined,
  );
}

export function planOf(
  messages: readonly Message[],
  settings: Partial<ArchivalPlanSettings> & { keepRecentTurns: number },
): ArchivalPlan {
  return required(maybePlanOf(messages, settings));
}

export function planMessage(
  role: Message["role"],
  content: string,
  timestamp = "2026-08-22T00:00:00.000Z",
): Message {
  return {
    msg_id: `m_${role}_${content}`,
    role,
    content,
    images: [],
    content_blocks: [{ type: "text", text: content }],
    timestamp,
  };
}
