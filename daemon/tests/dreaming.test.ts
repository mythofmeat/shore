import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CacheTracker } from "../src/cache/tracker.ts";
import { transcript } from "../src/commands/call_log.ts";
import { runningReport } from "../src/daemon/running.ts";
import { addDiaryNote } from "../src/autonomy/diary.ts";
import { dreamDue, type DreamInputs } from "../src/autonomy/tick.ts";
import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { characterDataDir } from "../src/config/dirs.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";
import type { ModelCatalog } from "../src/config/models.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { DIARY_FOR_DREAM, diaryText } from "../src/engine/prompt.ts";
import type { ContentBlock, DiaryNote, Message } from "../src/engine/types.ts";
import { hostZone } from "../src/ledger/zoned.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { withDreaming } from "../src/memory/compaction/prompts.ts";
import { loadActivePromptFile } from "../src/memory/deferred_edits.ts";
import { conversationLines, conversationsSince } from "../src/memory/dreaming/manifest.ts";
import { renderDreamPrompt } from "../src/memory/dreaming/prompt.ts";
import { readWorkspacePath, workspaceReadCounts } from "../src/memory/dreaming/reads.ts";
import { appendDreamRecord, lastDream, lastFinishedDream } from "../src/memory/dreaming/records.ts";
import { dreamToolsConfig } from "../src/memory/dreaming/run.ts";
import { required } from "../src/util/required.ts";
import { afterFirstChat, type ChatWorld } from "./support/chat_world.ts";
import { restoreTestEnv } from "./support/env.ts";
import { eventsForResponse } from "./support/stream.ts";
import { testTmp } from "./support/tmp.ts";

const KEY_ENV = "SHORE_DREAMING_TEST_KEY";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

afterAll(restoreTestEnv);

const due: DreamInputs = {
  enabled: true,
  forced: false,
  foreground: false,
  now: 10 * DAY,
  localMinute: 3 * 60,
  lastDreamAt: 6 * DAY,
  everyMs: 3 * DAY,
  window: { startMinute: 2 * 60, endMinute: 7 * 60 },
  quietMs: 3 * HOUR,
  idleAfterMs: 2 * HOUR,
  turnsSince: 25,
  minTurns: 20,
  retryAt: undefined,
};

test("a dream is due once its interval has passed, inside its window, with the user quiet and enough said", () => {
  expect(dreamDue(due)).toBe(true);
  expect(dreamDue({ ...due, lastDreamAt: undefined })).toBe(true);
  expect(dreamDue({ ...due, window: undefined, localMinute: 15 * 60 })).toBe(true);
  expect(dreamDue({ ...due, lastDreamAt: 8 * DAY })).toBe(false);
  expect(dreamDue({ ...due, localMinute: 7 * 60 })).toBe(false);
  expect(dreamDue({ ...due, localMinute: 90 })).toBe(false);
  expect(dreamDue({ ...due, quietMs: HOUR })).toBe(false);
  expect(dreamDue({ ...due, turnsSince: 19 })).toBe(false);
  expect(dreamDue({ ...due, retryAt: 10 * DAY + 1 })).toBe(false);
  expect(dreamDue({ ...due, enabled: false })).toBe(false);
  expect(dreamDue({ ...due, foreground: true })).toBe(false);
});

test("a window that crosses midnight holds on both sides of it", () => {
  const night = { ...due, window: { startMinute: 23 * 60, endMinute: 5 * 60 } };
  expect(dreamDue({ ...night, localMinute: 23 * 60 + 30 })).toBe(true);
  expect(dreamDue({ ...night, localMinute: 4 * 60 })).toBe(true);
  expect(dreamDue({ ...night, localMinute: 12 * 60 })).toBe(false);
});

