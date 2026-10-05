import { writeDurable } from "../src/storage/files.ts";
import { handleBash } from "../src/tools/bash.ts";
import { formatToolOutput } from "../src/tools/output.ts";
import { snapshotWorkspace } from "../src/tools/workspace_snapshot.ts";
import { readFile } from "./support/stored_files.ts";
import { toolGeneration } from "./support/tool_generation.ts";
import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import fixture from "./memory_captures/compaction.json";

import { pushAssistantTurn, pushInlineSystem } from "../src/llm/request";
import { appendCompactionTail } from "../src/memory/compaction/llm.ts";
import type { GenerateResponse, SidecarRequest, WireMessage } from "../src/llm/types";
import { MarkdownMemoryStore } from "../src/memory/markdown_store";
import {
  handleCompactionOutcome,
  loadMessagesForCompaction,
  pushAfterCompaction,
} from "../src/memory/compaction/background";
import {
  DEFAULT_COMPACT_PROMPT,
  stripOneTrailingNewline,
} from "../src/memory/compaction/prompts";
import {
  archiveSplitIndex,
  buildFinalMessage,
  compact,
  countTurns,
  findTurnSplit,
  trailingAutonomousLen,
  tryBeginCompaction,
} from "../src/memory/compaction/manager";
import type {
  CompactionLlm,
  CompactionOutcome,
  CompactionTools,
  ConversationManager,
  ConversationMessage,
  ToolOutput,
} from "../src/memory/compaction/types";
import {
  normalizeProtectedPath,
  normalizePromptVisiblePath,
  normalizeWorkspacePath,
  pathComponents,
  resolvePath,
  resolveRoots,
} from "../src/tools/workspace_path";
import { queueDeferredEdit } from "../src/memory/deferred_edits";
import type { Message } from "../src/engine/types.ts";
import { estimateMessageTokens } from "../src/engine/prompt.ts";
import { jsonlOf, maybePlanOf } from "./support/archival_plan.ts";
import { CompactionError } from "../src/memory/compaction/types";

type Json = Record<string, unknown>;
const fx = fixture as unknown as Record<string, Json[] | string>;
const section = (name: string): Json[] => fx[name] as Json[];

const WORKSPACE_PATHS: string[] = [
    "MEMORY.md",
    "./MEMORY.md",
    "././MEMORY.md",
    "././memory/a.md",
    ".\\memory\\a.md",
    "./memory\\a.md",
    "memory.md",
    "MeMoRy.Md",
    "workspace/MEMORY.md",
    "/MEMORY.md",
    "memory/daily/2026-03-25.md",
    "memory/preferences/tea.md",
    "memory/a.md",
    "memory/",
    "memory",
    "memory/.dreams/x.md",
    "memory/.DREAMS/x.md",
    "memory/dreaming/x.md",
    "memory/DREAMING/x.md",
    "memory/dreams.md",
    "memory/DREAMS.md",
    "memory/dreams",
    "memory/dreams/",
    "memory/dreams/x.md",
    "memory/dreamsx.md",
    "SOUL.md",
    "USER.md",
    "AGENTS.md",
    "TOOLS.md",
    "soul.md",
    "workspace/SOUL.md",
    "workspace/./SOUL.md",
    "./workspace/SOUL.md",
    "./USER.md",
    "HEARTBEAT.md",
    "RECENT_MEMORY.md",
    "DREAMS.md",
    "notes.md",
    "topics/foo.md",
    "memory/../../SOUL.md",
    "memory/../USER.md",
    "../SOUL.md",
    "memory/sub/../../escape.md",
    "memory\\..\\..\\SOUL.md",
    "memory\\daily\\a.md",
    ".\\SOUL.md",
    "/etc/passwd",
    "/SOUL.md",
    "",
    "   ",
    "  MEMORY.md  ",
    "\tmemory/a.md\n",
    "\uFEFFMEMORY.md",
    "\u0085MEMORY.md",
    "\u00A0MEMORY.md",
    "MEMORY.md\u0085",
    "memory//a.md",
    "memory/./a.md",
    "memory/a/../b.md",
    "./memory/a.md",
    "memory/日記/a.md",
  ];

const PROTECTED_FILES = ["SOUL.md", "USER.md", "TOOLS.md"];
const PROMPT_VISIBLE_FILES = [...PROTECTED_FILES, "MEMORY.md"];

describe("what counts as a path inside the workspace", () => {
  for (const path of WORKSPACE_PATHS) {
    test(JSON.stringify(path), () => {
      const normalized = normalizeWorkspacePath(path);
      expect(normalized.includes("\\"), "a normalized path uses one separator").toBe(false);
      expect(normalized.startsWith("/"), "and does not start at the filesystem root").toBe(false);
      expect(normalized.startsWith("./"), "and does not start with a needless dot").toBe(false);
      expect(normalized.startsWith("workspace/"), "and is relative to the workspace, not inside it").toBe(
        false,
      );
      expect(normalizeWorkspacePath(normalized), "normalizing twice changes nothing").toBe(normalized);

      expect(normalizeProtectedPath(path), "the protected files are named, and only those").toBe(
        PROTECTED_FILES.includes(normalized) ? normalized : undefined,
      );
      expect(
        normalizePromptVisiblePath(path),
        "the prompt shows the protected files and the memory index",
      ).toBe(PROMPT_VISIBLE_FILES.includes(normalized) ? normalized : undefined);
    });
  }
});

