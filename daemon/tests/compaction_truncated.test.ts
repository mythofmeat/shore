import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { toolGeneration } from "./support/tool_generation.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MarkdownMemoryStore } from "../src/memory/markdown_store.ts";
import type { ArchivalPlan } from "../src/memory/compaction/plan.ts";
import { planFor } from "./support/archival_plan.ts";
import { conversationManager } from "../src/memory/compaction/archive.ts";
import { compact } from "../src/memory/compaction/manager.ts";
import type {
  CompactionLlm,
  CompactionTools,
  ConversationMessage,
} from "../src/memory/compaction/types.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import { outcomeOf } from "./support/outcome.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test("a compaction cut off at the token ceiling does not archive behind a half-written summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-truncated-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);
  const deferred: string[] = [];

  const outcome = await compact(
    options(dataDir, workspace, memoryStore, await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), tools(workspace, deferred), scripted([
      response("tool_use", [
        {
          type: "tool_use",
          id: "write-1",
          name: "edit",
          input: { path: "MEMORY.md", content: "half a thought\n" },
        },
      ]),
      response("max_tokens", [{ type: "text", text: "the summary stops mid-sen" }]),
    ])),
    { keepRecentTurns: 1 },
  );

  expect(outcome.kind).toBe("truncated");
  expect(outcome).toMatchObject({ truncatedTurns: 1 });
  expect((outcome as { partialWrites: string[] }).partialWrites.length).toBeGreaterThan(0);
  expect(deferred).toEqual(["MEMORY.md"]);

  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(activeContent);
  expect(await outcomeOf(readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8"))).toThrow();
});

test("a pass that ends cleanly still archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-clean-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);

  const outcome = await compact(
    options(dataDir, workspace, memoryStore, await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), tools(workspace), scripted([
      response("tool_use", [
        {
          type: "tool_use",
          id: "write-1",
          name: "edit",
          input: { path: "memory/fact.md", content: "remembered\n" },
        },
      ]),
      response("end_turn", [{ type: "text", text: "done" }]),
    ])),
    { keepRecentTurns: 1 },
  );

  expect(outcome.kind).toBe("compacted");
});

function tools(workspace: string, deferred?: string[]): CompactionTools {
  return {
    workspaceDir: workspace,
    dispatch: async (_name, input) => {
      const edit = input as { path: string; content: string };
      const path = join(workspace, edit.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, edit.content, "utf8");
      return { output: "written", isError: false };
    },
    ...(deferred === undefined
      ? {}
      : { deferEdit: async (path: string) => { deferred.push(path); } }),
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
}

function options(
  dataDir: string,
  workspace: string,
  memoryStore: MarkdownMemoryStore,
  plan: ArchivalPlan,
  toolCtx: CompactionTools,
  llm: CompactionLlm,
) {
  return {
    conversationId: "ada",
    plan,
    promptTemplate: "compact",
    charName: "ada",
    userName: "user",
    llm,
    conversationMgr: conversationManager(join(dataDir, "ada", "threads", "main"), { dbPath: join(dataDir, "shore.db"), archiveKey: "ada" }),
    markdownStore: memoryStore,
    dryRun: false,
    chatRequest: request(),
    dataDir,
    resumable: true,
    tools: toolCtx,
  };
}

function conversation(): ConversationMessage[] {
  return [
    conversationMessage("user", "old question"),
    conversationMessage("assistant", "old answer"),
    conversationMessage("user", "recent question"),
    conversationMessage("assistant", "recent answer"),
  ];
}

function conversationMessage(role: string, content: string): ConversationMessage {
  return {
    role,
    content,
    timestamp: "2026-08-12T00:00:00Z",
    isToolResultOnly: false,
    isAutonomous: false,
  };
}

function activeLine(message: ConversationMessage): string {
  return JSON.stringify({
    msg_id: crypto.randomUUID(),
    role: message.role,
    content: message.content,
    content_blocks: [{ type: "text", text: message.content }],
    images: [],
    alternatives: [],
    timestamp: message.timestamp,
  });
}

function request(): SidecarRequest {
  return {
    sdk: "anthropic",
    provider_key: "anthropic",
    model: "claude-test",
    api_key: "k",
    messages: [],
    max_tokens: 100,
    replay_prior_thinking: "all",
  };
}

function response(
  finishReason: string,
  contentBlocks: GenerateResponse["content_blocks"],
): GenerateResponse {
  return {
    content: "",
    content_blocks: contentBlocks,
    finish_reason: finishReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
    model: "claude-test",
  };
}

function scripted(turns: GenerateResponse[]): CompactionLlm {
  let next = 0;
  return {
    run(callRequest, phase, loopOptions) {
      return toolGeneration(async (call) => this.generate(call))(callRequest, phase, undefined, loopOptions);
    },
    buildInitialRequest(prompt: string, chat: SidecarRequest) {
      return { ...chat, messages: [{ role: "user", content: [{ type: "text", text: prompt }], transient_tail: 1 }] };
    },
    async generate() {
      const turn = turns[next++];
      if (turn === undefined) throw new Error("script exhausted");
      return turn;
    },
  };
}
