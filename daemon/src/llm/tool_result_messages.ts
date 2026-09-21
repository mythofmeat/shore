import type { WireMessage } from "./types.ts";

export function coalesceToolResults(messages: readonly WireMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const message of messages) {
    const previous = out.at(-1);
    if (message.role === "user" && previous?.role === "user" &&
        message.content.some((block) => block.type === "tool_result") &&
        previous.content.some((block) => block.type === "tool_result")) {
      out[out.length - 1] = {
        ...previous,
        content: [...previous.content, ...message.content],
        transient_tail: message.transient_tail ?? 0,
      };
    } else out.push(message);
  }
  return out;
}
