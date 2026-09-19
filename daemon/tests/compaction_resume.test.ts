import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { toolGeneration } from "./support/tool_generation.ts";
import { required } from "../src/util/required.ts";

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
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
import type { GenerateResponse, SidecarRequest, WireMessage } from "../src/llm/types.ts";
import { handleDelete, handleEdit } from "../src/tools/workspace.ts";
import { renderToolOutcome } from "../src/memory/compaction/run.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test.each([false, true])("archive failure restores workspace edits, binary files, and deleted symlinks (delegated: %s)", async (delegated) => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-workspace-rollback-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  await mkdir(join(workspace, "projects"), { recursive: true });
  await mkdir(join(workspace, "assets"));
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  const activeContent = conversation().map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), activeContent);
  const bytes = Buffer.from([0, 255, 254, 128, 10]);
  await writeFile(join(workspace, "assets/data.bin"), bytes);
  await symlink("data.bin", join(workspace, "assets/link.bin"));
  await writeFile(join(workspace, "projects/note.md"), "original context");
  const dispatch = (name: string, input: unknown) => renderToolOutcome(() => name === "delete"
      ? handleDelete(input as Record<string, unknown>, workspace, characterDir)
      : handleEdit(input as Record<string, unknown>, workspace));
  const tools: CompactionTools = {
    workspaceDir: workspace,
    dispatch: (name, input, trackNestedWrite) => {
      if (name !== "ask_research") return dispatch(name, input);
      const nested = input as { name: string; input: unknown };
      return required(trackNestedWrite)(nested.name, nested.input, () => dispatch(nested.name, nested.input));
    },
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const calls: GenerateResponse["content_blocks"] = [
    { type: "tool_use", id: "edit-note", name: "edit", input: { path: "projects/note.md", content: "new context" } },
    { type: "tool_use", id: "edit-binary", name: "edit", input: { path: "assets/data.bin", content: "replacement" } },
    { type: "tool_use", id: "delete-link", name: "delete", input: { path: "assets/link.bin" } },
    { type: "tool_use", id: "delete-binary", name: "delete", input: { path: "assets/data.bin" } },
    { type: "tool_use", id: "create", name: "edit", input: { path: "projects/new.md", content: "new file" } },
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
        expect(readFile(join(workspace, "assets/data.bin"))).rejects.toThrow();
        expect(readlink(join(workspace, "assets/link.bin"))).rejects.toThrow();
        throw new Error("archive failed");
      },
    },
  }, { keepRecentTurns: 1 }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", "archive failed");

  expect(await readFile(join(workspace, "projects/note.md"), "utf8")).toBe("original context");
  expect(await readFile(join(workspace, "assets/data.bin"))).toEqual(bytes);
  expect(await readlink(join(workspace, "assets/link.bin"))).toBe("data.bin");
  expect(readFile(join(workspace, "projects/new.md"))).rejects.toThrow();
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(activeContent);
});

test.each([false, true])("compaction resumes without repeating writes and queues retention only after archive (retain: %s)", async (retain) => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-resume-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), activeContent, "utf8");

  let edits = 0;
  const heads = ["before-sha", "during-sha", "after-sha"];
  const tools: CompactionTools = {
    workspaceDir: workspace,
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
      true,
      retain,
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
  expect(pendingHistory.nextCharacterMemoryRetainJob("ada")).toBeUndefined();
  pendingHistory.close();

  const secondLlm = scripted([response("end_turn", [{ type: "text", text: "done" }])]);
  const second = await compact(
    options(dataDir, workspace, memoryStore, await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), tools, secondLlm, true, retain),
    { keepRecentTurns: 1 },
  );

  expect(second.kind).toBe("compacted");
  expect(edits).toBe(1);
  expect(secondLlm.calls).toBe(1);
  expect(secondLlm.apiKeys).toEqual(["secret-that-must-not-land-on-disk"]);
  expect(await readFile(join(workspace, "memory/fact.md"), "utf8")).toBe("remembered\n");
  expect(readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
  const history = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  expect(history.entries("ada")[0]).toMatchObject({
    memory_before: "before-sha",
    memory_after: "after-sha",
  });
  const job = history.nextCharacterMemoryRetainJob("ada");
  if (retain) {
    expect(job?.action).toBe("retain");
    expect(job?.status).toBe("pending");
  } else {
    expect(job).toBeUndefined();
  }
  history.close();
});

