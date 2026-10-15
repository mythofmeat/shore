import { describe, expect, test } from "bun:test";
import { MAX_THREAD_ID_LENGTH, isValidThreadId, createThread, ensureThreads, readThreadsIndex } from "../src/engine/threads.ts";
import { readFileSync, readFile } from "./support/stored_files.ts";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterRegistry } from "../src/characters.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { MAIN_THREAD, characterThreadsIndex } from "../src/config/dirs.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { type LoadedConfig } from "../src/config/loader.ts";
import { writeDurable } from "../src/storage/files.ts";
import { mkdir, rm } from "node:fs/promises";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { FORK_MARKER_FILE, forkThread, recoverForks, selectForkContext } from "../src/engine/fork.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import { type ContentBlock, type Message } from "../src/engine/types.ts";
import { testTmp } from "./support/tmp.ts";
import { outcomeOf } from "./support/outcome.ts";

describe("thread ids", () => {
  test("accepts ordinary ids and rejects path-shaped ones", () => {
    expect(isValidThreadId("main")).toBe(true);
    expect(isValidThreadId("agent-sdk-eval")).toBe(true);
    expect(isValidThreadId("v1.2_scratch")).toBe(true);

    expect(isValidThreadId("")).toBe(false);
    expect(isValidThreadId(".")).toBe(false);
    expect(isValidThreadId("..")).toBe(false);
    expect(isValidThreadId("../escape")).toBe(false);
    expect(isValidThreadId("a/b")).toBe(false);
    expect(isValidThreadId("-leading")).toBe(false);
    expect(isValidThreadId("_leading")).toBe(false);
    expect(isValidThreadId("with space")).toBe(false);
    expect(isValidThreadId("a".repeat(MAX_THREAD_ID_LENGTH))).toBe(true);
    expect(isValidThreadId("a".repeat(MAX_THREAD_ID_LENGTH + 1))).toBe(false);
  });
});

function config(configDir: string, dataDir: string, root: string): LoadedConfig {
  return {
    app: defaultAppConfig(),
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs: {
      config: configDir,
      data: dataDir,
      runtime: join(root, "runtime"),
      cache: join(root, "cache"),
    },
    rawTable: undefined,
  };
}

async function registryWith(...characters: string[]): Promise<{
  registry: CharacterRegistry;
  dataDir: string;
  configDir: string;
  loaded: LoadedConfig;
}> {
  const root = mkdtempSync(join(tmpdir(), "shore-registry-threads-"));
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  for (const name of characters) {
    const dir = join(configDir, "characters", name, "workspace");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SOUL.md"), `${name} soul`);
  }
  const loaded = config(configDir, dataDir, root);
  const registry = await CharacterRegistry.create(configDir, dataDir, loaded);
  return { registry, dataDir, configDir, loaded };
}

describe("concurrent thread-index mutations", () => {
  test("two threads created at once both survive on disk and in the registry", async () => {
    const { registry, dataDir } = await registryWith("aria");

    await Promise.all([
      registry.createThread("aria", "alpha"),
      registry.createThread("aria", "beta"),
    ]);

    const onDisk = JSON.parse(
      readFileSync(characterThreadsIndex(dataDir, "aria"), "utf8"),
    ) as { threads: Array<{ id: string }> };

    expect(onDisk.threads.map((t) => t.id).sort()).toEqual([MAIN_THREAD, "alpha", "beta"].sort());
    expect(registry.listThreads("aria").map((t) => t.id).sort()).toEqual(
      [MAIN_THREAD, "alpha", "beta"].sort(),
    );
  });

  test("a create racing an archive leaves the index consistent", async () => {
    const { registry, dataDir } = await registryWith("aria");
    await registry.createThread("aria", "doomed");

    await Promise.all([
      registry.createThread("aria", "fresh"),
      registry.archiveThread("aria", "doomed"),
    ]);

    const onDisk = JSON.parse(
      readFileSync(characterThreadsIndex(dataDir, "aria"), "utf8"),
    ) as { threads: Array<{ id: string }> };

    expect(onDisk.threads.map((t) => t.id).sort()).toEqual([MAIN_THREAD, "fresh"].sort());
    expect(registry.listThreads("aria").map((t) => t.id).sort()).toEqual(
      [MAIN_THREAD, "fresh"].sort(),
    );
  });
});

const NOW = "2026-09-05T12:00:00.000Z";

let counter = 0;