describe("resolving a path against the workspace root", () => {
  for (const path of WORKSPACE_PATHS) {
    test(JSON.stringify(path), () => {
      let resolved: string | undefined;
      let refusal: string | undefined;
      try {
        resolved = resolvePath("/ws", path);
      } catch (e) {
        refusal = (e as Error).message;
      }

      const [, stripped] = (() => {
        try {
          return resolveRoots("/ws", path);
        } catch {
          return ["", ""];
        }
      })();
      const components = pathComponents(stripped);
      const traversal = components.includes("..");
      const absolute = components.includes("/");
      const empty = stripped === "";

      if (refusal !== undefined) {
        expect(
          [
            "invalid args: path is empty",
            "invalid args: path traversal (..) is not allowed",
            "invalid args: absolute paths are not allowed",
          ],
          `${JSON.stringify(path)}: a refusal says which rule it broke`,
        ).toContain(refusal);
        if (refusal.includes("traversal")) expect(traversal, "and .. really is in it").toBe(true);
        if (refusal.includes("absolute")) expect(absolute, "and it really is absolute").toBe(true);
        if (refusal.includes("empty")) expect(empty, "and it really names nothing").toBe(true);
        return;
      }

      expect(
        [traversal, absolute, empty],
        "a path that resolves has no .., is not absolute, and names something",
      ).toEqual([false, false, false]);
      expect(
        pathComponents(required(resolved)),
        "and names exactly the normalized path, under the workspace root",
      ).toEqual(["/", "ws", ...pathComponents(normalizeWorkspacePath(path))]);
    });
  }
});

describe("prompt rendering", () => {
  test("buildFinalMessage", () => {
    for (const rec of section("build_final_message")) {
      expect(
        buildFinalMessage(rec.template as string, rec.char as string, rec.user as string),
      ).toBe(rec.out as string);
    }
  });

  test("a stray closer before the opener terminates, where the Rust hung", () => {
    expect(buildFinalMessage("{{/if}} stray closer only", "C", "U")).toBe(
      "{{/if}} stray closer only",
    );
    expect(buildFinalMessage("{{/if}}A{{#if recap}}B{{/if}}C", "C", "U")).toBe("{{/if}}AC");
  });
});

describe("where a conversation is cut in two", () => {
  const at = (role: string, content: string): ConversationMessage => ({
    role,
    content,
    timestamp: "2026-03-25T10:00:00Z",
    isToolResultOnly: false,
    isAutonomous: false,
  });
  const u = (content: string) => at("user", content);
  const a = (content: string) => at("assistant", content);
  const toolResult = (content: string) => ({ ...u(content), isToolResultOnly: true });
  const auto = (msg: ConversationMessage) => ({ ...msg, isAutonomous: true });

  const SHAPES: Record<string, ConversationMessage[]> = {
    empty: [],
    alternating_6: [
      u("Message 0"),
      a("Message 1"),
      u("Message 2"),
      a("Message 3"),
      u("Message 4"),
      a("Message 5"),
    ],
    alternating_1: [u("Message 0")],
    tool_loop: [
      u("real one"),
      a("reply"),
      u("real two"),
      a(""),
      toolResult("tool output"),
      a("final"),
      u("real three"),
      a("reply"),
    ],
    all_tool_results: [toolResult("a"), toolResult("b"), toolResult("c")],
    autonomous_tail: [
      u("hi"),
      a("hello"),
      u("more"),
      a("sure"),
      auto(a("still there?")),
      auto(a("checking in")),
    ],
    autonomous_user_tail: [u("hi"), a("hello"), auto(u("autonomous but a user"))],
    only_autonomous: [auto(a("a")), auto(a("b"))],
    autonomous_then_user: [u("hi"), auto(a("nudge")), u("back"), a("hey")],
    assistant_whitespace_content: [u("a"), a(" "), u("b")],
    system_role: [at("system", "sys"), u("a"), a("b")],
  };

  const typed = (messages: ConversationMessage[]): number =>
    messages.filter((m) => m.role === "user" && !m.isToolResultOnly).length;

  for (const [name, messages] of Object.entries(SHAPES)) {
    for (const keep of [0, 1, 2, 3, 5, 10]) {
      for (const retain of [false, true]) {
        test(`${name} keep=${keep} retain=${retain}`, () => {
          expect(countTurns(messages), "a turn is a message the user typed").toBe(typed(messages));

          const tail = trailingAutonomousLen(messages);
          expect(
            messages.slice(messages.length - tail).every((m) => m.role === "assistant" && m.isAutonomous),
            "the tail is all messages the character sent unprompted",
          ).toBe(true);
          const beforeTail = messages[messages.length - tail - 1];
          if (beforeTail !== undefined) {
            expect(
              beforeTail.role === "assistant" && beforeTail.isAutonomous,
              "and reaches back as far as it can",
            ).toBe(false);
          }

          const split = findTurnSplit(messages, keep);
          expect(split >= 0 && split <= messages.length, "the split is inside the conversation").toBe(
            true,
          );
          if (keep === 0) {
            expect(split, "keeping no turns keeps nothing").toBe(messages.length);
          } else {
            expect(
              typed(messages.slice(split)),
              "what is kept is that many turns, or the whole conversation",
            ).toBe(Math.min(keep, typed(messages)));
            if (split > 0) {
              expect(
                required(messages[split]).role === "user" &&
                  !required(messages[split]).isToolResultOnly,
                "and starts at a turn rather than mid-exchange",
              ).toBe(true);
            }
          }

          const archived = archiveSplitIndex(messages, keep, retain);
          if (!retain) {
            expect(archived, "with nothing retained the split stands").toBe(split);
            return;
          }
          expect(archived <= split, "retaining never archives more than the split would").toBe(true);
          expect(
            archived + tail <= messages.length,
            "and never archives something the character said unprompted",
          ).toBe(true);
          expect(
            archived === split || archived === messages.length - tail,
            "and gives up only as much as it must",
          ).toBe(true);
        });
      }
    }
  }
});

