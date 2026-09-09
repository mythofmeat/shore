import { readFileSync } from "./support/stored_files.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync,
  mkdirSync,
  mkdtempSync,

  rmSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CharacterRegistry } from "../src/characters.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { MAIN_THREAD, characterThreadsIndex } from "../src/config/dirs.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { ThreadError } from "../src/engine/threads.ts";
import { ForkBusy } from "../src/engine/fork.ts";
import { tryBeginCompaction } from "../src/memory/compaction/manager.ts";
import { buildSessionHistorySnapshot } from "../src/swp/handshake.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  roots.push(root);
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

describe("the registry as the thread authority", () => {
  test("a restart resumes a persisted thread and sends stale choices to the persisted home", async () => {
    const { registry, configDir, dataDir, loaded } = await registryWith("aria");
    await registry.createThread("aria", "eval");
    await registry.createThread("aria", "home");
    await registry.setHomeThread("aria", "home");

    const restarted = await CharacterRegistry.create(configDir, dataDir, loaded);
    const resumed = await buildSessionHistorySnapshot(restarted, "aria", "eval");
    expect(resumed.selectedThread).toBe("eval");

    await restarted.archiveThread("aria", "eval");
    const restartedAgain = await CharacterRegistry.create(configDir, dataDir, loaded);
    const recovered = await buildSessionHistorySnapshot(restartedAgain, "aria", "eval");
    expect(recovered.selectedThread).toBe("home");
  });

  test("a fresh character has exactly one thread, and it is home", async () => {
    const { registry } = await registryWith("aria");

    expect(registry.homeThread("aria")).toBe(MAIN_THREAD);
    expect(registry.listThreads("aria").map((t) => t.id)).toEqual([MAIN_THREAD]);
    expect(registry.threads("aria")?.home).toBe(MAIN_THREAD);
  });

  test("an unknown character reports main and no threads", async () => {
    const { registry } = await registryWith("aria");

    expect(registry.homeThread("ghost")).toBe(MAIN_THREAD);
    expect(registry.listThreads("ghost")).toEqual([]);
  });

  test("getOrCreate lands on the home thread and caches per thread", async () => {
    const { registry, dataDir } = await registryWith("aria");
    await registry.createThread("aria", "scratch");

    const home = await registry.getOrCreate("aria");
    expect(home.thread).toBe(MAIN_THREAD);
    expect(await registry.getOrCreate("aria")).toBe(home);
    expect(await registry.getOrCreate("aria", MAIN_THREAD)).toBe(home);

    const scratch = await registry.getOrCreate("aria", "scratch");
    expect(scratch).not.toBe(home);
    expect(scratch.thread).toBe("scratch");
    expect(scratch.conversationDir).toBe(join(dataDir, "aria", "threads", "scratch"));
    expect(home.conversationDir).toBe(join(dataDir, "aria", "threads", MAIN_THREAD));
    expect(scratch.characterDir).toBe(home.characterDir);
  });

  test("moving home changes which engine an unqualified call returns", async () => {
    const { registry } = await registryWith("aria");
    await registry.createThread("aria", "scratch");
    const home = await registry.getOrCreate("aria");

    await registry.setHomeThread("aria", "scratch");

    expect(registry.homeThread("aria")).toBe("scratch");
    const moved = await registry.getOrCreate("aria");
    expect(moved).not.toBe(home);
    expect(moved.thread).toBe("scratch");
  });

  test("archiving a thread drops its cached engine and its directory", async () => {
    const { registry, dataDir } = await registryWith("aria");
    await registry.createThread("aria", "scratch");
    const scratch = await registry.getOrCreate("aria", "scratch");
    expect(existsSync(scratch.conversationDir)).toBe(true);

    await registry.archiveThread("aria", "scratch");

    expect(registry.listThreads("aria").map((t) => t.id)).toEqual([MAIN_THREAD]);
    expect(existsSync(join(dataDir, "aria", "threads", "scratch"))).toBe(false);

    await registry.createThread("aria", "scratch");
    expect(await registry.getOrCreate("aria", "scratch")).not.toBe(scratch);
  });

  test.each([true, false])("thread retirement honors effective retention = %s", async (enabled) => {
    const { registry, dataDir, loaded } = await registryWith("aria");
    const effective = {
      ...loaded,
      app: { ...loaded.app, memory: { ...loaded.app.memory, retain: { ...loaded.app.memory.retain, enabled } } },
    };
    registry.setRuntimeEffectiveConfig("aria", effective);
    for (const id of ["configured", "optout"]) {
      await registry.createThread("aria", id);
      writeFileSync(join(dataDir, "aria", "threads", id, "active.jsonl"), JSON.stringify({
        msg_id: id, role: "user", content: "remember this", content_blocks: [{ type: "text", text: "remember this" }],
        timestamp: "2026-09-05T00:00:00Z", images: [],
      }) + "\n");
    }
    await registry.archiveThread("aria", "configured");
    await registry.archiveThread("aria", "optout", { retain: false });
    const store = HistoryStore.open(join(dataDir, "shore.db"));
    expect(store.entries("aria/configured")[0]?.memory_status).toBe(enabled ? "pending" : undefined);
    expect(store.entries("aria/optout")[0]?.memory_status).toBeUndefined();
    expect(store.backfillThreadArchiveRetention("aria")).toBe(0);
    store.close();
  });

  test("the home thread cannot be archived out from under the heartbeat", async () => {
    const { registry } = await registryWith("aria");

    expect(registry.archiveThread("aria", MAIN_THREAD)).rejects.toThrow(ThreadError);
    expect(registry.homeThread("aria")).toBe(MAIN_THREAD);
  });

  test("labels and last-active are visible through the registry", async () => {
    const { registry } = await registryWith("aria");
    await registry.createThread("aria", "scratch", { label: "Scratch" });

    expect(registry.listThreads("aria")[1]?.label).toBe("Scratch");
    expect(registry.listThreads("aria")[1]?.last_active).toBeUndefined();

    await registry.touchThread("aria", "scratch");
    expect(registry.listThreads("aria")[1]?.last_active).toBeDefined();
  });

  test("forking through the registry publishes the child and caches its engine apart", async () => {
    const { registry, dataDir } = await registryWith("aria");
    const home = await registry.getOrCreate("aria");
    await home.appendMessage({
      msg_id: "u1",
      role: "user",
      content: "first",
      images: [],
      content_blocks: [{ type: "text", text: "first" }],
      timestamp: "2026-09-05T00:00:00.000Z",
    });

    const result = await registry.forkThread("aria", MAIN_THREAD, "spin");

    expect(result.fork.message_count).toBe(1);
    expect(registry.listThreads("aria").map((t) => t.id)).toEqual([MAIN_THREAD, "spin"]);
    expect(registry.homeThread("aria")).toBe(MAIN_THREAD);
    const child = await registry.getOrCreate("aria", "spin");
    expect(child).not.toBe(home);
    expect(child.conversationDir).toBe(join(dataDir, "aria", "threads", "spin"));
    expect(child.messages().map((m) => m.content)).toEqual(["first"]);
  });

  test("a version stamped onto legacy context survives the cached engine's next write", async () => {
    const { registry, dataDir } = await registryWith("aria");
    const activePath = join(dataDir, "aria", "threads", MAIN_THREAD, "active.jsonl");
    mkdirSync(join(dataDir, "aria", "threads", MAIN_THREAD), { recursive: true });
    writeFileSync(
      activePath,
      `${JSON.stringify({
        msg_id: "u1",
        role: "user",
        content: "legacy",
        images: [],
        content_blocks: [{ type: "text", text: "legacy" }],
        timestamp: "2026-09-05T00:00:00.000Z",
      })}\n`,
    );

    const cached = await registry.getOrCreate("aria", MAIN_THREAD);
    expect(cached.messages().map((m) => m.version)).toEqual([undefined]);

    await registry.forkThread("aria", MAIN_THREAD, "spin");
    await cached.appendMessage({
      msg_id: "u2",
      role: "user",
      content: "later",
      images: [],
      content_blocks: [{ type: "text", text: "later" }],
      timestamp: "2026-09-05T00:01:00.000Z",
    });

    const parent = readFileSync(activePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { msg_id: string; version?: string });
    const stamped = parent.find((m) => m.msg_id === "u1")?.version;
    expect(stamped).toBeDefined();

    const child = readFileSync(
      join(dataDir, "aria", "threads", "spin", "active.jsonl"),
      "utf8",
    ).trim();
    expect((JSON.parse(child) as { version?: string }).version).toBe(stamped);
  });

  test("a fork while that character is compacting answers busy rather than half-copying", async () => {
    const { registry, dataDir } = await registryWith("aria");
    const guard = tryBeginCompaction(dataDir, "aria");
    expect(guard).toBeDefined();
    try {
      await registry.forkThread("aria", MAIN_THREAD, "spin").then(
        () => {
          throw new Error("expected the fork to be refused");
        },
        (e: unknown) => {
          expect(e).toBeInstanceOf(ForkBusy);
        },
      );
    } finally {
      guard?.release();
    }

    expect(registry.listThreads("aria").map((t) => t.id)).toEqual([MAIN_THREAD]);
    expect(existsSync(join(dataDir, "aria", "threads", "spin"))).toBe(false);

    await registry.forkThread("aria", MAIN_THREAD, "spin");
    expect(registry.listThreads("aria").map((t) => t.id)).toEqual([MAIN_THREAD, "spin"]);
  });

  test("threads of two characters stay separate", async () => {
    const { registry } = await registryWith("aria", "nova");
    await registry.createThread("aria", "scratch");

    expect(registry.listThreads("aria").map((t) => t.id)).toEqual([MAIN_THREAD, "scratch"]);
    expect(registry.listThreads("nova").map((t) => t.id)).toEqual([MAIN_THREAD]);

    const ariaScratch = await registry.getOrCreate("aria", "scratch");
    expect(ariaScratch.characterName).toBe("aria");
    expect(registry.getOrCreate("nova", "scratch")).rejects.toThrow(ThreadError);
  });

  test("a character that disappears takes its threads and engines with it", async () => {
    const { registry, configDir, loaded } = await registryWith("aria", "nova");
    await registry.createThread("nova", "scratch");
    await registry.getOrCreate("nova", "scratch");
    expect(registry.threads("nova")?.threads.length).toBe(2);

    rmSync(join(configDir, "characters", "nova"), { recursive: true, force: true });
    const summary = await registry.reloadRuntimeState(loaded);

    expect(summary.characterDiscoveryChanged).toBe(true);
    expect(summary.droppedEngines).toBe(1);
    expect(registry.threads("nova")).toBeUndefined();
    expect(registry.listThreads("nova")).toEqual([]);
    expect(registry.threads("aria")?.threads.length).toBe(1);
  });
});

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

  test("concurrent label and model edits on different threads both stick", async () => {
    const { registry, dataDir } = await registryWith("aria");
    await registry.createThread("aria", "alpha");
    await registry.createThread("aria", "beta");

    await Promise.all([
      registry.setThreadLabel("aria", "alpha", "first"),
      registry.setThreadModel("aria", "beta", "openai:gpt-4"),
      registry.setHomeThread("aria", "alpha"),
    ]);

    const onDisk = JSON.parse(
      readFileSync(characterThreadsIndex(dataDir, "aria"), "utf8"),
    ) as { home: string; threads: Array<{ id: string; label?: string; chat_model?: string }> };

    expect(onDisk.home).toBe("alpha");
    expect(onDisk.threads.find((t) => t.id === "alpha")?.label).toBe("first");
    expect(onDisk.threads.find((t) => t.id === "beta")?.chat_model).toBe("openai:gpt-4");

    const cached = registry.listThreads("aria");
    expect(cached.find((t) => t.id === "alpha")?.label).toBe("first");
    expect(cached.find((t) => t.id === "beta")?.chat_model).toBe("openai:gpt-4");
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

  test("the in-memory index matches disk after concurrent touches", async () => {
    const { registry, dataDir } = await registryWith("aria");
    await registry.createThread("aria", "alpha");

    await Promise.all([
      registry.touchThread("aria", "alpha"),
      registry.touchThread("aria", MAIN_THREAD),
      registry.setThreadLabel("aria", "alpha", "labelled"),
    ]);

    const onDisk = JSON.parse(
      readFileSync(characterThreadsIndex(dataDir, "aria"), "utf8"),
    ) as { threads: Array<{ id: string; label?: string; last_active?: string }> };

    expect(onDisk.threads.find((t) => t.id === "alpha")?.label).toBe("labelled");
    expect(onDisk.threads.every((t) => t.last_active !== undefined)).toBe(true);
    expect(registry.threads("aria")).toEqual(onDisk as never);
  });
});

