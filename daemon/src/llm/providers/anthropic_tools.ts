import { ToolError } from "@anthropic-ai/sdk/resources/beta/messages";
import type { BetaToolResultContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import type { ContentBlock } from "../../engine/types.ts";
import type { ToolPhase } from "../../tools/execute.ts";
import type { ToolDefinition } from "../types.ts";
import { toolResultText } from "../types.ts";

export function runnableTools(
  definitions: readonly ToolDefinition[],
  tools: ToolPhase,
  record: (toolId: string, block: ContentBlock) => void,
): BetaRunnableTool[] {
  return definitions.map((definition) =>
    betaTool({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.input_schema as { type: "object" },
      run: async (input: unknown, context) => {
        const toolId = context?.toolUse.id ?? "";
        const block = await tools.runTool({ id: toolId, name: definition.name, input });
        record(toolId, block);

        const content = block.type === "tool_result" ? block.content : "";
        if (block.type === "tool_result" && block.is_error === true) {
          throw new ToolError(toolResultText(content));
        }
        return toolResultParams(content);
      },
    }),
  );
}

function toolResultParams(
  content: string | ContentBlock[],
): string | BetaToolResultContentBlockParam[] {
  if (typeof content === "string") return content;
  const params: BetaToolResultContentBlockParam[] = [];
  for (const block of content) {
    if (block.type === "text") {
      params.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      params.push({
        type: "image",
        source: {
          type: "base64",
          media_type: block.source.media_type as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          data: block.source.data,
        },
      });
    }
  }
  return params.length === 0 ? toolResultText(content) : params;
}
