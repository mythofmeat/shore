import type { ToolPhase } from "../../src/tools/execute.ts";
import type { SidecarRequest, StreamEvent } from "../../src/llm/types.ts";
import { AnthropicProvider } from "../../src/llm/providers/anthropic.ts";
import {
  genericToolLoopEvents,
  type ModelCallRetryOptions,
} from "../../src/llm/providers/generic_loop.ts";

export function anthropicToolLoopEvents(
  req: SidecarRequest,
  tools: ToolPhase,
  signal?: AbortSignal,
  now: () => number = Date.now,
  retry?: ModelCallRetryOptions,
): AsyncIterable<StreamEvent> {
  return genericToolLoopEvents(new AnthropicProvider(), req, tools, signal, now, retry);
}