test("a dream asked for runs at the next tick whatever the schedule says, but never during a reply", () => {
  const asked = { ...due, forced: true, enabled: false, lastDreamAt: 9 * DAY, localMinute: 12 * 60, quietMs: 0, turnsSince: 0 };
  expect(dreamDue(asked)).toBe(true);
  expect(dreamDue({ ...asked, foreground: true })).toBe(false);
  expect(dreamDue({ ...asked, retryAt: asked.now + 1 })).toBe(false);
});

function configAt(root: string): LoadedConfig {
  return loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} });
}

test("[dreaming] is read under its own name, off unless turned on, and a bad start window is refused", async () => {
  const root = await mkdtemp(testTmp("shore-dreaming-config-"));
  await writeFile(join(root, "config.toml"), "[chat]\ndisplay_name = \"eve\"\n");
  expect(configAt(root).app.memory.dreaming.enabled).toBe(false);

  await writeFile(join(root, "config.toml"), [
    "[dreaming]",
    "enabled = true",
    "every = \"72h\"",
    "start_between = \"02:00-07:00\"",
    "idle_after = \"90m\"",
    "min_turns = 5",
    "time_limit = \"45m\"",
    "tools = [\"read\", \"bash\"]",
    "model = \"fixture\"",
    "",
  ].join("\n"));
  const loaded = configAt(root);
  const dreaming = loaded.app.memory.dreaming;
  expect(dreaming.enabled).toBe(true);
  expect(Number(dreaming.every.asSecs())).toBe(3 * 24 * 3600);
  expect(dreaming.start_between).toBe("02:00-07:00");
  expect(Number(dreaming.idle_after.asSecs())).toBe(90 * 60);
  expect(dreaming.min_turns).toBe(5);
  expect(Number(dreaming.time_limit.asSecs())).toBe(45 * 60);
  expect(dreaming.tools).toEqual(["read", "bash"]);
  expect(loaded.app.defaults.background.dreaming).toBe("fixture");

  await writeFile(join(root, "config.toml"), "[chat]\ndisplay_name = \"eve\"\n\n[dreaming]\n");
  expect(configAt(root).app.memory.dreaming.enabled).toBe(false);

  await writeFile(join(root, "config.toml"), "[dreaming]\nstart_between = \"25:00-03:00\"\n");
  expect(() => configAt(root)).toThrow(/start_between/);
});

function message(id: string, role: "user" | "assistant", text: string, timestamp: string): Message {
  return { msg_id: id, role, content: text, images: [], content_blocks: [{ type: "text", text }], alternatives: [], timestamp };
}

function toolTurn(id: string, at: string): Message[] {
  return [
    message(`${id}u`, "user", "look this up", at),
    { ...message(`${id}c`, "assistant", "", at), content_blocks: [{ type: "tool_use", id: `${id}t`, name: "read", input: {} }] },
    { ...message(`${id}r`, "user", "", at), content_blocks: [{ type: "tool_result", tool_use_id: `${id}t`, content: "found" }] },
    message(`${id}a`, "assistant", "here it is", at),
  ];
}

function putSegment(dataDir: string, archiveKey: string, idx: number, compactedAt: number, extra: { memory_before?: string; memory_after?: string; excluded?: boolean; toolTurns?: number } = {}): void {
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    const at = new Date(compactedAt - HOUR).toISOString();
    const toolTurns = Array.from({ length: extra.toolTurns ?? 0 }, (_unused, turn) => toolTurn(`t${archiveKey}${String(idx)}${String(turn)}`, at)).flat();
    store.putSegment(archiveKey, idx, {
      file: `${String(idx).padStart(4, "0")}.jsonl`,
      compacted_at: new Date(compactedAt).toISOString(),
      ...(extra.memory_before === undefined ? {} : { memory_before: extra.memory_before }),
      ...(extra.memory_after === undefined ? {} : { memory_after: extra.memory_after }),
    }, [message(`u${archiveKey}${String(idx)}`, "user", "hello", at), message(`a${archiveKey}${String(idx)}`, "assistant", "hi", at), ...toolTurns]);
    if (extra.excluded === true) store.setExcluded(archiveKey, idx, true);
  } finally {
    store.close();
  }
}

