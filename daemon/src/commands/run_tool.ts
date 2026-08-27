import { resolveDisplayName, subagentEnabled, toolEnabled } from "../config/app.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { Message } from "../engine/types.ts";
import type { SubagentTurn } from "../handler/generation.ts";
import { buildToolContext, type ToolContextDeps } from "../handler/tool_context.ts";
import { truncateSummary } from "../notifications.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import { toolLimitsFrom } from "../tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../tools/execute.ts";
import { ALL_TOOLS, SUBAGENT_INPUT_SCHEMA, templateVars } from "../tools/registry.ts";
import {
  CompiledToolSchema,
  compileToolSchema,
  type ToolSchemas,
} from "../tools/validate.ts";
import { renderTemplate } from "../engine/prompt.ts";
import { invalidRequest } from "./errors.ts";
import type { Args } from "./navigation.ts";

const NESTED_OUTPUT_CHARS = 600;

export interface McpSchemaView {
  full_name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface RunToolContext {
  config: LoadedConfig;
  dataDir: string;
  conversation: readonly Message[];
  tools: (charName: string, turn: SubagentTurn) => ToolContextDeps;
  mcpTools: () => readonly McpSchemaView[];
  now?: () => string;
  newMessageId?: () => string;
  toolUseId?: () => string;
}

export interface RunToolRequest {
  tool: string;
  input: Record<string, unknown>;
  pairs: Record<string, string>;
  raw: boolean;
}

export type ToolKind = "builtin" | "subagent" | "mcp";

export interface ResolvedTool {
  kind: ToolKind;
  schema: CompiledToolSchema | undefined;
  enabled: boolean;
}

export interface NestedCall {
  tool: string;
  subagent: string | null;
  ok: boolean;
  input: string;
  output: string;
}

export function parseRunToolArgs(args: Args): RunToolRequest {
  const tool = args["tool"];
  if (typeof tool !== "string" || tool.trim() === "") {
    throw invalidRequest("run_tool needs a `tool` name");
  }

  const input = args["input"];
  if (input !== undefined && !isPlainObject(input)) {
    throw invalidRequest("run_tool `input` must be a JSON object");
  }

  const pairs = args["pairs"];
  if (pairs !== undefined && !isPlainObject(pairs)) {
    throw invalidRequest("run_tool `pairs` must be an object of strings");
  }
  const stringPairs: Record<string, string> = {};
  for (const [key, value] of Object.entries(pairs ?? {})) {
    if (typeof value !== "string") {
      throw invalidRequest(`run_tool \`pairs.${key}\` must be a string`);
    }
    stringPairs[key] = value;
  }

  return {
    tool: tool.trim(),
    input: input === undefined ? {} : { ...input },
    pairs: stringPairs,
    raw: args["raw"] === true,
  };
}

export function resolveTool(
  name: string,
  config: LoadedConfig,
  mcpTools: readonly McpSchemaView[],
): ResolvedTool {
  const cfg = config.app.tools;

  if (name.startsWith("ask_")) {
    const agent = name.slice("ask_".length);
    if (!config.app.subagents.has(agent)) {
      throw invalidRequest(unknownSubagent(agent, config));
    }
    return {
      kind: "subagent",
      schema: compileToolSchema(name, SUBAGENT_INPUT_SCHEMA),
      enabled: subagentEnabled(cfg, agent),
    };
  }

  if (name.startsWith("mcp__")) {
    const def = mcpTools.find((t) => t.full_name === name);
    if (def === undefined) {
      throw invalidRequest(unknownMcpTool(name, mcpTools));
    }
    return {
      kind: "mcp",
      schema: compileToolSchema(name, def.input_schema),
      enabled: toolEnabled(cfg, name),
    };
  }

  const def = ALL_TOOLS.find((t) => t.name === name);
  if (def === undefined) {
    throw invalidRequest(unknownBuiltin(name));
  }
  return {
    kind: "builtin",
    schema: compileToolSchema(name, def.parameters),
    enabled: toolEnabled(cfg, name),
  };
}

export function coercePairs(
  pairs: Record<string, string>,
  schema: CompiledToolSchema | Record<string, unknown> | undefined,
): Record<string, unknown> {
  const document = schema instanceof CompiledToolSchema ? schema.schema : schema;
  const properties = isPlainObject(document?.["properties"]) ? document["properties"] : {};
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(pairs)) {
    const declared = properties[key];
    const type = isPlainObject(declared) ? declared["type"] : undefined;
    out[key] = coerceValue(key, value, typeof type === "string" ? type : undefined);
  }
  return out;
}

function coerceValue(key: string, value: string, type: string | undefined): unknown {
  switch (type) {
    case "integer":
    case "number": {
      const parsed = Number(value);
      if (value.trim() === "" || Number.isNaN(parsed)) {
        throw invalidRequest(`\`${key}\` takes a number, and '${value}' is not one`);
      }
      return parsed;
    }
    case "boolean": {
      const lowered = value.trim().toLowerCase();
      if (["true", "yes", "on", "1"].includes(lowered)) return true;
      if (["false", "no", "off", "0"].includes(lowered)) return false;
      throw invalidRequest(`\`${key}\` takes true or false, and '${value}' is neither`);
    }
    case "array":
    case "object": {
      try {
        return JSON.parse(value);
      } catch {
        throw invalidRequest(
          `\`${key}\` takes a JSON ${type}; '${value}' did not parse. ` +
            `Pass the whole payload with --json instead.`,
        );
      }
    }
    default:
      return value;
  }
}

