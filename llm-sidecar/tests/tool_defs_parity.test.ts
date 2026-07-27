/**
 * Every adapter receives the same `ToolDefinition[]` and must offer the same
 * tools, in the same order, with a parameters schema each provider accepts.
 *
 * This exists because the six translators were independent copies of one
 * unchecked `raw as {name?, description?, input_schema?}` cast, and had already
 * drifted: Anthropic defaulted a missing schema to `{type:"object"}` while the
 * other five defaulted to `{}`, which OpenAI and Gemini reject as function
 * parameters. Order is load-bearing too — it is part of Anthropic's cache
 * prefix, so an adapter that sorts or filters silently costs a cache write.
 */

import { describe, expect, test } from "bun:test";
import { buildAnthropicParams } from "../src/llm/providers/anthropic.ts";
import { buildGeminiParams } from "../src/llm/providers/gemini.ts";
import { buildZaiParams } from "../src/llm/providers/zai.ts";
import { buildCall as buildVercelCall } from "../src/llm/providers/vercel.ts";
import type { SidecarRequest, ToolDefinition } from "../src/llm/types.ts";

const TOOLS: ToolDefinition[] = [
  { name: "read", description: "Read a file.", input_schema: { type: "object", properties: {} } },
  { name: "ask_music", description: "Delegate.", input_schema: { type: "object" } },
  { name: "mcp__hue__on", description: "Lights on.", input_schema: { type: "object" } },
];

const EXPECTED_ORDER = ["read", "ask_music", "mcp__hue__on"];

function req(overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "claude-opus-4-8",
    api_key: "k",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 64,
    tools: TOOLS,
    ...overrides,
  } as SidecarRequest;
}

/** Gemini types `config.tools` as a ToolUnion; we only send declaration groups. */
function geminiDeclarations(
  r: SidecarRequest,
): Array<{ name?: string; parameters?: unknown }> | undefined {
  const tools = buildGeminiParams(r).config?.tools as
    | Array<{ functionDeclarations?: Array<{ name?: string; parameters?: unknown }> }>
    | undefined;
  return tools?.[0]?.functionDeclarations;
}

/** Z.ai's ChatCompletionTool is a union; every tool we send is a function tool. */
function zaiFunctions(
  r: SidecarRequest,
): Array<{ name: string; parameters?: unknown }> | undefined {
  const tools = buildZaiParams(r, false).tools as
    | Array<{ function: { name: string; parameters?: unknown } }>
    | undefined;
  return tools?.map((t) => t.function);
}

describe("tool definitions reach every adapter intact", () => {
  test("anthropic keeps name, description, and schema in offer order", () => {
    // `tools` is a ToolUnion (custom + Anthropic-hosted); the daemon only ever
    // sends custom ones, so narrow before asserting on custom-tool fields.
    const tools = buildAnthropicParams(req()).tools as
      | Array<{ name: string; description: string; input_schema: unknown }>
      | undefined;
    expect(tools?.map((t) => t.name)).toEqual(EXPECTED_ORDER);
    expect(tools?.[0]?.description).toBe("Read a file.");
    expect(tools?.[0]?.input_schema).toEqual({ type: "object", properties: {} });
  });

  test("gemini emits one functionDeclarations group in offer order", () => {
    const decls = geminiDeclarations(req({ sdk: "gemini", model: "gemini-3-pro" }));
    expect(decls?.map((d) => d.name)).toEqual(EXPECTED_ORDER);
    expect(decls?.[0]?.parameters).toEqual({ type: "object", properties: {} });
  });

  test("zai wraps each tool as an OpenAI function in offer order", () => {
    const fns = zaiFunctions(req({ sdk: "zai", model: "glm-4.6" }));
    expect(fns?.map((f) => f.name)).toEqual(EXPECTED_ORDER);
    expect(fns?.[0]?.parameters).toEqual({ type: "object", properties: {} });
  });

  test("vercel keys the ToolSet by tool name", () => {
    const call = buildVercelCall(req({ sdk: "deepseek", model: "deepseek-v4-pro" }));
    // A ToolSet is keyed, not ordered — assert membership, not sequence.
    expect(Object.keys(call.tools ?? {}).sort()).toEqual([...EXPECTED_ORDER].sort());
  });

  test("a tool arriving without a schema gets an object schema, not {}", () => {
    // The daemon always sends `input_schema`, but it is `serde_json::Value` and
    // could serialize as null. `{}` is not a valid parameters schema for
    // OpenAI or Gemini, so every adapter must fall back to `{type:"object"}`.
    const bare = [{ name: "x", description: "", input_schema: null }] as unknown as ToolDefinition[];

    const anthropicTools = buildAnthropicParams(req({ tools: bare })).tools as
      | Array<{ input_schema: unknown }>
      | undefined;
    expect(anthropicTools?.[0]?.input_schema).toEqual({ type: "object" });

    const decls = geminiDeclarations(req({ sdk: "gemini", model: "gemini-3-pro", tools: bare }));
    expect(decls?.[0]?.parameters).toEqual({ type: "object" });

    const fns = zaiFunctions(req({ sdk: "zai", model: "glm-4.6", tools: bare }));
    expect(fns?.[0]?.parameters).toEqual({ type: "object" });
  });
});
