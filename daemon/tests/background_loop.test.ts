import { afterEach, expect, jest, test } from "bun:test";

import { runBackgroundLoop, type BackgroundLoopDeps, type LoopRound, type LoopToolResult, type TranscriptRound } from "../src/autonomy/background_loop.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import type { ToolPhase } from "../src/tools/execute.ts";

afterEach(() => { jest.useRealTimers(); });

const READ: ContentBlock = { type: "tool_use", id: "t1", name: "read", input: { file_path: "SOUL.md" } };
const DRAW: ContentBlock = { type: "tool_use", id: "t2", name: "generate_image", input: { prompt: "a lamp" } };

function asked(): SidecarRequest {
  return {
    sdk: "anthropic", model: "claude-asked", api_key: "k", max_tokens: 1024, reasoning_replay: "all",
    messages: [{ role: "user", content: [{ type: "text", text: "[wake]" }] }],
  };
}

function answer(blocks: ContentBlock[], model = "claude-answered", output = 1): GenerateResponse {
  return {
    model,
    content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    content_blocks: blocks,
    finish_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 1, output_tokens: output, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
  };
}

interface Seen {
  persisted: LoopRound[];
  transcripts: [callType: string, iteration: number, captured: string[]][];
  notes: string[];
  parallel: (boolean | undefined)[];
}

function loop(generate: BackgroundLoopDeps["generate"], over: Partial<BackgroundLoopDeps> = {}): { deps: BackgroundLoopDeps; seen: Seen } {
  const seen: Seen = { persisted: [], transcripts: [], notes: [], parallel: [] };
  const results: Record<string, LoopToolResult> = {
    read: { output: "Ada", isError: false },
    generate_image: { output: "made the lamp", isError: false, value: { path: "/media/lamp.png" } },
  };
  const deps: BackgroundLoopDeps = {
    character: "ada",
    name: "Wake",
    callTypes: ["wake", "wake_tool_loop"],
    generate: async (request, phase, signal) => {
      seen.parallel.push(phase.parallel);
      return await generate(request, phase, signal);
    },
    dispatch: async (name) => results[name] ?? { output: "", isError: true },
    note: (text) => { seen.notes.push(text); },
    recordTranscript: (round: TranscriptRound) => { seen.transcripts.push([round.callType, round.iteration, round.captured.map((tool) => tool.name)]); },
    persist: async (round) => { seen.persisted.push(structuredClone(round)); },
    wrapUpGrace: 2,
    maxToolRounds: undefined,
    timeLimitMs: 30 * 60_000,
    wrapUpMs: 5 * 60_000,
    wrapUpText: (msLeft, rounds) => `[wrap up: ${String(Math.round(msLeft / 60_000))} minutes, ${String(rounds)} rounds]`,
    ...over,
  };
  return { deps, seen };
}

async function toolRound(phase: ToolPhase, request: SidecarRequest, uses: ContentBlock[]): Promise<void> {
  const reply = answer(uses);
  await phase.beforeTurn?.(request);
  await phase.onTurn?.(reply);
  const results: ContentBlock[] = [];
  for (const use of uses) if (use.type === "tool_use") results.push(await phase.runTool({ id: use.id, name: use.name, input: use.input }));
  await phase.recordTurn("assistant", uses);
  await phase.afterTurn?.(reply);
  await phase.recordTurn("user", results);
}

async function lastRound(phase: ToolPhase, request: SidecarRequest, text: string, output = 7): Promise<GenerateResponse> {
  const reply = answer([{ type: "text", text }], "claude-answered", output);
  await phase.beforeTurn?.(request);
  await phase.onTurn?.(reply);
  await phase.afterTurn?.(reply);
  return reply;
}

