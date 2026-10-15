import { describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ToolNames, shoreToolServer, toCallToolResult } from "../src/llm/providers/claude_agent_tools.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import type { ToolDefinition } from "../src/llm/types.ts";

const EMPTY_SCHEMA: Record<string, unknown> = { type: "object" };

function def(name: string, input_schema?: Record<string, unknown>): ToolDefinition {
  return { name, description: `the ${name} tool`, input_schema: input_schema ?? EMPTY_SCHEMA };
}

async function connected(
  defs: readonly ToolDefinition[],
  run: (bare: string, input: unknown) => Promise<ContentBlock>,
): Promise<Client> {
  const names = new ToolNames(defs);
  const server = shoreToolServer(defs, names, run);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const ok = (text: string): ContentBlock => ({
  type: "tool_result",
  tool_use_id: "toolu_1",
  content: text,
});

describe("the name a call comes back under", () => {

  test("a tool shore never advertised never reaches the dispatcher", async () => {
    let ran = 0;
    const client = await connected([def("read")], () => {
      ran += 1;
      return Promise.resolve(ok("contents"));
    });
    let refusal = "";
    try {
      await client.callTool({ name: "rm", arguments: { path: "/" } });
    } catch (e) {
      refusal = e instanceof Error ? e.message : String(e);
    }
    expect(ran).toBe(0);
    expect(refusal).toContain("not one of shore's tools");
  });
});

describe("what a tool result becomes", () => {
  test("a failure is marked as one rather than reading as success", () => {
    const failed = toCallToolResult({
      type: "tool_result",
      tool_use_id: "t1",
      content: "no such file",
      is_error: true,
    });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: "text", text: "no such file" }]);
  });
});

describe("the name the CLI actually uses at each boundary", () => {

  test("the namespaced name is refused, so a double prefix cannot slip through", async () => {
    const client = await connected([def("read")], () => Promise.resolve(ok("")));
    try {
      await client.callTool({ name: "mcp__shore__read", arguments: {} });
      throw new Error("should have been refused");
    } catch (e) {
      expect((e as Error).message).toContain("not one of shore's tools");
    }
  });
});