test("a dream is shown only what was archived since the last one and not excluded", async () => {
  const dataDir = await mkdtemp(testTmp("shore-dreaming-manifest-"));
  await mkdir(join(dataDir, "ada", "threads", "main"), { recursive: true });
  const since = Date.parse("2026-11-05T00:00:00Z");
  putSegment(dataDir, "ada", 0, since - HOUR);
  putSegment(dataDir, "ada", 1, since + HOUR, { memory_before: "1111111aaaa", memory_after: "2222222bbbb" });
  putSegment(dataDir, "ada", 2, since + 2 * HOUR, { excluded: true });
  putSegment(dataDir, "ada/garden", 0, since + 3 * HOUR, { memory_before: "3333333cccc", memory_after: "3333333cccc", toolTurns: 2 });

  const found = await conversationsSince(dataDir, "ada", since);
  expect(found.map((conversation) => [conversation.thread, conversation.segment])).toEqual([["main", 1], ["garden", 0]]);
  expect(found.map((conversation) => conversation.turns)).toEqual([1, 3]);

  const lines = conversationLines(found, "2222222..HEAD").split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("thread `main`");
  expect(lines[0]).toMatch(/: 1 turn\. Its compaction's commits: 1111111\.\.2222222\.$/);
  expect(lines[1]).toMatch(/: 3 turns\. Its compaction changed nothing\.$/);
  expect(lines[2]).toBe("- every change to the workspace since then: `git log --stat 2222222..HEAD`");
});

test("the compaction prompt's dreaming lines show only while dreaming is on", () => {
  const template = "Keep it small.{{#if dreaming}} Leave the rest to the dream.{{/if}} Commit.";
  expect(withDreaming(template, true)).toBe("Keep it small. Leave the rest to the dream. Commit.");
  expect(withDreaming(template, false)).toBe("Keep it small. Commit.");
});

function git(dir: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args]);
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

function response(request: SidecarRequest, blocks: ContentBlock[]): GenerateResponse {
  return {
    model: request.model,
    content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    content_blocks: blocks,
    finish_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
  };
}

type DreamScript = (request: SidecarRequest, round: number, signal: AbortSignal | undefined) => ContentBlock[] | Promise<ContentBlock[]>;

function provider(seen: SidecarRequest[], dream: DreamScript): SidecarProvider {
  let rounds = 0;
  return {
    generate: async (request) => response(request, [{ type: "text", text: "hello" }]),
    stream: async function* (request, signal) {
      const callType = request.context?.call_type;
      if (callType === "dreaming" || callType === "dreaming_tool_loop") {
        seen.push(structuredClone(request));
        yield* eventsForResponse(response(request, await dream(request, rounds++, signal)));
        return;
      }
      const answered = request.messages.at(-1)?.content.some((block) => block.type === "tool_result") === true;
      yield* eventsForResponse(response(request, answered
        ? [{ type: "text", text: "hello" }]
        : [{ type: "tool_use", id: "chat-read", name: "read", input: { file_path: "SOUL.md" } }]));
    },
  };
}

interface DreamWorld extends ChatWorld {
  characterDir: string;
}

async function afterOneChat(seen: SidecarRequest[], dream: DreamScript, tune: (app: AppConfig, models: ModelCatalog) => void, run: (world: DreamWorld) => Promise<void>): Promise<void> {
  await afterFirstChat({
    name: "dreaming",
    keyEnv: KEY_ENV,
    provider: provider(seen, dream),
    tools: ["read", "bash", "wake_in_thread", "start_thread"],
    models: ["fixture", "small"],
    tune: (app, models) => {
      app.defaults.display_name = "eve";
      tune(app, models);
    },
    prepare: async (workspace) => {
      await writeFile(join(workspace, "MEMORY.md"), "MEMORY before the chat\n");
      git(workspace, "init", "--quiet");
      git(workspace, "add", "--all");
      git(workspace, "commit", "--quiet", "-m", "start");
    },
  }, async (world) => {
    await run({ ...world, characterDir: characterDataDir(world.config.dirs.data, "ada") });
  });
}