export function describeTool(character: string, ctx: RunToolContext, args: Args): unknown {
  const { tool } = parseRunToolArgs(args);
  const cfg = ctx.config.app.tools;
  const vars = templateVars(character, resolveDisplayName(ctx.config.app.defaults));
  const seen = (kind: string, enabled: boolean, description: string, schema: unknown) => ({
    mode: "tool_definition",
    tool,
    kind,
    enabled,
    description,
    input_schema: schema,
  });

  if (tool.startsWith("ask_")) {
    const agent = tool.slice("ask_".length);
    const sub = ctx.config.app.subagents.get(agent);
    if (sub === undefined) throw invalidRequest(unknownSubagent(agent, ctx.config));
    return seen(
      "subagent",
      subagentEnabled(cfg, agent),
      renderTemplate(sub.description, vars),
      compileToolSchema(tool, SUBAGENT_INPUT_SCHEMA).schema,
    );
  }

  if (tool.startsWith("mcp__")) {
    const mcpTools = ctx.mcpTools();
    const def = mcpTools.find((t) => t.full_name === tool);
    if (def === undefined) throw invalidRequest(unknownMcpTool(tool, mcpTools));
    return seen(
      "mcp",
      toolEnabled(cfg, tool),
      def.description ?? "",
      compileToolSchema(tool, def.input_schema).schema,
    );
  }

  const def = ALL_TOOLS.find((t) => t.name === tool);
  if (def === undefined) throw invalidRequest(unknownBuiltin(tool));
  return seen(
    "builtin",
    toolEnabled(cfg, tool),
    renderTemplate(def.description, vars),
    compileToolSchema(tool, def.parameters).schema,
  );
}

export async function runTool(
  character: string,
  ctx: RunToolContext,
  args: Args,
): Promise<unknown> {
  const request = parseRunToolArgs(args);
  const resolved = resolveTool(request.tool, ctx.config, ctx.mcpTools());
  const input = { ...request.input, ...coercePairs(request.pairs, resolved.schema) };

  const frames: ServerMessage[] = [];
  const send = (message: ServerMessage): void => {
    frames.push(message);
  };
  const now = ctx.now ?? (() => new Date().toISOString());
  const newMessageId = ctx.newMessageId ?? (() => `m_${crypto.randomUUID()}`);
  const toolUseId = (ctx.toolUseId ?? (() => `debug_${crypto.randomUUID()}`))();

  const turn: SubagentTurn = {
    conversation: ctx.conversation,
    send,
    now,
    newMessageId,
    signal: new AbortController().signal,
  };

  const toolContext = await buildToolContext(
    ctx.config,
    ctx.dataDir,
    character,
    ctx.tools(character, turn),
  );

  const exec: ToolExecution = {
    sendDirect: send,
    ctx: toolContext,
    limits: toolLimitsFrom(ctx.config.app.tools, ctx.config.app.subagents),
    now,
    newMessageId,
    ...(resolved.schema === undefined
      ? {}
      : { schemas: new Map([[request.tool, resolved.schema]]) satisfies ToolSchemas }),
  };

  const run = await runToolUse({ id: toolUseId, name: request.tool, input }, exec, []);
  const output = run.window?.output ?? run.raw;

  return {
    tool: request.tool,
    character,
    kind: resolved.kind,
    enabled: resolved.enabled,
    input,
    ok: !run.isError,
    rejected: run.rejected,
    duration_ms: run.durationMs,
    output,
    truncated: run.window?.truncated ?? false,
    result_chars: run.window?.originalChars ?? Array.from(run.raw).length,
    raw: request.raw ? run.raw : null,
    calls: nestedCalls(frames, toolUseId, request.raw),
  };
}

export function nestedCalls(
  frames: readonly ServerMessage[],
  rootId: string,
  raw: boolean,
): NestedCall[] {
  const byId = new Map<string, NestedCall>();
  const order: string[] = [];

  for (const frame of frames) {
    if (frame.type === "tool_call") {
      if (frame.tool_id === rootId || byId.has(frame.tool_id)) continue;
      order.push(frame.tool_id);
      byId.set(frame.tool_id, {
        tool: frame.tool_name,
        subagent: frame.subagent ?? null,
        ok: true,
        input: clip(JSON.stringify(frame.input) ?? "", raw),
        output: "",
      });
      continue;
    }
    if (frame.type === "tool_result") {
      const call = byId.get(frame.tool_id);
      if (call === undefined) continue;
      call.output = clip(frame.output, raw);
      call.ok = !frame.is_error;
    }
  }

  return order.map((id) => byId.get(id) as NestedCall);
}

function clip(text: string, raw: boolean): string {
  return raw ? text : truncateSummary(text, NESTED_OUTPUT_CHARS);
}

function unknownBuiltin(name: string): string {
  return (
    `There is no tool named '${name}'. Built-in tools: ` +
    `${ALL_TOOLS.map((t) => t.name).join(", ")}. ` +
    `Sub-agents are called as ask_<name>, and MCP tools as mcp__<server>__<tool>.`
  );
}

function unknownSubagent(agent: string, config: LoadedConfig): string {
  const configured = [...config.app.subagents.keys()].sort();
  return configured.length === 0
    ? `No sub-agents are configured, so ask_${agent} does not exist`
    : `There is no sub-agent named '${agent}'. Configured: ${configured.join(", ")}`;
}

function unknownMcpTool(name: string, mcpTools: readonly McpSchemaView[]): string {
  return mcpTools.length === 0
    ? `No MCP tools are connected, so ${name} does not exist`
    : `There is no MCP tool named '${name}'. Connected: ` +
        mcpTools.map((t) => t.full_name).join(", ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
