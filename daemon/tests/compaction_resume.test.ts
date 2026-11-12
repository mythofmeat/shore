import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { toolGeneration } from "./support/tool_generation.ts";
import { required } from "../src/util/required.ts";

import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { MarkdownMemoryStore } from "../src/memory/markdown_store.ts";
import type { ArchivalPlan } from "../src/memory/compaction/plan.ts";
import { planFor } from "./support/archival_plan.ts";
import { conversationManager } from "../src/memory/compaction/archive.ts";
import { compact } from "../src/memory/compaction/manager.ts";
import * as checkpoints from "../src/memory/compaction/checkpoint.ts";
import type { Message } from "../src/engine/types.ts";
import type {
  CompactionLlm,
  CompactionTools,
  ConversationMessage,
} from "../src/memory/compaction/types.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import { handleBash } from "../src/tools/bash.ts";
import { renderToolOutcome } from "../src/memory/compaction/run.ts";
import { outcomeOf } from "./support/outcome.ts";

test.each([false, true])("archive failure restores workspace edits, binary files, and deleted symlinks (delegated: %s)", async (delegated) => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-workspace-rollback-"));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  await mkdir(join(workspace, "projects"), { recursive: true });
  await mkdir(join(workspace, "assets"));
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  const activeContent = conversation().map(activeLine).join("\n") + "\n";
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);
  const bytes = Buffer.from([0, 255, 254, 128, 10]);
  await writeFile(join(workspace, "assets/data.bin"), bytes);
  await symlink("data.bin", join(workspace, "assets/link.bin"));
  await writeFile(join(workspace, "projects/note.md"), "original context");
  const tools: CompactionTools = {
    workspaceDir: workspace,
    turns: { workspace, repo: join(dirname(workspace), "turns.git") },
    dispatch: (name, input, trackNestedWrite) => {
      if (name !== "ask_research") return renderToolOutcome(() => handleBash(input as Record<string, unknown>, workspace, "ada"));
      const nested = input as { name: string; input: unknown };
      return required(trackNestedWrite)(nested.name, nested.input, () => renderToolOutcome(() => handleBash(nested.input as Record<string, unknown>, workspace, "ada")));
    },
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const calls: GenerateResponse["content_blocks"] = [
    { type: "tool_use", id: "edit-note", name: "bash", input: { command: "printf 'new context' > projects/note.md" } },
    { type: "tool_use", id: "edit-binary", name: "bash", input: { command: "printf replacement > assets/data.bin" } },
    { type: "tool_use", id: "delete-link", name: "bash", input: { command: "rm assets/link.bin" } },
    { type: "tool_use", id: "delete-binary", name: "bash", input: { command: "rm assets/data.bin" } },
    { type: "tool_use", id: "create", name: "bash", input: { command: "printf 'new file' > projects/new.md" } },
  ];
  const opts = options(dataDir, workspace, memoryStore,
    await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), tools,
    scripted([response("tool_use", delegated ? calls.map((call) => {
      if (call.type !== "tool_use") return call;
      return { ...call, name: "ask_research", input: { name: call.name, input: call.input } };
    }) : calls), response("end_turn", [])]));
  const failure = await compact({
    ...opts,
    conversationMgr: {
      archiveAndRetain: async () => {
        expect(await outcomeOf(readFile(join(workspace, "assets/data.bin")))).toThrow();
        expect(await outcomeOf(readlink(join(workspace, "assets/link.bin")))).toThrow();
        throw new Error("archive failed");
      },
    },
  }, { keepRecentTurns: 1 }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", "archive failed");

  expect(await readFile(join(workspace, "projects/note.md"), "utf8")).toBe("original context");
  expect(await readFile(join(workspace, "assets/data.bin"))).toEqual(bytes);
  expect(await readlink(join(workspace, "assets/link.bin"))).toBe("data.bin");
  expect(await outcomeOf(readFile(join(workspace, "projects/new.md")))).toThrow();
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(activeContent);
  expect(await outcomeOf(readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8"))).toThrow();
});

test("a resumed pass keeps files changed while it was paused and rolls back the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-adopt-"));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  await mkdir(join(workspace, "memory"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), conversation().map(activeLine).join("\n") + "\n");
  await writeFile(join(workspace, "memory/kept.md"), "original kept");
  await writeFile(join(workspace, "memory/reverted.md"), "original reverted");
  const tools: CompactionTools = {
    workspaceDir: workspace,
    turns: { workspace, repo: join(dirname(workspace), "turns.git") },
    dispatch: (_name, input) => renderToolOutcome(() => handleBash(input as Record<string, unknown>, workspace, "ada")),
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const plan = async () => await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 });
  const first = await compact(options(dataDir, workspace, memoryStore, await plan(), tools, scripted([
    response("tool_use", [{ type: "tool_use", id: "write", name: "bash", input: { command: "printf pass > memory/kept.md; printf pass > memory/reverted.md" } }]),
    new Error("provider unavailable"),
  ])), { keepRecentTurns: 1 });
  expect(first.kind).toBe("paused");
  await writeFile(join(workspace, "memory/kept.md"), "outside");

  const resumed = await compact({
    ...options(dataDir, workspace, memoryStore, await plan(), tools, scripted([response("end_turn", [{ type: "text", text: "done" }])])),
    conversationMgr: { archiveAndRetain: async () => { throw new Error("archive failed"); } },
  }, { keepRecentTurns: 1 }).catch((e: unknown) => e);

  expect(resumed).toHaveProperty("message", "archive failed");
  expect(await readFile(join(workspace, "memory/kept.md"), "utf8")).toBe("outside");
  expect(await readFile(join(workspace, "memory/reverted.md"), "utf8")).toBe("original reverted");
});

