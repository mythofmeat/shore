import { describe, expect, test } from "bun:test";

import { defaultAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import type { Message } from "../src/engine/types.ts";
import {
  formatMemories,
  parseRecallResult,
  recallQuery,
  runMemoryRecall,
} from "../src/memory/recall.ts";

function message(role: "user" | "assistant", id: string, text: string): Message {
  return {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp: "2026-01-01T10:00:00-05:00",
  };
}

function world(): LoadedConfig {
  const app = defaultAppConfig();
  app.memory.recall.mode = "inject";
  app.memory.recall.server = "hindsight";
  app.memory.recall.max_memories = 3;
  app.memory.recall.recent_messages = 2;
  return {
    app,
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs: { config: "/c", data: "/d", cache: "/k", runtime: "/r" },
    rawTable: undefined,
  };
}

const CONVERSATION = [
  message("user", "m1", "morning"),
  message("assistant", "m2", "morning to you"),
  message("user", "m3", "what was that music script i wrote"),
];

describe("memory recall", () => {
  test("asks the configured server and returns a formatted block", async () => {
    const calls: { tool: string; args: unknown }[] = [];
    const diagnostics = new Diagnostics();
    const block = await runMemoryRecall(
      { config: world(), character: "qifei", messages: CONVERSATION, rid: "rid-1" },
      {
        diagnostics,
        mcpRegistry: {
          call: async (tool, args) => {
            calls.push({ tool, args });
            return JSON.stringify({
              memories: [
                { text: "Ren wrote beet-smartplaylist.py", occurred_at: "2026-07-04T00:00:00Z" },
                { text: "Ren sorts his library into five tiers" },
              ],
            });
          },
        },
        now: () => "2026-08-29T00:00:00Z",
        monotonicMs: () => 0,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("mcp__hindsight__recall");
    expect(calls[0]?.args).toEqual({
      query: "what was that music script i wrote",
      max_tokens: 2048,
      query_timestamp: "2026-01-01T10:00:00-05:00",
    });
    expect(block).toBe(
      "- Ren wrote beet-smartplaylist.py (said 2026-07-04)\n" +
        "- Ren sorts his library into five tiers",
    );
    expect(diagnostics.memory_recall.lastN(1)[0]).toMatchObject({
      status: "recalled",
      recalled: 2,
      character: "qifei",
      rid: "rid-1",
    });
  });

  test("stays out of the way when recall is off", async () => {
    const config = world();
    config.app.memory.recall.mode = "off";
    const diagnostics = new Diagnostics();
    let called = false;

    const block = await runMemoryRecall(
      { config, character: "qifei", messages: CONVERSATION },
      {
        diagnostics,
        mcpRegistry: {
          call: async () => {
            called = true;
            return "{}";
          },
        },
      },
    );

    expect(block).toBeUndefined();
    expect(called).toBe(false);
    expect(diagnostics.memory_recall.lastN(1)).toHaveLength(0);
  });

  test("fails open when the server is unavailable", async () => {
    const diagnostics = new Diagnostics();
    const block = await runMemoryRecall(
      { config: world(), character: "qifei", messages: CONVERSATION },
      {
        diagnostics,
        mcpRegistry: {
          call: () => Promise.reject(new Error("MCP server 'hindsight' is unavailable")),
        },
        monotonicMs: () => 0,
      },
    );

    expect(block).toBeUndefined();
    expect(diagnostics.memory_recall.lastN(1)[0]).toMatchObject({
      status: "failed",
      recalled: 0,
      error: "MCP server 'hindsight' is unavailable",
    });
  });

  test("records a miss rather than an empty block", async () => {
    const diagnostics = new Diagnostics();
    const block = await runMemoryRecall(
      { config: world(), character: "qifei", messages: CONVERSATION },
      {
        diagnostics,
        mcpRegistry: { call: async () => ({ memories: [] }) },
        monotonicMs: () => 0,
      },
    );

    expect(block).toBeUndefined();
    expect(diagnostics.memory_recall.lastN(1)[0]).toMatchObject({ status: "no_match" });
  });

  test("does not call out when there is nothing to search on", async () => {
    const diagnostics = new Diagnostics();
    let called = false;
    const block = await runMemoryRecall(
      { config: world(), character: "qifei", messages: [message("user", "m1", "   ")] },
      {
        diagnostics,
        mcpRegistry: {
          call: async () => {
            called = true;
            return "{}";
          },
        },
      },
    );

    expect(block).toBeUndefined();
    expect(called).toBe(false);
    expect(diagnostics.memory_recall.lastN(1)[0]).toMatchObject({ status: "no_query" });
  });

  test("query takes only the latest user message by default", () => {
    expect(recallQuery([...CONVERSATION, message("assistant", "m4", "  ")], 2)).toBe(
      "what was that music script i wrote",
    );
  });

  test("an empty latest user message does not fall back to stale user text", () => {
    expect(recallQuery([...CONVERSATION, message("user", "m4", "  ")], 2)).toBe("");
  });

  test("recent query mode preserves the old multi-message behavior", () => {
    expect(recallQuery([...CONVERSATION, message("assistant", "m4", "  ")], 2, "recent")).toBe(
      "morning to you\n\nwhat was that music script i wrote",
    );
  });

  test("times out, records the failure, and proceeds without a block", async () => {
    const config = world();
    config.app.memory.recall.timeout = ConfigDuration.fromMillis(5);
    const diagnostics = new Diagnostics();
    const block = await runMemoryRecall(
      { config, character: "qifei", messages: CONVERSATION },
      {
        diagnostics,
        mcpRegistry: {
          call: () => new Promise(() => {}),
        },
      },
    );

    expect(block).toBeUndefined();
    expect(diagnostics.memory_recall.lastN(1)[0]).toMatchObject({
      status: "failed",
      recalled: 0,
      error: "memory recall timed out after 5ms",
    });
  });

  test("result parsing survives junk from the server", () => {
    expect(parseRecallResult("not json")).toEqual([]);
    expect(parseRecallResult({ memories: "nope" })).toEqual([]);
    expect(parseRecallResult({ memories: [{ text: "" }, { text: 7 }, null, { text: "kept" }] }))
      .toEqual([{ text: "kept" }]);
  });

  test("result parsing reads a hindsight recall payload", () => {
    expect(
      parseRecallResult({
        results: [
          {
            id: "15452ec7",
            text: "Ren has multiple cats and is the one who feeds them.",
            fact_type: "observation",
            occurred_start: "2026-08-18T00:00:00.020000+00:00",
            occurred_end: "2026-08-18T00:00:00.020000+00:00",
          },
          { id: "725b8545", text: "Beer is a ragdoll.", occurred_start: null },
        ],
      }),
    ).toEqual([
      {
        text: "Ren has multiple cats and is the one who feeds them.",
        occurred_at: "2026-08-18T00:00:00.020000+00:00",
      },
      { text: "Beer is a ragdoll." },
    ]);
  });

  test("formatting omits the date when the server did not give one", () => {
    expect(formatMemories([{ text: "a" }, { text: "b", occurred_at: "2026-07-04T00:00:00Z" }])).toBe(
      "- a\n- b (said 2026-07-04)",
    );
  });
});