function systemText(request: SidecarRequest): string {
  return (request.system ?? []).map((block) => block.text).join("\n");
}

function instructionsOf(request: SidecarRequest): string {
  return request.messages.findLast((entry) => entry.role === "system")?.content
    .flatMap((block) => block.type === "text" ? [block.text] : []).join("\n") ?? "";
}

const COMMIT_A_NOTE = "printf 'a dream was here\\n' >> MEMORY.md && git -c user.name=d -c user.email=d@d commit --quiet -am 'dream: note'";

test("a dream asked for works on the current files, not the home thread's frozen copy, and its record comes from git", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(seen, (_request, round) => round === 0
    ? [
        { type: "tool_use", id: "dream-read", name: "read", input: { file_path: "MEMORY.md" } },
        { type: "tool_use", id: "dream-bash", name: "bash", input: { command: COMMIT_A_NOTE } },
      ]
    : [{ type: "text", text: "Tidied MEMORY.md." }], (app) => { app.memory.dreaming.enabled = true; }, async ({ config, workspace, characterDir, runtime }) => {
    expect(await loadActivePromptFile(characterDir, "MEMORY.md", "main")).toContain("before the chat");
    await writeFile(join(workspace, "MEMORY.md"), "MEMORY as it is now\n");
    git(workspace, "commit", "--quiet", "-am", "compaction");
    const head = git(workspace, "rev-parse", "HEAD");
    putSegment(config.dirs.data, "ada", 0, Date.now() - HOUR, { memory_before: git(workspace, "rev-parse", "HEAD~1"), memory_after: head });
    expect([...workspaceReadCounts(characterDir)]).toEqual([["SOUL.md", 1]]);

    expect(runtime.autonomy.forceDreamNow("ada")).toBe("queued");
    await runtime.autonomy.tick();
    await runtime.autonomy.dreamsEnded();

    const opening = required(seen[0]);
    expect(systemText(opening)).toContain("MEMORY as it is now");
    expect(systemText(opening)).not.toContain("before the chat");
    const offered = (opening.tools ?? []).map((tool) => tool.name);
    expect(offered).toContain("bash");
    expect(offered).not.toContain("wake_in_thread");
    expect(offered).not.toContain("start_thread");
    const instructions = instructionsOf(opening);
    expect(instructions).toContain("thread `main`");
    expect(instructions).toContain(`..${head.slice(0, 7)}.`);
    expect(instructions).toContain("`SOUL.md`: read once");
    expect(instructions).toContain("You have 90 minutes, and after 80 minutes you'll be told to wrap up.");

    const record = required(lastDream(characterDir));
    expect(record.outcome).toBe("finished");
    expect(record.commits).toBe(1);
    expect(record.files).toEqual(["MEMORY.md"]);
    expect(record.summary).toBe("Tidied MEMORY.md.");
    expect(record.conversations).toBe(1);
    expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toContain("a dream was here");
    expect(await loadActivePromptFile(characterDir, "MEMORY.md", "main")).toContain("a dream was here");
    expect([...workspaceReadCounts(characterDir)]).toEqual([]);
    const kinds = runtime.autonomy.log("ada", 100).map((event) => event.kind);
    expect(kinds).toContain("dream_started");
    expect(kinds).toContain("dream_finished");
    const status = required(runtime.autonomy.dreamStatus("ada"));
    expect(status.queued).toBe(false);
    expect(status.running).toBe(false);
    expect(status.lastAt).toBeDefined();
  });
});