describe("the single-flight guard", () => {
  test("one pass per character per data root", () => {
    const held: Array<{ release(): void } | undefined> = [];
    const acquire = (dir: string, char: string) => {
      const g = tryBeginCompaction(dir, char);
      held.push(g);
      return g !== undefined;
    };

    expect(acquire("/guard-data-a", "Aria"), "the first pass gets the lock").toBe(true);
    expect(acquire("/guard-data-a", "Aria"), "a second pass for the same character does not").toBe(false);
    expect(acquire("/guard-data-a", "Other"), "another character is unaffected").toBe(true);
    expect(acquire("/guard-data-b", "Aria"), "and so is the same character elsewhere").toBe(true);
    held[0]?.release();
    expect(acquire("/guard-data-a", "Aria"), "releasing lets the next pass in").toBe(true);

    for (const g of held) g?.release();
  });
});

describe("appending turns", () => {
  for (const [i, rec] of section("push_turns").entries()) {
    test(`${rec.name as string} provider=${String(rec.provider_key)} [${i}]`, () => {
      const req = chatRequest(twoMessages());
      const provider = rec.provider_key as string | null;
      if (provider === null) delete req.provider_key;
      else req.provider_key = provider;
      if (rec.name === "push_inline_system") {
        pushInlineSystem(req, "be brief");
      } else {
        pushAssistantTurn(req, responseFor(rec.name as string));
      }
      expect(normalizeMessages(req.messages)).toEqual(
        normalizeMessages(rec.messages as WireMessage[]),
      );
    });
  }
});

describe("the prompt templates", () => {
  test("import as text with exactly one trailing newline removed", () => {
    expect(DEFAULT_COMPACT_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_COMPACT_PROMPT.endsWith("\n")).toBe(false);
  });

  test("stripping takes one trailing newline, not the run", () => {
    expect(stripOneTrailingNewline("a\n\n")).toBe("a\n");
    expect(stripOneTrailingNewline("a\n")).toBe("a");
    expect(stripOneTrailingNewline("a")).toBe("a");
    expect(stripOneTrailingNewline("")).toBe("");
  });
});