test.each([false, true])("the tool-round ceiling preserves resumable slices, including a zero-cap pause (%s)", async (zeroCap) => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-slices-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), activeContent, "utf8");

  let edits = 0;
  const tools: CompactionTools = {
    workspaceDir: workspace,
    dispatch: async (_name, input) => {
      edits += 1;
      const edit = input as { path: string; content: string };
      const path = join(workspace, edit.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, edit.content, "utf8");
      return { output: "written", isError: false };
    },
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const toolTurn = (id: string, path: string) => response("tool_use", [{
    type: "tool_use",
    id,
    name: "edit",
    input: { path, content: `${id}\n` },
  }]);
  const run = async (llm: CompactionLlm, maxToolIterations = 1) => await compact({
    ...options(dataDir, workspace, memoryStore, await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), tools, llm),
    maxToolIterations,
  }, { keepRecentTurns: 1 });

  if (zeroCap) {
    expect((await run(scripted([toolTurn("one", "memory/one.md")]), 0)).kind).toBe("paused");
    const unused = scripted([]);
    expect((await run(unused, 0)).kind).toBe("paused");
    expect(unused.calls).toBe(0);
    expect(edits).toBe(0);
  }
  expect((await run(scripted([toolTurn("one", "memory/one.md")]))).kind).toBe("paused");
  expect((await run(scripted([toolTurn("two", "memory/two.md")]))).kind).toBe("paused");
  expect((await run(scripted([response("end_turn", [{ type: "text", text: "done" }])]))).kind)
    .toBe("compacted");

  expect(edits).toBe(2);
  expect(await readFile(join(workspace, "memory/one.md"), "utf8")).toBe("one\n");
  expect(await readFile(join(workspace, "memory/two.md"), "utf8")).toBe("two\n");
  expect(readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
});

test("an explicit keep-turns count wins over the split a stale checkpoint planned", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-keep-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), activeContent, "utf8");

  const tools: CompactionTools = {
    workspaceDir: workspace,
    dispatch: async (_name, input) => {
      const edit = input as { path: string; content: string };
      const path = join(workspace, edit.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, edit.content, "utf8");
      return { output: "written", isError: false };
    },
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };

  const paused = await compact(
    {
      ...options(dataDir, workspace, memoryStore, await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), tools, scripted([
        response("tool_use", [
          {
            type: "tool_use",
            id: "write-1",
            name: "edit",
            input: { path: "memory/half.md", content: "half\n" },
          },
        ]),
      ])),
      maxToolIterations: 1,
    },
    { keepRecentTurns: 1 },
  );
  expect(paused.kind).toBe("paused");
  const stale = JSON.parse(await readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8")) as {
    splitAt: number;
  };
  expect(stale.splitAt).toBe(2);

  const compacted = await compact(
    {
      ...options(
        dataDir,
        workspace,
        memoryStore,
        await planFor(dataDir, "ada", "main", { keepRecentTurns: 1, keepTurnsOverride: 0 }),
        tools,
        scripted([response("end_turn", [{ type: "text", text: "done" }])]),
      ),
      keepTurnsOverride: 0,
    },
    { keepRecentTurns: 1 },
  );

  expect(compacted).toMatchObject({
    kind: "compacted",
    messageCount: 4,
    compactedTurns: 2,
    retainedCount: 0,
    retainedTurns: 0,
  });
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe("");
  expect(await readFile(join(workspace, "memory/half.md"), "utf8")).toBe("half\n");
});