test("a dream's own reads aren't counted, and a failed dream leaves the count for the next one", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(seen, (_request, round) => {
    if (round === 0) return [{ type: "tool_use", id: "dream-read", name: "read", input: { file_path: "MEMORY.md" } }];
    throw new Error("provider fell over ".padEnd(400, "x"));
  }, (app) => { app.memory.dreaming.enabled = true; }, async ({ config, characterDir, runtime }) => {
    putSegment(config.dirs.data, "ada", 0, Date.now() - HOUR);
    runtime.autonomy.forceDreamNow("ada");
    await runtime.autonomy.tick();
    await runtime.autonomy.dreamsEnded();

    expect(seen).toHaveLength(2);
    const record = required(lastDream(characterDir));
    expect(record.outcome).toBe("failed");
    expect(record.error).toBe(`${"provider fell over ".padEnd(300, "x")}…`);
    expect([...workspaceReadCounts(characterDir)]).toEqual([["SOUL.md", 1]]);
    expect(required(runtime.autonomy.dreamStatus("ada")).lastAt).toBeUndefined();
    expect(runtime.autonomy.log("ada", 100).map((event) => event.kind)).toContain("dream_failed");
  });
});

test("a scheduled dream with nothing archived since the last one makes no model call", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(seen, () => [{ type: "text", text: "nothing" }], (app) => {
    app.memory.dreaming.enabled = true;
    app.memory.dreaming.min_turns = 0;
    app.memory.dreaming.idle_after = ConfigDuration.fromSecs(0);
  }, async ({ characterDir, runtime }) => {
    await runtime.autonomy.tick();
    expect(seen).toEqual([]);
    expect(lastDream(characterDir)).toBeUndefined();
  });
});

test("a scheduled dream runs once something has been archived since the last one", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(seen, () => [{ type: "text", text: "Checked." }], (app) => {
    app.memory.dreaming.enabled = true;
    app.memory.dreaming.min_turns = 0;
    app.memory.dreaming.idle_after = ConfigDuration.fromSecs(0);
  }, async ({ config, characterDir, runtime }) => {
    putSegment(config.dirs.data, "ada", 0, Date.now() - HOUR);
    await runtime.autonomy.tick();
    await runtime.autonomy.dreamsEnded();
    expect(seen).toHaveLength(1);
    expect(required(lastDream(characterDir)).outcome).toBe("finished");
  });
});

test("a running dream lets a snapshot through between calls, can't be queued twice, and a shutdown stops it for later", async () => {
  const seen: SidecarRequest[] = [];
  const { promise: called, resolve: calling } = Promise.withResolvers<void>();
  await afterOneChat(seen, async (_request, _round, signal) => {
    calling();
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => { reject(new Error("stopped")); }, { once: true });
    });
    return [];
  }, (app) => { app.memory.dreaming.enabled = true; }, async ({ config, characterDir, runtime }) => {
    putSegment(config.dirs.data, "ada", 0, Date.now() - HOUR);
    expect(runtime.autonomy.forceDreamNow("ada")).toBe("queued");
    await runtime.autonomy.tick();
    await called;

    const report = runningReport({ dataDir: config.dirs.data, generations: () => [], wakes: () => [], dreams: () => runtime.autonomy.runningDreams(), shutdown: () => undefined });
    expect(report.work.map((item) => [item.kind, item.character])).toEqual([["dream", "ada"]]);
    expect(await runtime.snapshotGate.withSnapshot(async () => "taken")).toBe("taken");
    expect(runtime.autonomy.forceDreamNow("ada")).toBe("running");
    expect(required(runtime.autonomy.dreamStatus("ada")).queued).toBe(false);

    await runtime.autonomy.quiesce();
    const record = required(lastDream(characterDir));
    expect(record.outcome).toBe("interrupted");
    expect(record.stopped_by).toBe("shutdown");
    const status = required(runtime.autonomy.dreamStatus("ada"));
    expect(status.running).toBe(false);
    expect(status.queued).toBe(true);
    expect(status.lastAt).toBeUndefined();
  });
});

