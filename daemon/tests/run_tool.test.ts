import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runTool, type RunToolContext } from "../src/commands/run_tool.ts";
import { loadConfig } from "../src/config/loader.ts";
import type { ToolContextDeps } from "../src/handler/tool_context.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

async function world(tools: RunToolContext["tools"] = () => ({})): Promise<{ ctx: RunToolContext; emitted: ServerMessage[] }> {
  const root = await mkdtemp(testTmp("shore-run-tool-"));
  await writeFile(join(root, "config.toml"), '[subagents.scout]\ndescription = "looks"\nprompt = "look"\n');
  const loaded = loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} });
  const config = { ...loaded, dirs: { ...loaded.dirs, data: join(root, "data"), cache: join(root, "cache") } };
  const emitted: ServerMessage[] = [];
  return {
    ctx: { config, dataDir: config.dirs.data, conversation: [], tools, mcpTools: () => [], toolUseId: () => "root", emit: (message) => { emitted.push(message); } },
    emitted,
  };
}

test("a tool run reports what the tool said, whether it worked, and the raw output only when asked, with no pictures when it sent none", async () => {
  const { ctx, emitted } = await world();
  const report = await runTool("ada", ctx, { tool: "guide" });
  expect(report).toStrictEqual({
    tool: "guide", character: "ada", kind: "builtin", enabled: false, input: {}, ok: true, rejected: false,
    duration_ms: report.duration_ms, output: report.output, truncated: false, result_chars: Array.from(report.output).length, raw: null, calls: [],
  });
  expect(report.output).toContain("guide");
  expect(emitted.map((frame) => frame.type)).toEqual(["tool_call", "tool_result"]);
  expect((await runTool("ada", ctx, { tool: "guide", raw: true })).raw).toBe(report.output);
});

test("a call its tool's schema refuses is reported as refused, not run, and not cut", async () => {
  const { ctx } = await world();
  const report = await runTool("ada", ctx, { tool: "read" });
  expect([report.ok, report.rejected, report.truncated, report.result_chars]).toEqual([false, true, false, Array.from(report.output).length]);
  expect(report.output).toContain("`file_path`");
});

test("what a sub-agent does on the way is reported as its calls and the pictures it sent, and every frame is passed on", async () => {
  const asked: string[] = [];
  const { ctx, emitted } = await world((_character, turn): ToolContextDeps => ({
    runSubagent: () => async (name, query) => {
      asked.push(`${name}: ${query}`);
      turn.send({ type: "tool_call", tool_id: "n1", tool_name: "read", input: { file_path: "SOUL.md" }, subagent: "scout" });
      turn.send({ type: "tool_result", tool_id: "n1", tool_name: "read", output: "no such file", is_error: true, subagent: "scout" });
      turn.send({ type: "send_image", path: "/media/lamp.png", caption: "the lamp", data: "QUJD", subagent: "scout" });
      turn.send({ type: "stream_end", text: "" } as unknown as ServerMessage);
      return "found nothing";
    },
  }));
  const report = await runTool("ada", ctx, { tool: "ask_scout", input: { query: "where is the soul?" } });
  expect(asked).toEqual(["scout: where is the soul?"]);
  expect([report.kind, report.ok, report.output]).toEqual(["subagent", true, "found nothing"]);
  expect(report.calls).toEqual([{ tool: "read", subagent: "scout", ok: false, input: '{"file_path":"SOUL.md"}', output: "no such file" }]);
  expect(report.images).toEqual([{ path: "/media/lamp.png", caption: "the lamp", data: "QUJD" }]);
  expect(emitted.map((frame) => frame.type)).toEqual(["tool_call", "tool_call", "tool_result", "send_image", "stream_end", "tool_result"]);
});

test("a run whose turn is cancelled before it starts, or while its tools are set up, never calls the tool", async () => {
  let setUp = 0;
  const before = await world(() => { setUp += 1; return {}; });
  const cancelled = new AbortController();
  cancelled.abort();
  expect(await outcomeOf(runTool("ada", { ...before.ctx, signal: cancelled.signal }, { tool: "guide" }))).toThrow();
  expect([setUp, before.emitted.length]).toEqual([0, 0]);

  const during = new AbortController();
  const midway = await world(() => { during.abort(); return {}; });
  expect(await outcomeOf(runTool("ada", { ...midway.ctx, signal: during.signal }, { tool: "guide" }))).toThrow();
  expect(midway.emitted).toEqual([]);
});
