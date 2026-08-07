import type { ContentBlock, Message, Role } from "./types";

function isToolLoopAssistant(msg: Message): boolean {
  return msg.role === "assistant" && msg.content_blocks.some((b) => b.type === "tool_use");
}

function isToolResultOnly(msg: Message): boolean {
  return (
    msg.role === "user" &&
    msg.content_blocks.length > 0 &&
    msg.content_blocks.every((b) => b.type === "tool_result")
  );
}

function deriveContentTextOnly(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== "text") continue;
    const trimmed = block.text.trim();
    if (trimmed !== "") parts.push(trimmed);
  }
  return parts.join("\n");
}

function collectRound(
  assistant: Message,
  results: Message | undefined,
  out: ContentBlock[],
): void {
  for (const block of assistant.content_blocks) {
    if (block.type === "tool_use") {
      out.push(block);
      const match = results?.content_blocks.find(
        (b) => b.type === "tool_result" && b.tool_use_id === block.id,
      );
      if (match !== undefined) out.push(match);
      continue;
    }
    if (block.type === "text" && block.text.trim() === "") continue;
    out.push(block);
  }
}

export function mergeToolLoopMessages(messages: Message[]): Message[] {
  const output: Message[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role !== "assistant") {
      if (!isToolResultOnly(msg)) output.push(msg);
      i += 1;
      continue;
    }

    if (!isToolLoopAssistant(msg)) {
      output.push(msg);
      i += 1;
      continue;
    }

    const mergedBlocks: ContentBlock[] = [];
    let lastAssistant = msg;

    while (i < messages.length) {
      const current = messages[i]!;
      const next = messages[i + 1];
      const results = next !== undefined && isToolResultOnly(next) ? next : undefined;

      collectRound(current, results, mergedBlocks);
      lastAssistant = current;
      i += results !== undefined ? 2 : 1;

      if (i >= messages.length) break;

      const following = messages[i]!;
      if (following.role === "assistant" && isToolLoopAssistant(following)) {
        continue;
      }
      if (following.role === "assistant") {
        mergedBlocks.push(...following.content_blocks);
        lastAssistant = following;
        i += 1;
        break;
      }
      break;
    }

    output.push({
      msg_id: lastAssistant.msg_id,
      role: "assistant" as Role,
      content: deriveContentTextOnly(mergedBlocks),
      images: lastAssistant.images,
      content_blocks: mergedBlocks,
      ...(lastAssistant.alt_index !== undefined ? { alt_index: lastAssistant.alt_index } : {}),
      ...(lastAssistant.alt_count !== undefined ? { alt_count: lastAssistant.alt_count } : {}),
      ...(lastAssistant.alternatives !== undefined
        ? { alternatives: lastAssistant.alternatives }
        : {}),
      timestamp: lastAssistant.timestamp,
      ...(lastAssistant.provider_key !== undefined
        ? { provider_key: lastAssistant.provider_key }
        : {}),
      ...(lastAssistant.model !== undefined ? { model: lastAssistant.model } : {}),
      ...(lastAssistant.origin !== undefined ? { origin: lastAssistant.origin } : {}),
    });
  }

  return output;
}
