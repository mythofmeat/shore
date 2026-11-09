import { describe, expect, test } from "bun:test";

import { MAX_ACTIVITY_CHARS, inspectionPreview, recentItems, recentText } from "../src/browser/live_limits.ts";
import { assertToolControlCoverage, toolControl, toolNames } from "../src/browser/tool_forms.ts";
import type { ToolAccessResult } from "../src/protocol/ToolAccessResult.ts";

describe("what a live view keeps of a long stream", () => {
  test("the most recent text, never starting in the middle of a character", () => {
    expect(recentText("short", 10)).toBe("short");
    expect(recentText("exactly", 7)).toBe("exactly");
    expect(recentText("abcdef", 3)).toBe("def");
    expect(recentText("ab😀cd", 3), "half an emoji is dropped").toBe("cd");
    expect(recentText("ab😀cd", 4)).toBe("😀cd");
    expect(recentText("\uDC00xy", 2)).toBe("xy");
  });

  test("the most recent items that fit both the count and the size, in order, saying whether any were left out", () => {
    const size = (item: string) => item.length;
    expect(recentItems(["a", "bb", "c"], 5, 100, size)).toEqual({ items: ["a", "bb", "c"], limited: false });
    expect(recentItems(["a", "bb", "c"], 2, 100, size)).toEqual({ items: ["bb", "c"], limited: true });
    expect(recentItems(["a", "bb", "c"], 5, 3, size)).toEqual({ items: ["bb", "c"], limited: true });
    expect(recentItems(["a", "toolong", "c"], 5, 3, size), "a large item is skipped, not a stop").toEqual({ items: ["a", "c"], limited: true });
    expect(recentItems(["ab", "c"], 5, 3, size), "exactly the size fits").toEqual({ items: ["ab", "c"], limited: false });
    expect(recentItems([undefined, "a"], 5, 100, (item: string | undefined) => item?.length ?? 0)).toEqual({ items: ["a"], limited: true });
    expect(recentItems([], 5, 100, size)).toEqual({ items: [], limited: false });
  });

  test("an inspected frame that is too large becomes a preview of its end, keeping what identifies it", () => {
    const small = { type: "phase", phase: "x" };
    expect(inspectionPreview(small)).toBe(small);
    expect(inspectionPreview(undefined)).toBeUndefined();
    const fits = { type: "x", text: "a".repeat(MAX_ACTIVITY_CHARS - 22) };
    expect(JSON.stringify(fits).length).toBe(MAX_ACTIVITY_CHARS);
    expect(inspectionPreview(fits)).toBe(fits);
    const large = { type: "stream_chunk", rid: "r".repeat(300), subagent: "memory", task_id: 7, text: "a".repeat(MAX_ACTIVITY_CHARS) };
    const preview = inspectionPreview(large) as Record<string, unknown>;
    expect(preview["type"]).toBe("stream_chunk");
    expect(preview["rid"]).toBe("r".repeat(256));
    expect(preview["subagent"]).toBe("memory");
    expect(preview["task_id"]).toBeUndefined();
    expect(preview["previewLimited"]).toBe(true);
    expect(preview["preview"]).toBe(JSON.stringify(large).slice(-MAX_ACTIVITY_CHARS));
    const text = inspectionPreview("b".repeat(MAX_ACTIVITY_CHARS + 5)) as Record<string, unknown>;
    expect(Object.keys(text).sort()).toEqual(["preview", "previewLimited"]);
  });
});

describe("running a tool by hand from the web", () => {
  test("lists every tool by its call name, sub-agents as ask_ tools, once each and in order", () => {
    const access = {
      tools: [{ tool: "read" }, { tool: "bash" }], subagents: [{ name: "memory" }], mcp: ["mcp__notes__find", "read"], warnings: [],
    } as unknown as ToolAccessResult;
    expect(toolNames(access)).toEqual(["ask_memory", "bash", "mcp__notes__find", "read"]);
  });

  test("edits free text in a box of several lines, wherever it sits in the arguments, but keeps choices as choices", () => {
    const control = toolControl({
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["a", "b"] },
        tags: { type: "array", items: { type: "string" } },
        either: { anyOf: [{ type: "string" }, { type: "null" }] },
        nested: { type: "object", properties: { note: { type: "string" } }, additionalProperties: { type: "string" } },
        count: { type: "integer" },
      },
    });
    expect(control.fields).toEqual({
      query: { kind: "string", multiline: true },
      mode: { kind: "string", choices: ["a", "b"] },
      tags: { kind: "array", item: { kind: "string", multiline: true } },
      either: { kind: "union", options: [{ kind: "string", multiline: true }, { kind: "null" }] },
      nested: { kind: "object", fields: { note: { kind: "string", multiline: true } }, required: [], hints: { note: "" }, additional: { kind: "string", multiline: true } },
      count: { kind: "integer" },
    });
    expect(control.additional).toEqual({ kind: "json" });
    expect(() => toolControl({ type: "string" })).toThrow("Tool arguments require an object editor");
  });

  test("every tool's arguments must have a renderer for each control, however deep", () => {
    const all = new Set(["object", "string", "array", "union", "null", "json", "integer"]);
    const schemas = [{ name: "search", schema: { type: "object", properties: { tags: { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } } }, additionalProperties: { type: "integer" } } }];
    expect(() => { assertToolControlCoverage(schemas, all); }).not.toThrow();
    for (const missing of ["object", "array", "union", "null", "string", "integer"]) {
      const renderers = new Set([...all].filter((kind) => kind !== missing));
      expect(() => { assertToolControlCoverage(schemas, renderers); }, missing).toThrow(`Missing tool input renderer: search.${missing}`);
    }
    expect(() => { assertToolControlCoverage([{ name: "plain", schema: { type: "object", additionalProperties: false } }], new Set(["object"])); }).not.toThrow();
  });
});