test("a durable archive that lost its checkpoint to a crash is recognised instead of re-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-crash-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  const checkpointFile = join(characterDir, "threads", "main", "compaction-checkpoint.json");

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), activeContent, "utf8");

  const tools: CompactionTools = {
    workspaceDir: workspace,
    dispatch: async (_name, input) => {
      const edit = input as { path: string; content: string };
      const path = join(workspace, edit.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, edit.content, "utf8");
      return { output: "written", isError: false };
    },
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const run = async (plan: ArchivalPlan, llm: CompactionLlm) =>
    await compact(options(dataDir, workspace, memoryStore, plan, tools, llm, true), {
      keepRecentTurns: 1,
    });

  const paused = await run(
    await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }),
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
  );
  expect(paused.kind).toBe("paused");
  const crashed = JSON.parse(await readFile(checkpointFile, "utf8")) as Record<string, unknown>;
  crashed.state = "running";
  delete crashed.pauseReason;

  const archived = await run(
    await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }),
    scripted([response("end_turn", [{ type: "text", text: "done" }])]),
  );
  expect(archived.kind).toBe("compacted");
  const retainedContent = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");
  writeDurable(checkpointFile, JSON.stringify(crashed));

  const grown = conversation();
  const grownContent = retainedContent + grown.map(activeLine).join("\n") + "\n";
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), grownContent);

  const afterCrash = scripted([]);
  const resumed = await run(await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), afterCrash);

  expect(resumed.kind).toBe("compacted");
  expect(afterCrash.calls).toBe(0);
  expect(readFile(checkpointFile, "utf8")).rejects.toThrow();
});

test("a checkpoint the workspace has moved past stays wedged until a restart throws it away", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-wedged-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), activeContent, "utf8");

  const tools: CompactionTools = {
    workspaceDir: workspace,
    dispatch: async (_name, input) => {
      const edit = input as { path: string; content: string };
      const path = join(workspace, edit.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, edit.content, "utf8");
      return { output: "written", isError: false };
    },
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const editTurn = response("tool_use", [
    {
      type: "tool_use",
      id: "write-1",
      name: "edit",
      input: { path: "memory/fact.md", content: "remembered\n" },
    },
  ]);
  const run = async (llm: CompactionLlm, restart = false) =>
    await compact(
      {
        ...options(
          dataDir,
          workspace,
          memoryStore,
          await planFor(dataDir, "ada", "main", { keepRecentTurns: 1, restart }),
          tools,
          llm,
        ),
        restart,
      },
      { keepRecentTurns: 1 },
    );

  const paused = await run(
    scripted([editTurn, new Error("429 Monthly usage limit reached. Resets in 10 days.")]),
  );
  expect(paused.kind).toBe("paused");

  await writeFile(join(workspace, "memory/fact.md"), "remembered, then reworded\n", "utf8");

  const wedgedLlm = scripted([]);
  const wedged = await run(wedgedLlm);
  expect(wedged).toMatchObject({
    kind: "paused",
    reason: "workspace_conflict",
    detail: "memory/fact.md",
  });
  expect(wedgedLlm.calls).toBe(0);
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(activeContent);

  const restartedLlm = scripted([editTurn, response("end_turn", [{ type: "text", text: "done" }])]);
  const restarted = await run(restartedLlm, true);

  expect(restarted.kind).toBe("compacted");
  expect(restarted).toMatchObject({ messageCount: 2, retainedCount: 2, retainedTurns: 1 });
  expect(restartedLlm.calls).toBe(2);
  const kept = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");
  expect(kept).not.toBe(activeContent);
  expect(
    kept
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { content: string }).content),
  ).toEqual(messages.slice(2).map((m) => m.content));
  expect(readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
});

test("a checkpoint whose source was edited out from under it is discarded instead of wedging", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-edited-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), activeContent, "utf8");

  let edits = 0;
  const tools: CompactionTools = {
    workspaceDir: workspace,
    dispatch: async (_name, input) => {
      edits += 1;
      const edit = input as { path: string; content: string };
      const path = join(workspace, edit.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, edit.content, "utf8");
      return { output: "written", isError: false };
    },
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };
  const run = async (plan: ArchivalPlan, llm: CompactionLlm) =>
    await compact(
      options(dataDir, workspace, memoryStore, plan, tools, llm),
      { keepRecentTurns: 1 },
    );

  const editTurn = response("tool_use", [
    {
      type: "tool_use",
      id: "write-1",
      name: "edit",
      input: { path: "memory/fact.md", content: "remembered\n" },
    },
  ]);
  const paused = await run(
    await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }),
    scripted([editTurn, new Error("provider unavailable")]),
  );
  expect(paused.kind).toBe("paused");

  const edited = [
    { ...required(messages[0]), content: "old question, reworded after sending" },
    ...messages.slice(1),
  ];
  const editedLines = edited.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), editedLines, "utf8");

  const freshLlm = scripted([editTurn, response("end_turn", [{ type: "text", text: "done" }])]);
  const second = await run(
    await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }),
    freshLlm,
  );

  expect(second.kind).toBe("compacted");
  expect(freshLlm.calls).toBe(2);
  expect(edits).toBe(2);
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).not.toBe(editedLines);
  expect(readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
});