const rejected = (work: Promise<unknown>): Promise<boolean> =>
  work.then(
    () => false,
    () => true,
  );

describe("a thread mutation whose client disconnects while it waits for the lock", () => {
  test("the queued create never touches the index", async () => {
    const { registry, dataDir } = await registryWith("aria");
    const controller = new AbortController();

    const holding = registry.createThread("aria", "slow", {});
    const queued = rejected(registry.createThread("aria", "abandoned", {}, controller.signal));
    controller.abort();

    await holding;
    expect(await queued).toBe(true);

    const onDisk = JSON.parse(
      readFileSync(characterThreadsIndex(dataDir, "aria"), "utf8"),
    ) as { threads: Array<{ id: string }> };

    expect(onDisk.threads.map((t) => t.id).sort()).toEqual([MAIN_THREAD, "slow"].sort());
    expect(registry.listThreads("aria").map((t) => t.id).sort()).toEqual(
      [MAIN_THREAD, "slow"].sort(),
    );
  });

  test("an abandoned label edit leaves the earlier one intact", async () => {
    const { registry, dataDir } = await registryWith("aria");
    await registry.createThread("aria", "alpha");
    const controller = new AbortController();

    const holding = registry.setThreadLabel("aria", "alpha", "kept");
    const queued = rejected(
      registry.setThreadLabel("aria", "alpha", "abandoned", controller.signal),
    );
    controller.abort();

    await holding;
    expect(await queued).toBe(true);

    const onDisk = JSON.parse(
      readFileSync(characterThreadsIndex(dataDir, "aria"), "utf8"),
    ) as { threads: Array<{ id: string; label?: string }> };
    expect(onDisk.threads.find((t) => t.id === "alpha")?.label).toBe("kept");
  });
});
