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
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import { handleBash } from "../src/tools/bash.ts";
import { renderToolOutcome } from "../src/memory/compaction/run.ts";
import { outcomeOf } from "./support/outcome.ts";

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
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);
  const bytes = Buffer.from([0, 255, 254, 128, 10]);
  await writeFile(join(workspace, "assets/data.bin"), bytes);
  await symlink("data.bin", join(workspace, "assets/link.bin"));
  await writeFile(join(workspace, "projects/note.md"), "original context");
  const tools: CompactionTools = {
    workspaceDir: workspace,
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
});

test("compaction resumes without repeating writes and commits only after archive", async () => {
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
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);

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
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);

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
  expect(await outcomeOf(readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8"))).toThrow();
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
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);

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
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);

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
    await compact(options(dataDir, workspace, memoryStore, plan, tools, llm), {
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
  expect(await outcomeOf(readFile(checkpointFile, "utf8"))).toThrow();
});

test.each([false, true])("a checkpoint resumes over an outside edit and keeps it (archive fails: %s)", async (archiveFails) => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-outside-edit-"));
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
  const run = async (llm: CompactionLlm, failArchive = false) => {
    const base = options(
      dataDir,
      workspace,
      memoryStore,
      await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }),
      tools,
      llm,
    );
    const conversationMgr = failArchive
      ? { ...base.conversationMgr, archiveAndRetain: async () => { throw new Error("archive failed"); } }
      : base.conversationMgr;
    return await compact({ ...base, conversationMgr }, { keepRecentTurns: 1 });
  };

  const paused = await run(scripted([
    response("tool_use", [
      { type: "tool_use", id: "write-1", name: "edit", input: { path: "memory/fact.md", content: "remembered\n" } },
    ]),
    new Error("provider unavailable"),
  ]));
  expect(paused.kind).toBe("paused");

  await writeFile(join(workspace, "memory/fact.md"), "remembered, then reworded\n", "utf8");

  const resumedLlm = scripted([response("end_turn", [{ type: "text", text: "done" }])]);
  if (archiveFails) {
    expect(await outcomeOf(run(resumedLlm, true))).toThrow("archive failed");
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(activeContent);
  } else {
    expect(await run(resumedLlm)).toMatchObject({ kind: "compacted", toolRounds: 1, memoryFilesWritten: ["memory/fact.md"] });
  }
  expect(resumedLlm.calls).toBe(1);
  const notes = resumedLlm.requests[0]?.messages.at(-1)?.content.flatMap((b) => b.type === "text" ? [b.text] : []);
  expect(notes).toEqual([expect.stringContaining("memory/fact.md changed outside it")]);
  expect(await readFile(join(workspace, "memory/fact.md"), "utf8")).toBe("remembered, then reworded\n");
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
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);

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
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), editedLines);

  const freshLlm = scripted([editTurn, response("end_turn", [{ type: "text", text: "done" }])]);
  const second = await run(
    await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }),
    freshLlm,
  );

  expect(second.kind).toBe("compacted");
  expect(freshLlm.calls).toBe(2);
  expect(edits).toBe(2);
  expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).not.toBe(editedLines);
  expect(await outcomeOf(readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8"))).toThrow();
});

test.each(["model", "before_archive", "preview"])("cancellation at %s preserves a completed checkpoint for explicit resume", async (phase) => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-cancel-race-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada", "threads", "main");
  const workspace = join(root, "workspace");
  await mkdir(characterDir, { recursive: true });
  await mkdir(join(workspace, "memory"), { recursive: true });
  const memory = await MarkdownMemoryStore.open(join(workspace, "memory"));
  const content = conversation().map(activeLine).join("\n") + "\n";
  writeDurable(join(characterDir, "active.jsonl"), content);
  const controller = new AbortController();
  const llm = scripted([response("end_turn", [{ type: "text", text: "Completed memory review" }])]);
  const tools: CompactionTools = {
    workspaceDir: workspace, dispatch: async () => { throw new Error("Unexpected tool replay"); },
    ensureWorkspaceGitRepo: async () => {}, gitCommitAll: async () => false,
    gitHead: async () => { if (phase === "before_archive" && llm.calls > 0) controller.abort(); return "unchanged"; },
  };
  const plan = await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 });
  const result = await compact({
    ...options(dataDir, workspace, memory, plan, tools, { ...llm, run: async (...args) => {
      const completed = await llm.run(...args);
      if (phase === "model" || phase === "preview") controller.abort();
      return completed;
    } }), signal: controller.signal, dryRun: phase === "preview",
  }, { keepRecentTurns: 1 });
  expect(result.kind).toBe("paused");
  expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(content);
  if (phase === "preview") return;
  const resumed = scripted([]);
  const completed = await compact(options(dataDir, workspace, memory,
    await planFor(dataDir, "ada", "main", { keepRecentTurns: 1 }), tools, resumed), { keepRecentTurns: 1 });
  expect(completed.kind).toBe("compacted");
  expect(resumed.calls).toBe(0);
  expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).not.toBe(content);
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
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), activeContent);

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
  writeDurable(activePath, messages.map(activeLine).join("\n") + "\n");

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
  writeDurable(activePath, planned);

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
