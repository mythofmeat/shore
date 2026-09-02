import { required } from "../src/util/required.ts";

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { MarkdownMemoryStore } from "../src/memory/markdown_store.ts";
import { conversationManager } from "../src/memory/compaction/archive.ts";
import { compact } from "../src/memory/compaction/manager.ts";
import type {
  CompactionLlm,
  CompactionTools,
  ConversationMessage,
} from "../src/memory/compaction/types.ts";
import type { GenerateResponse, SidecarRequest, WireMessage } from "../src/llm/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test("a failed compaction resumes after its completed tool round without replaying the write", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-resume-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(characterDir, { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "active.jsonl"), activeContent, "utf8");

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
      messages,
      activeContent,
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
    ),
    { keepRecentTurns: 1 },
  );

  expect(first.kind).toBe("paused");
  expect(edits).toBe(1);
  expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(activeContent);
  const checkpoint = JSON.parse(
    await readFile(join(characterDir, "compaction-checkpoint.json"), "utf8"),
  ) as { request: { api_key: string }; loop: { toolRounds: number }; memoryBefore?: string };
  expect(checkpoint.request.api_key).toBe("");
  expect(checkpoint.loop.toolRounds).toBe(1);
  expect(checkpoint.memoryBefore).toBe("before-sha");

  const secondLlm = scripted([response("end_turn", [{ type: "text", text: "done" }])]);
  const second = await compact(
    options(dataDir, workspace, memoryStore, messages, activeContent, tools, secondLlm, true),
    { keepRecentTurns: 1 },
  );

  expect(second.kind).toBe("compacted");
  expect(edits).toBe(1);
  expect(secondLlm.calls).toBe(1);
  expect(secondLlm.apiKeys).toEqual(["secret-that-must-not-land-on-disk"]);
  expect(await readFile(join(workspace, "memory/fact.md"), "utf8")).toBe("remembered\n");
  expect(readFile(join(characterDir, "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
  const history = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  expect(history.entries("ada")[0]).toMatchObject({
    memory_before: "before-sha",
    memory_after: "after-sha",
  });
  history.close();
});

test("the tool-round ceiling pauses work in resumable slices instead of making the job incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-slices-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(characterDir, { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "active.jsonl"), activeContent, "utf8");

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
  const run = (llm: CompactionLlm) => compact({
    ...options(dataDir, workspace, memoryStore, messages, activeContent, tools, llm),
    maxToolIterations: 1,
  }, { keepRecentTurns: 1 });

  expect((await run(scripted([toolTurn("one", "memory/one.md")]))).kind).toBe("paused");
  expect((await run(scripted([toolTurn("two", "memory/two.md")]))).kind).toBe("paused");
  expect((await run(scripted([response("end_turn", [{ type: "text", text: "done" }])]))).kind)
    .toBe("compacted");

  expect(edits).toBe(2);
  expect(await readFile(join(workspace, "memory/one.md"), "utf8")).toBe("one\n");
  expect(await readFile(join(workspace, "memory/two.md"), "utf8")).toBe("two\n");
  expect(readFile(join(characterDir, "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
});

test("an explicit keep-turns count wins over the split a stale checkpoint planned", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-keep-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(characterDir, { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "active.jsonl"), activeContent, "utf8");

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
      ...options(dataDir, workspace, memoryStore, messages, activeContent, tools, scripted([
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
  const stale = JSON.parse(await readFile(join(characterDir, "compaction-checkpoint.json"), "utf8")) as {
    splitAt: number;
  };
  expect(stale.splitAt).toBe(2);

  const compacted = await compact(
    {
      ...options(dataDir, workspace, memoryStore, messages, activeContent, tools, scripted([
        response("end_turn", [{ type: "text", text: "done" }]),
      ])),
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
  expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe("");
  expect(await readFile(join(workspace, "memory/half.md"), "utf8")).toBe("half\n");
});

test("a durable archive that lost its checkpoint to a crash is recognised instead of re-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-crash-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(characterDir, { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
  const checkpointFile = join(characterDir, "compaction-checkpoint.json");

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "active.jsonl"), activeContent, "utf8");

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
  const run = (msgs: ConversationMessage[], content: string, llm: CompactionLlm) =>
    compact(options(dataDir, workspace, memoryStore, msgs, content, tools, llm, true), {
      keepRecentTurns: 1,
    });

  const paused = await run(
    messages,
    activeContent,
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
    messages,
    activeContent,
    scripted([response("end_turn", [{ type: "text", text: "done" }])]),
  );
  expect(archived.kind).toBe("compacted");
  const retainedContent = await readFile(join(characterDir, "active.jsonl"), "utf8");
  await writeFile(checkpointFile, JSON.stringify(crashed), "utf8");

  const grown = conversation();
  const grownContent = retainedContent + grown.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "active.jsonl"), grownContent, "utf8");

  const afterCrash = scripted([]);
  const resumed = await run([...messages.slice(2), ...grown], grownContent, afterCrash);

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
  await mkdir(characterDir, { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "active.jsonl"), activeContent, "utf8");

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
  const run = (llm: CompactionLlm, restart = false) =>
    compact(
      {
        ...options(dataDir, workspace, memoryStore, messages, activeContent, tools, llm),
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
  expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(activeContent);

  const restartedLlm = scripted([editTurn, response("end_turn", [{ type: "text", text: "done" }])]);
  const restarted = await run(restartedLlm, true);

  expect(restarted.kind).toBe("compacted");
  expect(restartedLlm.calls).toBe(2);
  expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).not.toBe(activeContent);
  expect(readFile(join(characterDir, "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
});

test("a checkpoint whose source was edited out from under it is discarded instead of wedging", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-compact-edited-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const characterDir = join(dataDir, "ada");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await mkdir(characterDir, { recursive: true });
  const memoryStore = await MarkdownMemoryStore.open(join(workspace, "memory"));

  const messages = conversation();
  const activeContent = messages.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "active.jsonl"), activeContent, "utf8");

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
  const run = (msgs: ConversationMessage[], content: string, llm: CompactionLlm) =>
    compact(
      options(dataDir, workspace, memoryStore, msgs, content, tools, llm),
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
    messages,
    activeContent,
    scripted([editTurn, new Error("provider unavailable")]),
  );
  expect(paused.kind).toBe("paused");

  const edited = [
    { ...required(messages[0]), content: "old question, reworded after sending" },
    ...messages.slice(1),
  ];
  const editedLines = edited.map(activeLine).join("\n") + "\n";
  await writeFile(join(characterDir, "active.jsonl"), editedLines, "utf8");

  const freshLlm = scripted([editTurn, response("end_turn", [{ type: "text", text: "done" }])]);
  const second = await run(edited, editedLines, freshLlm);

  expect(second.kind).toBe("compacted");
  expect(freshLlm.calls).toBe(2);
  expect(edits).toBe(2);
  expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).not.toBe(editedLines);
  expect(readFile(join(characterDir, "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
});

function options(
  dataDir: string,
  workspace: string,
  memoryStore: MarkdownMemoryStore,
  messages: ConversationMessage[],
  activeContent: string,
  tools: CompactionTools,
  llm: CompactionLlm,
  durable = false,
) {
  return {
    conversationId: "ada",
    messages,
    activeContent,
    systemTemplate: "system",
    promptTemplate: "compact",
    charName: "ada",
    userName: "user",
    llm,
    conversationMgr: conversationManager(
      join(dataDir, "ada"),
      () => new Date().toISOString(),
      () => crypto.randomUUID(),
      durable ? { dbPath: join(dataDir, HISTORY_DB_FILE), character: "ada" } : undefined,
    ),
    markdownStore: memoryStore,
    dryRun: false,
    retainTrailingAutonomous: false,
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
