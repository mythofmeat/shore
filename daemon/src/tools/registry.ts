import { parameterText, toolText } from "../texts/registry.ts";
import { renderTemplate } from "../texts/template.ts";
import type { Texts, TextValues } from "../texts/texts.ts";
import { compareByCodePoint } from "../util/sort.ts";
import type { ToolDefinition } from "../llm/types.ts";
import { toolPatternMatches } from "../config/app.ts";


export interface ToolDef {
  name: string;
  parameters: Record<string, unknown>;
}

export interface ToolsConfigView {
  enabled: string[];
}

export interface SubagentConfigView {
  description: string;
}



export const ALL_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: "read",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 2000 },
        original: { type: "boolean" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1 },
        old_string: { type: "string", minLength: 1 },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    parameters: {
      type: "object",
      properties: { patch: { type: "string", minLength: 1 } },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  {
    name: "bash",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
        },
        workdir: {
          type: "string",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "activity_heatmap",
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          default: 30,
        },
      },
    },
  },
  {
    name: "chat_logs",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "read", "list"] },
        query: { type: "string" },
        match: {
          type: "string",
          enum: ["words", "substring"],
        },
        sort: { type: "string", enum: ["best", "oldest", "newest"] },
        speaker: { type: "string" },
        all_time: { type: "boolean" },
        limit: { type: "integer" },
        around: { type: "string" },
        before: { type: "integer" },
        after: { type: "integer" },
        overview: { type: "string" },
        thread: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        offset: { type: "integer" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "model_history",
    parameters: {
      type: "object",
      properties: {
        start_time: {
          type: "string",
        },
        end_time: {
          type: "string",
        },
      },
      required: [],
    },
  },
  {
    name: "threads",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "start", "edit"] },
        name: { type: "string", minLength: 1, maxLength: 64 },
        label: { type: "string" },
        purpose: { type: "string" },
        pins: { type: "array", items: { type: "string" } },
        opening: { type: "string" },
        folder: { type: "string" },
        sealed_until: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "list_triggers",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "wake_in_thread",
    parameters: {
      type: "object",
      properties: {
        thread: { type: "string", minLength: 1, maxLength: 64 },
        reason: { type: "string", minLength: 1 },
        limit: { type: "string" },
        overwrite: { type: "boolean" },
        when: { type: "string" },
      },
      required: ["thread", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1 },
        thread: { type: "string", minLength: 1, maxLength: 64 },
        push: { type: "boolean" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "guide",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string" },
      },
      additionalProperties: false,
    },
  },
]);

export { toolPatternMatches };

export function toolEnabled(cfg: ToolsConfigView, name: string): boolean {
  return cfg.enabled.some((t) => toolPatternMatches(t, name));
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

function described(schema: Record<string, unknown>, description: string | undefined): Record<string, unknown> {
  if (description === undefined) return schema;
  const { default: fallback, ...rest } = schema;
  return fallback === undefined ? { ...rest, description } : { ...rest, description, default: fallback };
}

export function renderToolSchema(texts: Texts, tool: string, parameters: Record<string, unknown>, values: TextValues): Record<string, unknown> {
  const rendered = Object.entries(parameters["properties"] as Record<string, Record<string, unknown>>).map(([name, schema]) =>
    [name, described(schema, texts.render(parameterText(tool, name), values))]);
  return { ...parameters, properties: Object.fromEntries(rendered) };
}

export function renderedTools(texts: Texts, tools: readonly ToolDef[], values: TextValues): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: texts.render(toolText(t.name), values) ?? "",
    input_schema: renderToolSchema(texts, t.name, t.parameters, values),
  }));
}

export function renderToolDefs(
  texts: Texts,
  cfg: ToolsConfigView,
  charName: string,
  userName: string,
): ToolDefinition[] {
  return renderedTools(texts, availableTools(cfg), Object.fromEntries(toolTemplateVars(cfg, charName, userName)));
}

export const SUBAGENT_INPUT_SCHEMA: Record<string, unknown> = Object.freeze({
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
});

export function subagentInputSchema(texts: Texts): Record<string, unknown> {
  return renderToolSchema(texts, "ask", SUBAGENT_INPUT_SCHEMA, {});
}

export function subagentToolDefs(
  texts: Texts,
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
      input_schema: subagentInputSchema(texts),
    }));
}

export function assembleToolSurface(
  staticDefs: readonly ToolDefinition[],
  subagentDefs: readonly ToolDefinition[],
  mcpDefs: readonly ToolDefinition[],
): ToolDefinition[] {
  return [...staticDefs, ...subagentDefs, ...mcpDefs];
}
