import type { GenerateResponse, StreamEvent } from "../../src/llm/types.ts";

export async function* eventsForResponse(
  response: GenerateResponse,
): AsyncGenerator<StreamEvent> {
  yield { type: "start", model: response.model };
  for (const block of response.content_blocks) {
    switch (block.type) {
      case "text":
        yield { type: "text", text: block.text };
        break;
      case "thinking":
        yield { type: "thinking", text: block.thinking };
        break;
      case "tool_use":
        yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
        break;
      default:
        break;
    }
  }
  yield {
    type: "done",
    content: response.content,
    content_blocks: response.content_blocks,
    finish_reason: response.finish_reason,
    usage: response.usage,
    timing: response.timing,
  };
}

export async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

export function tickingClock(): () => number {
  let t = 0;
  return () => {
    t += 10;
    return t;
  };
}
