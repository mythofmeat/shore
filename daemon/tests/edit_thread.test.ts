import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CharacterRegistry } from "../src/characters.ts";
import { threadLock } from "../src/commands/threads.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { readThreadsIndex, type ThreadRecord } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { editCharacterThread } from "../src/handler/edit_thread.ts";
import { buildGenerationRequest } from "../src/handler/setup.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import { dispatchTool } from "../src/tools/dispatch.ts";
import { handleListThreads } from "../src/tools/list_threads.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = "2026-11-01T10:00:00Z";

const resolved = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  apiKeyEnv: "SHORE_EDIT_THREAD_KEY",
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
} as unknown as ResolvedModel;

const messages: Message[] = [{
  msg_id: "u1",
  role: "user",
  content: "chapter two?",
  images: [],
  content_blocks: [{ type: "text", text: "chapter two?" }],
  timestamp: NOW,
}];

async function setup(files: Record<string, string>) {
  const root = testTmp(`edit-thread-${crypto.randomUUID()}`);
  const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  initializeDatabase(dirs.data);
  const app = defaultAppConfig();
  app.defaults.display_name = "Sam";
  const config: LoadedConfig = { app, models: emptyCatalog(), providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
  const workspace = characterWorkspace(config, "frank").dir;
  for (const [path, content] of Object.entries({ "SOUL.md": "Frank", ...files })) {
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
  const registry = await CharacterRegistry.create(dirs.config, dirs.data, config);
  const events: ServerMessage[] = [];
  const edit = async (input: Record<string, unknown>): Promise<unknown> =>
    await dispatchTool("edit_thread", input, await buildToolContext(config, dirs.data, "frank", {
      editThread: (character, request) => editCharacterThread({ registry, emitEvent: (event) => events.push(event) }, character, request),
    }));
  const stored = async (id: string): Promise<ThreadRecord | undefined> =>
    (await readThreadsIndex(dirs.data, "frank"))?.threads.find((thread) => thread.id === id);
  const system = async (thread: string): Promise<string> => JSON.stringify((await buildGenerationRequest({
    engine: { thread, messages: () => messages, messagesThroughLastUserTurn: () => messages, segmentCount: () => 0 },
    dataDir: dirs.data,
    charName: "frank",
    config,
    resolved,
    regen: false,
    mcpRegistry: { toolDefsFiltered: () => [] },
  })).request.system);
  return { dirs, registry, events, edit, stored, system };
}

describe("the character editing a thread", () => {
  test("sets and clears a side thread's label, purpose and files, and that thread's next turn shows them", async () => {
    const { registry, events, edit, stored, system } = await setup({
      "stories/lighthouse.md": "Mara keeps the light.",
      "cast/mara.md": "Mara, the keeper.",
    });
    await registry.createThread("frank", "story", { label: "Lighthouse", purpose: "A story.", files: ["stories/lighthouse.md"] });
    expect(await system("story")).not.toContain("Mara, the keeper.");

    expect(await edit({ name: "story", label: "The lighthouse at Brae", purpose: "Mara's winter, a chapter at a time.", files: ["stories/lighthouse.md", "[[mara]]"] }))
      .toBe('Changed the thread "story": label "The lighthouse at Brae"; purpose set; files stories/lighthouse.md, cast/mara.md. You\'ll see the change from that thread\'s next turn, the same as when Sam changes it.');
    const changed = await system("story");
    expect(changed).toContain('\\"The lighthouse at Brae\\"');
    expect(changed).toContain("Mara's winter, a chapter at a time.");
    expect(changed).toContain("Mara, the keeper.");
    expect(events).toEqual([{ type: "threads_changed", character: "frank", thread: "story" }]);

    expect(await edit({ name: "story", label: "", purpose: "", files: [] })).toContain("label cleared; purpose cleared; files cleared");
    const cleared = await system("story");
    for (const gone of ["Brae", "Mara's winter", "Mara keeps the light.", "Mara, the keeper."]) expect(cleared).not.toContain(gone);
    const record = await stored("story");
    expect([record?.label, record?.purpose, record?.files]).toEqual([undefined, undefined, undefined]);
  });

  test("a file that can't be loaded changes nothing, the label and purpose included, and the result says which and why", async () => {
    const { registry, events, edit, stored } = await setup({ "stories/lighthouse.md": "Mara keeps the light." });
    await registry.createThread("frank", "story", { label: "Lighthouse", purpose: "A story.", files: ["stories/lighthouse.md"] });
    const before = await stored("story");

    const refused = await outcomeOf(edit({ name: "story", label: "Renamed", purpose: "Something else", files: ["stories/lighthouse.md", "stories/lighthose.md"] }));
    expect(refused).toThrow("nothing changed, because a thread file can't be loaded:\n- stories/lighthose.md does not exist");
    expect(await stored("story")).toEqual(before);
    expect(registry.listThreads("frank").find((thread) => thread.id === "story")).toEqual(before);
    expect(events).toEqual([]);
  });

  test("the home thread and a thread that doesn't exist are refused, and the result says why", async () => {
    const { edit, stored } = await setup({});
    const home = await stored("main");
    expect(await outcomeOf(edit({ name: "main", label: "Home", purpose: "Everything" }))).toThrow(`thread "main" is the home thread for frank, and the home thread's prompt shows no purpose or files`);
    expect(await outcomeOf(edit({ name: "nowhere", label: "Somewhere" }))).toThrow(`no thread "nowhere" for frank`);
    expect(await stored("main")).toEqual(home);
    expect(await stored("nowhere")).toBeUndefined();
  });

  test("a thread the user locks refuses her and says so, while the user can still change it, until it's unlocked", async () => {
    const { dirs, registry, edit, stored } = await setup({});
    await registry.createThread("frank", "story", { label: "Lighthouse", purpose: "A story.", created_by: "character" });
    const user = { registry, character: "frank", current: "main" };

    expect((await threadLock(user, { name: "story", locked: true })).threads.find((thread) => thread.id === "story")?.locked).toBe(true);
    expect(await outcomeOf(edit({ name: "story", purpose: "Mine now" })))
      .toThrow('Nothing changed: Sam locked the thread "story", so its label, purpose and files change only when Sam changes them.');
    expect((await stored("story"))?.purpose).toBe("A story.");
    expect(await handleListThreads({ dataDir: dirs.data, character: "frank", userName: "Sam", timeZone: "UTC", now: () => Date.parse(NOW) }))
      .toContain('story "Lighthouse" (locked) · compaction off');

    await registry.setThreadPurpose("frank", "story", "Sam's call");
    expect(await stored("story")).toMatchObject({ purpose: "Sam's call", locked: true });

    await threadLock(user, { name: "story", locked: false });
    expect(await edit({ name: "story", purpose: "Hers again" })).toContain('Changed the thread "story": purpose set.');
    const record = await stored("story");
    expect([record?.purpose, record?.locked]).toEqual(["Hers again", undefined]);
  });
});
