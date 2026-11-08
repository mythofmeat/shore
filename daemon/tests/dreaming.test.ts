import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { dreamDue, type DreamInputs } from "../src/autonomy/tick.ts";
import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { characterDataDir } from "../src/config/dirs.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { buildGenerationDeps } from "../src/handler/deps.ts";
import { runGeneration } from "../src/handler/generation.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { withDreaming } from "../src/memory/compaction/prompts.ts";
import { loadActivePromptFile } from "../src/memory/deferred_edits.ts";
import { conversationLines, conversationsSince } from "../src/memory/dreaming/manifest.ts";
import { workspaceReadCounts } from "../src/memory/dreaming/reads.ts";
import { lastDream } from "../src/memory/dreaming/records.ts";
import { createRuntime } from "../src/runtime.ts";
import { required } from "../src/util/required.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
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

  await writeFile(join(root, "config.toml"), "[dreaming]\nstart_between = \"25:00-03:00\"\n");
  expect(() => configAt(root)).toThrow(/start_between/);
});

function message(id: string, role: "user" | "assistant", text: string, timestamp: string): Message {
  return { msg_id: id, role, content: text, images: [], content_blocks: [{ type: "text", text }], alternatives: [], timestamp };
}

function putSegment(dataDir: string, archiveKey: string, idx: number, compactedAt: number, extra: { memory_before?: string; memory_after?: string; excluded?: boolean } = {}): void {
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    const at = new Date(compactedAt - HOUR).toISOString();
    store.putSegment(archiveKey, idx, {
      file: `${String(idx).padStart(4, "0")}.jsonl`,
      message_count: 2,
      compacted_at: new Date(compactedAt).toISOString(),
      ...(extra.memory_before === undefined ? {} : { memory_before: extra.memory_before }),
      ...(extra.memory_after === undefined ? {} : { memory_after: extra.memory_after }),
    }, [message(`u${archiveKey}${String(idx)}`, "user", "hello", at), message(`a${archiveKey}${String(idx)}`, "assistant", "hi", at)]);
    if (extra.excluded === true) store.setExcluded(archiveKey, idx, true);
  } finally {
    store.close();
  }
}

