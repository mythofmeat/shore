import { SHORE_MCP_SERVER } from "./claude_agent_tools.ts";

const SHORE_PREFIX = `mcp__${SHORE_MCP_SERVER}__`;
const DATA_LINE = /^data:(.*)$/s;
const NEWLINE = 0x0a;

type Json = Record<string, unknown>;

export type WireNames = ReadonlyMap<unknown, string>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function bareWithin(value: unknown, bare: (name: unknown) => unknown): void {
  if (Array.isArray(value)) for (const item of value) bareWithin(item, bare);
  if (!isRecord(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "exclude_tools" && Array.isArray(inner)) value[key] = inner.map(bare);
    else if (key !== "input") bareWithin(inner, bare);
  }
  if (value.type === "tool_use") value.name = bare(value.name);
  if (value.type === "tool_reference") {
    value.name = bare(value.name);
    value.tool_name = bare(value.tool_name);
  }
  if (value.type === "tool_definition") {
    if (isRecord(value.definition)) value.definition.name = bare(value.definition.name);
  }
}

export function withBareToolNames(body: Json): { body: Json; wireNames: WireNames } {
  const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord) : [];
  const taken = new Set(tools.map(tool => tool.name));
  const wireNames = new Map<unknown, string>();
  const bare = (name: unknown): unknown => {
    if (typeof name !== "string" || !name.startsWith(SHORE_PREFIX)) return name;
    const stripped = name.slice(SHORE_PREFIX.length);
    if (taken.has(stripped)) return name;
    wireNames.set(stripped, name);
    return stripped;
  };
  for (const tool of tools) tool.name = bare(tool.name);
  if (isRecord(body.tool_choice)) body.tool_choice.name = bare(body.tool_choice.name);
  bareWithin(body.messages, bare);
  bareWithin(body.context_management, bare);
  return { body, wireNames };
}

function restoreCall(block: Json, wireNames: WireNames): boolean {
  const wire = block.type === "tool_use" ? wireNames.get(block.name) : undefined;
  if (wire === undefined) return false;
  block.name = wire;
  return true;
}

function restoredLine(line: string, wireNames: WireNames): string {
  const data = DATA_LINE.exec(line);
  if (data === null) return line;
  const event = parsedJson(data[1] ?? "");
  if (!isRecord(event) || !isRecord(event.content_block) || !restoreCall(event.content_block, wireNames)) return line;
  return `data: ${JSON.stringify(event)}`;
}

export function restoringToolNames(wireNames: WireNames): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let held = new Uint8Array(0);
  const restored = (bytes: Uint8Array): Uint8Array =>
    encoder.encode(decoder.decode(bytes).split("\n").map(line => restoredLine(line, wireNames)).join("\n"));
  return new TransformStream({
    transform(chunk, controller) {
      const joined = new Uint8Array(held.length + chunk.length);
      joined.set(held);
      joined.set(chunk, held.length);
      const end = joined.lastIndexOf(NEWLINE) + 1;
      held = joined.slice(end);
      controller.enqueue(restored(joined.subarray(0, end)));
    },
    flush(controller) {
      controller.enqueue(restored(held));
    },
  });
}

export function restoredToolNames(text: string, wireNames: WireNames): string {
  const message = parsedJson(text);
  if (!isRecord(message) || !Array.isArray(message.content)) return text;
  const restored = message.content.filter(isRecord).map(block => restoreCall(block, wireNames));
  return restored.includes(true) ? JSON.stringify(message) : text;
}
