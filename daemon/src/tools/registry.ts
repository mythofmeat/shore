import { renderTemplate, stripOneTrailingNewline } from "../engine/prompt.ts";
import { compareByCodePoint } from "../util/sort.ts";
import type { ToolDefinition } from "../llm/types.ts";
import { schemasFrom } from "./validate.ts";

import bashDesc from "../../prompts/tools/bash.md" with { type: "text" };
import activityHeatmapDesc from "../../prompts/tools/activity/activity_heatmap.md" with { type: "text" };
import modelHistoryDesc from "../../prompts/tools/history/model_history.md" with { type: "text" };
import searchHistoryDesc from "../../prompts/tools/history/search_history.md" with { type: "text" };
import generateImageDesc from "../../prompts/tools/images/generate_image.md" with { type: "text" };
import webSearchDesc from "../../prompts/tools/web/web_search.md" with { type: "text" };
import searchDesc from "../../prompts/tools/workspace/search.md" with { type: "text" };

export type ToolCategory = "web" | "other";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: ToolCategory;
}

export interface ToolsConfigView {
  enabled_tools: string[];
  enabled_subagents: string[];
}

export interface SubagentConfigView {
  description: string;
}

export const ALL_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: "bash",
    description: stripOneTrailingNewline(bashDesc),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "Bash command or script to execute." },
        workdir: { type: "string", description: "Working directory, relative to the workspace or absolute. Defaults to the workspace root." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    category: "other",
  },
  {
    name: "generate_image",
    description: stripOneTrailingNewline(generateImageDesc),
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text prompt for image generation." },
        size: {
          type: "string",
          description: "Image dimensions (e.g. '1024x1024').",
          default: "1024x1024",
        },
        caption: {
          type: "string",
          description: "Optional caption to send with the generated image.",
        },
      },
      required: ["prompt"],
    },
    category: "other",
  },
  {
    name: "web_search",
    description: stripOneTrailingNewline(webSearchDesc),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        max_results: {
          type: "integer",
          description: "Maximum number of results to return.",
          default: 5,
        },
      },
      required: ["query"],
    },
    category: "web",
  },
  {
    name: "activity_heatmap",
    description: stripOneTrailingNewline(activityHeatmapDesc),
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "Number of days of history to include.",
          default: 30,
        },
      },
    },
    category: "other",
  },
  {
    name: "search",
    description: stripOneTrailingNewline(searchDesc),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword, phrase, or natural-language description to search for.",
        },
        mode: {
          type: "string",
          enum: ["hybrid", "lexical", "vector"],
          description:
            "Ranking mode. `hybrid` (default) blends semantic similarity with substring matching. `lexical` is case-insensitive substring only, ordered by file recency. `vector` is pure semantic similarity.",
        },
        path: {
          type: "string",
          description:
            "Optional relative path to scope the search to a subtree. Works in all modes — hybrid/vector queries are filtered to this subtree after ranking against the workspace-wide embedding index.",
        },
        max_results: {
          type: "number",
          description: "Maximum matches to return. Defaults to 20, maximum 100.",
        },
        context: {
          type: "integer",
          minimum: 0,
          maximum: 10000,
          default: 500,
          description: "Characters of context on each side of the match. Automatically shrinks to target a 12000-character response while retaining every result and the full match.",
        },
      },
      required: ["query"],
    },
    category: "other",
  },
  {
    name: "search_chat_logs",
    description: stripOneTrailingNewline(searchHistoryDesc),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional keyword or phrase to search for (case-insensitive). Omit this to return messages by time range only.",
        },
        match: {
          type: "string",
          enum: ["ranked", "phrase"],
          description: "Use phrase for named artists/titles: requires the whole case-insensitive phrase with word boundaries and disables semantic expansion. Default ranked allows partial-term matches.",
        },
        compact: {
          type: "boolean",
          description: "Return matching excerpts of up to 600 characters without neighboring messages. Use for focused fact lookup; default false returns full messages and neighbors.",
        },
        start_time: {
          type: "string",
          description:
            "Optional inclusive lower timestamp bound in RFC3339 format, for example 2026-05-13T09:00:00+10:00.",
        },
        end_time: {
          type: "string",
          description:
            "Optional inclusive upper timestamp bound in RFC3339 format, for example 2026-05-13T17:00:00+10:00.",
        },
        max_results: {
          type: "number",
          description: "Maximum matching messages to return. Defaults to 3, maximum 50.",
        },
        mode: {
          type: "string",
          enum: ["auto", "lexical", "hybrid", "vector"],
          description:
            "Retrieval mode. `auto` uses hybrid search when embeddings are configured and lexical FTS otherwise; `vector` searches only currently embedded chunks.",
        },
        model: {
          type: "string",
          description:
            "Optional model filter: only return assistant messages minted by a matching model. Case-insensitive substring match with '.' and '-' treated as equal, so 'opus-4.6' matches both 'claude-opus-4-6' and 'anthropic/claude-opus-4.6'. Messages stored before model tracking carry no model and never match.",
        },
      },
      required: [],
    },
    category: "other",
  },
  {
    name: "model_history",
    description: stripOneTrailingNewline(modelHistoryDesc),
    parameters: {
      type: "object",
      properties: {
        start_time: {
          type: "string",
          description:
            "Optional inclusive lower timestamp bound in RFC3339 format, for example 2026-05-13T09:00:00+10:00.",
        },
        end_time: {
          type: "string",
          description:
            "Optional inclusive upper timestamp bound in RFC3339 format, for example 2026-05-13T17:00:00+10:00.",
        },
      },
      required: [],
    },
    category: "other",
  },
]);

