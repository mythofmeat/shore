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
import readChatLogsDesc from "../../prompts/tools/history/read_chat_logs.md" with { type: "text" };
import searchChatLogsDesc from "../../prompts/tools/history/search_chat_logs.md" with { type: "text" };
import generateImageDesc from "../../prompts/tools/images/generate_image.md" with { type: "text" };
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

const CHAT_LOG_TIME =
  "A local date (2026-03-01), a local time (2026-03-01T21:30), or an RFC3339 timestamp.";

export const ALL_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: "read",
    description: stripOneTrailingNewline(readDesc),
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1, description: "File to read. Absolute, relative to the workspace root, or a [[link]] copied from a Markdown file." },
        offset: { type: "integer", minimum: 1, description: "First text line to return, numbered from 1. Default 1. Not accepted for images." },
        limit: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum text lines to return. Default 2000, maximum 2000. The result character budget can shorten the page." },
        original: { type: "boolean", description: "Send an image file at the full resolution the model accepts instead of the reduced copy. Default false. Image files only." },
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
    name: "search_chat_logs",
    description: stripOneTrailingNewline(searchChatLogsDesc),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "An FTS5 query, or the text to find when `match` is `substring`." },
        match: {
          type: "string",
          enum: ["words", "substring"],
          description: "`words` (default) reads `query` as FTS5. `substring` finds it anywhere, inside words too.",
        },
        sort: { type: "string", enum: ["best", "oldest", "newest"], description: "Order of hits. Default `best`." },
        speaker: { type: "string", description: "Only this speaker: `user`, `character`, or either name." },
        thread: { type: "string", description: "Only this thread, such as `main`." },
        start: { type: "string", description: `Inclusive start. ${CHAT_LOG_TIME}` },
        end: { type: "string", description: `Inclusive end. ${CHAT_LOG_TIME}` },
        all_time: { type: "boolean", description: "Search the whole archive, not just the last 6 months. Ignored with `start` or `end`." },
        limit: { type: "integer", description: "Hits per page. Default 10, at most 50." },
        offset: { type: "integer", description: "Hits to skip, to get the next page." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_chat_logs",
    description: stripOneTrailingNewline(readChatLogsDesc),
    parameters: {
      type: "object",
      properties: {
        around: { type: "string", description: "A message id from `search_chat_logs`." },
        before: { type: "integer", description: "Messages to show before `around`. Default 3." },
        after: { type: "integer", description: "Messages to show after `around`. Default 3." },
        start: { type: "string", description: `Read from here. ${CHAT_LOG_TIME}` },
        end: { type: "string", description: `Read up to here, inclusive. ${CHAT_LOG_TIME}` },
        offset: { type: "integer", description: "Messages to skip in a `start`/`end` read, to get the next page." },
        thread: { type: "string", description: "The thread to read. `start`/`end` reads default to `main`; with `around` it picks the copy in that thread." },
        overview: { type: "string", description: "A local date such as 2026-03-01, to list that day's conversations." },
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