test("a dream is shown only what was archived since the last one, outside the heartbeat thread and not excluded", async () => {
  const dataDir = await mkdtemp(testTmp("shore-dreaming-manifest-"));
  await mkdir(join(dataDir, "ada", "threads", "main"), { recursive: true });
  const since = Date.parse("2026-11-05T00:00:00Z");
  putSegment(dataDir, "ada", 0, since - HOUR);
  putSegment(dataDir, "ada", 1, since + HOUR, { memory_before: "1111111aaaa", memory_after: "2222222bbbb" });
  putSegment(dataDir, "ada", 2, since + 2 * HOUR, { excluded: true });
  putSegment(dataDir, "ada/heartbeat", 0, since + HOUR);
  putSegment(dataDir, "ada/garden", 0, since + 3 * HOUR, { memory_before: "3333333cccc", memory_after: "3333333cccc" });

  const found = await conversationsSince(dataDir, "ada", since, new Set(["heartbeat"]));
  expect(found.map((conversation) => [conversation.thread, conversation.segment])).toEqual([["main", 1], ["garden", 0]]);
  expect(found.map((conversation) => conversation.turns)).toEqual([1, 1]);

  const lines = conversationLines(found, "eve", "2222222..HEAD").split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("thread `main`");
  expect(lines[0]).toContain("2 messages, 1 from eve.");
  expect(lines[0]).toContain("Its compaction's commits: 1111111..2222222.");
  expect(lines[1]).toContain("Its compaction changed nothing.");
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

type DreamScript = (request: SidecarRequest, round: number) => ContentBlock[];

function provider(seen: SidecarRequest[], dream: DreamScript): SidecarProvider {
  let rounds = 0;
  return {
    generate: async (request) => response(request, [{ type: "text", text: "hello" }]),
    stream: async function* (request) {
      const callType = request.context?.call_type;
      if (callType === "dreaming") {
        seen.push(structuredClone(request));
        yield* eventsForResponse(response(request, dream(request, rounds++)));
        return;
      }
      const answered = request.messages.at(-1)?.content.some((block) => block.type === "tool_result") === true;
      yield* eventsForResponse(response(request, answered
        ? [{ type: "text", text: "hello" }]
        : [{ type: "tool_use", id: "chat-read", name: "read", input: { file_path: "SOUL.md" } }]));
    },
  };
}

interface DreamWorld {
  root: string;
  config: LoadedConfig;
  workspace: string;
  characterDir: string;
  runtime: Awaited<ReturnType<typeof createRuntime>>;
}

async function afterOneChat(seen: SidecarRequest[], dream: DreamScript, tune: (app: AppConfig) => void, run: (world: DreamWorld) => Promise<void>): Promise<void> {
  setTestEnv(KEY_ENV, "fixture-key");
  const root = await mkdtemp(testTmp("shore-dreaming-"));
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.defaults.display_name = "eve";
  app.advanced.max_retries = 0;
  app.memory.compaction.enabled = false;
  app.tools.enabled_tools = ["read", "bash", "set_next_wake", "start_thread"];
  tune(app);
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY_ENV,
    maxContextTokens: 200_000, maxOutputTokens: 4096,
  });
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  await writeFile(join(workspace, "MEMORY.md"), "MEMORY before the chat\n");
  git(workspace, "init", "--quiet");
  git(workspace, "add", "--all");
  git(workspace, "commit", "--quiet", "-m", "start");
  const env = { [KEY_ENV]: "fixture-key" };
  const runtime = await createRuntime({ config, providers: { anthropic: provider(seen, dream) }, env });
  try {
    const autonomy = new TurnAutonomyBridge(runtime.autonomy);
    const deps = buildGenerationDeps({
      runtime, providers: runtime.providers, autonomy, diagnostics: new Diagnostics(), env, emitEvent: () => {},
    });
    await runGeneration(deps, {
      meta: {
        session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "main" },
        rid: "chat", kind: "message",
      },
      body: { rid: "chat", text: "hello", stream: true, images: [], image_data: [] },
      charName: "ada", regen: false, rid: "chat", signal: new AbortController().signal, send: async () => {},
    });
    await autonomy.settled("ada");
    await run({ root, config, workspace, characterDir: characterDataDir(config.dirs.data, "ada"), runtime });
  } finally {
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
  }
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
    : [{ type: "text", text: "Tidied MEMORY.md." }], () => {}, async ({ config, workspace, characterDir, runtime }) => {
    expect(await loadActivePromptFile(characterDir, "MEMORY.md", "main")).toContain("before the chat");
    await writeFile(join(workspace, "MEMORY.md"), "MEMORY as it is now\n");
    git(workspace, "commit", "--quiet", "-am", "compaction");
    const head = git(workspace, "rev-parse", "HEAD");
    putSegment(config.dirs.data, "ada", 0, Date.now() - HOUR, { memory_before: git(workspace, "rev-parse", "HEAD~1"), memory_after: head });
    expect([...workspaceReadCounts(characterDir)]).toEqual([["SOUL.md", 1]]);

    expect(runtime.autonomy.forceDreamNow("ada")).toBe(true);
    await runtime.autonomy.tick();

    const opening = required(seen[0]);
    expect(systemText(opening)).toContain("MEMORY as it is now");
    expect(systemText(opening)).not.toContain("before the chat");
    const offered = (opening.tools ?? []).map((tool) => tool.name);
    expect(offered).toContain("bash");
    expect(offered).not.toContain("set_next_wake");
    expect(offered).not.toContain("start_thread");
    const instructions = instructionsOf(opening);
    expect(instructions).toContain("thread `main`");
    expect(instructions).toContain(`..${head.slice(0, 7)}.`);
    expect(instructions).toContain("`SOUL.md`: read once");

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
    throw new Error("provider fell over");
  }, () => {}, async ({ config, characterDir, runtime }) => {
    putSegment(config.dirs.data, "ada", 0, Date.now() - HOUR);
    runtime.autonomy.forceDreamNow("ada");
    await runtime.autonomy.tick();

    expect(seen).toHaveLength(2);
    const record = required(lastDream(characterDir));
    expect(record.outcome).toBe("failed");
    expect(record.error).toBeDefined();
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
