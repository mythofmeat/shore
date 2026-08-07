import type { ContentBlock } from "../engine/types";
import type { WireMessage } from "./types";

export function sanitizeToolPairs(messages: WireMessage[]): WireMessage[] | undefined {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    for (const block of msg.content) {
      if (msg.role === "assistant" && block.type === "tool_use") {
        toolUseIds.add(block.id);
      } else if (msg.role === "user" && block.type === "tool_result") {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  const orphanUses = difference(toolUseIds, toolResultIds);
  const orphanResults = difference(toolResultIds, toolUseIds);

  if (orphanUses.size === 0 && orphanResults.size === 0) return undefined;

  const out: WireMessage[] = [];
  for (const msg of messages) {
    const kept = msg.content.filter((block) => keep(msg.role, block, orphanUses, orphanResults));
    if (kept.length === 0) continue;
    out.push({
      role: msg.role,
      content: kept,
      ...(msg.provider_key !== undefined ? { provider_key: msg.provider_key } : {}),
      ...(msg.model !== undefined ? { model: msg.model } : {}),
    });
  }
  return out;
}

function keep(
  role: WireMessage["role"],
  block: ContentBlock,
  orphanUses: Set<string>,
  orphanResults: Set<string>,
): boolean {
  if (role === "assistant" && block.type === "tool_use") return !orphanUses.has(block.id);
  if (role === "user" && block.type === "tool_result") return !orphanResults.has(block.tool_use_id);
  return true;
}

function difference(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const v of a) if (!b.has(v)) out.add(v);
  return out;
}
