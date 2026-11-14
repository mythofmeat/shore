import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { toolGeneration } from "./support/tool_generation.ts";
import { expect, test } from "bun:test";
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
import { outcomeOf, rejectionOf } from "./support/outcome.ts";

test("a compaction cut off at the token ceiling does not archive behind a half-written summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-truncated-"));
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

test("an archive that fails puts every memory file the pass touched back as it was", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-rollback-"));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  const blob = Buffer.from([0xff, 0x00, 0xfe]);
  await writeFile(join(workspace, "MEMORY.md"), "before\n");
  await writeFile(join(workspace, "memory", "old.md"), "old\n");
  await writeFile(join(workspace, "memory", "blob.bin"), blob);
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), conversation().map(activeLine).join("\n") + "\n");

  const base = options(dataDir, workspace, memoryStore, await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), tools(workspace), scripted([
    response("tool_use", [
      { type: "tool_use", id: "w1", name: "edit", input: { path: "MEMORY.md", content: "after\n" } },
      { type: "tool_use", id: "w2", name: "edit", input: { path: "memory/new.md", content: "new\n" } },
      { type: "tool_use", id: "w3", name: "delete", input: { path: "memory/old.md" } },
      { type: "tool_use", id: "w4", name: "delete", input: { path: "memory/blob.bin" } },
    ]),
    response("end_turn", [{ type: "text", text: "done" }]),
  ]));
  const failing = { ...base, conversationMgr: { ...base.conversationMgr, archiveAndRetain: async () => { throw new Error("disk full"); } } };

  expect(String(await rejectionOf(compact(failing, { keepRecentTurns: 1 })))).toContain("disk full");
  expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toBe("before\n");
  expect(await readFile(join(workspace, "memory", "old.md"), "utf8")).toBe("old\n");
  expect(Buffer.from(await readFile(join(workspace, "memory", "blob.bin")))).toEqual(blob);
  expect(await outcomeOf(readFile(join(workspace, "memory", "new.md"), "utf8"))).toThrow();
});

test("a compaction that uses up its tool rounds pauses with what it wrote and its conversation untouched, and carries on from there when run again", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-rounds-"));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  const activeContent = conversation().map(activeLine).join("\n") + "\n";
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);

  const edit = (id: string, path: string, content: string) => response("tool_use", [{ type: "tool_use", id, name: "edit", input: { path, content } }]);
  const model = scripted([
    edit("w1", "MEMORY.md", "one\n"), edit("w2", "memory/two.md", "two\n"),
    edit("w3", "memory/three.md", "three\n"), response("tool_use", [{ type: "text", text: "nothing more to write" }]),
  ]);
  const pass = async () => compact(
    { ...options(dataDir, workspace, memoryStore, await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), tools(workspace), model), maxToolRounds: 2 },
    { keepRecentTurns: 1 },
  );
  const written = async (path: string): Promise<string | undefined> => readFile(join(workspace, path), "utf8").catch(() => undefined);

  expect(await pass()).toMatchObject({ kind: "paused", reason: "iteration_limit", toolRounds: 2, toolsCalled: ["edit", "edit"] });
  expect([await written("MEMORY.md"), await written("memory/two.md"), await written("memory/three.md")]).toEqual(["one\n", "two\n", undefined]);
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(activeContent);

  expect(await pass()).toMatchObject({ kind: "compacted" });
  expect(await written("memory/three.md")).toBe("three\n");
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).not.toBe(activeContent);
});

test("a pass stopped before a turn's tools ran runs them when it is run again, and they count toward its tool rounds", async () => {
  const resumed = async (maxToolRounds: number): Promise<{ first: unknown; outcome: unknown; asked: number; files: (string | undefined)[] }> => {
    const root = await mkdtemp(join(tmpdir(), "shore-compact-pending-"));
    const dataDir = join(root, "data");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "memory"), { recursive: true });
    await mkdir(join(dataDir, "ada", "threads", "main"), { recursive: true });
    const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
    writeDurable(join(dataDir, "ada", "threads", "main", "active.jsonl"), conversation().map(activeLine).join("\n") + "\n");

    const edit = (id: string, path: string) => response("tool_use", [{ type: "tool_use", id, name: "edit", input: { path, content: `${id}\n` } }]);
    const turns = [edit("w1", "memory/one.md"), edit("w2", "memory/two.md"), response("end_turn", [{ type: "text", text: "done" }])];
    let asked = 0;
    const model: CompactionLlm = { ...scripted(turns), async generate() { asked += 1; return turns[asked - 1] as GenerateResponse; } };
    const working = tools(workspace);
    let broken = true;
    const flaky: CompactionTools = { ...working, dispatch: async (name, input, track) => {
      if (broken) throw new Error("the workspace went away");
      return await working.dispatch(name, input, track);
    } };
    const pass = async () => compact(
      { ...options(dataDir, workspace, memoryStore, await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), flaky, model), maxToolRounds },
      { keepRecentTurns: 1 },
    );
    const first = await pass();
    broken = false;
    const outcome = await pass();
    const written = async (path: string): Promise<string | undefined> => readFile(join(workspace, path), "utf8").catch(() => undefined);
    return { first, outcome, asked, files: [await written("memory/one.md"), await written("memory/two.md")] };
  };

  const one = await resumed(1);
  expect(one.first).toMatchObject({ kind: "paused", reason: "provider", detail: "the workspace went away", toolRounds: 0 });
  expect(one.outcome).toMatchObject({ kind: "paused", reason: "iteration_limit", toolRounds: 1 });
  expect([one.asked, one.files]).toEqual([1, ["w1\n", undefined]]);

  const two = await resumed(2);
  expect(two.outcome).toMatchObject({ kind: "paused", reason: "iteration_limit", toolRounds: 2 });
  expect([two.asked, two.files]).toEqual([2, ["w1\n", "w2\n"]]);

  const three = await resumed(3);
  expect(three.outcome).toMatchObject({ kind: "compacted" });
  expect([three.asked, three.files]).toEqual([3, ["w1\n", "w2\n"]]);
});

function tools(workspace: string, deferred?: string[]): CompactionTools {
  return {
    workspaceDir: workspace,
    turns: { workspace, repo: join(dirname(workspace), "turns.git") },
    dispatch: async (name, input) => {
      const edit = input as { path: string; content: string };
      const path = join(workspace, edit.path);
      if (name === "delete") {
        await rm(path);
        return { output: "deleted", isError: false };
      }
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
    reasoning_replay: "all",
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
