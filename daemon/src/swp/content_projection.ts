import type { ContentBlock } from "../protocol/ContentBlock.ts";
import type { MessageAlternative } from "../protocol/MessageAlternative.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";

export const MULTIMODAL_TOOL_RESULTS = "multimodal-tool-results";

function text(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type === "image") return [`[Image attached: ${block.source.media_type}; this client does not support structured image results]`];
    if (block.type === "tool_result") return [typeof block.content === "string" ? block.content : text(block.content)];
    return [];
  }).join("\n");
}

function blocksForLegacy(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === "image") return { type: "text", text: text([block]) };
    if (block.type === "tool_result" && Array.isArray(block.content)) return { ...block, content: text(block.content) };
    return block;
  });
}

function projectBody<T extends Pick<MessageAlternative, "content_blocks"> & { alternatives?: MessageAlternative[] }>(body: T): T {
  return {
    ...body,
    content_blocks: blocksForLegacy(body.content_blocks),
    ...(body.alternatives === undefined ? {} : { alternatives: body.alternatives.map(projectBody) }),
  };
}

export function contentForClient(message: ServerMessage, capabilities: readonly string[]): ServerMessage {
  if (capabilities.includes(MULTIMODAL_TOOL_RESULTS)) return message;
  switch (message.type) {
    case "history": return { ...message, messages: message.messages.map(projectBody) };
    case "new_message": return projectBody(message);
    case "stream_end": return (message.terminal_content_blocks === null || message.terminal_content_blocks === undefined) ? message : {
      ...message, terminal_content_blocks: blocksForLegacy(message.terminal_content_blocks),
    };
    default: return message;
  }
}
