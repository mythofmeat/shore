import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendSubagentTrace,
  readSubagentTraces,
  subagentTraceFile,
} from "../src/tools/subagent_trace.ts";
import type { Message } from "../src/engine/types.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shore-trace-"));
  roots.push(root);
  return join(root, "ada");
}

function message(text: string): Message {
  return {
    msg_id: "m_1",
    role: "assistant",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: "2026-01-01T00:00:00+00:00",
  };
}

async function seed(dir: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await appendSubagentTrace(dir, {
      subagent: "researcher",
      parent_tool_use_id: id,
      model: "cheap",
      messages: [],
    });
  }
}

describe("appendSubagentTrace", () => {
  test("creates the character directory and round-trips a run", async () => {
    const dir = await tempDir();
    await appendSubagentTrace(dir, {
      subagent: "researcher",
      parent_tool_use_id: "toolu_01",
      rid: "r-9",
      model: "cheap",
      messages: [message("looked it up")],
      result: "she moved out in June",
    });

    const traces = await readSubagentTraces(dir);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.parent_tool_use_id).toBe("toolu_01");
    expect(traces[0]?.subagent).toBe("researcher");
    expect(traces[0]?.rid).toBe("r-9");
    expect(traces[0]?.result).toBe("she moved out in June");
    expect(traces[0]?.messages[0]?.content_blocks[0]).toEqual({
      type: "text",
      text: "looked it up",
    });
    expect(traces[0]?.ts).not.toBe("");
  });

  test("appends rather than replacing, so a character accumulates runs", async () => {
    const dir = await tempDir();
    await seed(dir, ["toolu_01", "toolu_02", "toolu_03"]);

    const traces = await readSubagentTraces(dir);
    expect(traces.map((t) => t.parent_tool_use_id)).toEqual([
      "toolu_01",
      "toolu_02",
      "toolu_03",
    ]);
  });
});

describe("readSubagentTraces", () => {
  test("a character that has never delegated reads as empty", async () => {
    expect(await readSubagentTraces(await tempDir())).toEqual([]);
  });

  test("ids select the runs a rendered page asks for", async () => {
    const dir = await tempDir();
    await seed(dir, ["toolu_01", "toolu_02", "toolu_03"]);

    const traces = await readSubagentTraces(dir, { ids: ["toolu_03", "toolu_01"] });
    expect(traces.map((t) => t.parent_tool_use_id)).toEqual(["toolu_01", "toolu_03"]);
  });

  test("count keeps the newest runs, which is what a bare listing wants", async () => {
    const dir = await tempDir();
    await seed(dir, ["toolu_01", "toolu_02", "toolu_03"]);

    const traces = await readSubagentTraces(dir, { count: 2 });
    expect(traces.map((t) => t.parent_tool_use_id)).toEqual(["toolu_02", "toolu_03"]);
  });

  test("a torn line is skipped and the runs around it still read", async () => {
    const dir = await tempDir();
    await seed(dir, ["toolu_01"]);
    await appendFile(subagentTraceFile(dir), '{"subagent":"researcher","parent_\n', "utf8");
    await seed(dir, ["toolu_02"]);

    const traces = await readSubagentTraces(dir);
    expect(traces.map((t) => t.parent_tool_use_id)).toEqual(["toolu_01", "toolu_02"]);
  });

  test("a line carrying no parent id is not a trace and is dropped", async () => {
    const dir = await tempDir();
    await seed(dir, ["toolu_01"]);
    await appendFile(
      subagentTraceFile(dir),
      `${JSON.stringify({ subagent: "orphan", messages: [] })}\n`,
      "utf8",
    );

    const traces = await readSubagentTraces(dir);
    expect(traces.map((t) => t.subagent)).toEqual(["researcher"]);
  });
});
