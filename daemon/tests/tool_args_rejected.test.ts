import { describe, expect, test } from "bun:test";

import { parseToolArgs } from "../src/llm/tool_args.ts";
import { executeToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { schemasFrom } from "../src/tools/validate.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

const READ_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, offset: { type: "number" } },
  required: ["path"],
};

describe("parseToolArgs", () => {

  test("a truncated payload reports the failure instead of becoming {}", () => {
    const parsed = parseToolArgs('{"path":"notes.md"');
    expect(parsed.input).toEqual({});
    expect(parsed.input_error).toContain("not valid JSON");
    expect(parsed.input_error).toContain("18 characters");
  });
});

describe("executeToolUse", () => {
  function harness() {
    const frames: ServerMessage[] = [];
    const exec: ToolExecution = {
      sendDirect: (m) => frames.push(m),
      ctx: { characterName: "Rhia" } as unknown as ToolContext,
      limits: { timeouts: {}, result_chars: {} } as never,
      now: () => "2026-08-13T00:00:00Z",
      newMessageId: () => "m_1",
      schemas: schemasFrom([{ name: "read", input_schema: READ_SCHEMA }]),
    };
    return { frames, exec };
  }

  test("a garbled read never reaches the tool and never lists the workspace root", async () => {
    const { frames, exec } = harness();
    const block = await executeToolUse(
      { id: "t1", name: "read", input: {}, input_error: "the arguments were not valid JSON" },
      exec,
      [],
    );

    expect(block).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: true });
    expect((block as { content: string }).content).toContain("was not run");
    expect(frames.some((f) => f.type === "tool_result" &&  f.is_error)).toBe(true);
  });

  test("a call missing a required argument is refused before dispatch", async () => {
    const { exec } = harness();
    const block = await executeToolUse({ id: "t2", name: "read", input: {} }, exec, []);
    expect(block).toMatchObject({ is_error: true });
    expect((block as { content: string }).content).toContain("`path`");
  });

  test("a call with the wrong declared type is refused before dispatch", async () => {
    const { exec } = harness();
    const block = await executeToolUse(
      { id: "t3", name: "read", input: { path: 42 } },
      exec,
      [],
    );
    expect(block).toMatchObject({ is_error: true });
    expect((block as { content: string }).content).toContain("`path`");
    expect((block as { content: string }).content).toContain("string");
  });
});