export const BUILTIN_TOOL_SCHEMAS = schemasFrom(
  ALL_TOOLS.map((tool) => ({ name: tool.name, input_schema: tool.parameters })),
);

export function toolPatternMatches(pattern: string, name: string): boolean {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : pattern === name;
}

export function toolEnabled(cfg: ToolsConfigView, name: string): boolean {
  return cfg.enabled_tools.some((t) => toolPatternMatches(t, name));
}

export function anyEnabled(cfg: ToolsConfigView): boolean {
  return cfg.enabled_tools.length > 0 || cfg.enabled_subagents.length > 0;
}

export function availableTools(cfg: ToolsConfigView): ToolDef[] {
  return ALL_TOOLS.filter((t) => toolEnabled(cfg, t.name));
}

export function templateVars(charName: string, userName: string): Map<string, string> {
  return new Map([
    ["char", charName],
    ["character_name", charName],
    ["user", userName],
  ]);
}

export function renderToolDefs(
  cfg: ToolsConfigView,
  charName: string,
  userName: string,
): ToolDefinition[] {
  const vars = templateVars(charName, userName);
  return availableTools(cfg).map((t) => ({
    name: t.name,
    description: renderTemplate(t.description, vars),
    input_schema: t.parameters,
  }));
}

export const SUBAGENT_INPUT_SCHEMA: Record<string, unknown> = Object.freeze({
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural-language request for this sub-agent.",
    },
  },
  required: ["query"],
});

export function subagentToolDefs(
  subagents: ReadonlyMap<string, SubagentConfigView>,
  enabled: readonly string[],
  charName: string,
  userName: string,
): ToolDefinition[] {
  const vars = templateVars(charName, userName);
  return [...subagents.keys()]
    .sort(compareByCodePoint)
    .filter((name) => enabled.includes(name))
    .map((name) => ({
      name: `ask_${name}`,
      description: renderTemplate((subagents.get(name) as SubagentConfigView).description, vars),
      input_schema: SUBAGENT_INPUT_SCHEMA,
    }));
}

export function assembleToolSurface(
  staticDefs: readonly ToolDefinition[],
  subagentDefs: readonly ToolDefinition[],
  mcpDefs: readonly ToolDefinition[],
): ToolDefinition[] {
  return [...staticDefs, ...subagentDefs, ...mcpDefs];
}
