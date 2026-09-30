import { limitImageBlock } from "../prepare_images.ts";
import { MANY_IMAGES_MAX_EDGE } from "../image_settings.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { windowToolResult } from "../../tools/dispatch.ts";
import type { ContentBlock } from "../../engine/types.ts";
import type { ToolDefinition } from "../types.ts";

export const SHORE_MCP_SERVER = "shore";

export const MCP_RESULT_CEILING_BYTES = 48_000;

const MAX_MCP_NAME = 128;

export class DuplicateToolName extends Error {
  constructor(wire: string, first: string, second: string) {
    super(
      `claude_agent: ${JSON.stringify(first)} and ${JSON.stringify(second)} are both advertised ` +
        `as ${JSON.stringify(wire)} — rename one of them`,
    );
    this.name = "DuplicateToolName";
  }
}

export class ToolNameTooLong extends Error {
  constructor(bare: string, wire: string) {
    super(
      `claude_agent: ${JSON.stringify(bare)} becomes ${JSON.stringify(wire)}, which is ` +
        `${String(wire.length)} characters — MCP allows ${String(MAX_MCP_NAME)}`,
    );
    this.name = "ToolNameTooLong";
  }
}

function sanitize(name: string): string {
  return Array.from(name, (c) => (/[A-Za-z0-9_-]/.test(c) ? c : "_")).join("");
}

export class ToolNames {
  readonly #wireOf = new Map<string, string>();
  readonly #bareOf = new Map<string, string>();

  constructor(defs: readonly ToolDefinition[]) {
    for (const def of defs) {
      const wire = `mcp__${SHORE_MCP_SERVER}__${sanitize(def.name)}`;
      if (wire.length > MAX_MCP_NAME) throw new ToolNameTooLong(def.name, wire);
      const clash = this.#bareOf.get(wire);
      if (clash !== undefined) throw new DuplicateToolName(wire, clash, def.name);
      this.#wireOf.set(def.name, wire);
      this.#bareOf.set(wire, def.name);
    }
  }

  wireOf(bare: string): string | undefined {
    return this.#wireOf.get(bare);
  }

  bareOf(wire: string): string | undefined {
    return this.#bareOf.get(wire);
  }

  get wireNames(): string[] {
    return [...this.#bareOf.keys()];
  }
}

export type RunShoreTool = (bare: string, input: unknown) => Promise<ContentBlock>;

function textOf(block: ContentBlock): string {
  return block.type === "text" ? block.text : "";
}

function underCeiling(text: string): string {
  let budget = MCP_RESULT_CEILING_BYTES;
  for (let pass = 0; pass < 4; pass += 1) {
    const windowed = windowToolResult(text, budget).output;
    const bytes = Buffer.byteLength(windowed, "utf8");
    if (bytes <= MCP_RESULT_CEILING_BYTES) return windowed;
    budget = Math.max(1, Math.floor((budget * MCP_RESULT_CEILING_BYTES) / bytes));
  }
  return windowToolResult(text, budget).output;
}

export function toCallToolResult(block: ContentBlock): CallToolResult {
  if (block.type !== "tool_result") {
    return { content: [{ type: "text", text: underCeiling(textOf(block)) }] };
  }

  if (typeof block.content === "string") {
    return {
      content: [{ type: "text", text: underCeiling(block.content) }],
      ...(block.is_error === true ? { isError: true } : {}),
    };
  }

  const content: CallToolResult["content"] = [];
  for (const inner of block.content) {
    if (inner.type === "text") {
      content.push({ type: "text", text: underCeiling(inner.text) });
    } else if (inner.type === "image") {
      content.push({ type: "image", data: inner.source.data, mimeType: inner.source.media_type });
    }
  }
  return {
    content,
    ...(block.is_error === true ? { isError: true } : {}),
  };
}

export class UnknownShoreTool extends Error {
  constructor(wire: string) {
    super(`claude_agent: ${JSON.stringify(wire)} is not one of shore's tools`);
    this.name = "UnknownShoreTool";
  }
}

export function shoreToolServer(
  defs: readonly ToolDefinition[],
  names: ToolNames,
  run: RunShoreTool,
): McpServer {
  const server = new McpServer(
    { name: SHORE_MCP_SERVER, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: defs.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.input_schema as { type: "object" },
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const bare = request.params.name;
    if (names.wireOf(bare) === undefined) throw new UnknownShoreTool(bare);
    return toCallToolResult(await limitImageBlock(await run(bare, request.params.arguments ?? {}), MANY_IMAGES_MAX_EDGE));
  });

  return server;
}
