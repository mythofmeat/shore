import type { ContentBlock } from "../engine/types.ts";
import type { SidecarProvider, SidecarRequest, StreamEvent, WireMessage } from "./types.ts";
import { countImageBlocks, isImageRejection, stripImageBlocks, textOnlyReason } from "./image_support.ts";

export interface ImagePolicy {
  support: (request: SidecarRequest) => boolean | undefined;
  rejected: (request: SidecarRequest) => void;
  warn: (message: string) => void;
}

export function withToolImages(provider: SidecarProvider, policy: ImagePolicy): SidecarProvider {
  let refused = false;
  const project = (req: SidecarRequest): SidecarRequest => {
    if (!refused && policy.support(req) !== false) return req;
    const reason = textOnlyReason(req.provider_key ?? req.sdk, req.model);
    const stripped = stripImageBlocks(req.messages, reason);
    if (stripped.stripped === 0) return req;
    policy.warn(`${reason}; ${stripped.stripped} image(s) omitted from this request. Original images remain in conversation history.`);
    return { ...req, messages: stripped.messages };
  };
  const stream = async function* (req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    let visible = false;
    const call = project(req);
    try {
      for await (const event of provider.stream(call, signal)) {
        if (event.type === "error" && !visible && countImageBlocks(call.messages) > 0 && isImageRejection(event.cause ?? { kind: "stream_errored", ...event })) {
          throw event.cause ?? { kind: "stream_errored", ...event };
        }
        if (!["start", "ping", "provider_warning", "error"].includes(event.type)) visible = true;
        yield event;
      }
    } catch (error) {
      if (visible || signal?.aborted || countImageBlocks(call.messages) === 0 || !isImageRejection(error)) throw error;
      refused = true;
      policy.rejected(req);
      yield* provider.stream(project(req), signal);
    }
  };
  return {
    stream,
    generate: (req, signal) => provider.generate(project(req), signal),
    ...(provider.streamWithTools === undefined ? {} : {
      streamWithTools: (req, tools, signal, options) => {
        const originals = new Map<string, ContentBlock>();
        if (provider.streamWithTools === undefined) throw new Error("Native tool stream is unavailable");
        return provider.streamWithTools(project(req), {
          ...tools,
          runTool: async (use) => {
            const result = await tools.runTool(use);
            if (result.type === "tool_result") originals.set(result.tool_use_id, result);
            const message: WireMessage = { role: "user", content: [result] };
            return project({ ...req, messages: [message] }).messages[0]?.content[0] ?? result;
          },
          recordTurn: (role, blocks) => tools.recordTurn(role, blocks.map((block) => block.type === "tool_result" ? originals.get(block.tool_use_id) ?? block : block)),
        }, signal, options);
      },
    }),
  };
}
