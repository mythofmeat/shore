import { describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  DuplicateToolName,
  ToolNameTooLong,
  ToolNames,
  UnknownShoreTool,
  MCP_RESULT_CEILING_BYTES,
  SHORE_MCP_SERVER,
  shoreToolServer,
  toCallToolResult,
} from "../src/llm/providers/claude_agent_tools.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import type { ToolDefinition } from "../src/llm/types.ts";

const EMPTY_SCHEMA: Record<string, unknown> = { type: "object" };

function def(name: string, input_schema?: Record<string, unknown>): ToolDefinition {
  return { name, description: `the ${name} tool`, input_schema: input_schema ?? EMPTY_SCHEMA };
}

const READ_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { path: { type: "string", description: "Path to read, relative to the workspace." } },
  required: ["path"],
};

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

describe("what the model is shown", () => {
  test("shore's tools are advertised under the server's namespace", async () => {
    const client = await connected([def("read"), def("git")], () => Promise.resolve(ok("")));
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(["read", "git"]);
  });

  test("the schema reaches the model exactly as shore wrote it", async () => {
    const client = await connected([def("read", READ_SCHEMA)], () => Promise.resolve(ok("")));
    const listed = await client.listTools();
    expect(listed.tools[0]?.inputSchema as Record<string, unknown>).toEqual(READ_SCHEMA);
  });

  test("a subagent is advertised like any other tool", async () => {
    const client = await connected([def("ask_internet")], () => Promise.resolve(ok("")));
    const listed = await client.listTools();
    expect(listed.tools[0]?.name).toBe("ask_internet");
  });

  test("descriptions are carried through so the model knows what a tool is for", async () => {
    const client = await connected([def("read")], () => Promise.resolve(ok("")));
    const listed = await client.listTools();
    expect(listed.tools[0]?.description).toBe("the read tool");
  });
});

describe("the name a call comes back under", () => {
  test("a call reaches shore under the name its dispatcher knows", async () => {
    const seen: string[] = [];
    const client = await connected([def("read")], (bare) => {
      seen.push(bare);
      return Promise.resolve(ok("contents"));
    });
    await client.callTool({ name: "read", arguments: { path: "SOUL.md" } });
    expect(seen).toEqual(["read"]);
  });

  test("shore's own MCP tools survive the round trip rather than losing a prefix", () => {
    const names = new ToolNames([def("mcp__github__get_issue")]);
    const wire = names.wireOf("mcp__github__get_issue");
    expect(wire).toBe("mcp__shore__mcp__github__get_issue");
    expect(names.bareOf(wire ?? "")).toBe("mcp__github__get_issue");
  });

  test("arguments are handed over untouched", async () => {
    let seen: unknown;
    const client = await connected([def("read")], (_bare, input) => {
      seen = input;
      return Promise.resolve(ok("contents"));
    });
    await client.callTool({ name: "read", arguments: { path: "SOUL.md", limit: 5 } });
    expect(seen).toEqual({ path: "SOUL.md", limit: 5 });
  });

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

  test("the table itself does not know a tool that was never advertised", () => {
    const names = new ToolNames([def("read")]);
    expect(names.bareOf("mcp__shore__rm")).toBeUndefined();
    expect(new UnknownShoreTool("mcp__shore__rm").message).toContain("not one of shore's tools");
  });
});