describe("loading a conversation", () => {
  test("flattens stored messages into what the split logic reads", async () => {
    const rec = fx.load_messages as unknown as Record<string, unknown>;
    const root = await mkdtemp(join(tmpdir(), "shore-compaction-load-"));
    try {
      await mkdir(join(root, "Aria", "threads", "main"), { recursive: true });
      writeDurable(join(root, "Aria", "threads", "main", "active.jsonl"), rec.active_jsonl as string);
      const loaded = await loadMessagesForCompaction(root, "Aria", "main");
      expect(loaded.rawContent).toBe(rec.raw_content as string);
      expect(loaded.messages.map(({ tokens: _, ...flat }) => flat)).toEqual(
        (rec.messages as Json[]).map(toConversationMessage),
      );
      expect(loaded.messages.map((m) => m.tokens)).toEqual(
        loaded.store.messages().map((m) => estimateMessageTokens(m)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("reporting an outcome", () => {
  for (const rec of section("outcome_mapping")) {
    test(rec.name as string, () => {
      const notifications: Json[] = [];
      const outcome = camelOutcome(rec.outcome as Json);
      const retained = handleCompactionOutcome("Aria", (title, body) => {
        notifications.push({ title, body, retained: 0 });
      }, outcome);
      expect(retained).toEqual(outcome.kind === "compacted" || (outcome.kind === "rotated" && !outcome.dryRun)
        ? { kind: "completed", retained: rec.retained as number }
        : { kind: "skipped", reason: outcome.kind });
      const expected = (rec.notifications as Json[]).map((n) => ({
        title: n.title,
        body: n.body,
        retained: 0,
      }));
      expect(notifications).toEqual(expected);
    });
  }

  test("the post-compaction push fires only for a compacted outcome", async () => {
    for (const rec of section("outcome_mapping")) {
      const outcome = camelOutcome(rec.outcome as Json);
      for (const enabled of [true, false]) {
        let pushed = false;
        await pushAfterCompaction(enabled, outcome, async () => {
          pushed = true;
        });
        expect(pushed).toBe(enabled && outcome.kind === "compacted");
      }
    }
  });
});

const coverage = { dispatched: 0, rolledBack: 0, blocked: 0, dryRun: 0 };

test.each([0, 7])("archive failure restores Bash changes, even after command exit %s", async (exitCode) => {
  const root = await mkdtemp(join(tmpdir(), "shore-bash-rollback-"));
  const workspace = join(root, "workspace");
  try {
    await mkdir(join(workspace, "directory"), { recursive: true });
    await writeFile(join(root, "outside"), "outside remains untouched");
    await writeFile(join(workspace, "directory/note"), "original nested file");
    await writeFile(join(workspace, "file"), "original flat file");
    await writeFile(join(workspace, "MEMORY.md"), "original memory");
    await writeFile(join(workspace, "binary"), Buffer.from([0, 255, 128, 42]));
    await symlink("../outside", join(workspace, "link"));
    const markdownStore = await MarkdownMemoryStore.open(join(workspace, "memory"));
    const before = await snapshotWorkspace(workspace);
    const bashTurn: GenerateResponse = {
      ...responseFor("blocks"),
      content_blocks: [{ type: "tool_use", id: "shell", name: "bash", input: { command: `
printf changed > MEMORY.md
printf changed > binary
chmod 700 binary
rm -r directory
printf replacement > directory
rm file link
mkdir file new-directory
printf new > file/child
printf new > new-directory/child
ln -s MEMORY.md link
exit ${exitCode}` } }],
    };
    const llm = new ScriptedLlm([bashTurn, responseFor("text_only")]);
    const messages = twoMessages();
    const tools: CompactionTools = {
      workspaceDir: workspace,
      ensureWorkspaceGitRepo: async () => {},
      gitCommitAll: async () => false,
      dispatch: async (name, input) => {
        const value = await handleBash(input as Record<string, unknown>, workspace, "Aria");
        return { output: formatToolOutput(name, value), isError: value.exit_code !== 0 };
      },
    };
    const plan = required(maybePlanOf(messages.map((message, index) => toPlanMessage({
      ...message, is_tool_result_only: false, is_autonomous: false,
    }, index)), { keepRecentTurns: 0 }));
    let failure: unknown;
    try {
      await compact({
        conversationId: "bash-archive", plan, charName: "Aria", userName: "Tom",
        promptTemplate: "Compact", llm,
        conversationMgr: new RecordingMgr("next", true), dryRun: false,
        chatRequest: chatRequest(messages), tools, markdownStore,
      }, { keepRecentTurns: 0 });
    } catch (error) { failure = error; }
    expect(String(failure)).toContain("simulated archive failure");
    expect(await snapshotWorkspace(workspace)).toEqual(before);
    expect(await readFile(join(root, "outside"), "utf8")).toBe("outside remains untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

describe("compaction passes", () => {
  for (const pass of section("passes")) {
    test(pass.name as string, async () => {
      await runPass(pass);
    });
  }
});

test("the passes cover dispatch, blocked tools, rejections and rollback", () => {
  expect(coverage.dispatched, "passes that ran at least one tool").toBeGreaterThan(10);
  expect(coverage.rolledBack, "passes whose archive failed after tools had run").toBeGreaterThan(0);
  expect(coverage.blocked, "passes where a tool the model asked for never ran").toBeGreaterThan(2);
  expect(coverage.dryRun, "passes that previewed instead of writing").toBeGreaterThan(0);
});

function toConversationMessage(m: Json): ConversationMessage {
  return {
    role: m.role as string,
    content: m.content as string,
    timestamp: m.timestamp as string,
    isToolResultOnly: m.is_tool_result_only as boolean,
    isAutonomous: m.is_autonomous as boolean,
  };
}

function toPlanMessage(m: Json, index: number): Message {
  const content = m.content as string;
  const toolResultOnly = m.is_tool_result_only === true;
  return {
    msg_id: `m_${String(index)}`,
    role: m.role as Message["role"],
    content,
    images: [],
    content_blocks: toolResultOnly
      ? [{ type: "tool_result", tool_use_id: `t_${String(index)}`, content }]
      : [{ type: "text", text: content }],
    timestamp: m.timestamp as string,
    ...(m.is_autonomous === true ? { origin: "autonomous" as const } : {}),
  };
}

function twoMessages(): ConversationMessage[] {
  return [0, 1].map((i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i}`,
    timestamp: "2026-03-25T10:00:00Z",
    isToolResultOnly: false,
    isAutonomous: false,
  }));
}

function chatRequest(messages: ConversationMessage[]): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "mock-chat-model",
    api_key: "",
    messages: messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: [{ type: "text", text: m.content }],
    })),
    system: [{ text: "mock chat system", label: "system" }],
    tools: [],
    max_tokens: 1024,
    replay_prior_thinking: "all",
    provider_key: "mockprov",
  };
}

function responseFor(name: string): GenerateResponse {
  const base = { usage: emptyUsage(), timing: { total_ms: 0, time_to_first_token_ms: 0 }, model: "mock" };
  switch (name) {
    case "blocks":
      return {
        ...base,
        content: "",
        content_blocks: [
          { type: "tool_use", id: "call_0", name: "edit", input: { path: "memory/a.md", content: "x" } },
        ],
        finish_reason: "tool_use",
      };
    case "text_only":
      return { ...base, content: "hello", content_blocks: [{ type: "text", text: "hello" }], finish_reason: "end_turn" };
    case "empty":
      return { ...base, content: "", content_blocks: [], finish_reason: "end_turn" };
    case "whitespace_text":
      return { ...base, content: "   \n\t ", content_blocks: [], finish_reason: "end_turn" };
    case "unicode_space_text":
      return { ...base, content: "\u0085\u00A0", content_blocks: [], finish_reason: "end_turn" };
    case "bom_text":
      return { ...base, content: "﻿", content_blocks: [], finish_reason: "end_turn" };
    default:
      throw new Error(`unknown push_turns case ${name}`);
  }
}

const emptyUsage = () => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
});

const READ_FAILED = /^(\w+) failed to read existing file: .*$/;

function normalizeMessageValue(key: string, value: unknown): unknown {
  if (key === "is_error" && value === false) return undefined;
  if (typeof value === "string") {
    const match = READ_FAILED.exec(value);
    if (match !== null) return `${match[1]} failed to read existing file: <io error>`;
  }
  return value;
}

function normalizeMessages(messages: readonly WireMessage[]): unknown {
  const normalized: unknown = JSON.parse(JSON.stringify(messages, normalizeMessageValue));
  return normalized;
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out[relative(root, path)] = await readFile(path, "utf8");
    }
  };
  await walk(root);
  return out;
}

class ScriptedLlm implements CompactionLlm {
  run: CompactionLlm["run"] = (request, phase, options) => toolGeneration(async () => this.generate())(request, phase, undefined, options);
  built: Json | undefined;
  request: SidecarRequest | undefined;
  readonly served: GenerateResponse[] = [];
  readonly #responses: GenerateResponse[];

  constructor(responses: GenerateResponse[]) {
    this.#responses = [...responses];
  }

  buildInitialRequest(
    prompt: string,
    chatRequest_: SidecarRequest,
  ): SidecarRequest {
    this.built = {
      chat_prefix_len: chatRequest_.messages.length,
      built_message_count: chatRequest_.messages.length + 1,
      compact_now_text: prompt,
    };
    const request: SidecarRequest = {
      ...chatRequest_,
      messages: [...chatRequest_.messages],
    };
    appendCompactionTail(request, prompt);
    this.request = request;
    return request;
  }

  async generate(): Promise<GenerateResponse> {
    const next = this.#responses.shift();
    if (next === undefined) throw new Error("llm: scripted LLM exhausted");
    this.served.push(next);
    return next;
  }
}

class RecordingMgr implements ConversationManager {
  readonly calls: Json[] = [];

  constructor(
    private readonly nextId: string,
    private readonly fail: boolean,
  ) {}

  async archiveAndRetain(
    conversationId: string,
    params: { keepLastN: number; activeContent: string },
  ): Promise<string> {
    this.calls.push({
      conversation_id: conversationId,
      keep_last_n: params.keepLastN,
      active_content: params.activeContent,
    });
    if (this.fail) throw new Error("conversation: simulated archive failure");
    return this.nextId;
  }
}

class ReplayTools implements CompactionTools {
  readonly gitCalls: Json[] = [];
  readonly seen: Json[] = [];
  #next = 0;

  constructor(
    readonly workspaceDir: string,
    private readonly characterDataDir: string,
    private readonly records: Json[],
  ) {}

  async deferEdit(path: string): Promise<void> {
    await queueDeferredEdit(this.characterDataDir, path);
  }

  async dispatch(name: string, input: unknown): Promise<ToolOutput> {
    if (name === "edit") {
      const legacy = input as { path?: unknown };
      if (typeof legacy.path !== "string") return { output: "edit blocked: missing required path", isError: true };
      try {
        const target = resolvePath(this.workspaceDir, legacy.path);
        const existing = await stat(target).catch(() => undefined);
        if (existing?.isDirectory()) return { output: "edit: target is a directory", isError: true };
      } catch (error) { return { output: String(error), isError: true }; }
    }
    const rec = this.records[this.#next];
    this.#next += 1;
    if (rec === undefined) {
      throw new Error(`unexpected dispatch #${this.#next} for ${name}`);
    }
    this.seen.push({ name, input });
    expect({ name, input }).toEqual({ name: rec.name as string, input: rec.input });

    for (const [rel, body] of Object.entries(rec.writes as Record<string, string>)) {
      const path = join(this.workspaceDir, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, "utf8");
    }
    for (const rel of rec.deletes as string[]) {
      await rm(join(this.workspaceDir, rel), { force: true });
    }
    return { output: rec.output as string, isError: rec.is_error as boolean };
  }

  async ensureWorkspaceGitRepo(
    workspaceDir: string,
    charName: string,
    reason: string,
  ): Promise<void> {
    expect(workspaceDir).toBe(this.workspaceDir);
    this.gitCalls.push({ call: "ensure_workspace_git_repo", char: charName, reason });
  }

  async gitCommitAll(
    workspaceDir: string,
    charName: string,
    message: string,
  ): Promise<boolean> {
    expect(workspaceDir).toBe(this.workspaceDir);
    this.gitCalls.push({ call: "git_commit_all", char: charName, message });
    return false;
  }

  get dispatchCount(): number {
    return this.#next;
  }
}

function expectFinalRequestShape(
  request: SidecarRequest | undefined,
  built: Json | null,
  outcome: Json | null,
  pass: Json,
): void {
  const builtCount = (built?.["built_message_count"] as number | undefined) ?? 0;
  const where = pass.name as string;

  if (request === undefined) {
    expect(builtCount, `${where}: a pass that never called the model built nothing`).toBe(0);
    return;
  }

  const messages = request.messages;
  const rounds = (outcome?.["tool_rounds"] as number | undefined) ?? 0;

  const last = messages[messages.length - 1];
  const closed = last?.role === "assistant";

  if (outcome !== null) {
    expect(
      messages.length,
      `${where}: the built request, then two messages per round`,
    ).toBe(builtCount + 2 * rounds + (closed ? 1 : 0));
  } else {
    expect(
      messages.length,
      `${where}: a pass that failed still left whole rounds behind it`,
    ).toBeGreaterThanOrEqual(builtCount);
  }

  expect(
    messages[builtCount - 1]?.content.at(-1),
    `${where}: the compaction prompt is one user text block`,
  ).toEqual({ type: "text", text: built?.["compact_now_text"] as string });

  const tail = messages.slice(builtCount);
  for (const [i, m] of tail.entries()) {
    expect(m.role, `${where}: round ${Math.floor(i / 2)} alternates model then tool results`).toBe(
      i % 2 === 0 ? "assistant" : "user",
    );
  }

  if (!closed && tail.length > 0) {
    expect(
      last?.role,
      `${where}: a pass stopped at its cap ends on the tool results, with no closing turn`,
    ).toBe("user");
  }
  if (where === "workspace_paths_and_traversal") {
    const rejected = tail.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as { type?: string; content?: unknown }[]).some(
          (b) =>
            b.type === "tool_result" &&
            typeof b.content === "string" &&
            b.content.includes("path traversal"),
        ),
    );
    expect(rejected, `${where}: the model is told its write was refused, and why`).toBe(true);
  }

  if (tail.length === 0) {
    expect(
      last?.role,
      `${where}: a pass that never reached the model ends at its compaction user turn`,
    ).toBe("user");
  }
}

function typedTurns(messages: ConversationMessage[]): number {
  return messages.filter((m) => m.role === "user" && !m.isToolResultOnly).length;
}

function treeAfter(
  before: Record<string, string>,
  dispatches: Json[],
): Record<string, string> {
  const tree = { ...before };
  for (const d of dispatches) {
    for (const [rel, body] of Object.entries(d.writes as Record<string, string>)) tree[rel] = body;
    for (const rel of d.deletes as string[]) delete tree[rel];
  }
  return tree;
}

function toolsAskedFor(served: readonly GenerateResponse[]): string[] {
  return served.flatMap((r) =>
    r.content_blocks.filter((b) => b.type === "tool_use").map((b) => b.name),
  );
}

function expectOutcomeShape(
  pass: Json,
  outcome: Json | null,
  error: string | null,
  served: readonly GenerateResponse[],
  changed: string[],
  messages: ConversationMessage[],
  split: number,
  where: string,
): void {
  if (outcome === null) {
    expect(error, `${where}: a pass with no outcome says why`).not.toBeNull();
    return;
  }
  expect(error, `${where}: a pass that produced an outcome did not fail`).toBeNull();

  const dry = pass.dry_run === true;
  expect(outcome.kind, `${where}: a dry run says so, and a real one says compacted`).toBe(
    dry ? "dry_run" : "compacted",
  );

  expect(outcome.message_count, `${where}: it reports how many messages it archived`).toBe(split);
  expect(outcome.compacted_turns, `${where}: and how many turns those were`).toBe(
    typedTurns(messages.slice(0, split)),
  );
  expect(outcome.retained_count, `${where}: and how many messages stayed behind`).toBe(
    messages.length - split,
  );
  expect(outcome.retained_turns, `${where}: and how many turns those were`).toBe(
    typedTurns(messages.slice(split)),
  );

  const askedRounds = served.filter((r) => r.content_blocks.some((b) => b.type === "tool_use")).length;
  const cap = pass.max_tool_iterations as number | null;
  expect(outcome.tool_rounds, `${where}: it runs every round the model asked for, up to its cap`).toBe(
    cap === null ? askedRounds : Math.min(askedRounds, cap),
  );
  expect(
    outcome.tools_called ?? [],
    `${where}: and lists every tool asked for in the rounds it ran`,
  ).toEqual(toolsAskedFor(served.slice(0, outcome.tool_rounds as number)));

  if (dry) {
    const preview = (outcome.file_ops_preview ?? []) as { path: string }[];
    expect(outcome.would_write_files, `${where}: the count is the length of the preview`).toBe(
      preview.length,
    );
    expect(outcome.markdown_preview, `${where}: which lists the same paths`).toEqual(
      preview.map((f) => f.path),
    );
    expect(changed, `${where}: a dry run changes nothing on disk`).toEqual([]);
    expect(preview, `${where}: dry runs leave write tools inert`).toEqual([]);
    return;
  }

  expect(outcome.conversation_id, `${where}: it names the conversation it compacted`).toBe("conv-1");
  expect(outcome.new_conversation_id, `${where}: and the one that replaced it`).toBe("new-conv-id");
  expect(outcome.markdown_paths, `${where}: the files written are the memory it wrote`).toEqual(
    outcome.memory_files_written,
  );
  expect(
    [...(outcome.memory_files_written as string[])].sort(),
    `${where}: and are exactly the files that changed on disk`,
  ).toEqual(changed);
}

async function runPass(pass: Json): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shore-compaction-"));
  try {
    const workspace = join(root, "workspace");
    const memory = join(workspace, "memory");
    await mkdir(memory, { recursive: true });
    const dataDir = join(root, "data");
    await mkdir(join(dataDir, "Aria"), { recursive: true });

    for (const seed of pass.seed as Json[]) {
      const path = join(workspace, seed.path as string);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, seed.content as string, "utf8");
    }

    for (const rel of (pass.seed_dirs as string[] | undefined) ?? []) {
      await mkdir(join(workspace, rel), { recursive: true });
    }
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "not yours\n", "utf8");
    for (const link of (pass.seed_links as Json[] | undefined) ?? []) {
      const target = link.target === "<outside>" ? outside : join(workspace, link.target as string);
      await symlink(target, join(workspace, link.link as string));
    }

    const storeDir =
      pass.store_elsewhere === true ? join(root, "other", "memory") : memory;
    if (pass.store_elsewhere === true) await mkdir(storeDir, { recursive: true });
    const store =
      pass.with_store === true ? await MarkdownMemoryStore.open(storeDir) : undefined;
    const tools = new ReplayTools(workspace, join(dataDir, "Aria"), pass.dispatches as Json[]);
    const llm = new ScriptedLlm(scriptFor(pass.name as string));
    const mgr = new RecordingMgr("new-conv-id", pass.archive_fails === true);
    const messageSets = fx["pass_message_sets"] as unknown as Record<string, Json[]>;
    const set = messageSets[pass.messages_ref as string];
    if (set === undefined) throw new Error(`no message set named ${String(pass.messages_ref)}`);
    const messages = set.map(toConversationMessage);
    const planMessages = set.map(toPlanMessage);
    const plan = maybePlanOf(planMessages, {
      keepRecentTurns: pass.keep_recent_turns as number,
      ...(pass.keep_turns_override === null
        ? {}
        : { keepTurnsOverride: pass.keep_turns_override as number }),
      retainTrailingAutonomous: pass.retain_trailing_autonomous as boolean,
    });

    const seeded = Object.fromEntries(
      (pass.seed as Json[]).map((f) => [f.path as string, f.content as string]),
    );
    expect(await snapshotTree(workspace), "the seed is what the pass starts from").toEqual(seeded);

    const keepTurns =
      pass.keep_turns_override === null
        ? (pass.keep_recent_turns as number)
        : (pass.keep_turns_override as number);
    const split = archiveSplitIndex(
      messages,
      keepTurns,
      pass.retain_trailing_autonomous as boolean,
    );

    let outcome: unknown = null;
    let error: string | null = null;
    try {
      if (plan === undefined) throw CompactionError.insufficientMessages();
      outcome = await compact(
        {
          conversationId: "conv-1",
          plan,
          promptTemplate: "Compact now, {{char}}.",
          charName: "Aria",
          userName: "Tom",
          llm,
          conversationMgr: mgr,
          ...(store === undefined ? {} : { markdownStore: store }),
          dryRun: pass.dry_run as boolean,
          ...(pass.keep_turns_override === null
            ? {}
            : { keepTurnsOverride: pass.keep_turns_override as number }),
          chatRequest: chatRequest(messages),
          ...(pass.with_data_dir === true ? { dataDir } : {}),
          tools,
          ...(pass.max_tool_iterations === null
            ? {}
            : { maxToolIterations: pass.max_tool_iterations as number }),
        },
        { keepRecentTurns: pass.keep_recent_turns as number },
      );
    } catch (e) {
      error = (e as Error).message.replaceAll(await realpath(root), "<root>");
    }

    const shapedOutcome = outcome === null ? null : snakeOutcome(outcome as Json);
    const where = pass.name as string;
    expect(error).toBe(pass.error as string | null);
    expect(tools.dispatchCount).toBe((pass.dispatches as Json[]).length);

    const rolledBack = pass.archive_fails === true && mgr.calls.length > 0;
    const tree = await snapshotTree(workspace);
    expect(
      tree,
      rolledBack
        ? `${where}: a failed archive puts every file back as it was`
        : `${where}: the workspace changed only where a tool changed it`,
    ).toEqual(rolledBack ? seeded : treeAfter(seeded, pass.dispatches as Json[]));

    const changed = Object.keys({ ...seeded, ...tree })
      .filter((rel) => seeded[rel] !== tree[rel])
      .sort();

    const ensured = tools.gitCalls.filter((c) => c.call === "ensure_workspace_git_repo");
    const committed = tools.gitCalls.filter((c) => c.call === "git_commit_all");
    expect(ensured.length, `${where}: the workspace is made a git repo once, at most`).toBeLessThanOrEqual(1);
    if (pass.dry_run === true) {
      expect(tools.gitCalls, `${where}: a dry run touches git at all`).toEqual([]);
    }
    for (const call of tools.gitCalls) {
      expect(call.char, `${where}: git is told which character it is for`).toBe("Aria");
    }
    expect(
      committed.length > 0,
      `${where}: the only commit compaction makes is the one recording a rollback`,
    ).toBe(rolledBack);

    expect(mgr.calls.length, `${where}: the conversation is archived at most once`).toBeLessThanOrEqual(1);
    for (const call of mgr.calls) {
      expect(call.conversation_id, `${where}: the archive names the conversation`).toBe("conv-1");
      expect(call.active_content, `${where}: and carries the text still live`).toBe(
        jsonlOf(planMessages),
      );
      expect(call.keep_last_n, `${where}: and keeps everything after the split`).toBe(
        messages.length - split,
      );
    }
    expect(
      mgr.calls.length > 0,
      `${where}: the conversation is archived once the tool loop is done, unless this is a dry run`,
    ).toBe(pass.dry_run !== true && (shapedOutcome !== null || pass.archive_fails === true));

    if (tools.dispatchCount > 0) coverage.dispatched += 1;
    if (rolledBack) coverage.rolledBack += 1;
    if (pass.dry_run === true) coverage.dryRun += 1;
    if (toolsAskedFor(llm.served).length > tools.dispatchCount) coverage.blocked += 1;

    expectOutcomeShape(pass, shapedOutcome, error, llm.served, changed, messages, split, where);

    const built =
      llm.built === undefined
        ? null
        : {
            chat_prefix_len: messages.length,
            built_message_count: messages.length + 1,
            compact_now_text: "Compact now, Aria.",
          };
    expect(
      llm.built ?? null,
      `${where}: the request is the chat so far, plus a rendered compact-now turn`,
    ).toEqual(built);

    expectFinalRequestShape(llm.request, built, shapedOutcome, pass);

    const queued = await queuedDeferredPaths(join(dataDir, "Aria"));
    expect(queued).toEqual(pass.deferred_queued_paths as string[]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function queuedDeferredPaths(characterDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(characterDir, "deferred_edits.jsonl"), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => (JSON.parse(l) as { path: string }).path);
}

function camelOutcome(outcome: Json): CompactionOutcome {
  const map: Record<string, string> = {
    memory_files_written: "memoryFilesWritten",
    conversation_id: "conversationId",
    new_conversation_id: "newConversationId",
    message_count: "messageCount",
    compacted_turns: "compactedTurns",
    retained_count: "retainedCount",
    retained_turns: "retainedTurns",
    markdown_paths: "markdownPaths",
    tool_rounds: "toolRounds",
    tools_called: "toolsCalled",
    would_write_files: "wouldWriteFiles",
    file_ops_preview: "fileOpsPreview",
    markdown_preview: "markdownPreview",
  };
  const out: Json = {};
  for (const [k, v] of Object.entries(outcome)) out[map[k] ?? k] = v;
  return out as unknown as CompactionOutcome;
}

function snakeOutcome(outcome: Json): Json {
  const map: Record<string, string> = {
    memoryFilesWritten: "memory_files_written",
    conversationId: "conversation_id",
    newConversationId: "new_conversation_id",
    messageCount: "message_count",
    compactedTurns: "compacted_turns",
    retainedCount: "retained_count",
    retainedTurns: "retained_turns",
    markdownPaths: "markdown_paths",
    toolRounds: "tool_rounds",
    toolsCalled: "tools_called",
    wouldWriteFiles: "would_write_files",
    fileOpsPreview: "file_ops_preview",
    markdownPreview: "markdown_preview",
  };
  const out: Json = {};
  for (const [k, v] of Object.entries(outcome)) out[map[k] ?? k] = v;
  return out;
}

const pass_name_is_dry = (n: string) => n.startsWith("dry_run");

function scriptFor(name: string): GenerateResponse[] {
  const base = {
    usage: emptyUsage(),
    timing: { total_ms: 0, time_to_first_token_ms: 0 },
    model: "mock",
  };
  const toolRound = (calls: Array<[string, unknown]>): GenerateResponse => ({
    ...base,
    content: "",
    content_blocks: calls.map(([toolName, input], i) => ({
      type: "tool_use" as const,
      id: `call_${i}`,
      name: toolName,
      input,
    })),
    finish_reason: "tool_use",
  });
  const editRound = (entries: Array<[string, string]>): GenerateResponse =>
    toolRound(entries.map(([path, content]) => ["edit", { path, content }]));
  const endTurn = (text: string): GenerateResponse => ({
    ...base,
    content: text,
    content_blocks: text === "" ? [] : [{ type: "text", text }],
    finish_reason: "end_turn",
  });

  const defaultScript = (): GenerateResponse[] => [
    editRound([["memory/daily/a.md", "# A\n"]]),
    endTurn("done"),
  ];

  switch (name) {
    case "two_writes_one_round":
      return [
        editRound([
          ["memory/daily/a.md", "# A\n"],
          ["memory/people/b.md", "# B\n"],
        ]),
        endTurn("done"),
      ];
    case "writes_memory_index":
      return [editRound([["MEMORY.md", "# Index\n- thread\n"]]), endTurn("done")];
    case "writes_memory_index_without_data_dir":
      return [editRound([["MEMORY.md", "# Index\n"]]), endTurn("done")];
    case "no_writes_read_only":
      return [toolRound([["read", {}]]), endTurn("nothing to save")];
    case "no_writes_at_all":
      return [endTurn("nothing to save")];
    case "workspace_paths_and_traversal":
      return [
        editRound([
          ["DREAMS.md", "x"],
          ["../escape.md", "y"],
          ["notes.md", "z"],
        ]),
        endTurn("tried"),
      ];
    case "memory_and_prompt_paths":
      return [
        editRound([
          ["memory/ok.md", "# ok\n"],
          ["memory/dreams.md", "# dreams\n"],
          ["SOUL.md", "# soul\n"],
        ]),
        endTurn("mixed"),
      ];
    case "delete_workspace_file":
      return [
        toolRound([["delete", { path: "notes.md" }]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "edit_missing_path":
      return [
        toolRound([["edit", { content: "no path" }]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "edit_in_place_over_seed":
      return [
        toolRound([
          [
            "edit",
            {
              path: "memory/a.md",
              edits: [{ old_string: "old line", new_string: "new line" }],
            },
          ],
        ]),
        endTurn("edited"),
      ];
    case "edit_in_place_missing_file":
      return [
        toolRound([
          [
            "edit",
            { path: "memory/missing.md", edits: [{ old_string: "a", new_string: "b" }] },
          ],
        ]),
        endTurn("failed"),
      ];
    case "overwrite_existing_then_archive":
      return [editRound([["memory/a.md", "# replaced\n"]]), endTurn("done")];
    case "rollback_restores_on_archive_failure":
      return [
        editRound([
          ["memory/a.md", "# replaced\n"],
          ["memory/b.md", "# new\n"],
        ]),
        endTurn("done"),
      ];
    case "dry_run_records_preview":
      return [
        editRound([
          ["memory/a.md", "# A\n"],
          ["DREAMS.md", "# dreams\n"],
        ]),
        endTurn("preview"),
      ];
    case "dry_run_in_place_edit_has_no_preview_body":
      return [
        toolRound([
          ["edit", { path: "memory/a.md", edits: [{ old_string: "a", new_string: "b" }] }],
        ]),
        endTurn("preview"),
      ];
    case "dry_run_blocks_git":
      return [toolRound([["git", { subcommand: "status", args: [] }]]), endTurn("preview")];
    case "dry_run_without_store":
      return [editRound([["memory/a.md", "# A\n"]]), endTurn("preview")];
    case "cap_zero_rounds":
      return [editRound([["memory/a.md", "# A\n"]]), endTurn("done")];
    case "cap_one_round":
    case "two_rounds_uncapped":
      return [
        editRound([["memory/a.md", "# A\n"]]),
        editRound([["memory/b.md", "# B\n"]]),
        endTurn("done"),
      ];
    case "cap_two_rounds_model_stops_first":
      return [editRound([["memory/a.md", "# A\n"]]), endTurn("done")];
    case "llm_exhausted":
      return [editRound([["memory/a.md", "# A\n"]])];
    case "git_commit_allowed_live":
      return [
        editRound([["memory/a.md", "# A\n"]]),
        toolRound([["git", { subcommand: "add", args: ["memory/a.md"] }]]),
        endTurn("committed"),
      ];
    case "unknown_tool_passes_through":
      return [
        toolRound([["roll_dice", { notation: "1d1" }]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "write_tool_is_not_write_like":
      return [
        toolRound([["write", { path: "DREAMS.md", content: "x" }]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "edit_with_non_string_path":
      return [
        toolRound([["edit", { path: 42, content: "x" }]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "edit_with_non_string_content":
    case "dry_run_edit_with_non_string_content":
      return [
        toolRound([["edit", { path: "memory/a.md", content: 42 }]]),
        endTurn(pass_name_is_dry(name) ? "preview" : "done"),
      ];
    case "symlink_escape_only":
      return [editRound([["memory/link/secret.md", "owned"]]), endTurn("blocked")];
    case "edit_over_a_directory_only":
      return [editRound([["memory/sub", "clobber"]]), endTurn("blocked")];
    case "symlink_escape_is_rejected":
      return [
        editRound([["memory/link/secret.md", "owned"]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "edit_over_a_directory":
      return [
        editRound([["memory/sub", "clobber"]]),
        editRound([["memory/a.md", "# A\n"]]),
        endTurn("done"),
      ];
    case "index_plus_other_file":
      return [
        editRound([
          ["MEMORY.md", "# Index\n"],
          ["memory/a.md", "# A\n"],
        ]),
        endTurn("done"),
      ];
    case "only_the_prompt_visible_write_is_queued":
      return [
        editRound([
          ["memory/a.md", "# A\n"],
          ["SOUL.md", "# soul\n"],
        ]),
        endTurn("done"),
      ];
    case "rollback_two_rounds_same_path":
      return [
        editRound([["memory/a.md", "# first\n"]]),
        editRound([["memory/a.md", "# second\n"]]),
        endTurn("done"),
      ];
    default:
      return defaultScript();
  }
}
