import { streamWithRetry } from "./fallback.ts";
import { shouldRetryError } from "./retry.ts";
import { streamErrorEvent } from "./types.ts";
import type { ToolPhase } from "../tools/execute.ts";
import type { SidecarProvider, SidecarRequest, StreamEvent, ToolLoopOptions } from "./types.ts";
import { EventChannel, genericToolLoopEvents, type ModelCallRetryOptions } from "./providers/generic_loop.ts";

export function toolLoopEvents(
  provider: SidecarProvider,
  request: SidecarRequest,
  tools: ToolPhase,
  signal?: AbortSignal,
  retry?: ModelCallRetryOptions,
  options: ToolLoopOptions = {},
): AsyncIterable<StreamEvent> {
  if ((request.tools?.length ?? 0) > 0 && provider.streamWithTools !== undefined) {
    return provider.streamWithTools(request, tools, signal, { ...options, ...(retry === undefined ? {} : { retry }) });
  }
  return genericToolLoopEvents(provider, request, tools, signal, Date.now, retry, options);
}

export async function* retryToolStream(
  start: (tools: ToolPhase, signal: AbortSignal) => AsyncIterable<StreamEvent>,
  tools: ToolPhase,
  signal: AbortSignal | undefined,
  retry: ModelCallRetryOptions | undefined,
): AsyncIterable<StreamEvent> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const channel = new EventChannel();
  const started = Date.now();
  let visible = false;
  let lastError: Extract<StreamEvent, { type: "error" }> | undefined;
  const phase: ToolPhase = {
    ...tools,
    onTurn: (turn) => {
      visible = true;
      return tools.onTurn?.(turn);
    },
    runTool: (use) => {
      visible = true;
      return tools.runTool(use);
    },
  };
  const once = async (): Promise<void> => {
    lastError = undefined;
    for await (const event of start(phase, abort.signal)) {
      if (event.type === "error") {
        lastError = event;
        throw event.cause ?? { kind: "stream_errored", ...event };
      }
      if (event.type !== "start" && event.type !== "provider_warning" && event.type !== "ping") visible = true;
      await channel.send(event);
    }
  };
  const running = (async () => {
    try {
      if (retry === undefined) await once();
      else await streamWithRetry(
        once, retry.settings,
        (error, attempt, maxRetries) => !visible && shouldRetryError(error, attempt, { max_retries: maxRetries }).decision === "retry",
        retry.sleep,
        { signal: abort.signal, ...(retry.onRetry === undefined ? {} : { onRetry: retry.onRetry }), ...(retry.random === undefined ? {} : { random: retry.random }) },
      );
    } catch (error) {
      await channel.send(lastError ?? streamErrorEvent(error,
        { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        started, 0, Date.now));
    } finally {
      channel.close();
    }
  })();
  try {
    yield* channel.drain();
  } finally {
    abort.abort();
    channel.close();
    await running;
    signal?.removeEventListener("abort", cancel);
  }
}