describe("names that cannot be advertised as they are", () => {
  test("a character's subagent named with a space is still callable", () => {
    const names = new ToolNames([def("ask_the internet")]);
    expect(names.wireOf("ask_the internet")).toBe("mcp__shore__ask_the_internet");
    expect(names.bareOf("mcp__shore__ask_the_internet")).toBe("ask_the internet");
  });

  test("two tools that sanitize to one name are refused, not silently merged", () => {
    expect(() => new ToolNames([def("ask_a b"), def("ask_a_b")])).toThrow(DuplicateToolName);
  });

  test("a name too long to advertise is refused rather than truncated", () => {
    expect(() => new ToolNames([def("a".repeat(130))])).toThrow(ToolNameTooLong);
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

  test("a successful result is not marked as an error", () => {
    expect(toCallToolResult(ok("fine")).isError).toBeUndefined();
  });

  test("an image the tool produced reaches the model, not just the transcript", () => {
    const withImage = toCallToolResult({
      type: "tool_result",
      tool_use_id: "t1",
      content: [
        { type: "text", text: "here it is" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    });
    expect(withImage.content).toEqual([
      { type: "text", text: "here it is" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  test("an image survives the wire, not just the conversion", async () => {
    const client = await connected([def("generate_image")], () =>
      Promise.resolve({
        type: "tool_result",
        tool_use_id: "t1",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      } satisfies ContentBlock),
    );
    const result = await client.callTool({ name: "generate_image", arguments: {} });
    expect(result.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  });
});

describe("the name the CLI actually uses at each boundary", () => {
  test("shore advertises the bare name, because the CLI adds the namespace itself", async () => {
    const client = await connected([def("read")], () => Promise.resolve(ok("")));
    const listed = await client.listTools();
    const advertised = listed.tools[0]?.name ?? "";
    expect(advertised).toBe("read");
    expect(`mcp__${SHORE_MCP_SERVER}__${advertised}`).toBe(
      new ToolNames([def("read")]).wireOf("read") ?? "",
    );
  });

  test("a call comes back under the advertised name, not the namespaced one", async () => {
    const seen: string[] = [];
    const client = await connected([def("read")], (bare) => {
      seen.push(bare);
      return Promise.resolve(ok("done"));
    });
    await client.callTool({ name: "read", arguments: {} });
    expect(seen).toEqual(["read"]);
  });

  test("the namespaced name is refused, so a double prefix cannot slip through", async () => {
    const client = await connected([def("read")], () => Promise.resolve(ok("")));
    try {
      await client.callTool({ name: "mcp__shore__read", arguments: {} });
      throw new Error("should have been refused");
    } catch (e) {
      expect((e as Error).message).toContain("not one of shore's tools");
    }
  });

  test("shore's own MCP tools keep their prefix through the round trip", async () => {
    const seen: string[] = [];
    const client = await connected([def("mcp__github__get_issue")], (bare) => {
      seen.push(bare);
      return Promise.resolve(ok("done"));
    });
    const listed = await client.listTools();
    expect(listed.tools[0]?.name).toBe("mcp__github__get_issue");
    await client.callTool({ name: "mcp__github__get_issue", arguments: {} });
    expect(seen).toEqual(["mcp__github__get_issue"]);
  });
});

describe("staying under what the CLI will inline", () => {
  const big = (n: number): ContentBlock => ({
    type: "tool_result",
    tool_use_id: "toolu_1",
    content: "x".repeat(n),
  });

  const bytesOf = (result: ReturnType<typeof toCallToolResult>): number =>
    Buffer.byteLength(
      result.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
      "utf8",
    );

  test("a result the CLI would spill to a file is windowed by shore first", () => {
    expect(bytesOf(toCallToolResult(big(400_000)))).toBeLessThanOrEqual(MCP_RESULT_CEILING_BYTES);
  });

  test("shore says it truncated, rather than letting the model guess", () => {
    const text = toCallToolResult(big(400_000)).content[0];
    expect(text?.type === "text" ? text.text : "").toContain("tool_result truncated");
  });

  test("a result that already fits is passed through untouched", () => {
    const text = toCallToolResult(big(100)).content[0];
    expect(text?.type === "text" ? text.text : "").toBe("x".repeat(100));
  });

  test("multi-byte text is measured in bytes, not characters", () => {
    const wide: ContentBlock = {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "\u3042".repeat(200_000),
    };
    expect(bytesOf(toCallToolResult(wide))).toBeLessThanOrEqual(MCP_RESULT_CEILING_BYTES);
  });
});