test("a pass every Claude account refuses waits until the first one frees up instead of retrying sooner", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-accounts-out-"));
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  await mkdir(join(dataDir, "ada", "threads", "main"), { recursive: true });
  await mkdir(join(workspace, "memory"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  writeDurable(join(dataDir, "ada", "threads", "main", "active.jsonl"), conversation().map(activeLine).join("\n") + "\n");
  const tools: CompactionTools = {
    workspaceDir: workspace,
    turns: { workspace, repo: join(dirname(workspace), "turns.git") },
    dispatch: async () => ({ output: "ok", isError: false }),
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const freeAt = new Date(Date.now() + 3_600_000).toISOString();
  const plan = async () => await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 });
  const first = await compact(options(dataDir, workspace, memoryStore, await plan(), tools, scripted([
    response("tool_use", [{ type: "tool_use", id: "look", name: "bash", input: { command: "ls" } }]),
    Object.assign(new Error("claude_agent: usage limit reached: You've hit your session limit"), { resetAt: freeAt }),
  ])), { keepRecentTurns: 1 });
  expect(first).toMatchObject({ kind: "paused", resumeAt: freeAt });

  const early = scripted([response("end_turn", [{ type: "text", text: "done" }])]);
  const retried = await compact(options(dataDir, workspace, memoryStore, await plan(), tools, early), { keepRecentTurns: 1 });
  expect(retried).toMatchObject({ kind: "paused", resumeAt: freeAt });
  expect(early.calls).toBe(0);
});

