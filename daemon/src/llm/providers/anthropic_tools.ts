/**
 * Shore's tool surface, in the shape Anthropic's `toolRunner` executes.
 *
 * The Anthropic SDK owns the request → execute → continue cycle for that
 * dialect, and the price of that is handing it callables rather than being
 * asked for a list of tool calls. This is the adapter: one `BetaRunnableTool`
 * per definition, each of which runs the tool through the {@link ToolPhase} and
 * reports back in the SDK's vocabulary.
 *
 * Split out of `tool_rpc.ts`'s `daemonTools`, which did the same job over a
 * Unix socket. What changed is the middle — the call is a function call now —
 * and one thing that fell out with it: `daemonTools` needed an `onUnreachable`
 * callback that aborted the runner, because a tool that could not be *attempted*
 * had to end the turn without telling the model, and the runner formats
 * everything a tool throws as tool-result content. In one process there is no
 * such failure. `runTool` always answers.
 */

import { ToolError } from "@anthropic-ai/sdk/resources/beta/messages";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import type { ContentBlock } from "../../engine/types.ts";
import type { ToolPhase } from "../../tools/execute.ts";
import type { ToolDefinition } from "../types.ts";

/**
 * Wrap each definition as a runnable tool.
 *
 * `record` is called as each result lands so the caller can assemble a round's
 * `tool_result` blocks in the order the model asked for them. The runner runs a
 * round's tools concurrently, so completion order is a race and must not decide
 * what gets stored.
 */
export function runnableTools(
  definitions: readonly ToolDefinition[],
  tools: ToolPhase,
  record: (toolId: string, block: ContentBlock) => void,
): BetaRunnableTool[] {
  return definitions.map((definition) =>
    betaTool({
      name: definition.name,
      description: definition.description,
      // `betaTool` wants a *literal* schema so it can derive the argument type;
      // ours arrives at runtime. Narrowing the cast to "some object schema"
      // rather than `never` keeps the derived argument type permissive — with
      // `never`, the resulting tool will not widen to the runner's tool list.
      inputSchema: definition.input_schema as { type: "object" },
      run: async (input: unknown, context) => {
        // The runner hands back the tool_use that triggered this run; its id is
        // what the result block has to echo.
        const toolId = context?.toolUse.id ?? "";
        const block = await tools.runTool({ id: toolId, name: definition.name, input });
        record(toolId, block);

        const content = block.type === "tool_result" ? block.content : "";
        const text = typeof content === "string" ? content : JSON.stringify(content);
        // A failed tool keeps its own text: `ToolError` carries content
        // verbatim, where a plain `Error` would be reformatted as "Error: …"
        // and the model would read the prefix as part of the failure.
        if (block.type === "tool_result" && block.is_error === true) throw new ToolError(text);
        return text;
      },
    }),
  );
}