test("a dream runs on the chat model whatever wakes use, and counts only the commits it made itself", async () => {
  const seen: SidecarRequest[] = [];
  let workspaceDir = "";
  await afterOneChat(seen, (_request, round) => {
    if (round === 0) return [{ type: "tool_use", id: "dream-bash", name: "bash", input: { command: COMMIT_A_NOTE } }];
    if (round === 1) {
      writeFileSync(join(workspaceDir, "chat.md"), "written in chat\n");
      git(workspaceDir, "add", "chat.md");
      git(workspaceDir, "commit", "--quiet", "-m", "chat");
      return [{ type: "tool_use", id: "dream-read", name: "read", input: { file_path: "MEMORY.md" } }];
    }
    return [{ type: "text", text: "Done." }];
  }, (app) => { app.defaults.background.heartbeat = "small"; }, async ({ config, workspace, characterDir, runtime }) => {
    workspaceDir = workspace;
    expect([...workspaceReadCounts(characterDir)]).toEqual([]);
    putSegment(config.dirs.data, "ada", 0, Date.now() - HOUR);
    runtime.autonomy.forceDreamNow("ada");
    await runtime.autonomy.tick();
    await runtime.autonomy.dreamsEnded();

    expect(seen.map((request) => request.model)).toEqual(["claude-fixture", "claude-fixture", "claude-fixture"]);
    const record = required(lastDream(characterDir));
    expect(record.outcome).toBe("finished");
    expect(record.commits).toBe(1);
    expect(record.files).toEqual(["MEMORY.md"]);
    expect(record.summary).toBe("Done.");
    expect(transcript({ characterName: "ada", callStore: runtime.callStore }, { source: "dreaming", count: 10 }).entries).toHaveLength(3);
  });
});

test("a dream stopped at its round limit is cut off, keeps no half-written summary, and the next dream is told", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(seen, (_request, round) => [
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: `dream-bash-${String(round)}`, name: "bash", input: { command: "true" } },
  ], (_app, models) => {
    models.chat.set("chat.fixture", { ...required(models.chat.get("chat.fixture")), maxToolIterations: 1 });
  }, async ({ config, characterDir, runtime }) => {
    putSegment(config.dirs.data, "ada", 0, Date.now() - HOUR);
    runtime.autonomy.forceDreamNow("ada");
    await runtime.autonomy.tick();
    await runtime.autonomy.dreamsEnded();
    const record = required(lastDream(characterDir));
    expect(record.outcome).toBe("cut_off");
    expect(record.stopped_by).toBe("round_limit");
    expect(record.summary).toBeUndefined();
    const first = seen.length;

    runtime.autonomy.forceDreamNow("ada");
    await runtime.autonomy.tick();
    await runtime.autonomy.dreamsEnded();
    const next = instructionsOf(required(seen[first]));
    expect(next).toContain("used up its rounds of tool calls");
    expect(next).toContain("thread `main`");
  });
});

test("a dream a budget pauses before it starts is no failure, makes no call and stays queued", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(seen, () => [{ type: "text", text: "never" }], (app) => {
    app.memory.dreaming.enabled = true;
    app.usage.budgets = [{
      name: "dreams", period: "month", cost_usd: 0, warn_at: [], limit: "block", character: undefined, provider: undefined,
      api_key: undefined, model: undefined, call_type: "dreaming", usage_kind: [], allow_compaction_over_budget: undefined,
      reset_hour: undefined, reset_day_of_week: undefined, reset_day_of_month: undefined, pace_period: undefined,
      pace_action: undefined, pace_warn_at: undefined, warn_action: undefined, pace_warn_action: undefined,
    }];
  }, async ({ config, characterDir, runtime }) => {
    putSegment(config.dirs.data, "ada", 0, Date.now() - HOUR);
    runtime.autonomy.forceDreamNow("ada");
    await runtime.autonomy.tick();
    await runtime.autonomy.dreamsEnded();
    expect(seen).toEqual([]);
    expect(lastDream(characterDir)).toBeUndefined();
    expect(runtime.autonomy.log("ada", 100).map((event) => event.kind)).toContain("budget_paused");
    const status = required(runtime.autonomy.dreamStatus("ada"));
    expect(status.queued).toBe(true);
    expect(required(status.nextDueAt)).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(required(runtime.autonomy.runnerFor("ada")).snapshot().dream?.failures).toBe(0);
  });
});

