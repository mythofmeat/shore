import { toolGeneration } from "./support/tool_generation.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { GenerateResponse, SidecarRequest, WireMessage } from "../src/llm/types.ts";
import { MarkdownMemoryStore } from "../src/memory/markdown_store.ts";
import { planMessage, planOf } from "./support/archival_plan.ts";
import { compact } from "../src/memory/compaction/manager.ts";
import {
  COMPACTION_SUBAGENT,
  tagCompactionFrames,
  type CompactionLlm,
  type CompactionTools,
  type ConversationManager,
  type ToolOutput,
} from "../src/memory/compaction/types.ts";

const MESSAGES = [
  planMessage("user", "one"),
  planMessage("assistant", "two"),
  planMessage("user", "three"),
  planMessage("assistant", "four"),
];

function chatRequest(): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "fixture-model",
    api_key: "",
    provider_key: "anthropic",
    messages: MESSAGES.map(
      (m): WireMessage => ({ role: m.role, content: [{ type: "text", text: m.content }] }),
    ),
    max_tokens: 1024,
    replay_prior_thinking: "off",
  } as unknown as SidecarRequest;
}

function response(blocks: unknown[], finish: string): GenerateResponse {
  return {
    content: "",
    content_blocks: blocks,
    finish_reason: finish,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
    model: "fixture-model",
  } as unknown as GenerateResponse;
}

class TwoRoundLlm implements CompactionLlm {
  run: CompactionLlm["run"] = (request, phase, options) => toolGeneration(async () => this.generate())(request, phase, undefined, options);
  #round = 0;
  buildInitialRequest(): SidecarRequest {
    return chatRequest();
  }
  generate(): Promise<GenerateResponse> {
    this.#round += 1;
    if (this.#round === 1) {
      return Promise.resolve(
        response(
          [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "edit",
              input: { path: "memory/notes.md", content: "- a note\n" },
            },
          ],
          "tool_use",
        ),
      );
    }
    return Promise.resolve(response([{ type: "text", text: "done" }], "end_turn"));
  }
}

class QuietTools implements CompactionTools {
  constructor(readonly workspaceDir: string) {}
  dispatch(): Promise<ToolOutput> {
    return Promise.resolve({ output: "written", isError: false });
  }
  ensureWorkspaceGitRepo(): Promise<void> {
    return Promise.resolve();
  }
  gitCommitAll(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

const MGR: ConversationManager = {
  archiveAndRetain: () => Promise.resolve("new-conversation-id"),
};

async function collectFrames(): Promise<ServerMessage[]> {
  const root = await mkdtemp(join(tmpdir(), "shore-compaction-progress-"));
  try {
    const workspace = join(root, "workspace");
    const memory = join(workspace, "memory");
    await mkdir(memory, { recursive: true });
    const markdownStore = await MarkdownMemoryStore.open(memory);

    const frames: ServerMessage[] = [];
    await compact(
      {
        conversationId: "conv-1",
        plan: planOf(MESSAGES, { keepRecentTurns: 0 }),
        systemTemplate: "System for {{char}}.",
        promptTemplate: "Compact now, {{char}}.",
        charName: "Aria",
        userName: "Tom",
        llm: new TwoRoundLlm(),
        conversationMgr: MGR,
        markdownStore,
        dryRun: false,
        chatRequest: chatRequest(),
        tools: new QuietTools(workspace),
        emit: tagCompactionFrames((message) => frames.push(message)),
      },
      { keepRecentTurns: 0 },
    );
    return frames;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("a compaction pass reports what it is doing", () => {
  test("it announces each round before the model call", async () => {
    const phases = (await collectFrames()).filter((f) => f.type === "phase");
    expect(phases.map((f) => (f as { phase: string }).phase)).toEqual([
      "compacting round 1",
      "compacting round 2",
    ]);
  });

  test("every tool call is reported with its result", async () => {
    const frames = await collectFrames();
    const calls = frames.filter((f) => f.type === "tool_call");
    const results = frames.filter((f) => f.type === "tool_result");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool_name: "edit", tool_id: "toolu_1" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      tool_name: "edit",
      tool_id: "toolu_1",
      output: "written",
      is_error: false,
    });
  });

  test("the call is reported before its result, so the view never shows an orphan", async () => {
    const frames = await collectFrames();
    const callAt = frames.findIndex((f) => f.type === "tool_call");
    const resultAt = frames.findIndex((f) => f.type === "tool_result");
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(resultAt).toBeGreaterThan(callAt);
  });

  test("compaction frames are tagged so the view never mistakes them for a chat turn", async () => {
    const frames = await collectFrames();
    const tagged = frames.filter((f) => f.type === "tool_call" || f.type === "tool_result");
    expect(tagged.length).toBeGreaterThan(0);
    for (const frame of tagged) {
      expect((frame as { subagent?: string | null }).subagent).toBe(COMPACTION_SUBAGENT);
    }
  });

  test("a pass with no sink still runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "shore-compaction-silent-"));
    try {
      const workspace = join(root, "workspace");
      const memory = join(workspace, "memory");
      await mkdir(memory, { recursive: true });
      const outcome = await compact(
        {
          conversationId: "conv-1",
          plan: planOf(MESSAGES, { keepRecentTurns: 0 }),
          systemTemplate: "System for {{char}}.",
          promptTemplate: "Compact now, {{char}}.",
          charName: "Aria",
          userName: "Tom",
          llm: new TwoRoundLlm(),
          conversationMgr: MGR,
          markdownStore: await MarkdownMemoryStore.open(memory),
          dryRun: false,
            chatRequest: chatRequest(),
          tools: new QuietTools(workspace),
        },
        { keepRecentTurns: 0 },
      );
      expect(outcome.kind).toBe("compacted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("tagCompactionFrames", () => {
  test("leaves frames that carry no subagent field alone", () => {
    const seen: ServerMessage[] = [];
    tagCompactionFrames((m) => seen.push(m))({
      type: "phase",
      rid: null,
      phase: "compacting round 1",
      model: null,
    });
    expect(seen[0]).toEqual({
      type: "phase",
      rid: null,
      phase: "compacting round 1",
      model: null,
    });
  });

  test("stamps the streamed model output so it renders under compaction", () => {
    const seen: ServerMessage[] = [];
    const sink = tagCompactionFrames((m) => seen.push(m));
    sink({ type: "stream_start", rid: null, regen: false, subagent: null });
    sink({ type: "stream_chunk", rid: null, text: "hi", content_type: "text", subagent: null });
    for (const frame of seen) {
      expect((frame as { subagent?: string | null }).subagent).toBe(COMPACTION_SUBAGENT);
    }
  });
});
