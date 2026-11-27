import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CharacterRegistry } from "../src/characters.ts";
import { newThread, threadPins as setPinsCommand } from "../src/commands/threads.ts";
import { characterDataDir, characterThreadsIndex } from "../src/config/dirs.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { forkThread } from "../src/engine/fork.ts";
import { serializeMessages } from "../src/engine/message_store.ts";
import { assemblePrompt } from "../src/engine/prompt.ts";
import { NO_PRIOR_CONTEXT } from "../src/engine/segments.ts";
import { createThread, readThreadsIndex, threadPins, writeThreadsIndex, type ThreadsIndex } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { editCharacterThread } from "../src/handler/edit_thread.ts";
import { buildGenerationRequest } from "../src/handler/setup.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import { systemToText } from "../src/llm/types.ts";
import { applyDeferredEdits, changedPromptFiles } from "../src/memory/deferred_edits.ts";
import { exportUnifiedDatabase, importUnifiedDatabase } from "../src/storage/archive.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { readDurable, threadFile, writeDurable } from "../src/storage/files.ts";
import { shoreLog } from "../src/log.ts";
import { databasePath, readCharacterState, writeCharacterState } from "../src/storage/store.ts";
import { CharacterWorkspace, characterWorkspace } from "../src/tools/character_workspace.ts";
import { dispatchTool } from "../src/tools/dispatch.ts";
import { outcomeOf, rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";
import { required } from "../src/util/required.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";
import { Texts } from "../src/texts/texts.ts";

const NOW = "2026-11-21T10:00:00Z";

const messages: Message[] = [{
  msg_id: "u1",
  role: "user",
  content: "where were we?",
  images: [],
  content_blocks: [{ type: "text", text: "where were we?" }],
  timestamp: NOW,
}];

const resolved = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  apiKeyEnv: "SHORE_THREAD_PINS_KEY",
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
} as unknown as ResolvedModel;

