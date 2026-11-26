import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { refreshThreadPrompt, threadPrompt } from "../src/commands/thread_prompt.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { serializeMessages } from "../src/engine/message_store.ts";
import { NO_PRIOR_CONTEXT } from "../src/engine/segments.ts";
import { createThread, readThreadsIndex, setThreadPins, setThreadPurpose } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { buildGenerationRequest } from "../src/handler/setup.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
import { withStorage } from "../src/storage/store.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import { required } from "../src/util/required.ts";
import { outcomeOf } from "./support/outcome.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = "2026-11-27T10:00:00Z";

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

async function setup(files: Record<string, string> = {}) {
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
  });
  const config: LoadedConfig = { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
  const workspace = characterWorkspace(config, "frank").dir;
  for (const [path, content] of Object.entries({ "SOUL.md": "Frank keeps the lighthouse.", ...files })) {
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
  const refreshed: string[] = [];
  const context = async () => ({ config, dataDir: dirs.data, character: "frank", threads: required(await readThreadsIndex(dirs.data, "frank")).threads, refreshed: (name: string) => { refreshed.push(name); } });
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
  return { dirs, workspace, view, refresh, sent, talking, stored, refreshed };
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
    const { dirs, workspace, view, refresh, sent, talking, refreshed } = await setup({ "notes/plan.md": "Chapter three next." });
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
    expect(refreshed).toEqual([]);

    const fresh = await refresh();
    expect(refreshed).toEqual(["frank"]);
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

  test("of a thread that doesn't exist, or that isn't named, is refused", async () => {
    const { dirs, view } = await setup();
    await createThread(dirs.data, "frank", "story", NOW);
    expect(await outcomeOf(view("nowhere"))).toThrow("Thread not found: nowhere");
    expect(await outcomeOf(threadPrompt({ config: {} as LoadedConfig, dataDir: "", character: "frank", threads: [], refreshed: () => {} }, {}))).toThrow("Missing required argument: name");
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

  test("can't be given a purpose, but one it already has can be cleared", async () => {
    const { dirs } = await setup();
    await createThread(dirs.data, "frank", "story", NOW, { purpose: "Mara's winter." });
    await setThreadPurpose(dirs.data, "frank", "story", "Mara's spring.", NOW);

    expect(await outcomeOf(setThreadPurpose(dirs.data, "frank", "main", "Everything", NOW))).toThrow(`thread "main" is the home thread for frank, and the home thread's prompt shows no purpose`);
    const cleared = await setThreadPurpose(dirs.data, "frank", "main", undefined, NOW);
    expect(cleared.threads.find((thread) => thread.id === "story")?.purpose).toBe("Mara's spring.");
  });
});