test("compaction resumes without repeating writes and commits only after archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-resume-"));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);

  let edits = 0;
  const heads = ["before-sha", "during-sha", "after-sha"];
  const tools: CompactionTools = {
    workspaceDir: workspace,
    turns: { workspace, repo: join(dirname(workspace), "turns.git") },
    dispatch: async (name, input) => {
      if (name !== "edit") return { output: "ok", isError: false };
      edits += 1;
      const edit = input as { path: string; content: string };
      const path = join(workspace, edit.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, edit.content, "utf8");
      return { output: "written", isError: false };
    },
    ensureWorkspaceGitRepo: async () => {},
    gitHead: async () => heads.shift(),
    gitCommitAll: async () => false,
  };

  const first = await compact(
    options(
      dataDir,
      workspace,
      memoryStore,
      await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }),
      tools,
      scripted([
        response("tool_use", [
          {
            type: "tool_use",
            id: "write-1",
            name: "edit",
            input: { path: "memory/fact.md", content: "remembered\n" },
          },
        ]),
        new Error("provider unavailable"),
      ]),
    ),
    { keepRecentTurns: 1 },
  );

  expect(first.kind).toBe("paused");
  expect(edits).toBe(1);
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(activeContent);
  const checkpoint = JSON.parse(
    await readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8"),
  ) as { request: { api_key: string }; loop: { toolRounds: number }; memoryBefore?: string };
  expect(checkpoint.request.api_key).toBe("");
  expect(checkpoint.loop.toolRounds).toBe(1);
  expect(checkpoint.memoryBefore).toBe("before-sha");

  const pendingHistory = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  expect(pendingHistory.segmentCount("ada")).toBe(0);
  pendingHistory.close();

  const secondLlm = scripted([response("end_turn", [{ type: "text", text: "done" }])]);
  const second = await compact(
    options(dataDir, workspace, memoryStore, await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), tools, secondLlm),
    { keepRecentTurns: 1 },
  );

  expect(second.kind).toBe("compacted");
  expect(edits).toBe(1);
  expect(secondLlm.calls).toBe(1);
  expect(secondLlm.apiKeys).toEqual(["secret-that-must-not-land-on-disk"]);
  expect(await readFile(join(workspace, "memory/fact.md"), "utf8")).toBe("remembered\n");
  expect(await outcomeOf(readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8"))).toThrow();
  const history = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  expect(history.entries("ada")[0]).toMatchObject({
    memory_before: "before-sha",
    memory_after: "after-sha",
  });
  history.close();
});

function options(
  dataDir: string,
  workspace: string,
  memoryStore: MarkdownMemoryStore,
  plan: ArchivalPlan,
  tools: CompactionTools,
  llm: CompactionLlm,
) {
  return {
    conversationId: "ada",
    plan,
    promptTemplate: "compact",
    charName: "ada",
    userName: "user",
    llm,
    conversationMgr: conversationManager(
      join(dataDir, "ada", "threads", "main"),
      { dbPath: join(dataDir, HISTORY_DB_FILE), archiveKey: "ada" },
      () => new Date().toISOString(),
      () => crypto.randomUUID(),
    ),
    markdownStore: memoryStore,
    dryRun: false,
    chatRequest: compactionRequest(),
    dataDir,
    tools,
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

function compactionRequest(): SidecarRequest {
  return {
    sdk: "anthropic",
    provider_key: "anthropic",
    model: "claude-test",
    api_key: "secret-that-must-not-land-on-disk",
    messages: [],
    max_tokens: 100,
    replay_prior_thinking: "all",
  };
}

function response(finishReason: string, contentBlocks: GenerateResponse["content_blocks"]): GenerateResponse {
  return {
    content: "",
    content_blocks: contentBlocks,
    finish_reason: finishReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
    model: "claude-test",
  };
}

function scripted(
  turns: Array<GenerateResponse | Error>,
): CompactionLlm & { calls: number; apiKeys: string[]; requests: SidecarRequest[] } {
  let next = 0;
  return {
    run(callRequest, phase, loopOptions) {
      return toolGeneration(async (call) => this.generate(call))(callRequest, phase, undefined, loopOptions);
    },
    calls: 0,
    apiKeys: [],
    requests: [],
    buildInitialRequest(prompt: string, chat: SidecarRequest) {
      return { ...chat, api_key: "secret-that-must-not-land-on-disk", messages: [{ role: "user", content: [{ type: "text", text: prompt }], transient_tail: 1 }] };
    },
    async generate(request) {
      this.calls += 1;
      this.apiKeys.push(request.api_key);
      this.requests.push(structuredClone(request));
      const turn = turns[next++];
      if (turn instanceof Error) throw turn;
      if (turn === undefined) throw new Error("script exhausted");
      return turn;
    },
  };
}

test("a conversation rewritten after the plan was resolved pauses instead of archiving", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-rewritten-"));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activePath = join(characterDir, "threads", "main", "active.jsonl");
  writeDurable(activePath, messages.map(activeLine).join("\n") + "\n");

  const tools: CompactionTools = {
    workspaceDir: workspace,
    turns: { workspace, repo: join(dirname(workspace), "turns.git") },
    dispatch: async () => ({ output: "ok", isError: false }),
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const plan = await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 });

  writeDurable(
    activePath,
    conversation().slice(0, 2).map(activeLine).join("\n") + "\n",
  );

  const outcome = await compact(
    options(
      dataDir,
      workspace,
      memoryStore,
      plan,
      tools,
      scripted([response("end_turn", [{ type: "text", text: "done" }])]),
    ),
    { keepRecentTurns: 1 },
  );

  expect(outcome).toMatchObject({ kind: "paused", reason: "source_conflict" });
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    expect(store.segmentCount("ada")).toBe(0);
  } finally {
    store.close();
  }
});

