import type { ToolPhase } from "../../tools/execute.ts";
import type { SidecarRequest, StreamEvent } from "../types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import {
  genericToolLoopEvents,
  type ModelCallRetryOptions,
} from "./generic_loop.ts";

export function anthropicToolLoopEvents(
  req: SidecarRequest,
  tools: ToolPhase,
  signal?: AbortSignal,
  now: () => number = Date.now,
  retry?: ModelCallRetryOptions,
): AsyncIterable<StreamEvent> {
  return genericToolLoopEvents(new AnthropicProvider(), req, tools, signal, now, retry);
}