test("a wake's rounds are kept once each, with the model that answered, its tools run one at a time, and what it ends with is added to what was asked", async () => {
  const request = asked();
  const { deps, seen } = loop(async (call, phase) => {
    await toolRound(phase, call, [READ, DRAW]);
    return await lastRound(phase, call, "Read the log.");
  });
  const result = await runBackgroundLoop(request, deps);

  expect(result).toEqual({ images: [{ path: "/media/lamp.png", caption: undefined, data: undefined }], rounds: 2, usage: { input_tokens: 1, output_tokens: 7, cache_read_tokens: 0, cache_creation_tokens: 0 } });
  expect(seen.parallel).toEqual([false]);
  expect(seen.persisted).toEqual([
    { role: "assistant", blocks: [READ, DRAW], model: "claude-answered" },
    { role: "user", blocks: [
      { type: "tool_result", tool_use_id: "t1", content: "Ada", is_error: false },
      { type: "tool_result", tool_use_id: "t2", content: "made the lamp", is_error: false },
    ] },
    { role: "assistant", blocks: [{ type: "text", text: "Read the log." }], model: "claude-answered" },
  ]);
  expect(seen.transcripts).toEqual([["wake", 0, ["read", "generate_image"]], ["wake_tool_loop", 1, []]]);
  expect(request.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "[wake]" }] },
    { role: "assistant", content: [{ type: "text", text: "Read the log." }] },
  ]);
  expect(seen.notes).toEqual(["Tool: read → Ada", "Tool: generate_image → made the lamp"]);
});

test("a wake that answers at once is kept once, and a round kept before its model is known carries none", async () => {
  const single = loop(async (call, phase) => await lastRound(phase, call, "Nothing to do."));
  expect((await runBackgroundLoop(asked(), single.deps)).rounds).toBe(1);
  expect(single.seen.persisted).toEqual([{ role: "assistant", blocks: [{ type: "text", text: "Nothing to do." }], model: "claude-answered" }]);

  const early = loop(async (call, phase) => {
    await phase.recordTurn("assistant", [READ]);
    await phase.afterTurn?.(answer([READ]));
    return await lastRound(phase, call, "Done.");
  });
  await runBackgroundLoop(asked(), early.deps);
  expect(early.seen.persisted.map((round) => [round.role, "model" in round])).toEqual([["assistant", false], ["assistant", true]]);
});

test("a wake out of rounds is told to wrap up, the log says when, and it stops once its extra rounds are used", async () => {
  jest.useFakeTimers();
  const request = asked();
  const nudged: string[][] = [];
  const { deps, seen } = loop(async (call, phase) => {
    for (;;) {
      await toolRound(phase, call, [READ]);
      nudged.push(call.messages.at(-1)?.content.flatMap((block) => block.type === "text" ? [block.text] : []) ?? []);
    }
  }, { maxToolRounds: 1 });
  const result = await runBackgroundLoop(request, deps);

  expect(result.stoppedAt).toBe("rounds");
  expect(result.rounds).toBe(3);
  expect(nudged).toEqual([["[wake]"], ["[wake]", "[wrap up: 30 minutes, 2 rounds]"], ["[wake]", "[wrap up: 30 minutes, 2 rounds]"]]);
  expect(seen.notes.filter((text) => text.startsWith("Wrap-up"))).toEqual(["Wrap-up nudge on round 1, with about 30 minutes left"]);
  expect(seen.persisted.filter((round) => round.role === "system")).toEqual([{ role: "system", blocks: [{ type: "text", text: "[wrap up: 30 minutes, 2 rounds]" }] }]);
});

test("a wake still running at its time limit is cut off there, and one that ends in time leaves no timer behind", async () => {
  jest.useFakeTimers();
  jest.advanceTimersByTime(5_000);
  const late = loop(async (call, phase, signal) => {
    jest.advanceTimersByTime(60_000);
    if (signal.aborted) throw new Error("aborted");
    return await lastRound(phase, call, "Still going.");
  }, { timeLimitMs: 60_000, wrapUpMs: 10_000 });
  const stopped = await runBackgroundLoop(asked(), late.deps);
  expect([stopped.timedOut, stopped.failedRound, String(stopped.failure)]).toEqual([true, 0, "Error: aborted"]);
  expect(jest.getTimerCount()).toBe(0);

  const early = loop(async (call, phase) => await lastRound(phase, call, "Done."), { timeLimitMs: 60_000, wrapUpMs: 10_000 });
  expect((await runBackgroundLoop(asked(), early.deps)).timedOut).toBeUndefined();
  expect(jest.getTimerCount()).toBe(0);
});