test("turns that arrive while a pass runs are kept, not archived with the planned range", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-grown-"));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activePath = join(characterDir, "threads", "main", "active.jsonl");
  const planned = messages.map(activeLine).join("\n") + "\n";
  writeDurable(activePath, planned);

  const tools: CompactionTools = {
    workspaceDir: workspace,
    turns: { workspace, repo: join(dirname(workspace), "turns.git") },
    dispatch: async () => ({ output: "ok", isError: false }),
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const plan = await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 });

  const arrived = conversationMessage("user", "one more thing while you were busy");
  writeDurable(activePath, planned + activeLine(arrived) + "\n");

  const outcome = await compact(
    options(
      dataDir,
      workspace,
      memoryStore,
      plan,
      tools,
      scripted([response("end_turn", [{ type: "text", text: "done" }])]),
    ),
    { keepRecentTurns: 1 },
  );

  expect(outcome).toMatchObject({ kind: "compacted", compactedTurns: 1, retainedTurns: 2 });
  const kept = (await readFile(activePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { content: string }).content);
  expect(kept).toEqual([
    ...messages.slice(2).map((m) => m.content),
    "one more thing while you were busy",
  ]);
});

test("regenerating the newest reply while a pass runs still archives the planned turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-regenerated-"));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const lines = conversation().map(activeLine);
  const activePath = join(characterDir, "threads", "main", "active.jsonl");
  writeDurable(activePath, lines.join("\n") + "\n");

  const tools: CompactionTools = {
    workspaceDir: workspace,
    turns: { workspace, repo: join(dirname(workspace), "turns.git") },
    dispatch: async () => ({ output: "ok", isError: false }),
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const plan = await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 });

  const reordered = lines.slice(0, 3).map((line) => {
    const fields = JSON.parse(line) as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(Object.entries(fields).reverse()));
  });
  writeDurable(activePath, [...reordered, activeLine(conversationMessage("assistant", "a regenerated answer"))].join("\n") + "\n");

  const outcome = await compact(
    options(dataDir, workspace, memoryStore, plan, tools, scripted([response("end_turn", [{ type: "text", text: "done" }])])),
    { keepRecentTurns: 1 },
  );

  expect(outcome).toMatchObject({ kind: "compacted", compactedTurns: 1, retainedTurns: 1 });
  const kept = (await readFile(activePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { content: string }).content);
  expect(kept).toEqual(["recent question", "a regenerated answer"]);
});

