import editDesc from "../../prompts/tools/workspace/edit.md" with { type: "text" };
import patchDesc from "../../prompts/tools/workspace/apply_patch.md" with { type: "text" };
import { renderTemplate, stripOneTrailingNewline } from "../engine/prompt.ts";
import { compareByCodePoint } from "../util/sort.ts";
import type { ToolDefinition } from "../llm/types.ts";
import { toolPatternMatches } from "../config/app.ts";

import bashDesc from "../../prompts/tools/bash.md" with { type: "text" };
import activityHeatmapDesc from "../../prompts/tools/activity/activity_heatmap.md" with { type: "text" };
import setNextWakeDesc from "../../prompts/tools/autonomy/set_next_wake.md" with { type: "text" };
import modelHistoryDesc from "../../prompts/tools/history/model_history.md" with { type: "text" };
import searchHistoryDesc from "../../prompts/tools/history/search_history.md" with { type: "text" };
import generateImageDesc from "../../prompts/tools/images/generate_image.md" with { type: "text" };
import searchDesc from "../../prompts/tools/workspace/search.md" with { type: "text" };
import readDesc from "../../prompts/tools/workspace/read.md" with { type: "text" };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolsConfigView {
  enabled_tools: string[];
  enabled_subagents: string[];
}

export interface SubagentConfigView {
  description: string;
}

const TIME_BOUND_FORMAT =
  "RFC3339 timestamp with seconds and an explicit UTC offset or `Z`, for example 2026-05-13T09:00:00+10:00. The offset is interpreted as written.";

