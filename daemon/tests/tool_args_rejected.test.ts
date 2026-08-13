import { describe, expect, test } from "bun:test";

import { parseToolArgs } from "../src/llm/tool_args.ts";
import { argumentRejection, executeToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { schemasFrom, schemaViolation } from "../src/tools/validate.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

const READ_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, offset: { type: "number" } },
  required: ["path"],
};

describe("parseToolArgs", () => {
  test("empty arguments stay an empty object — a no-argument call is legal", () => {
    expect(parseToolArgs("")).toEqual({ input: {} });
    expect(parseToolArgs("   ")).toEqual({ input: {} });
  });

  test("valid JSON parses as before", () => {
    expect(parseToolArgs('{"path":"notes.md"}')).toEqual({ input: { path: "notes.md" } });
  });

  test("a truncated payload reports the failure instead of becoming {}", () => {
    const parsed = parseToolArgs('{"path":"notes.md"');
    expect(parsed.input).toEqual({});
    expect(parsed.input_error).toContain("not valid JSON");
    expect(parsed.input_error).toContain("18 characters");
  });
});

describe("schemaViolation", () => {
  test("a missing required argument is named", () => {
    expect(schemaViolation(READ_SCHEMA, { offset: 3 })).toContain("`path`");
  });

  test("a complete call passes, and extra arguments are allowed", () => {
    expect(schemaViolation(READ_SCHEMA, { path: "a.md", extra: 1 })).toBeUndefined();
  });

  test("a non-object payload is rejected with what arrived", () => {
    expect(schemaViolation(READ_SCHEMA, ["a.md"])).toContain("an array");
    expect(schemaViolation(READ_SCHEMA, "a.md")).toContain("a string");
  });

  test("a tool with no required arguments never trips it", () => {
    expect(schemaViolation({ type: "object", required: [] }, {})).toBeUndefined();
    expect(schemaViolation(undefined, {})).toBeUndefined();
  });
});

describe("argumentRejection", () => {
  const schemas = schemasFrom([{ name: "read", input_schema: READ_SCHEMA }]);

  test("tells the model to reissue rather than leaving it to guess", () => {
    const message = argumentRejection(
      { id: "t1", name: "read", input: {}, input_error: "the arguments were not valid JSON" },
      schemas,
    );
    expect(message).toContain("was not run");
    expect(message).toContain("Nothing was executed");
    expect(message).toContain("Issue the call again");
  });

  test("a valid call is not rejected", () => {
    expect(argumentRejection({ id: "t1", name: "read", input: { path: "a" } }, schemas)).toBeUndefined();
  });
});

describe("executeToolUse", () => {
  function harness() {
    const frames: ServerMessage[] = [];
    const diagnostics: unknown[] = [];
    const exec: ToolExecution = {
      sendDirect: (m) => frames.push(m),
      ctx: { characterName: "Rhia" } as unknown as ToolContext,
      limits: { timeouts: {}, result_chars: {} } as never,
      diagnostics: { push: (e) => diagnostics.push(e) },
      now: () => "2026-08-13T00:00:00Z",
      newMessageId: () => "m_1",
      schemas: schemasFrom([{ name: "read", input_schema: READ_SCHEMA }]),
    };
    return { frames, diagnostics, exec };
  }

  test("a garbled read never reaches the tool and never lists the workspace root", async () => {
    const { frames, diagnostics, exec } = harness();
    const block = await executeToolUse(
      { id: "t1", name: "read", input: {}, input_error: "the arguments were not valid JSON" },
      exec,
      [],
    );

    expect(block).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: true });
    expect((block as { content: string }).content).toContain("was not run");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ tool_name: "read", success: false });
    expect(frames.some((f) => f.type === "tool_result" && f.is_error === true)).toBe(true);
  });

  test("a call missing a required argument is refused before dispatch", async () => {
    const { exec } = harness();
    const block = await executeToolUse({ id: "t2", name: "read", input: {} }, exec, []);
    expect(block).toMatchObject({ is_error: true });
    expect((block as { content: string }).content).toContain("`path`");
  });
});
