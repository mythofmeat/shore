import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CharacterRegistry } from "../src/characters.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { MAIN_THREAD } from "../src/config/dirs.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { ThreadError } from "../src/engine/threads.ts";

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
