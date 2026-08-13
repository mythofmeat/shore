import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  const tools: CompactionTools = {
    workspaceDir: workspace,
    configDir: "",
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
    ),
    { keepRecentTurns: 1 },
  );

  expect(first.kind).toBe("paused");
  expect(edits).toBe(1);
  expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(activeContent);
  const checkpoint = JSON.parse(
    await readFile(join(characterDir, "compaction-checkpoint.json"), "utf8"),
  ) as { request: { api_key: string }; loop: { toolRounds: number } };
  expect(checkpoint.request.api_key).toBe("");
  expect(checkpoint.loop.toolRounds).toBe(1);

  const secondLlm = scripted([response("end_turn", [{ type: "text", text: "done" }])]);
  const second = await compact(
    options(dataDir, workspace, memoryStore, messages, activeContent, tools, secondLlm),
    { keepRecentTurns: 1 },
  );

  expect(second.kind).toBe("compacted");
  expect(edits).toBe(1);
  expect(secondLlm.calls).toBe(1);
  expect(secondLlm.apiKeys).toEqual(["secret-that-must-not-land-on-disk"]);
  expect(await readFile(join(workspace, "memory/fact.md"), "utf8")).toBe("remembered\n");
  await expect(readFile(join(characterDir, "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
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
    configDir: "",
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
  await expect(readFile(join(characterDir, "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
});

function options(
  dataDir: string,
  workspace: string,
  memoryStore: MarkdownMemoryStore,
  messages: ConversationMessage[],
  activeContent: string,
  tools: CompactionTools,
  llm: CompactionLlm,
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
    conversationMgr: conversationManager(join(dataDir, "ada")),
    markdownStore: memoryStore,
    dryRun: false,
    retainTrailingAutonomous: false,
    chatRequest: request(),
    dataDir,
    resumable: true,
    tools,
  };
}

function conversation(): ConversationMessage[] {
  return [
    message("user", "old question"),
    message("assistant", "old answer"),
    message("user", "recent question"),
    message("assistant", "recent answer"),
  ];
}

function message(role: string, content: string): ConversationMessage {
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
