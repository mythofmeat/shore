
import { readFileSync } from "./support/stored_files.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CharacterRegistry } from "../src/characters.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { MAIN_THREAD, characterThreadsIndex } from "../src/config/dirs.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";

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