async function setup(options: { files?: Record<string, string>; tools?: string[]; checkLimitMs?: number; beforeStart?: (data: string) => Promise<void> } = {}) {
  const root = testTmp(`thread-pins-${crypto.randomUUID()}`);
  const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  await mkdir(join(dirs.data, "frank"), { recursive: true });
  await options.beforeStart?.(dirs.data);
  initializeDatabase(dirs.data);
  const app = promptedAppConfig();
  app.chat.display_name = "Sam";
  app.tools.enabled = options.tools ?? [];
  if (options.checkLimitMs !== undefined) app.triggers.check_time_limit = ConfigDuration.fromMillis(options.checkLimitMs);
  const config: LoadedConfig = { app, models: emptyCatalog(), providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
  const workspace = characterWorkspace(config, "frank").dir;
  for (const [path, content] of Object.entries({ "SOUL.md": "Frank", ...options.files })) {
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
  const system = async (thread = "story"): Promise<string> => systemToText((await buildGenerationRequest({
    engine: { thread, messages: () => messages, messagesThroughLastUserTurn: () => messages, priorContext: () => NO_PRIOR_CONTEXT },
    dataDir: dirs.data,
    charName: "frank",
    config,
    resolved,
    regen: false,
    mcpRegistry: { toolDefsFiltered: () => [] },
  })).request.system);
  const talking = (thread = "story") => { writeDurable(threadFile(dirs.data, "frank", thread, "active.jsonl"), serializeMessages(messages)); };
  const refresh = async (thread = "story") => { await applyDeferredEdits(characterDataDir(dirs.data, "frank"), characterWorkspace(config, "frank"), thread); };
  return { config, dirs, workspace, system, talking, refresh };
}

const HEADER = "Files and command output pinned to this thread's prompt. Changes show up here after a long pause in this thread, or after it compacts; commands run again then.";

describe("a command pin", () => {
  test("runs in the workspace as the thread's prompt is made, and what it printed is shown under the command, after the files before it", async () => {
    const { dirs, system } = await setup({ files: { "notes/plan.md": "Chapter three next." } });
    await createThread(dirs.data, "frank", "story", NOW, { pins: ["notes/plan.md", "!cat notes/plan.md | tr a-z A-Z; echo done >&2"] });

    expect(await system()).toContain(`${HEADER}\n\n## notes/plan.md\n\nChapter three next.\n\n## $ cat notes/plan.md | tr a-z A-Z; echo done >&2\n\nCHAPTER THREE NEXT.\ndone`);
  });

  test("keeps what it printed until the thread's prompt is refreshed, and then runs again", async () => {
    const { dirs, system, talking, refresh } = await setup();
    await createThread(dirs.data, "frank", "story", NOW, { pins: ["!echo run >> runs.log; wc -l < runs.log"] });
    talking();

    const first = await system();
    expect(first).toContain("## $ echo run >> runs.log; wc -l < runs.log\n\n1");
    expect(await system()).toBe(first);

    await refresh();
    expect(await system()).toContain("## $ echo run >> runs.log; wc -l < runs.log\n\n2");
  });

  test("says how it ended when it fails, is killed, prints nothing, or runs past the time limit", async () => {
    const { dirs, system } = await setup({ checkLimitMs: 1000 });
    await createThread(dirs.data, "frank", "story", NOW, { pins: ["!echo half; exit 3", "!true", "!kill -9 $$", "!sleep 5"] });

    const shown = await system();
    expect(shown).toContain("## $ echo half; exit 3\n\nhalf\n\n(Exited with status 3.)");
    expect(shown).toContain("## $ true\n\n(The command printed nothing.)");
    expect(shown).toContain("## $ kill -9 $$\n\n(It was killed before it finished.)");
    expect(shown).toContain("## $ sleep 5\n\n(Stopped at its time limit of 1 second.)");
  });

  test("runs alongside the thread's other pins, so one waiting on another doesn't sit out the time limit", async () => {
    const { dirs, system } = await setup({ checkLimitMs: 5000 });
    await createThread(dirs.data, "frank", "story", NOW, { pins: ["!until [ -e ready ]; do sleep 0.05; done; echo saw it", "!touch ready; echo made it"] });

    const shown = await system();
    expect(shown).toContain("## $ until [ -e ready ]; do sleep 0.05; done; echo saw it\n\nsaw it");
    expect(shown).toContain("## $ touch ready; echo made it\n\nmade it");
  });

  describe("that can't be started", () => {
    afterEach(() => { spyOn(CharacterWorkspace.prototype, "run").mockRestore(); });

    test("says why", async () => {
      const { dirs, system } = await setup();
      await createThread(dirs.data, "frank", "story", NOW, { pins: ["!date"] });
      spyOn(CharacterWorkspace.prototype, "run").mockRejectedValue(new Error("no shell on this host"));

      expect(await system()).toContain("## $ date\n\n(It couldn't be run: no shell on this host.)");
    });
  });

  test("printing more than a pin holds is cut, and pins past the thread's total are cut or left out, without pointing at a file to read", async () => {
    const { dirs, system } = await setup();
    const printing = (bytes: number, letter: string) => `!head -c ${String(bytes)} /dev/zero | tr '\\0' ${letter}`;
    await createThread(dirs.data, "frank", "story", NOW, {
      pins: [printing(40 * 1024, "a"), printing(30 * 1024, "b"), printing(30 * 1024, "c"), printing(30 * 1024, "d"), printing(30 * 1024, "e"), printing(10, "f")],
    });

    const first = `${"a".repeat(32 * 1024)}\n\n[Cut at 32 KB of 40 KB.]`;
    const room = 128 * 1024 - first.length - 3 * 30 * 1024;
    const shown = await system();
    expect(shown).toContain(`## ${printing(40 * 1024, "a").replace("!", "$ ")}\n\n${first}\n\n## `);
    expect(shown).toContain(`## ${printing(30 * 1024, "e").replace("!", "$ ")}\n\n${"e".repeat(room)}\n\n[Cut: a thread's pins can be at most 128 KB together.]`);
    expect(shown).toContain(`## ${printing(10, "f").replace("!", "$ ")}\n\n(Left out: a thread's pins can be at most 128 KB together.)`);
  });

  test("printing exactly as much as a pin holds is shown whole, and pins that exactly fill the thread's total are all shown whole", async () => {
    const { dirs, system } = await setup();
    const full = (letter: string) => `!head -c 32768 /dev/zero | tr '\\0' ${letter}`;
    await createThread(dirs.data, "frank", "story", NOW, { pins: [full("w"), full("x"), full("y"), full("z")] });

    const shown = await system();
    for (const letter of ["w", "x", "y"]) expect(shown).toContain(`$ ${full(letter).slice(1)}\n\n${letter.repeat(32 * 1024)}\n\n## `);
    expect(shown).toEndWith(`## $ ${full("z").slice(1)}\n\n${"z".repeat(32 * 1024)}`);
  });

  test("that hasn't run yet says so rather than calling itself a missing file", () => {
    const { system } = assemblePrompt({
      texts: new Texts(),
      thread: { id: "story", home: "main", created_at: NOW, started_by_you: false, pins: [{ pin: "!date", content: undefined }, { pin: "notes.md", content: undefined }] },
      character_name: "frank",
      display_name: "Sam",
      sections: [{ shore: "thread_pins" }],
      has_prior_context: false,
      messages,
      max_context_tokens: 40_000,
      max_output_tokens: 1_000,
      user_timestamp_mode: "never",
    }, "UTC");

    expect(system.find((block) => block.label === "thread_pins")?.content).toBe(`${HEADER}\n\n## $ date\n\n(This command hasn't run yet.)\n\n## notes.md\n\n(This file is empty or isn't in the workspace.)`);
  });
});

describe("a thread's pinned files", () => {
  test("a file gone from the workspace when the prompt is refreshed is shown as missing, and a thread with no pins shows no pins at all", async () => {
    const { dirs, workspace, system, talking, refresh } = await setup({ files: { "notes/plan.md": "Chapter three next." } });
    await createThread(dirs.data, "frank", "story", NOW, { pins: ["notes/plan.md"] });
    await createThread(dirs.data, "frank", "bare", NOW);
    talking();
    expect(await system()).toContain("## notes/plan.md\n\nChapter three next.");

    await Bun.file(join(workspace, "notes", "plan.md")).delete();
    await refresh();
    expect(await system()).toContain("## notes/plan.md\n\n(This file is empty or isn't in the workspace.)");
    expect(await system("bare")).not.toContain(HEADER);
  });
});

describe("a forked thread's prompt", () => {
  test("shows the source's purpose, and its pins as the source last showed them, a missing file included, until the fork's own prompt is refreshed", async () => {
    const { dirs, workspace, system, talking, refresh } = await setup({ files: { "notes/plan.md": "Chapter three next." } });
    await createThread(dirs.data, "frank", "story", NOW, { purpose: "Writing the novel together.", pins: ["notes/plan.md", "notes/cast.md", "!echo run >> runs.log; wc -l < runs.log"] });
    talking();
    const source = await system();
    expect(source).toContain("## notes/plan.md\n\nChapter three next.");
    expect(source).toContain("## notes/cast.md\n\n(This file is empty or isn't in the workspace.)");
    expect(source).toContain("## $ echo run >> runs.log; wc -l < runs.log\n\n1");

    await writeFile(join(workspace, "notes", "plan.md"), "Chapter four next.");
    await forkThread(dirs.data, "frank", "story", "branch", { now: () => NOW });
    const branch = await system("branch");
    expect(branch).toContain("What this thread is for: Writing the novel together.");
    expect(branch.slice(branch.indexOf(HEADER))).toBe(source.slice(source.indexOf(HEADER)));

    await refresh("branch");
    const refreshed = await system("branch");
    expect(refreshed).toContain("## notes/plan.md\n\nChapter four next.");
    expect(refreshed).toContain("## $ echo run >> runs.log; wc -l < runs.log\n\n2");
    expect(await system()).toContain("## notes/plan.md\n\nChapter three next.");
  });
});

describe("a thread's pinned files at their limits", () => {
  test("one of exactly 32 KB can be pinned and is shown whole, and four that come to exactly 128 KB can be pinned together", async () => {
    const full = (letter: string) => letter.repeat(32 * 1024);
    const { config, system, talking } = await setup({ files: { "a.md": full("a"), "b.md": full("b"), "c.md": full("c"), "d.md": full("d") } });
    const registry = await CharacterRegistry.create(config.dirs.config, config.dirs.data, config);
    await registry.createThread("frank", "story", { pins: ["a.md", "b.md", "c.md", "d.md"] });
    talking();

    const shown = await system();
    for (const letter of ["a", "b", "c"]) expect(shown).toContain(`## ${letter}.md\n\n${full(letter)}\n\n## `);
    expect(shown).toEndWith(`## d.md\n\n${full("d")}`);
  });

  test("setting them stops when the request is cancelled, rather than reporting the files it couldn't look for", async () => {
    const { config } = await setup();
    const registry = await CharacterRegistry.create(config.dirs.config, config.dirs.data, config);
    await registry.createThread("frank", "story", {});
    const cancelled = new AbortController();
    cancelled.abort();

    expect(await rejectionOf(registry.setThreadPins("frank", "story", ["notes/missing.md"], cancelled.signal))).toBe(cancelled.signal.reason);
  });
});

describe("the user's thread commands", () => {
  async function commands() {
    const { config } = await setup({ files: { "notes.md": "Notes." } });
    const registry = await CharacterRegistry.create(config.dirs.config, config.dirs.data, config);
    return { registry, character: "frank", current: "main" };
  }

  test("make a thread with all it was given, or with only its name", async () => {
    const user = await commands();
    const made = await newThread(user, { name: "lamp", label: "The lamp", purpose: "Keep the light", pins: [" notes.md ", "", "!date"], model: "anthropic:opus", compaction: true });
    expect(made.threads.find((thread) => thread.id === "lamp")).toMatchObject({ label: "The lamp", purpose: "Keep the light", pins: ["notes.md", "!date"], chat_model: "anthropic:opus", compaction: true });

    const bare = (await newThread(user, { name: "bare", pins: null })).threads.find((thread) => thread.id === "bare");
    expect([bare?.label, bare?.purpose, bare?.pins, bare?.chat_model, bare?.compaction]).toEqual([undefined, undefined, undefined, undefined, false]);
    expect(await outcomeOf(newThread(user, { name: "lamp" }))).toThrow('thread "lamp" already exists for frank');
  });

  test("set a thread's pins, clear them when given none, and say when the thread doesn't exist", async () => {
    const user = await commands();
    await newThread(user, { name: "lamp" });

    expect((await setPinsCommand(user, { name: "lamp", pins: ["notes.md", "!date"] })).threads.find((thread) => thread.id === "lamp")?.pins).toEqual(["notes.md", "!date"]);
    expect((await setPinsCommand(user, { name: "lamp" })).threads.find((thread) => thread.id === "lamp")?.pins).toBeUndefined();
    expect(await outcomeOf(setPinsCommand(user, { name: "nowhere", pins: [] }))).toThrow('no thread "nowhere" for frank');
  });

  test("refuse pins that aren't a list of text", async () => {
    const user = await commands();
    await newThread(user, { name: "lamp" });
    for (const pins of ["notes.md", [1]]) {
      expect(await outcomeOf(newThread(user, { name: "odd", pins }))).toThrow("pins must be a list of workspace paths and !commands");
      expect(await outcomeOf(setPinsCommand(user, { name: "lamp", pins }))).toThrow("pins must be a list of workspace paths and !commands");
    }
  });
});

describe("a thread's prompt snapshot", () => {
  test("taken by a refresh before the thread's prompt was first made counts, so a prompt file changed after it is reported as waiting", async () => {
    const { config, dirs, workspace, talking, refresh } = await setup();
    await createThread(dirs.data, "frank", "story", NOW);
    talking();
    await refresh();
    await writeFile(join(workspace, "SOUL.md"), "Frank, changed.");

    expect(await changedPromptFiles(characterDataDir(dirs.data, "frank"), characterWorkspace(config, "frank"), "story")).toEqual(["SOUL.md"]);
  });
});

describe("setting pins", () => {
  test("a ! with nothing after it, a command over more than one line, or a file named with a leading ! is refused", () => {
    expect(() => threadPins(["!  "])).toThrow("a command pin has nothing after its !");
    expect(() => threadPins(["!echo one\necho two"])).toThrow('the command pin "!echo one\\necho two" must be a single line');
    expect(() => threadPins(["./!odd.md"])).toThrow("!odd.md can't be pinned, because a pin that starts with ! is a command");
  });

  test("a command is stored without the space after its !, a repeat counts once, and commands count toward the 20", () => {
    expect(threadPins(["! git log", "!git log", "notes.md"])).toEqual(["!git log", "notes.md"]);
    const many = Array.from({ length: 21 }, (_, at) => `!echo ${String(at)}`);
    expect(threadPins(many.slice(1))).toHaveLength(20);
    expect(() => threadPins(many)).toThrow("a thread can have at most 20 pins");
  });

  test("every pin that can't be set is named, and nothing changes", async () => {
    const { config } = await setup({ files: { "notes.md": "Notes." } });
    const registry = await CharacterRegistry.create(config.dirs.config, config.dirs.data, config);

    expect(await outcomeOf(registry.createThread("frank", "story", { pins: ["../secret.md", "!date", "./!odd.md", "notes.md"] })))
      .toThrow('nothing changed, because these pins can\'t be loaded:\n- the pinned file "../secret.md" leaves the workspace\n- !odd.md can\'t be pinned, because a pin that starts with ! is a command');
    expect(registry.listThreads("frank").map((thread) => thread.id)).toEqual(["main"]);
  });

  test("commands keep their places among files whose links are resolved", async () => {
    const { config } = await setup({ files: { "stories/lighthouse.md": "Mara keeps the light.", "world/INDEX.md": "The coast." } });
    const registry = await CharacterRegistry.create(config.dirs.config, config.dirs.data, config);

    await registry.createThread("frank", "story", { pins: ["!date", "[[lighthouse]]", "!uptime", "[[world/]]"] });
    expect(registry.listThreads("frank").find((thread) => thread.id === "story")?.pins).toEqual(["!date", "stories/lighthouse.md", "!uptime", "world/INDEX.md"]);
    await registry.setThreadPins("frank", "story", []);
    expect(registry.listThreads("frank").find((thread) => thread.id === "story")?.pins).toBeUndefined();
  });

  test("a character without the bash tool can't add a command, but keeps the ones the user pinned", async () => {
    const { config, dirs } = await setup({ files: { "notes.md": "Notes." }, tools: ["threads"] });
    const registry = await CharacterRegistry.create(config.dirs.config, config.dirs.data, config);
    const edit = async (input: Record<string, unknown>): Promise<unknown> =>
      await dispatchTool("threads", { action: "edit", name: "story", ...input }, await buildToolContext(config, dirs.data, "frank", {
        editThread: (character, request) => editCharacterThread({ registry }, character, request),
      }));
    await registry.createThread("frank", "story", { pins: ["!date"] });

    expect(await edit({ pins: ["!date", "notes.md"] })).toContain("pins !date, notes.md.");
    expect(await outcomeOf(edit({ pins: ["!date", "!uptime"] }))).toThrow("nothing changed, because a command pin runs in a shell and you have no bash tool: !uptime");
    expect(await outcomeOf(registry.createThread("frank", "more", { created_by: "character", pins: ["!uptime"] }))).toThrow("you have no bash tool: !uptime");
    expect((await readThreadsIndex(dirs.data, "frank"))?.threads.map((thread) => [thread.id, thread.pins])).toEqual([["main", undefined], ["story", ["!date", "notes.md"]]]);
  });

  test("a character with the bash tool can pin a command", async () => {
    const { config, dirs } = await setup({ tools: ["bash", "threads"] });
    const registry = await CharacterRegistry.create(config.dirs.config, config.dirs.data, config);
    await registry.createThread("frank", "story", { created_by: "character", pins: ["!date"] });

    await registry.editThreadAsCharacter("frank", "story", { pins: ["!date", "!uptime"] });
    expect((await readThreadsIndex(dirs.data, "frank"))?.threads.find((thread) => thread.id === "story")?.pins).toEqual(["!date", "!uptime"]);
  });
});

describe("threads from before pins", () => {
  const OLD_INDEX = {
    version: 1, home: "main",
    threads: [
      { id: "main", created_at: NOW, compaction: true },
      { id: "story", created_at: NOW, compaction: false, files: ["notes/plan.md"] },
      { id: "lamp", created_at: NOW, compaction: false, files: ["!odd.md"] },
    ],
  } as unknown as ThreadsIndex;

  test("have their files moved to pins at the first start, with what their prompts were showing, a file named with a leading ! dropped, and a list that can't be read left alone", async () => {
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    const said: string[] = [];
    const { dirs, system } = await setup({
      files: { "notes/plan.md": "Changed since." },
      beforeStart: async (data) => {
        writeDurable(characterThreadsIndex(data, "gus"), "{ not json");
        await writeThreadsIndex(data, "frank", OLD_INDEX);
        writeCharacterState(characterDataDir(data, "frank"), "threads/story/active_prompt/.snapshot", "1");
        writeCharacterState(characterDataDir(data, "frank"), "threads/story/active_prompt/thread_files/notes/plan.md", "Chapter three next.");
      },
    }).finally(() => {
      said.push(...warned.mock.calls.map((call) => String(call[0]).replace(/: SyntaxError.*$/, "")));
      warned.mockRestore();
    });
    const characterDir = characterDataDir(dirs.data, "frank");

    expect(said).toEqual([
      "shore: gus/threads.json isn't a thread list Shore can read, so its thread files weren't moved to pins",
      "shore: these thread files were left out of their threads' pins, because a pin that starts with ! is a command: !odd.md",
    ]);
    expect(readDurable(characterThreadsIndex(dirs.data, "gus"))).toBe("{ not json");

    const threads = (await readThreadsIndex(dirs.data, "frank"))?.threads;
    expect(threads?.map((thread) => [thread.id, thread.pins, "files" in thread])).toEqual([["main", undefined, false], ["story", ["notes/plan.md"], false], ["lamp", undefined, false]]);
    const moved = readDurable(characterThreadsIndex(dirs.data, "frank"));
    await writeThreadsIndex(dirs.data, "frank", required(await readThreadsIndex(dirs.data, "frank")));
    expect(readDurable(characterThreadsIndex(dirs.data, "frank"))).toBe(moved);
    expect(readCharacterState(characterDir, "threads/story/active_prompt/thread_files/notes/plan.md")).toBeUndefined();
    expect(await system()).toContain("## notes/plan.md\n\nChapter three next.");
  });

  test("are moved only once", async () => {
    const { dirs } = await setup();
    await writeThreadsIndex(dirs.data, "frank", OLD_INDEX);
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    let warnings: unknown[][] = [];
    try {
      initializeDatabase(dirs.data);
    } finally {
      warnings = [...warned.mock.calls];
      warned.mockRestore();
    }
    expect(warnings).toEqual([]);
    expect((await readThreadsIndex(dirs.data, "frank"))?.threads.find((thread) => thread.id === "story")).toMatchObject({ files: ["notes/plan.md"] });
  });

  test("in an archive from before pins are imported with pins", async () => {
    const source = await setup();
    const target = await setup();
    await writeThreadsIndex(source.dirs.data, "frank", OLD_INDEX);
    const archive = join(source.dirs.cache, "frank.db");
    exportUnifiedDatabase(databasePath(source.dirs.data), "frank", archive);

    importUnifiedDatabase(databasePath(target.dirs.data), archive, "frank");
    expect((await readThreadsIndex(target.dirs.data, "frank"))?.threads.find((thread) => thread.id === "story")?.pins).toEqual(["notes/plan.md"]);
  });
});
