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
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), activeContent, "utf8");
  const deferred: string[] = [];

  const outcome = await compact(
    options(dataDir, workspace, memoryStore, messages, activeContent, tools(workspace, deferred), scripted([
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
  expect(readFile(join(characterDir, "threads", "main", "compaction-checkpoint.json"), "utf8")).rejects.toThrow();
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
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), activeContent, "utf8");

  const outcome = await compact(
    options(dataDir, workspace, memoryStore, messages, activeContent, tools(workspace), scripted([
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
  messages: ConversationMessage[],
  activeContent: string,
  toolCtx: CompactionTools,
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
    conversationMgr: conversationManager(join(dataDir, "ada", "threads", "main")),
    markdownStore: memoryStore,
    dryRun: false,
    retainTrailingAutonomous: false,
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
    buildInitialRequest(_system: string, compactNowUser: WireMessage, chat: SidecarRequest) {
      return { ...chat, messages: [compactNowUser] };
    },
    async generate() {
      const turn = turns[next++];
      if (turn === undefined) throw new Error("script exhausted");
      return turn;
    },
  };
}