describe("a pass that stopped part way", () => {
  async function world(label: string) {
    const root = await mkdtemp(join(tmpdir(), `shore-compact-${label}-`));
    const dataDir = join(root, "data");
    const characterDir = join(dataDir, "ada");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "memory"), { recursive: true });
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
    const activeContent = conversation().map(activeLine).join("\n") + "\n";
    writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);
    let edits = 0;
    const tools: CompactionTools = {
      workspaceDir: workspace,
      turns: { workspace, repo: join(dirname(workspace), "turns.git") },
      dispatch: async (name, input) => {
        if (name !== "edit") return { output: "ok", isError: false };
        edits += 1;
        const edit = input as { path: string; content: string };
        await mkdir(dirname(join(workspace, edit.path)), { recursive: true });
        await writeFile(join(workspace, edit.path), edit.content, "utf8");
        return { output: "written", isError: false };
      },
      ensureWorkspaceGitRepo: async () => {},
      gitCommitAll: async () => false,
    };
    const checkpointPath = join(characterDir, "threads", "main", "compaction-checkpoint.json");
    const active = join(characterDir, "threads", "main", "active.jsonl");
    return { dataDir, workspace, memoryStore, tools, activeContent, checkpointPath, active, edits: () => edits };
  }
  const write = response("tool_use", [{ type: "tool_use", id: "write-1", name: "edit", input: { path: "memory/fact.md", content: "remembered\n" } }]);
  const finished = response("end_turn", [{ type: "text", text: "done" }]);

  test("one that archived but stopped before clearing its checkpoint is reported done next time, without asking the model again", async () => {
    const w = await world("archived");
    const realRemove = checkpoints.removeCompactionCheckpoint;
    let stops = 1;
    const remove = spyOn(checkpoints, "removeCompactionCheckpoint").mockImplementation(async (...args) => {
      if (stops > 0) {
        stops -= 1;
        throw new Error("stopped");
      }
      await realRemove(...args);
    });
    let stopped: unknown;
    try {
      stopped = await compact(options(w.dataDir, w.workspace, w.memoryStore, await planFor(w.dataDir, "ada", "main", { keepRecentTurns: 1 }), w.tools, scripted([write, finished])), { keepRecentTurns: 1 }).catch((e: unknown) => e);
    } finally {
      remove.mockRestore();
    }
    expect(stopped).toHaveProperty("message", "stopped");
    const id = (JSON.parse(await readFile(w.checkpointPath, "utf8")) as { id: string }).id;
    const kept = await readFile(w.active, "utf8");
    writeDurable(join(w.dataDir, "ada", "threads", "main", "active.jsonl"), kept + [conversationMessage("user", "newer question"), conversationMessage("assistant", "newer answer")].map(activeLine).join("\n") + "\n");

    const quiet = scripted([]);
    const outcome = await compact(options(w.dataDir, w.workspace, w.memoryStore, await planFor(w.dataDir, "ada", "main", { keepRecentTurns: 1 }), w.tools, quiet), { keepRecentTurns: 1 });
    expect(outcome).toEqual({
      kind: "compacted",
      memoryFilesWritten: ["memory/fact.md"],
      conversationId: "ada",
      newConversationId: id,
      compactedTurns: 1,
      retainedTurns: 2,
      markdownPaths: ["memory/fact.md"],
      toolRounds: 1,
      toolsCalled: ["edit"],
    });
    expect(quiet.calls).toBe(0);
    expect(await outcomeOf(readFile(w.checkpointPath, "utf8"))).toThrow();
  });

  test("one whose archive was recorded while the conversation still holds the archived turns finishes rewriting it", async () => {
    const w = await world("recorded");
    const first = await compact(options(w.dataDir, w.workspace, w.memoryStore, await planFor(w.dataDir, "ada", "main", { keepRecentTurns: 1 }), w.tools, scripted([write, new Error("provider unavailable")])), { keepRecentTurns: 1 });
    expect(first.kind).toBe("paused");
    const id = (JSON.parse(await readFile(w.checkpointPath, "utf8")) as { id: string }).id;
    const lines = w.activeContent.trim().split("\n");
    const history = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    const segment = history.beginCompaction("ada", { file: HISTORY_DB_FILE, compacted_at: "2026-08-12T00:00:00Z", compaction_id: id }, lines.slice(0, 2).map((line) => JSON.parse(line) as Message), w.activeContent, lines.slice(2).join("\n") + "\n");
    history.finishCompaction("ada", segment);
    history.close();

    const outcome = await compact(options(w.dataDir, w.workspace, w.memoryStore, await planFor(w.dataDir, "ada", "main", { keepRecentTurns: 1 }), w.tools, scripted([finished])), { keepRecentTurns: 1 });
    expect(outcome.kind).toBe("compacted");
    expect(await readFile(w.active, "utf8")).toBe(lines.slice(2).join("\n") + "\n");
    const after = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      expect(after.segmentCount("ada")).toBe(1);
    } finally {
      after.close();
    }
  });

  test("one whose conversation was rewritten by hand, with nothing archived, starts over", async () => {
    const w = await world("rewritten");
    const first = await compact(options(w.dataDir, w.workspace, w.memoryStore, await planFor(w.dataDir, "ada", "main", { keepRecentTurns: 1 }), w.tools, scripted([write, new Error("provider unavailable")])), { keepRecentTurns: 1 });
    expect(first.kind).toBe("paused");
    writeDurable(join(w.dataDir, "ada", "threads", "main", "active.jsonl"), [conversationMessage("user", "a different start"), ...conversation().slice(1)].map(activeLine).join("\n") + "\n");
    const fresh = scripted([finished]);
    const outcome = await compact(options(w.dataDir, w.workspace, w.memoryStore, await planFor(w.dataDir, "ada", "main", { keepRecentTurns: 1 }), w.tools, fresh), { keepRecentTurns: 1 });
    expect(outcome.kind).toBe("compacted");
    expect(fresh.calls).toBe(1);
  });

  test("a pass that claimed memory versions turns the claim into coverage when it archives", async () => {
    const w = await world("covered");
    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    store.claimMemoryCoverage("ada", "compaction", ["v1"], "claim-1", "pass", Date.now(), 60_000);
    store.close();
    const outcome = await compact({ ...options(w.dataDir, w.workspace, w.memoryStore, await planFor(w.dataDir, "ada", "main", { keepRecentTurns: 1 }), w.tools, scripted([finished])), coverage: { claim: "claim-1", unit: "turn", claimed: 1, background: 0, fresh: 0 } }, { keepRecentTurns: 1 });
    expect(outcome.kind).toBe("compacted");
    const after = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      expect([...after.coveredMemoryVersions("ada", "compaction", ["v1"])]).toEqual(["v1"]);
    } finally {
      after.close();
    }
  });

  test("one restarted on purpose writes again from the start instead of resuming", async () => {
    const w = await world("restarted");
    const first = await compact(options(w.dataDir, w.workspace, w.memoryStore, await planFor(w.dataDir, "ada", "main", { keepRecentTurns: 1 }), w.tools, scripted([write, new Error("provider unavailable")])), { keepRecentTurns: 1 });
    expect(first.kind).toBe("paused");
    const abandoned = (JSON.parse(await readFile(w.checkpointPath, "utf8")) as { id: string }).id;
    const again = scripted([write, finished]);
    const outcome = await compact(options(w.dataDir, w.workspace, w.memoryStore, await planFor(w.dataDir, "ada", "main", { keepRecentTurns: 1, restart: true }), w.tools, again), { keepRecentTurns: 1 });
    expect(outcome).toMatchObject({ kind: "compacted", toolRounds: 1 });
    expect(outcome).not.toHaveProperty("newConversationId", abandoned);
    expect(w.edits()).toBe(2);
    expect(again.calls).toBe(2);
  });
});

