import editDesc from "../../prompts/tools/workspace/edit.md" with { type: "text" };
import patchDesc from "../../prompts/tools/workspace/apply_patch.md" with { type: "text" };
import { renderTemplate, stripOneTrailingNewline } from "../engine/prompt.ts";
import { compareByCodePoint } from "../util/sort.ts";
import type { ToolDefinition } from "../llm/types.ts";
import { toolPatternMatches } from "../config/app.ts";

import bashDesc from "../../prompts/tools/bash.md" with { type: "text" };
import activityHeatmapDesc from "../../prompts/tools/activity/activity_heatmap.md" with { type: "text" };
import setNextWakeDesc from "../../prompts/tools/autonomy/set_next_wake.md" with { type: "text" };
import listTriggersDesc from "../../prompts/tools/autonomy/list_triggers.md" with { type: "text" };
import wakeInThreadDesc from "../../prompts/tools/autonomy/wake_in_thread.md" with { type: "text" };
import writeDiaryDesc from "../../prompts/tools/autonomy/write_diary.md" with { type: "text" };
import sendPushDesc from "../../prompts/tools/autonomy/send_push.md" with { type: "text" };
import guideDesc from "../../prompts/tools/guide.md" with { type: "text" };
import listThreadsDesc from "../../prompts/tools/threads/list_threads.md" with { type: "text" };
import startSealedThreadDesc from "../../prompts/tools/threads/start_sealed_thread.md" with { type: "text" };
import startThreadDesc from "../../prompts/tools/threads/start_thread.md" with { type: "text" };
import editThreadDesc from "../../prompts/tools/threads/edit_thread.md" with { type: "text" };
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
    name: "list_threads",
    description: stripOneTrailingNewline(listThreadsDesc),
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "start_thread",
    description: stripOneTrailingNewline(startThreadDesc),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "Thread id: letters, digits, dot, dash or underscore, starting with a letter or digit, such as `lighthouse`." },
        label: { type: "string", minLength: 1, description: "Name shown in the thread list, such as `The lighthouse story`." },
        purpose: { type: "string", description: "A line or two on what the thread is for." },
        files: { type: "array", items: { type: "string" }, description: "Files to keep in the thread's prompt: paths relative to the workspace root, or links like `[[notes]]` and `[[lighthouse/]]`." },
        opening: { type: "string", description: "Your first message in the new thread." },
        folder: { type: "string", description: "Folder in the thread list to put the thread in, such as `Projects`. It is made if there isn't one by that name." },
      },
      required: ["name", "label"],
      additionalProperties: false,
    },
  },
  {
    name: "start_sealed_thread",
    description: stripOneTrailingNewline(startSealedThreadDesc),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "Thread id: letters, digits, dot, dash or underscore, starting with a letter or digit." },
        label: { type: "string", minLength: 1, description: "The name the thread is known by. It is all your other turns see of it, and what the thread list shows once it opens." },
        opens: { type: "string", description: 'Local date and 24-hour time the seal comes off, like "2026-12-24 08:00".' },
      },
      required: ["name", "label", "opens"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_thread",
    description: stripOneTrailingNewline(editThreadDesc),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "Id of the side thread to change, as `list_threads` shows it." },
        label: { type: "string", description: "New name for the thread list, or an empty string to clear it." },
        purpose: { type: "string", description: "New line or two on what the thread is for, or an empty string to clear it." },
        files: { type: "array", items: { type: "string" }, description: "The thread's whole new list of files to keep in its prompt: paths relative to the workspace root, or links like `[[notes]]` and `[[lighthouse/]]`. An empty list clears it." },
      },
      required: ["name"],
      additionalProperties: false,
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
          description: "Hours from now until that heartbeat. Fractions are allowed. Held between the soonest and the furthest ahead {{user}} lets you ask for one.",
        },
        reason: {
          type: "string",
          description: "A note to yourself for that heartbeat, which starts with it. Also recorded in the heartbeat log.",
        },
      },
      required: ["hours_from_now", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "list_triggers",
    description: stripOneTrailingNewline(listTriggersDesc),
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "write_diary",
    description: stripOneTrailingNewline(writeDiaryDesc),
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, description: "The note, in your own words, for a turn of yours that has none of this conversation in front of it." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "wake_in_thread",
    description: stripOneTrailingNewline(wakeInThreadDesc),
    parameters: {
      type: "object",
      properties: {
        thread: { type: "string", minLength: 1, maxLength: 64, description: "Id of the thread to be woken in, as `list_threads` shows it." },
        reason: { type: "string", minLength: 1, description: "What the wake is for. Shown to you when it starts." },
        limit: { type: "string", description: 'How long the wake may run, like "45m" or "2h". Defaults to 30 minutes.' },
        overwrite: { type: "boolean", description: "Put this wake in the place of one you already asked for in that thread and that hasn't started. Without it, a second request is refused." },
      },
      required: ["thread", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "send_push",
    description: stripOneTrailingNewline(sendPushDesc),
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, description: "What the notification says. A line or two." },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "guide",
    description: stripOneTrailingNewline(guideDesc),
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The topic to read, by the name the list gives it. Leave it out for the list." },
      },
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

export function toolTemplateVars(cfg: ToolsConfigView, charName: string, userName: string): Map<string, string> {
  const vars = templateVars(charName, userName);
  for (const tool of availableTools(cfg)) vars.set(tool.name, tool.name);
  return vars;
}

export function renderToolSchema(parameters: Record<string, unknown>, vars: Map<string, string>): Record<string, unknown> {
  const rendered = Object.entries(parameters["properties"] as Record<string, Record<string, unknown>>).map(([name, schema]) => {
    const description = schema["description"];
    return [name, typeof description === "string" ? { ...schema, description: renderTemplate(description, vars) } : schema];
  });
  return { ...parameters, properties: Object.fromEntries(rendered) };
}

export function renderToolDefs(
  cfg: ToolsConfigView,
  charName: string,
  userName: string,
): ToolDefinition[] {
  const vars = toolTemplateVars(cfg, charName, userName);
  return availableTools(cfg).map((t) => ({
    name: t.name,
    description: renderTemplate(t.description, vars),
    input_schema: renderToolSchema(t.parameters, vars),
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
