import { renderTemplate, stripOneTrailingNewline } from "../engine/prompt.ts";
import { compareByCodePoint } from "../util/sort.ts";
import type { ToolDefinition } from "../llm/types.ts";

import activityHeatmapDesc from "../../prompts/tools/activity/activity_heatmap.md" with { type: "text" };
import rollDiceDesc from "../../prompts/tools/basic/roll_dice.md" with { type: "text" };
import modelHistoryDesc from "../../prompts/tools/history/model_history.md" with { type: "text" };
import searchHistoryDesc from "../../prompts/tools/history/search_history.md" with { type: "text" };
import generateImageDesc from "../../prompts/tools/images/generate_image.md" with { type: "text" };
import fetchUrlDesc from "../../prompts/tools/web/fetch_url.md" with { type: "text" };
import webSearchDesc from "../../prompts/tools/web/web_search.md" with { type: "text" };
import deleteDesc from "../../prompts/tools/workspace/delete.md" with { type: "text" };
import editDesc from "../../prompts/tools/workspace/edit.md" with { type: "text" };
import gitDesc from "../../prompts/tools/workspace/git.md" with { type: "text" };
import readDesc from "../../prompts/tools/workspace/read.md" with { type: "text" };
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
    name: "fetch_url",
    description: stripOneTrailingNewline(fetchUrlDesc),
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
      },
      required: ["url"],
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
    name: "roll_dice",
    description: stripOneTrailingNewline(rollDiceDesc),
    parameters: {
      type: "object",
      properties: {
        notation: {
          type: "string",
          description: "Dice notation: NdS[+/-M]. Examples: '2d6', '1d20+5', '4d6-1'.",
        },
      },
      required: ["notation"],
    },
    category: "other",
  },
  {
    name: "read",
    description: stripOneTrailingNewline(readDesc),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path within your workspace. A file path returns its contents; a directory path lists its entries. Omit for a listing of the workspace root.",
        },
        offset: {
          type: "number",
          description:
            "Line number to start reading from (1-based). Files only; ignored for directories. Optional.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of lines to read. Files only; ignored for directories. Optional.",
        },
      },
      required: [],
    },
    category: "other",
  },
  {
    name: "edit",
    description: stripOneTrailingNewline(editDesc),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path within your workspace." },
        content: {
          type: "string",
          description:
            "Full content for the file, creating it or overwriting it wholesale. Parent directories are created automatically. Mutually exclusive with `edits`.",
        },
        edits: {
          type: "array",
          description:
            "List of replacements to apply in order to an existing file. Mutually exclusive with `content`.",
          items: {
            type: "object",
            properties: {
              old_string: {
                type: "string",
                description:
                  "Exact text to find and replace. Must match whitespace and newlines precisely.",
              },
              new_string: {
                type: "string",
                description: "Text to replace old_string with.",
              },
              replace_all: {
                type: "boolean",
                description:
                  "Replace every occurrence of old_string. Defaults to false, which requires old_string to match exactly once.",
              },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path"],
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
      },
      required: ["query"],
    },
    category: "other",
  },
  {
    name: "delete",
    description: stripOneTrailingNewline(deleteDesc),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to remove, within your workspace.",
        },
      },
      required: ["path"],
    },
    category: "other",
  },
  {
    name: "git",
    description: stripOneTrailingNewline(gitDesc),
    parameters: {
      type: "object",
      properties: {
        subcommand: {
          type: "string",
          description:
            'The git subcommand to run, e.g. "status", "add", "commit", "log", "diff".',
        },
        args: {
          type: "array",
          description:
            'Arguments for the subcommand, one array element per argument. For example ["-m", "note why this matters"]. Optional.',
          items: { type: "string" },
        },
        workdir: {
          type: "string",
          description:
            "Directory to run in, relative to your workspace root. Optional; defaults to the workspace root.",
        },
      },
      required: ["subcommand"],
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
