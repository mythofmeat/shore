import { toolLoopEvents } from "../../src/llm/tool_loop.ts";
import { consumeStream } from "../../src/llm/stream.ts";
import type { GenerateResponse, SidecarRequest, ToolLoopOptions } from "../../src/llm/types.ts";
import type { ToolPhase } from "../../src/tools/execute.ts";
import { eventsForResponse } from "./stream.ts";

export function toolGeneration(
  next: (request: SidecarRequest, iteration: number) => Promise<GenerateResponse | undefined>,
) {
  return async (request: SidecarRequest, phase: ToolPhase, signal?: AbortSignal, options?: ToolLoopOptions): Promise<GenerateResponse> => {
    let iteration = 0;
    const provider = {
      generate: async (call: SidecarRequest) => {
        const response = await next(call, iteration++);
        if (response === undefined) throw new Error("Model returned no response");
        return response;
      },
      async *stream(call: SidecarRequest) {
        yield* eventsForResponse(await this.generate(call));
      },
    };
    const result = await consumeStream(toolLoopEvents(provider, request, phase, signal, undefined, options), {
      regen: false, sink: () => {},
    });
    if ("err" in result) throw result.err.kind === "stream_errored" ? result.err.cause ?? result.err : result.err;
    return { ...result.ok, model: request.model };
  };
}
