import { describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { DuplicateToolName, ToolNameTooLong, ToolNames, shoreToolServer, toCallToolResult } from "../src/llm/providers/claude_agent_tools.ts";
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

describe("what a tool result becomes, whatever it holds", () => {
  test("a plain block becomes its text, and a result's list keeps its text and pictures and its failure", () => {
    expect(toCallToolResult({ type: "text", text: "plain" })).toEqual({ content: [{ type: "text", text: "plain" }] });
    expect(toCallToolResult({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } })).toEqual({ content: [{ type: "text", text: "" }] });
    const listed = (isError: boolean | undefined) => toCallToolResult({
      type: "tool_result",
      tool_use_id: "t1",
      content: [
        { type: "text", text: "seen" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
      ...(isError === undefined ? {} : { is_error: isError }),
    });
    expect(listed(true)).toEqual({ content: [{ type: "text", text: "seen" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: true });
    expect(listed(false)).toEqual({ content: [{ type: "text", text: "seen" }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
    expect(Object.hasOwn(listed(undefined), "isError")).toBe(false);
  });
});

describe("the names shore's tools travel under", () => {
  test("a wire name may be 128 characters but no more, and two tools that clean up to one name are refused", () => {
    const prefix = "mcp__shore__".length;
    expect(new ToolNames([def("a".repeat(128 - prefix))]).wireOf("a".repeat(128 - prefix))).toHaveLength(128);
    expect(() => new ToolNames([def("a".repeat(129 - prefix))])).toThrow(ToolNameTooLong);
    expect(() => new ToolNames([def("look.up"), def("look_up")])).toThrow(DuplicateToolName);
    expect(new ToolNames([def("look.up")]).bareOf("mcp__shore__look_up")).toBe("look.up");
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