test("a wildcard grant never gives a dream a left-out tool, and a list of its own picks its sub-agents", () => {
  const tools = { ...defaultAppConfig().tools, enabled_tools: ["*"], enabled_mcp: ["discord"], enabled_subagents: ["memory", "music"] };
  const open = dreamToolsConfig(tools, undefined);
  expect(open.enabled_tools).toContain("read");
  expect(open.enabled_tools).toContain("bash");
  for (const name of ["wake_in_thread", "list_triggers", "write_diary", "start_thread", "edit_thread", "list_threads", "generate_image", "guide"]) {
    expect(open.enabled_tools).not.toContain(name);
  }
  expect(open.enabled_mcp).toEqual([]);
  expect(open.enabled_subagents).toEqual(["memory", "music"]);
  const chosen = dreamToolsConfig(tools, ["read", "ask_memory", "start_thread", "mcp__discord__send"]);
  expect(chosen.enabled_tools).toEqual(["read"]);
  expect(chosen.enabled_subagents).toEqual(["memory"]);
});

test("only a read from the first line counts as opening a workspace file, however the workspace path is written", () => {
  const workspace = join(process.cwd(), "ws");
  expect(readWorkspacePath(`${join(workspace, "notes", "a.md")}: lines 1–40\n1\thi`, workspace)).toBe(join("notes", "a.md"));
  expect(readWorkspacePath(`${join(workspace, "notes", "a.md")}: lines 41–80\n41\thi`, workspace)).toBeUndefined();
  expect(readWorkspacePath(`${join(workspace, "a.md")}: lines 1–2\n1\thi`, "ws/./")).toBe("a.md");
  expect(readWorkspacePath(`${join(process.cwd(), "elsewhere.md")}: lines 1–2\n1\thi`, workspace)).toBeUndefined();
});

test("DREAMS.md goes into the dream prompt as written, never read as template", () => {
  const notes = "Ask {{user}} about the {{#if reads}}hidden{{/if}} note";
  const rendered = renderDreamPrompt("{{#if notes}}Notes:\n{{notes}}{{/if}}\n{{#if reads}}Reads:\n{{reads}}{{/if}}\nfor {{user}}", {
    now: "now", userName: "eve", characterName: "ada", lastDream: undefined, conversations: "", reads: undefined, notes,
    timeLimit: "90 minutes", wrapUpAfter: "80 minutes",
  });
  expect(rendered).toBe(`Notes:\n${notes}\n\nfor eve`);
});

test("the last finished dream stays on record however many attempts follow it", async () => {
  const dataDir = await mkdtemp(testTmp("shore-dreaming-records-"));
  const characterDir = characterDataDir(dataDir, "ada");
  await mkdir(characterDir, { recursive: true });
  const at = (hours: number) => new Date(Date.UTC(2026, 10, 1) + hours * HOUR).toISOString();
  appendDreamRecord(characterDir, { started_at: at(0), ended_at: at(0), outcome: "finished", conversations: 1, commits: 0, files: [], head: "abc1234" });
  for (let hours = 1; hours <= 25; hours += 1) {
    appendDreamRecord(characterDir, { started_at: at(hours), ended_at: at(hours), outcome: "failed", conversations: 1, commits: 0, files: [] });
  }
  expect(required(lastFinishedDream(characterDir)).head).toBe("abc1234");
  expect(required(lastDream(characterDir)).started_at).toBe(at(25));
});

