import { describe, expect, test } from "bun:test";

import { parseToolArgs } from "../src/llm/tool_args.ts";
import { argumentRejection, executeToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { ALL_TOOLS, BUILTIN_TOOL_SCHEMAS } from "../src/tools/registry.ts";
import {
  compileToolSchema,
  InvalidToolSchema,
  schemasFrom,
  schemaViolation,
} from "../src/tools/validate.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

const READ_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, offset: { type: "number" } },
  required: ["path"],
};

const NESTED_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["fast", "careful"] },
    attempts: { type: "integer", minimum: 1, maximum: 3 },
    targets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          labels: { type: "array", items: { type: "string", minLength: 2 } },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    strategy: {
      oneOf: [{ const: "auto" }, { type: "integer", minimum: 1 }],
    },
  },
  required: ["mode", "targets"],
  additionalProperties: false,
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

  test("nested types, enums, array items, bounds, formats, and unknown fields are enforced", () => {
    const violation = schemaViolation(NESTED_SCHEMA, {
      mode: "reckless",
      attempts: 4.5,
      targets: [{ url: "not a URI", labels: ["x"], extra: true }],
      surprise: true,
    });

    expect(violation).toContain("`mode`");
    expect(violation).toContain("`attempts`");
    expect(violation).toContain("`targets[0].url`");
    expect(violation).toContain("`targets[0].labels[0]`");
    expect(violation).toContain("`targets[0].extra`");
    expect(violation).toContain("`surprise`");
  });

  test("supported composition keywords execute as part of the contract", () => {
    const base = { mode: "fast", targets: [{ url: "https://example.com" }] };
    expect(schemaViolation(NESTED_SCHEMA, { ...base, strategy: "auto" })).toBeUndefined();
    expect(schemaViolation(NESTED_SCHEMA, { ...base, strategy: 2 })).toBeUndefined();
    expect(schemaViolation(NESTED_SCHEMA, { ...base, strategy: false })).toContain("`strategy`");
  });

  test("defaults stay annotations and validation never mutates the input", () => {
    const input: Record<string, unknown> = {};
    const schema = compileToolSchema("defaults", {
      type: "object",
      properties: { limit: { type: "integer", default: 5 } },
    });
    expect(schemaViolation(schema, input)).toBeUndefined();
    expect(input).toEqual({});
  });
});

describe("schema registration", () => {
  test("every built-in schema compiles when the registry loads", () => {
    expect(BUILTIN_TOOL_SCHEMAS.size).toBe(ALL_TOOLS.length);
  });

  test("invalid and unsupported schemas are rejected instead of partially interpreted", () => {
    expect(() => compileToolSchema("broken", null)).toThrow(InvalidToolSchema);
    expect(() => compileToolSchema("future", { type: "object", mysteryKeyword: true })).toThrow(
      "unknown keyword",
    );
    expect(() =>
      compileToolSchema("format", {
        type: "object",
        properties: { value: { type: "string", format: "made-up-format" } },
      }),
    ).toThrow("unknown format");
  });

  test("duplicate names cannot replace an already compiled contract", () => {
    expect(() =>
      schemasFrom([
        { name: "same", input_schema: { type: "object" } },
        { name: "same", input_schema: { type: "object" } },
      ]),
    ).toThrow("registered more than once");
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
