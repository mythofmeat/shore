import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { refreshThreadPrompt, threadPrompt } from "../src/commands/thread_prompt.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { serializeMessages } from "../src/engine/message_store.ts";
import { NO_PRIOR_CONTEXT } from "../src/engine/segments.ts";
import { createThread, readThreadsIndex, setThreadPins, setThreadPurpose } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { afterCommand, type DispatchContext } from "../src/handler/command_dispatch.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps } from "../src/handler/deps.ts";
import { buildGenerationRequest } from "../src/handler/setup.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import type { ThreadPromptView } from "../src/protocol/ThreadPromptView.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/connection.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
import { withStorage } from "../src/storage/store.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import { required } from "../src/util/required.ts";
import { afterFirstChat } from "./support/chat_world.ts";
import { restoreTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";
import { eventsForResponse } from "./support/stream.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = "2026-11-27T10:00:00Z";

afterEach(() => {
  setSystemTime();
  restoreTestEnv();
});

const messages: Message[] = [{
  msg_id: "u1",
  role: "user",
  content: "where were we?",
  images: [],
  content_blocks: [{ type: "text", text: "where were we?" }],
  timestamp: NOW,
}];

const SIDE_HEADER = "Files and command output pinned to this thread's prompt. Changes show up here after a long pause in this thread, or after it compacts; commands run again then.";
const HOME_HEADER = "Files and command output pinned to this thread's prompt. Changes show up here after this thread compacts; commands run again then.";

async function setup(files: Record<string, string> = {}, cacheTtl?: string) {
  const root = testTmp(`thread-prompt-${crypto.randomUUID()}`);
  const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  await mkdir(join(dirs.data, "frank"), { recursive: true });
  initializeDatabase(dirs.data);
  await writeFile(join(dirs.config, "system.md"), "{{char}} talks with {{user}}.");
  const app = promptedAppConfig();
  app.chat.display_name = "Sam";
  app.chat.model = "fixture";
  app.chat.system_prompt = "system.md";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic", sdk: "anthropic",
    modelId: "claude-fixture", apiKeyEnv: "SHORE_THREAD_PROMPT_KEY", maxContextTokens: 200_000, maxOutputTokens: 4096,
    ...(cacheTtl === undefined ? {} : { cacheTtl }),
  });
  const config: LoadedConfig = { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
  const workspace = characterWorkspace(config, "frank").dir;
  for (const [path, content] of Object.entries({ "SOUL.md": "Frank keeps the lighthouse.", ...files })) {
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
  const clock = { now: Date.parse(NOW) + 60_000 };
  const context = async () => {
    const index = required(await readThreadsIndex(dirs.data, "frank"));
    return { config, dataDir: dirs.data, character: "frank", home: index.home, threads: index.threads, now: () => clock.now };
  };
  const view = async (name = "story") => await threadPrompt(await context(), { name });
  const refresh = async (name = "story") => await refreshThreadPrompt(await context(), { name });
  const sent = async (thread = "story") => (await buildGenerationRequest({
    engine: { thread, messages: () => messages, messagesThroughLastUserTurn: () => messages, priorContext: () => NO_PRIOR_CONTEXT },
    dataDir: dirs.data,
    charName: "frank",
    config,
    resolved: required(models.chat.get("chat.fixture")),
    regen: false,
    mcpRegistry: { toolDefsFiltered: () => [] },
  })).request.system?.map(({ label, text }) => ({ label, text }));
  const talking = (thread = "story") => { writeDurable(threadFile(dirs.data, "frank", thread, "active.jsonl"), serializeMessages(messages)); };
  const stored = () => withStorage(dirs.data, (db) => db.query("SELECT path, hex(content) AS content FROM state_files ORDER BY path").all());
  return { dirs, workspace, view, refresh, sent, talking, stored, clock };
}

const shownParts = (view: Awaited<ReturnType<typeof threadPrompt>>) => view.parts.map(({ label, text }) => ({ label, text }));

describe("a thread's prompt", () => {
  test("is shown part by part as the thread's next request sends it, before its first turn and after it", async () => {
    const { dirs, view, sent, talking } = await setup({ "notes/plan.md": "Chapter three next." });
    await createThread(dirs.data, "frank", "story", NOW, { label: "The story", purpose: "Mara's winter.", pins: ["notes/plan.md"] });

    const before = await view();
    expect(before.thread).toBe("story");
    expect(before.parts.map(({ label }) => label)).toEqual(["system_prompt", "SOUL.md", "thread", "thread_pins"]);
    expect(before.parts[0]?.text).toBe("frank talks with Sam.");
    expect(before.parts[3]?.text).toBe(`${SIDE_HEADER}\n\n## notes/plan.md\n\nChapter three next.`);
    expect(before.pins).toEqual([{ pin: "notes/plan.md", bytes: 19, shown: "whole", changed: false }]);
    talking();
    expect(shownParts(before)).toEqual(required(await sent()));

    const after = await view();
    expect(shownParts(after)).toEqual(shownParts(before));
    expect(shownParts(after)).toEqual(required(await sent()));
  });

  test("runs no pinned command and writes nothing, and shows a command's output once a turn has run it", async () => {
    const { dirs, workspace, view, sent, talking, stored } = await setup();
    await createThread(dirs.data, "frank", "story", NOW, { pins: ["!echo run >> runs.log; wc -l < runs.log"] });
    talking();
    const untouched = stored();

    const fresh = await view();
    expect(fresh.pins).toEqual([{ pin: "!echo run >> runs.log; wc -l < runs.log", bytes: 0, shown: "nothing", changed: false }]);
    expect(fresh.parts.at(-1)?.text).toBe(`${SIDE_HEADER}\n\n## $ echo run >> runs.log; wc -l < runs.log\n\n(This command hasn't run yet.)`);
    expect(await Bun.file(join(workspace, "runs.log")).exists()).toBe(false);
    expect(stored()).toEqual(untouched);

    const request = required(await sent());
    const ran = await view();
    expect(shownParts(ran)).toEqual(request);
    expect(ran.pins).toEqual([{ pin: "!echo run >> runs.log; wc -l < runs.log", bytes: 1, shown: "whole", changed: false }]);
    expect(await Bun.file(join(workspace, "runs.log")).text()).toBe("run\n");
  });

  test("keeps showing what a changed file said until it is refreshed, and says which files changed", async () => {
    const { dirs, workspace, view, refresh, sent, talking } = await setup({ "notes/plan.md": "Chapter three next." });
    await createThread(dirs.data, "frank", "story", NOW, { pins: ["notes/plan.md", "!echo printed"] });
    talking();
    await sent();
    await writeFile(join(workspace, "notes", "plan.md"), "Chapter four.");
    await writeFile(join(workspace, "SOUL.md"), "Frank sails.");

    const waiting = await view();
    expect(waiting.parts.map(({ label, changed }) => [label, changed])).toEqual([["system_prompt", false], ["SOUL.md", true], ["thread", false], ["thread_pins", false]]);
    expect(waiting.parts[1]?.text).toBe("Frank keeps the lighthouse.");
    expect(waiting.parts[3]?.text).toContain("## notes/plan.md\n\nChapter three next.");
    expect(waiting.pins).toEqual([{ pin: "notes/plan.md", bytes: 19, shown: "whole", changed: true }, { pin: "!echo printed", bytes: 7, shown: "whole", changed: false }]);

    const fresh = await refresh();
    expect(fresh.parts.map(({ changed }) => changed)).toEqual([false, false, false, false]);
    expect(fresh.parts[1]?.text).toBe("Frank sails.");
    expect(fresh.pins[0]).toEqual({ pin: "notes/plan.md", bytes: 13, shown: "whole", changed: false });
    expect(shownParts(fresh)).toEqual(required(await sent()));
  });

  test("marks a file gone from the workspace as changed while the prompt still shows it, and as showing nothing once refreshed", async () => {
    const { dirs, workspace, view, refresh, sent, talking } = await setup({ "notes/plan.md": "Chapter three next." });
    await createThread(dirs.data, "frank", "story", NOW, { pins: ["notes/plan.md"] });
    talking();
    await sent();
    await Bun.file(join(workspace, "notes", "plan.md")).delete();

    expect((await view()).pins).toEqual([{ pin: "notes/plan.md", bytes: 19, shown: "whole", changed: true }]);
    expect((await refresh()).pins).toEqual([{ pin: "notes/plan.md", bytes: 0, shown: "nothing", changed: false }]);
  });

  test("marks the pins that don't fit in what a thread's pins can take together as cut or left out", async () => {
    const { dirs, view, sent, talking } = await setup();
    const printing = (bytes: number, letter: string) => `!head -c ${String(bytes)} /dev/zero | tr '\\0' ${letter}`;
    await createThread(dirs.data, "frank", "story", NOW, { pins: [printing(32 * 1024, "a"), printing(30 * 1024, "b"), printing(30 * 1024, "c"), printing(30 * 1024, "d"), printing(30 * 1024, "e"), printing(10, "f")] });
    talking();
    await sent();

    expect((await view()).pins.map(({ bytes, shown }) => [bytes, shown])).toEqual([
      [32 * 1024, "whole"], [30 * 1024, "whole"], [30 * 1024, "whole"], [30 * 1024, "whole"], [30 * 1024, "cut"], [10, "left_out"],
    ]);
  });

  test("once a side thread has been quiet for the model's cache time, an hour unless the model says otherwise, shows what the next message refreshes it to", async () => {
    for (const [cacheTtl, quiet] of [[undefined, 60], ["5m", 5]] as const) {
      const { dirs, workspace, view, sent, talking, clock } = await setup({ "notes/plan.md": "Chapter three next." }, cacheTtl);
      await createThread(dirs.data, "frank", "story", NOW, { pins: ["notes/plan.md", "!echo printed"] });
      talking();
      await sent();
      await writeFile(join(workspace, "notes", "plan.md"), "Chapter four.");
      await writeFile(join(workspace, "SOUL.md"), "Frank sails.");

      clock.now = Date.parse(NOW) + quiet * 60_000 - 1;
      const waiting = await view();
      expect(waiting.pins.map(({ bytes, shown, changed }) => [bytes, shown, changed])).toEqual([[19, "whole", true], [7, "whole", false]]);
      expect(waiting.parts.find(({ label }) => label === "SOUL.md")).toEqual({ label: "SOUL.md", text: "Frank keeps the lighthouse.", changed: true });
      clock.now += 1;
      const refreshing = await view();
      expect(refreshing.pins.map(({ bytes, shown, changed }) => [bytes, shown, changed])).toEqual([[13, "whole", false], [0, "nothing", false]]);
      expect(refreshing.parts.find(({ label }) => label === "SOUL.md")).toEqual({ label: "SOUL.md", text: "Frank sails.", changed: false });
      expect(refreshing.parts.at(-1)?.text).toBe(`${SIDE_HEADER}\n\n## notes/plan.md\n\nChapter four.\n\n## $ echo printed\n\n(This command hasn't run yet.)`);
    }
  });

  test("leaves out a prompt file that was blank when it went in, as the request does, even once the file has text", async () => {
    const { dirs, workspace, view, sent, talking } = await setup({ "SOUL.md": "  \n" });
    await createThread(dirs.data, "frank", "story", NOW);
    talking();
    expect(required(await sent()).map(({ label }) => label)).toEqual(["system_prompt", "thread"]);
    await writeFile(join(workspace, "SOUL.md"), "Frank.");

    const shown = await view();
    expect(shown.parts.map(({ label }) => label)).toEqual(["system_prompt", "thread"]);
    expect(shownParts(shown)).toEqual(required(await sent()));
  });

  test("of a thread that doesn't exist, or that isn't named, is refused", async () => {
    const { dirs, view } = await setup();
    await createThread(dirs.data, "frank", "story", NOW);
    expect(await outcomeOf(view("nowhere"))).toThrow("Thread not found: nowhere");
    expect(await outcomeOf(threadPrompt({ config: {} as LoadedConfig, dataDir: "", character: "frank", home: "main", threads: [], now: Date.now }, {}))).toThrow("Missing required argument: name");
  });
});

describe("the home thread's prompt", () => {
  test("has its pins, under a heading that says only compaction refreshes them, and no side thread's part", async () => {
    const { dirs, view, sent, talking } = await setup({ "notes/plan.md": "Chapter three next." });
    await setThreadPins(dirs.data, "frank", "main", ["notes/plan.md"], NOW);
    talking("main");

    const request = required(await sent("main"));
    expect(request.map(({ label }) => label)).toEqual(["system_prompt", "SOUL.md", "thread_pins"]);
    expect(request.at(-1)?.text).toBe(`${HOME_HEADER}\n\n## notes/plan.md\n\nChapter three next.`);
    expect(shownParts(await view("main"))).toEqual(request);
  });

  test("isn't refreshed by a long pause, so a pinned file changed since stays marked changed", async () => {
    const { dirs, workspace, view, sent, talking, clock } = await setup({ "notes/plan.md": "Chapter three next." });
    await setThreadPins(dirs.data, "frank", "main", ["notes/plan.md"], NOW);
    talking("main");
    await sent("main");
    await writeFile(join(workspace, "notes", "plan.md"), "Chapter four.");
    clock.now = Date.parse(NOW) + 2 * 60 * 60_000;

    expect((await view("main")).pins).toEqual([{ pin: "notes/plan.md", bytes: 19, shown: "whole", changed: true }]);
  });

  test("can't be given a purpose, but one it already has can be cleared", async () => {
    const { dirs } = await setup();
    await createThread(dirs.data, "frank", "story", NOW, { purpose: "Mara's winter." });
    await setThreadPurpose(dirs.data, "frank", "story", "Mara's spring.", NOW);

    expect(await outcomeOf(setThreadPurpose(dirs.data, "frank", "main", "Everything", NOW))).toThrow(`thread "main" is the home thread for frank, and the home thread's prompt shows no purpose`);
    const cleared = await setThreadPurpose(dirs.data, "frank", "main", undefined, NOW);
    expect(cleared.threads.find((thread) => thread.id === "story")?.purpose).toBe("Mara's spring.");
  });
});

describe("through the daemon", () => {
  const blocks = (system: SidecarRequest["system"]) => (system ?? []).map(({ label, text }) => ({ label, text }));

  test("a thread's prompt is what its next message sends, and after a long pause it is the prompt that message refreshes to", async () => {
    const sent: ReturnType<typeof blocks>[] = [];
    const respond = (request: SidecarRequest): GenerateResponse => {
      sent.push(blocks(request.system));
      return {
        model: request.model, content: "Noted.", content_blocks: [{ type: "text", text: "Noted." }], finish_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    };
    const provider: SidecarProvider = { generate: async (request) => respond(request), stream: async function* (request) { yield* eventsForResponse(respond(request)); } };
    setSystemTime(new Date(NOW));
    await afterFirstChat({
      name: "thread-prompt", keyEnv: "SHORE_TEST_THREAD_PROMPT_KEY", provider, tools: [],
      prepare: async (workspace) => { await mkdir(join(workspace, "notes")); await writeFile(join(workspace, "notes", "plan.md"), "Chapter three next."); },
    }, async ({ runtime, workspace, say }) => {
      const deps = buildCommandPathDeps({
        runtime, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(), router: new SessionRouter(),
        handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env: { SHORE_TEST_THREAD_PROMPT_KEY: "fixture-key" },
      });
      const command = async (name: string, args: Record<string, unknown>) => await dispatchCommand(deps, { name, args }, {
        session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "story" },
        rid: name, kind: "command",
      });
      const shown = async () => {
        const frame = await command("thread_prompt", { name: "story" });
        expect(frame).toMatchObject({ type: "command_output", name: "thread_prompt" });
        return (frame as { data: ThreadPromptView }).data;
      };
      expect(await command("create_thread", { name: "story", pins: ["[[plan]]"] })).toMatchObject({ type: "command_output" });
      await say("where were we?", "story");
      expect(shownParts(await shown())).toEqual(required(sent.at(-1)));

      await writeFile(join(workspace, "notes", "plan.md"), "Chapter four.");
      expect((await shown()).pins).toEqual([{ pin: "notes/plan.md", bytes: 19, shown: "whole", changed: true }]);

      setSystemTime(new Date(Date.parse(NOW) + 2 * 60 * 60_000));
      const later = await shown();
      expect(later.pins).toEqual([{ pin: "notes/plan.md", bytes: 13, shown: "whole", changed: false }]);
      await say("and now?", "story");
      expect(shownParts(later)).toEqual(required(sent.at(-1)));
      expect(await command("thread_prompt_refresh", { name: "story" })).toMatchObject({ type: "command_output", name: "thread_prompt_refresh", data: { thread: "story" } });
    });
  });

  test("refreshing the prompt of the thread the keepalive is warming rebuilds that thread's cached request, and of any other thread leaves it alone", async () => {
    const refreshed: unknown[][] = [];
    const context = (warm: string | undefined) => ({
      character: "ada", runtime: { warmThread: () => warm, refreshCachedRequest: (...args: unknown[]) => { refreshed.push(args); } },
    }) as unknown as DispatchContext;

    await afterCommand("thread_prompt_refresh", { name: "story" }, {}, context("story"));
    await afterCommand("thread_prompt_refresh", { name: "side" }, {}, context("story"));
    await afterCommand("thread_prompt_refresh", {}, {}, context(undefined));
    await afterCommand("thread_prompt_refresh", "story", {}, context("story"));

    expect(refreshed).toEqual([["ada", "prompt_reload", "story"]]);
  });
});