async function freshDataDir(): Promise<string> {
  counter += 1;
  const dir = testTmp(`fork-${String(counter)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

function message(partial: Partial<Message> & Pick<Message, "msg_id" | "role">): Message {
  const blocks = partial.content_blocks ?? [{ type: "text", text: partial.content ?? "" }];
  return {
    content: partial.content ?? "",
    images: [],
    timestamp: NOW,
    ...partial,
    content_blocks: blocks,
  };
}

function user(id: string, text: string): Message {
  return message({ msg_id: id, role: "user", content: text });
}

function assistant(id: string, text: string, extra: Partial<Message> = {}): Message {
  return message({ msg_id: id, role: "assistant", content: text, ...extra });
}

function toolUse(id: string, useId: string): Message {
  const blocks: ContentBlock[] = [{ type: "tool_use", id: useId, name: "read", input: {} }];
  return message({ msg_id: id, role: "assistant", content_blocks: blocks });
}

function toolResult(id: string, useId: string): Message {
  const blocks: ContentBlock[] = [
    { type: "tool_result", tool_use_id: useId, content: "ok" },
  ];
  return message({ msg_id: id, role: "user", content_blocks: blocks });
}

async function seed(root: string, character: string, thread: string, messages: Message[]) {
  await ensureThreads(root, character, NOW);
  if (thread !== "main") await createThread(root, character, thread, NOW);
  const path = join(root, character, "threads", thread, "active.jsonl");
  const store = await MessageStore.load(path);
  for (const msg of messages) await store.append(msg);
  return path;
}

async function readMessages(path: string): Promise<Message[]> {
  const store = await MessageStore.load(path);
  return [...store.messages()];
}

describe("choosing what a fork copies", () => {

  test("a tool exchange travels whole, results attached to the call that made them", () => {
    const messages = [
      user("u1", "one"),
      assistant("a1", "reply one"),
      user("u2", "two"),
      toolUse("a2", "call-1"),
      toolResult("r2", "call-1"),
      assistant("a3", "reply two"),
    ];
    const selected = selectForkContext(messages, 1);
    expect(selected.map((m) => m.msg_id)).toEqual(["u2", "a2", "r2", "a3"]);
  });
});

describe("forking a thread", () => {
  test("the child holds a copy the parent can no longer change", async () => {
    const root = await freshDataDir();
    const path = await seed(root, "ada", "main", [
      user("u1", "first"),
      assistant("a1", "reply"),
    ]);

    const result = await forkThread(root, "ada", "main", "spin", { now: () => NOW });
    expect(result.fork.message_count).toBe(2);
    expect(result.fork.turn_count).toBe(1);

    const parent = await MessageStore.load(path);
    await parent.edit("u1", "rewritten");
    await parent.append(user("u2", "later"));

    const child = await readMessages(join(root, "ada", "threads", "spin", "active.jsonl"));
    expect(child.map((m) => m.content)).toEqual(["first", "reply"]);
  });

  test("a directory that already holds data is never overwritten", async () => {
    const root = await freshDataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);
    const squatter = join(root, "ada", "threads", "spin");
    await mkdir(squatter, { recursive: true });
    writeDurable(join(squatter, "active.jsonl"), "keep me\n");

    expect(await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW }))).toThrow(
      /already holds data/,
    );
    expect(await readFile(join(squatter, "active.jsonl"), "utf8")).toBe("keep me\n");
  });
});

describe("recovering an interrupted fork", () => {
  test("a failure before the registry publishes leaves no child and no provenance", async () => {
    const root = await freshDataDir();
    const path = await seed(root, "ada", "main", [user("u1", "first")]);

    expect(
      await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW, failAfter: "provenance" })),
    ).toThrow(/injected/);

    expect(existsSync(join(root, "ada", "threads", "spin", FORK_MARKER_FILE))).toBe(true);
    expect(await recoverForks(root, "ada")).toEqual(["spin"]);
    expect(existsSync(join(root, "ada", "threads", "spin"))).toBe(false);
    expect((await readThreadsIndex(root, "ada"))?.threads.map((t) => t.id)).toEqual(["main"]);

    const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
    try {
      expect(store.threadForks("ada")).toEqual([]);
    } finally {
      store.close();
    }
    expect(await readMessages(path)).toHaveLength(1);
  });

  test("a crash before the context is written leaves the source untouched", async () => {
    const root = await freshDataDir();
    const path = await seed(root, "ada", "main", [user("u1", "first")]);

    expect(
      await outcomeOf(forkThread(root, "ada", "main", "spin", { now: () => NOW, failAfter: "context" })),
    ).toThrow(/injected/);

    await recoverForks(root, "ada");
    expect(existsSync(join(root, "ada", "threads", "spin"))).toBe(false);
    expect(await readMessages(path)).toHaveLength(1);
  });

  test("two forks racing for the same name leave exactly one thread", async () => {
    const root = await freshDataDir();
    await seed(root, "ada", "main", [user("u1", "first")]);

    const outcomes = await Promise.allSettled([
      forkThread(root, "ada", "main", "spin", { now: () => NOW }),
      forkThread(root, "ada", "main", "spin", { now: () => NOW }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((await readThreadsIndex(root, "ada"))?.threads.map((t) => t.id)).toEqual(["main", "spin"]);
  });
});