function options(
  dataDir: string,
  workspace: string,
  memoryStore: MarkdownMemoryStore,
  plan: ArchivalPlan,
  tools: CompactionTools,
  llm: CompactionLlm,
  durable = false,
  retain = false,
) {
  return {
    conversationId: "ada",
    plan,
    rulesTemplate: "system",
    promptTemplate: "compact",
    charName: "ada",
    userName: "user",
    llm,
    conversationMgr: conversationManager(
      join(dataDir, "ada", "threads", "main"),
      () => new Date().toISOString(),
      () => crypto.randomUUID(),
      durable ? { dbPath: join(dataDir, HISTORY_DB_FILE), archiveKey: "ada", retain } : undefined,
    ),
    markdownStore: memoryStore,
    dryRun: false,
    chatRequest: compactionRequest(),
    dataDir,
    resumable: true,
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
): CompactionLlm & { calls: number; apiKeys: string[] } {
  let next = 0;
  return {
    run(callRequest, phase, loopOptions) {
      return toolGeneration(async (call) => this.generate(call))(callRequest, phase, undefined, loopOptions);
    },
    calls: 0,
    apiKeys: [],
    buildInitialRequest(_system: string, compactNowUser: WireMessage, chat: SidecarRequest) {
      return { ...chat, api_key: "secret-that-must-not-land-on-disk", messages: [compactNowUser] };
    },
    async generate(request) {
      this.calls += 1;
      this.apiKeys.push(request.api_key);
      const turn = turns[next++];
      if (turn instanceof Error) throw turn;
      if (turn === undefined) throw new Error("script exhausted");
      return turn;
    },
  };
}

test("an archived operation whose turns are still live is not mistaken for a finished pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-live-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), activeContent, "utf8");

  const tools: CompactionTools = {
    workspaceDir: workspace,
    dispatch: async () => ({ output: "ok", isError: false }),
    ensureWorkspaceGitRepo: async () => {},
    gitCommitAll: async () => false,
  };

  const paused = await compact(
    options(
      dataDir,
      workspace,
      memoryStore,
      await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }),
      tools,
      scripted([new Error("provider unavailable")]),
      true,
    ),
    { keepRecentTurns: 1 },
  );
  expect(paused.kind).toBe("paused");

  const checkpoint = JSON.parse(
    await readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8"),
  ) as { id: string };

  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    const idx = store.beginCompaction(
      "ada",
      {
        file: HISTORY_DB_FILE,
        message_count: 2,
        compacted_at: "2026-08-12T00:00:00Z",
        compaction_id: checkpoint.id,
      },
      [],
      "before",
      "after",
    );
    store.finishCompaction("ada", idx);
  } finally {
    store.close();
  }

  const secondLlm = scripted([response("end_turn", [{ type: "text", text: "done" }])]);
  const second = await compact(
    options(
      dataDir,
      workspace,
      memoryStore,
      await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }),
      tools,
      secondLlm,
      true,
    ),
    { keepRecentTurns: 1 },
  );

  expect(second.kind).toBe("compacted");
  expect(secondLlm.calls).toBe(1);
});

test("a conversation rewritten after the plan was resolved pauses instead of archiving", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-rewritten-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activePath = join(characterDir, "threads", "main", "active.jsonl");
  await writeFile(activePath, messages.map(activeLine).join("\n") + "\n", "utf8");

  const tools: CompactionTools = {
    workspaceDir: workspace,
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
      true,
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
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activePath = join(characterDir, "threads", "main", "active.jsonl");
  const planned = messages.map(activeLine).join("\n") + "\n";
  await writeFile(activePath, planned, "utf8");

  const tools: CompactionTools = {
    workspaceDir: workspace,
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
      true,
    ),
    { keepRecentTurns: 1 },
  );

  expect(outcome).toMatchObject({ kind: "compacted", messageCount: 2, retainedCount: 3 });
  const kept = (await readFile(activePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { content: string }).content);
  expect(kept).toEqual([
    ...messages.slice(2).map((m) => m.content),
    "one more thing while you were busy",
  ]);
});
