import type { ContentBlock } from "../engine/types.ts";
import type { SidecarRequest, WireMessage } from "./types.ts";

function isThinking(block: ContentBlock): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

export interface ThinkingDrops {
  strippedByPolicy: number;
}

export function replayableMessagesWithDrops(req: SidecarRequest): {
  messages: WireMessage[];
  drops: ThinkingDrops;
} {
  const stripPrior = req.replay_prior_thinking === "none";
  const drops: ThinkingDrops = { strippedByPolicy: 0 };

  const out: WireMessage[] = [];
  for (const msg of req.messages) {
    const accompaniesToolUse =
      msg.role === "assistant" && msg.content.some((block) => block.type === "tool_use");
    const strips = stripPrior && msg.role === "assistant" && !accompaniesToolUse;

    const kept = msg.content.filter((block) => {
      if (block.type === "text" && block.text.trim() === "") return false;
      if (!isThinking(block)) return true;
      if (!strips) return true;
      drops.strippedByPolicy += 1;
      return false;
    });
    if (kept.length === 0) continue;
    out.push({ ...msg, content: kept });
  }
  return { messages: out, drops };
}

export function totalThinkingDrops(drops: ThinkingDrops): number {
  return drops.strippedByPolicy;
}

export function replayableMessages(req: SidecarRequest): WireMessage[] {
  const { messages, drops } = replayableMessagesWithDrops(req);

  if (req.context !== undefined) req.context.thinking_dropped = totalThinkingDrops(drops);

  return messages;
}

export function recordExtraThinkingDrops(req: SidecarRequest, dropped: number): void {
  if (dropped === 0 || req.context === undefined) return;
  req.context.thinking_dropped = (req.context.thinking_dropped ?? 0) + dropped;
}