test("a dream's first call may start cold, but a follow-up that loses its cache is flagged", () => {
  const tracker = new CacheTracker(3600);
  const anomaly = (callType: string, read: number, write: number) => tracker.observe({
    ts: "2026-11-08T03:00:00Z", provider: "anthropic", sdk: "anthropic", model: "claude-fixture", thinking_enabled: false,
    cache_read_tokens: read, cache_write_tokens: write, call_type: callType,
  }).anomaly;
  expect(anomaly("message", 0, 10_000)).toBeUndefined();
  expect(anomaly("message", 10_000, 100)).toBeUndefined();
  expect(anomaly("dreaming", 0, 8_000)).toBeUndefined();
  expect(anomaly("dreaming_tool_loop", 8_000, 200)).toBeUndefined();
  expect(anomaly("dreaming_tool_loop", 0, 9_000)).toBe("unexpected_write");
});

function leaveNote(characterDir: string, id: string, at: number, text: string): DiaryNote {
  addDiaryNote(characterDir, { at, thread: "own-time", source: "wake", text }, () => id);
  return { id, at: new Date(at).toISOString(), thread: "own-time", source: "wake", text };
}

test("a dream ends its instructions with the diary notes no finished dream has been shown, however old they are", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(seen, () => [{ type: "text", text: "Folded the notes into MEMORY.md." }], () => {}, async ({ characterDir, runtime }) => {
    const dream = async (): Promise<string> => {
      const first = seen.length;
      runtime.autonomy.forceDreamNow("ada");
      await runtime.autonomy.tick();
      await runtime.autonomy.dreamsEnded();
      expect(lastDream(characterDir)?.outcome).toBe("finished");
      return instructionsOf(required(seen[first]));
    };
    expect(await dream()).not.toContain("[Your diary");

    const march = leaveNote(characterDir, "d1", Date.now() - 3 * DAY, "The log is read up to March.");
    const shown = await dream();
    expect(shown).toEndWith(`kept as this dream's record.\n\n${diaryText([march], DIARY_FOR_DREAM, hostZone())}`);
    expect(shown).toContain(
      "[Your diary since your last dream. Each entry says where it came from. " +
      "Fold what matters into your files, because once this dream finishes, later dreams aren't shown these entries.]\n\nyour note at the end of a wake in \"own-time\" · ",
    );

    const april = leaveNote(characterDir, "d2", Date.now() - HOUR, "April is next.");
    const later = await dream();
    expect(later).toEndWith(`kept as this dream's record.\n\n${diaryText([april], DIARY_FOR_DREAM, hostZone())}`);
    expect(later).not.toContain("up to March");

    expect(await dream()).not.toContain("[Your diary");
  });
});

test("a dream that is cut off is shown the same diary notes again next time", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(seen, (_request, round) => [
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: `dream-bash-${String(round)}`, name: "bash", input: { command: "true" } },
  ], (_app, models) => {
    models.chat.set("chat.fixture", { ...required(models.chat.get("chat.fixture")), maxToolIterations: 1 });
  }, async ({ characterDir, runtime }) => {
    const march = leaveNote(characterDir, "d1", Date.now() - HOUR, "The log is read up to March.");
    const block = diaryText([march], DIARY_FOR_DREAM, hostZone());
    runtime.autonomy.forceDreamNow("ada");
    await runtime.autonomy.tick();
    await runtime.autonomy.dreamsEnded();
    expect(lastDream(characterDir)?.outcome).toBe("cut_off");
    expect(instructionsOf(required(seen[0]))).toContain(block);
    const first = seen.length;

    runtime.autonomy.forceDreamNow("ada");
    await runtime.autonomy.tick();
    await runtime.autonomy.dreamsEnded();
    expect(instructionsOf(required(seen[first]))).toEndWith(block);
  });
});