export const ALL_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: "read",
    description: stripOneTrailingNewline(readDesc),
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1, description: "File to read. Absolute, or relative to the workspace root." },
        offset: { type: "integer", minimum: 1, description: "First text line to return, numbered from 1. Default 1. Not accepted for images." },
        limit: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum text lines to return. Default 2000, maximum 2000. The result character budget can shorten the page." },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description: stripOneTrailingNewline(editDesc),
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1, description: "Existing UTF-8 file. Absolute, or relative to the workspace root." },
        old_string: { type: "string", minLength: 1, description: "Exact text to replace, including whitespace and line endings." },
        new_string: { type: "string", description: "Replacement text. Empty string deletes the matched text." },
        replace_all: { type: "boolean", description: "Replace all non-overlapping exact occurrences. Default false requires a unique match." },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description: stripOneTrailingNewline(patchDesc),
    parameters: {
      type: "object",
      properties: { patch: { type: "string", minLength: 1, description: "Codex patch starting with *** Begin Patch and ending with *** End Patch." } },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  {
    name: "bash",
    description: stripOneTrailingNewline(bashDesc),
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
          description: "Bash command or script to execute. May span multiple lines.",
        },
        workdir: {
          type: "string",
          description: "Working directory. Relative paths resolve from the workspace root; absolute paths are accepted. Defaults to the workspace root.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_image",
    description: stripOneTrailingNewline(generateImageDesc),
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Description of the image to generate: subject, mood, composition, and style.",
        },
        size: {
          type: "string",
          description: "Requested dimensions as WIDTHxHEIGHT, for example '1024x1024'. Omit to use the configured default size. Which sizes work depends on the configured image model.",
        },
        caption: {
          type: "string",
          description: "Optional caption sent with the image. Omit to send the image without one.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "activity_heatmap",
    description: stripOneTrailingNewline(activityHeatmapDesc),
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "Number of most recent days to include, as a positive integer. Default 30. Up to 90 days are retained; larger values return what exists.",
          default: 30,
        },
      },
    },
  },
  {
    name: "search",
    description: stripOneTrailingNewline(searchDesc),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for: a keyword, phrase, or natural-language description. Must not be empty.",
        },
        mode: {
          type: "string",
          enum: ["hybrid", "lexical", "vector"],
          description:
            "Ranking mode. `hybrid` (default) blends semantic similarity with substring matching. `lexical` is case-insensitive substring matching only, ordered by file recency. `vector` is semantic similarity only. Semantic modes fall back to lexical when embeddings are not configured, and the response says so.",
        },
        path: {
          type: "string",
          description:
            "Restrict the search to this directory, relative to the workspace. Applies in every mode; semantic results are filtered to the subtree after ranking against the workspace-wide index. Omit to search the whole workspace.",
        },
        max_results: {
          type: "integer",
          description: "Maximum number of hits to return. Default 20; values above 100 are capped at 100.",
        },
        context: {
          type: "integer",
          minimum: 0,
          maximum: 10000,
          default: 500,
          description: "Characters of context on each side of a match. Default 500, range 0-10000. May be reduced automatically to keep the response near 12000 characters; every result and the full match are kept.",
        },
      },
      required: ["query"],
    },
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
            "Text to search for (case-insensitive). Omit to select messages by the other filters alone.",
        },
        match: {
          type: "string",
          enum: ["ranked", "phrase"],
          description: "`ranked` (default) allows partial-term matches. `phrase` requires the whole phrase, case-insensitively and on word boundaries, with no semantic expansion; use it for names and titles. `phrase` requires `query`.",
        },
        compact: {
          type: "boolean",
          description: "Return matching excerpts of up to 600 characters without neighboring messages, for focused fact lookup. Default false returns full messages with their neighbors.",
        },
        start_time: {
          type: "string",
          description: `Inclusive lower bound on message time. ${TIME_BOUND_FORMAT}`,
        },
        end_time: {
          type: "string",
          description: `Inclusive upper bound on message time. ${TIME_BOUND_FORMAT}`,
        },
        max_results: {
          type: "integer",
          description: "Maximum number of matching messages to return, not counting neighboring context. Default 3; values above 50 are capped at 50.",
        },
        mode: {
          type: "string",
          enum: ["auto", "lexical", "hybrid", "vector"],
          description:
            "Retrieval mode. `auto` uses hybrid when embeddings are configured and lexical otherwise. `lexical` matches text only. `hybrid` blends lexical and semantic matches. `vector` is semantic only and searches only chunks that are currently embedded, so messages awaiting indexing can be missed. Semantic modes fall back to lexical when embeddings are not configured, and without a `query` matching is always lexical. Defaults to the configured retrieval mode.",
        },
        model: {
          type: "string",
          description:
            "Only return assistant messages generated by a matching model. Case-insensitive substring match with '.' and '-' treated as equal, so 'opus-4.6' matches both 'claude-opus-4-6' and 'anthropic/claude-opus-4.6'. User messages and messages stored without a model never match, so an empty result can mean the messages are not attributable.",
        },
      },
      required: [],
    },
  },
  {
    name: "model_history",
    description: stripOneTrailingNewline(modelHistoryDesc),
    parameters: {
      type: "object",
      properties: {
        start_time: {
          type: "string",
          description: `Inclusive lower bound on when a model was used. Omit to start from the earliest recorded call. ${TIME_BOUND_FORMAT}`,
        },
        end_time: {
          type: "string",
          description: `Inclusive upper bound on when a model was used. Omit to include everything up to now. ${TIME_BOUND_FORMAT}`,
        },
      },
      required: [],
    },
  },
  {
    name: "set_next_wake",
    description: stripOneTrailingNewline(setNextWakeDesc),
    parameters: {
      type: "object",
      properties: {
        hours_from_now: {
          type: "number",
          description: "Hours from now until the next heartbeat. Fractions are allowed. Clamped to the configured minimum and maximum interval.",
        },
        reason: { type: "string", description: "Why this time. Recorded in the heartbeat log." },
      },
      required: ["hours_from_now", "reason"],
      additionalProperties: false,
    },
  },
]);

export { toolPatternMatches };

export function toolEnabled(cfg: ToolsConfigView, name: string): boolean {
  return cfg.enabled_tools.some((t) => toolPatternMatches(t, name));
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
