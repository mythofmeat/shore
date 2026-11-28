import { expect, test } from "bun:test";

import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { Texts } from "../src/texts/texts.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { carryToolMedia } from "../src/tools/media.ts";
import { BUILTIN_TOOL_SCHEMAS } from "./support/builtin_tool_schemas.ts";

function execution(ctx: Partial<ToolContext>, frames: ServerMessage[] = [], times: number[] = []): ToolExecution {
  return {
    sendDirect: (frame) => frames.push(frame),
    ctx: { texts: new Texts(), userName: "eve", characterName: "ada", workspaceDir: "/nowhere", characterDataDir: "/nowhere", conversationDir: "/nowhere", historyDbPath: "/nowhere/h.db", configDir: "/nowhere", ...ctx },
    limits: { timeout_ms: 0, max_result_chars: 0 },
    now: () => "2026-11-24T00:00:00Z",
    newMessageId: () => "m_1",
    monotonicMs: () => times.shift() ?? 0,
    schemas: BUILTIN_TOOL_SCHEMAS,
  };
}

test("a call refused for its arguments is marked refused and took as long as checking it, and one that ran took as long as running it and says what came back", async () => {
  const refused = await runToolUse({ id: "t1", name: "read", input: {} }, execution({}, [], [100, 130]));
  expect([refused.rejected, refused.isError, refused.durationMs]).toEqual([true, true, 30]);
  const frames: ServerMessage[] = [];
  const ran = await runToolUse({ id: "t2", name: "guide", input: {} }, execution({ guide: () => "the guide" }, frames, [200, 245]));
  expect([ran.rejected, ran.isError, ran.durationMs, ran.output]).toEqual([false, false, 45, "the guide"]);
  expect(frames.map((frame) => [frame.type, "output" in frame ? frame.output : undefined])).toEqual([["tool_call", undefined], ["tool_result", "the guide"]]);
});

test("a patch that fails says what a failed patch may have left behind, unless that note is switched off", async () => {
  const note = new Texts().render("patch_failed") ?? "";
  const failed = await runToolUse({ id: "t1", name: "apply_patch", input: { patch: "not a patch" } }, execution({}));
  expect([failed.isError, failed.raw.endsWith(`\n${note}`)]).toEqual([true, true]);
  const quiet = await runToolUse({ id: "t2", name: "apply_patch", input: { patch: "not a patch" } }, execution({ texts: new Texts({ patch_failed: false }) }));
  expect([quiet.isError, quiet.raw.includes(note)]).toEqual([true, false]);
});

test("a tool's picture that can't be sent to the model makes its result an error", async () => {
  const picture = carryToolMedia({ value: "look", media: [{ mime_type: "image/x-unknown", data: "AAAA", label: "a drawing" }], extra: [] });
  const run = await runToolUse({ id: "t1", name: "guide", input: {} }, execution({ guide: () => picture as string }));
  expect([run.isError, run.output.includes("[a drawing not sent to the model: ")]).toEqual([true, true]);
});
