import { describe, expect, test } from "bun:test";

import { parseToolArgs } from "../src/llm/tool_args.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { schemasFrom, schemaViolation } from "../src/tools/validate.ts";
import { BUILTIN_TOOL_SCHEMAS } from "./support/builtin_tool_schemas.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { Texts } from "../src/texts/texts.ts";

const READ_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, offset: { type: "number" } },
  required: ["path"],
};

describe("parseToolArgs", () => {

  test("a truncated payload reports the failure instead of becoming {}", () => {
    const parsed = parseToolArgs('{"path":"notes.md"');
    expect(parsed.input).toEqual({});
    expect(parsed.input_error).toBeString();
    expect(parsed.input_length).toBe(18);
  });

  test("no arguments at all are an empty input, and a parse failure gives the parser's own words", () => {
    expect(parseToolArgs("  ")).toStrictEqual({ input: {} });
    let why = "";
    try {
      JSON.parse("{");
    } catch (e) {
      why = (e as Error).message;
    }
    expect(parseToolArgs("{")).toStrictEqual({ input: {}, input_error: why, input_length: 1 });
  });
});

describe("runToolUse", () => {
  function harness() {
    const frames: ServerMessage[] = [];
    const exec: ToolExecution = {
      sendDirect: (m) => frames.push(m),
      ctx: { characterName: "Rhia", texts: new Texts() } as unknown as ToolContext,
      limits: { timeouts: {}, result_chars: {} } as never,
      now: () => "2026-08-13T00:00:00Z",
      newMessageId: () => "m_1",
      schemas: schemasFrom([{ name: "read", input_schema: READ_SCHEMA }]),
    };
    return { frames, exec };
  }

  test("a garbled read never reaches the tool and never lists the workspace root", async () => {
    const { frames, exec } = harness();
    const { block } = await runToolUse({ id: "t1", name: "read", input: {}, input_error: "Unexpected end of input", input_length: 1 }, exec);

    expect(block).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: true });
    expect((block as { content: string }).content).toContain("was not run");
    expect(frames.some((f) => f.type === "tool_result" &&  f.is_error)).toBe(true);
  });

  test("arguments that weren't JSON say why and how many characters arrived, none when that wasn't counted", async () => {
    const { exec } = harness();
    const counted = await runToolUse({ id: "t1", name: "read", input: {}, input_error: "Unexpected end of input", input_length: 9 }, exec);
    expect((counted.block as { content: string }).content).toContain("the arguments were not valid JSON (Unexpected end of input); 9 characters arrived");
    const uncounted = await runToolUse({ id: "t2", name: "read", input: {}, input_error: "Unexpected end of input" }, exec);
    expect((uncounted.block as { content: string }).content).toContain("the arguments were not valid JSON (Unexpected end of input); 0 characters arrived");
  });

  test("a call missing a required argument is refused before dispatch", async () => {
    const { exec } = harness();
    const { block } = await runToolUse({ id: "t2", name: "read", input: {} }, exec);
    expect(block).toMatchObject({ is_error: true });
    expect((block as { content: string }).content).toContain("`path`");
  });

  test("a call with the wrong declared type is refused before dispatch", async () => {
    const { exec } = harness();
    const { block } = await runToolUse({ id: "t3", name: "read", input: { path: 42 } }, exec);
    expect(block).toMatchObject({ is_error: true });
    expect((block as { content: string }).content).toContain("`path`");
    expect((block as { content: string }).content).toContain("string");
  });
});

test("each built-in tool takes its bounded arguments up to their bounds and refuses them one past", () => {
  const takes = (tool: string, input: Record<string, unknown>): boolean => schemaViolation(new Texts(), BUILTIN_TOOL_SCHEMAS.get(tool), input) === undefined;
  const long = (n: number): string => "a".repeat(n);
  const edit = { file_path: "a", old_string: "a", new_string: "" };
  expect([
    takes("read", { file_path: "a", offset: 1, limit: 1 }), takes("read", { file_path: "a", limit: 2000 }),
    takes("read", { file_path: "" }), takes("read", { file_path: "a", offset: 0 }), takes("read", { file_path: "a", limit: 0 }), takes("read", { file_path: "a", limit: 2001 }),
  ]).toEqual([true, true, false, false, false, false]);
  expect([takes("edit", edit), takes("edit", { ...edit, file_path: "" }), takes("edit", { ...edit, old_string: "" })]).toEqual([true, false, false]);
  expect([takes("apply_patch", { patch: "a" }), takes("apply_patch", { patch: "" })]).toEqual([true, false]);
  expect([takes("threads", { action: "list", name: "a" }), takes("threads", { action: "list", name: long(64) }), takes("threads", { action: "list", name: "" }), takes("threads", { action: "list", name: long(65) })])
    .toEqual([true, true, false, false]);
  expect([
    takes("wake_in_thread", { thread: "a", reason: "a" }), takes("wake_in_thread", { thread: long(64), reason: "a" }),
    takes("wake_in_thread", { thread: "", reason: "a" }), takes("wake_in_thread", { thread: long(65), reason: "a" }), takes("wake_in_thread", { thread: "a", reason: "" }),
  ]).toEqual([true, true, false, false, false]);
  expect([
    takes("send_message", { text: "a", thread: "a" }), takes("send_message", { text: "a", thread: long(64) }),
    takes("send_message", { text: "" }), takes("send_message", { text: "a", thread: "" }), takes("send_message", { text: "a", thread: long(65) }),
  ]).toEqual([true, true, false, false, false]);
});