describe("rolling back a pass whose archive failed", () => {
  async function world(label: string) {
    const root = await mkdtemp(join(tmpdir(), `shore-compact-rollback-${label}-`));
    const dataDir = join(root, "data");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "memory"), { recursive: true });
    await mkdir(join(dataDir, "ada", "threads", "main"), { recursive: true });
    const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
    writeDurable(join(dataDir, "ada", "threads", "main", "active.jsonl"), conversation().map(activeLine).join("\n") + "\n");
    const tools: CompactionTools = {
      workspaceDir: workspace,
      turns: { workspace, repo: join(dirname(workspace), "turns.git") },
      dispatch: async (name, input) => {
        if (name === "delete") {
          await unlink(join(workspace, (input as { path: string }).path));
          return { output: "deleted", isError: false };
        }
        return await renderToolOutcome(() => handleBash(input as Record<string, unknown>, workspace, "ada"));
      },
      ensureWorkspaceGitRepo: async () => {},
      gitCommitAll: async () => false,
    };
    const plan = async () => await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 });
    const failing = { archiveAndRetain: async (): Promise<string> => { throw new Error("archive failed"); } };
    return { dataDir, workspace, memoryStore, tools, plan, failing };
  }
  const call = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });

  test("deleted files and links come back, but one recreated while the pass was paused keeps its new content", async () => {
    const w = await world("deleted");
    await writeFile(join(w.workspace, "memory/a.md"), "original a");
    await writeFile(join(w.workspace, "memory/b.md"), "original b");
    await symlink("a.md", join(w.workspace, "memory/link.md"));
    const first = await compact(options(w.dataDir, w.workspace, w.memoryStore, await w.plan(), w.tools, scripted([
      response("tool_use", [call("d1", "delete", { path: "memory/a.md" }), call("d2", "delete", { path: "memory/b.md" }), call("d3", "delete", { path: "memory/link.md" })]),
      new Error("provider unavailable"),
    ])), { keepRecentTurns: 1 });
    expect(first.kind).toBe("paused");
    await writeFile(join(w.workspace, "memory/b.md"), "outside b");
    const resumed = await compact({ ...options(w.dataDir, w.workspace, w.memoryStore, await w.plan(), w.tools, scripted([response("end_turn", [])])), conversationMgr: w.failing }, { keepRecentTurns: 1 }).catch((e: unknown) => e);
    expect(resumed).toHaveProperty("message", "archive failed");
    expect(await readFile(join(w.workspace, "memory/a.md"), "utf8")).toBe("original a");
    expect(await readFile(join(w.workspace, "memory/b.md"), "utf8")).toBe("outside b");
    expect(await readlink(join(w.workspace, "memory/link.md"))).toBe("a.md");
  });

  test("an older checkpoint's recorded states are put back and the files it made are removed", async () => {
    const w = await world("legacy");
    await writeFile(join(w.workspace, "memory/old.md"), "rewritten by the pass");
    await writeFile(join(w.workspace, "memory/made.md"), "made by the pass");
    const first = await compact(options(w.dataDir, w.workspace, w.memoryStore, await w.plan(), w.tools, scripted([new Error("provider unavailable")])), { keepRecentTurns: 1 });
    expect(first.kind).toBe("paused");
    const saved = required(await checkpoints.loadCompactionCheckpoint(w.dataDir, "ada", "main"));
    saved.loop.writesApplied.push(
      { displayPath: "memory/old.md", resolvedPath: join(w.workspace, "memory/old.md"), previousState: { kind: "file", content: Buffer.from("as it was").toString("base64"), mode: 0o644 } },
      { displayPath: "memory/made.md", resolvedPath: join(w.workspace, "memory/made.md") },
    );
    await checkpoints.saveCompactionCheckpoint(w.dataDir, saved, "main");
    const resumed = await compact({ ...options(w.dataDir, w.workspace, w.memoryStore, await w.plan(), w.tools, scripted([response("end_turn", [])])), conversationMgr: w.failing }, { keepRecentTurns: 1 }).catch((e: unknown) => e);
    expect(resumed).toHaveProperty("message", "archive failed");
    expect(await readFile(join(w.workspace, "memory/old.md"), "utf8")).toBe("as it was");
    expect(await outcomeOf(readFile(join(w.workspace, "memory/made.md"), "utf8"))).toThrow();
  });

  test("files one command wrote together go back to how they were before it, and earlier files before theirs", async () => {
    const w = await world("batch");
    for (const name of ["one", "two", "three"]) await writeFile(join(w.workspace, `memory/${name}.md`), `original ${name}`);
    const failure = await compact({ ...options(w.dataDir, w.workspace, w.memoryStore, await w.plan(), w.tools, scripted([
      response("tool_use", [call("w1", "bash", { command: "printf changed > memory/one.md" })]),
      response("tool_use", [call("w2", "bash", { command: "printf changed > memory/two.md; printf changed > memory/three.md" })]),
      response("end_turn", []),
    ])), conversationMgr: w.failing }, { keepRecentTurns: 1 }).catch((e: unknown) => e);
    expect(failure).toHaveProperty("message", "archive failed");
    for (const name of ["one", "two", "three"]) expect(await readFile(join(w.workspace, `memory/${name}.md`), "utf8")).toBe(`original ${name}`);
  });
});
