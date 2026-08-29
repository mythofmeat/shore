import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pathTriggersReload, startConfigWatcher } from "../src/daemon/hot_reload.ts";

const DIR = "/tmp/shore-test-config";
const FILE = join(DIR, "config.toml");

const stoppers: (() => Promise<void>)[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shore-watch-"));
  roots.push(root);
  return root;
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("which paths are config", () => {
  test("the supported inputs", () => {
    expect(pathTriggersReload(DIR, FILE, join(DIR, "config.toml"))).toBe(true);
    expect(pathTriggersReload(DIR, FILE, join(DIR, ".env"))).toBe(true);
    expect(pathTriggersReload(DIR, FILE, join(DIR, "models.toml"))).toBe(true);
    expect(pathTriggersReload(DIR, FILE, join(DIR, "conf.d/models.toml"))).toBe(true);
    expect(pathTriggersReload(DIR, FILE, join(DIR, "characters/Alice/config.toml"))).toBe(true);
  });

  test("a character's prompts and memory are not", () => {
    expect(pathTriggersReload(DIR, FILE, join(DIR, "characters/Alice/workspace/SOUL.md"))).toBe(
      false,
    );
    expect(
      pathTriggersReload(DIR, FILE, join(DIR, "characters/Alice/workspace/memory/facts.toml")),
    ).toBe(false);
    expect(pathTriggersReload(DIR, FILE, join(DIR, "characters/Alice/workspace/MEMORY.md"))).toBe(
      false,
    );
  });

  test("a character appearing or going is", () => {
    expect(pathTriggersReload(DIR, FILE, join(DIR, "characters/Alice"))).toBe(true);
    expect(pathTriggersReload(DIR, FILE, join(DIR, "characters/Alice/character.md"))).toBe(true);
  });

  test("so is the characters directory itself", () => {
    expect(pathTriggersReload(DIR, FILE, join(DIR, "characters"))).toBe(true);
  });

  test("SOUL.md reloads for a character the registry does not have yet", () => {
    const known = (name: string) => name === "Alice";
    expect(
      pathTriggersReload(DIR, FILE, join(DIR, "characters/Bob/workspace/SOUL.md"), known),
    ).toBe(true);
  });

  test("SOUL.md is still ignored for a character it already has", () => {
    const known = (name: string) => name === "Alice";
    expect(
      pathTriggersReload(DIR, FILE, join(DIR, "characters/Alice/workspace/SOUL.md"), known),
    ).toBe(false);
    expect(
      pathTriggersReload(DIR, FILE, join(DIR, "characters/Bob/workspace/MEMORY.md"), known),
    ).toBe(false);
    expect(
      pathTriggersReload(DIR, FILE, join(DIR, "characters/Bob/workspace/memory/facts.toml"), known),
    ).toBe(false);
  });

  test("the config file counts wherever it is", () => {
    expect(pathTriggersReload(DIR, "/etc/shore.toml", "/etc/shore.toml")).toBe(true);
    expect(pathTriggersReload(DIR, FILE, "/etc/other.toml")).toBe(false);
  });

  test("everything else under the tree is left alone", () => {
    expect(pathTriggersReload(DIR, FILE, join(DIR, "notes.md"))).toBe(false);
    expect(pathTriggersReload(DIR, FILE, join(DIR, "prompts/system.md"))).toBe(false);
    expect(pathTriggersReload(DIR, FILE, join(DIR, "conf.d/README.md"))).toBe(false);
    expect(pathTriggersReload(DIR, FILE, join(DIR, ".env.example"))).toBe(false);
    expect(pathTriggersReload(DIR, FILE, join(DIR, "characters/Alice/.env"))).toBe(false);
    expect(pathTriggersReload(DIR, FILE, join(DIR, ".env/notes"))).toBe(false);
  });
});

describe("the watcher", () => {
  test("a burst of edits is one reload, carrying every path", async () => {
    const dir = await tempRoot();
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, "");
    const reloads: string[][] = [];

    const watcher = startConfigWatcher({
      configPath,
      configDir: dir,
      reload: (paths) => {
        reloads.push([...paths]);
        return Promise.resolve();
      },
      debounceMs: 60,
    });
    expect(watcher).toBeDefined();
    stoppers.push(async () => { await watcher?.stop(); });

    await writeFile(configPath, "a = 1\n");
    await writeFile(join(dir, "models.toml"), "b = 2\n");
    await writeFile(configPath, "a = 2\n");

    await until(() => reloads.length > 0);
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toEqual([configPath, join(dir, "models.toml")].sort());
  });

  test("events spread across the window are still one reload", async () => {
    const dir = await tempRoot();
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, "");
    const reloads: string[][] = [];

    const watcher = startConfigWatcher({
      configPath,
      configDir: dir,
      reload: (paths) => {
        reloads.push([...paths]);
        return Promise.resolve();
      },
      debounceMs: 150,
    });
    stoppers.push(async () => { await watcher?.stop(); });

    await writeFile(configPath, "a = 1\n");
    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    await writeFile(join(dir, "models.toml"), "b = 2\n");
    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    await writeFile(configPath, "a = 2\n");

    await until(() => reloads.length > 0);
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });

    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toEqual([configPath, join(dir, "models.toml")].sort());
  });

  test("scaffolding a first character reloads without a restart", async () => {
    const dir = await tempRoot();
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, "");
    const reloads: string[][] = [];

    const watcher = startConfigWatcher({
      configPath,
      configDir: dir,
      reload: (paths) => {
        reloads.push([...paths]);
        return Promise.resolve();
      },
      knownCharacter: () => false,
      debounceMs: 60,
    });
    stoppers.push(async () => { await watcher?.stop(); });

    await mkdir(join(dir, "characters", "ada", "workspace"), { recursive: true });
    await writeFile(join(dir, "characters", "ada", "workspace", "SOUL.md"), "You are ada.\n");

    await until(() => reloads.length > 0);
    expect(reloads[0]).toContain(join(dir, "characters"));
  });

  test("a reload queued behind a slow one is dropped when the watcher stops", async () => {
    const dir = await tempRoot();
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, "");
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const watcher = startConfigWatcher({
      configPath,
      configDir: dir,
      reload: async () => {
        calls += 1;
        if (calls === 1) await gate;
      },
      debounceMs: 40,
    });

    await writeFile(configPath, "a = 1\n");
    await until(() => calls === 1);

    await writeFile(join(dir, "models.toml"), "b = 2\n");
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });

    const stopping = watcher?.stop();
    release();
    await stopping;
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    expect(calls).toBe(1);
  });

  test("stop waits for a reload already in flight", async () => {
    const dir = await tempRoot();
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, "");
    let started = 0;
    let finished = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const watcher = startConfigWatcher({
      configPath,
      configDir: dir,
      reload: async () => {
        started += 1;
        await gate;
        finished += 1;
      },
      debounceMs: 40,
    });

    await writeFile(configPath, "a = 1\n");
    await until(() => started === 1);

    let stopped = false;
    const stopping = (watcher?.stop() ?? Promise.resolve()).then(() => {
      stopped = true;
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(stopped).toBe(false);
    expect(finished).toBe(0);

    release();
    await stopping;
    expect(finished).toBe(1);
  });

  test("a workspace save does not wake it at all", async () => {
    const dir = await tempRoot();
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, "");
    const workspace = join(dir, "characters", "ada", "workspace", "memory");
    await mkdir(workspace, { recursive: true });
    let reloads = 0;

    const watcher = startConfigWatcher({
      configPath,
      configDir: dir,
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
      debounceMs: 40,
    });
    stoppers.push(async () => { await watcher?.stop(); });

    await writeFile(join(workspace, "facts.toml"), "x = 1\n");
    await writeFile(join(dir, "characters", "ada", "workspace", "SOUL.md"), "hi\n");
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(reloads).toBe(0);
  });

  test("stopping stops it, including a debounce already ticking", async () => {
    const dir = await tempRoot();
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, "");
    let reloads = 0;

    const watcher = startConfigWatcher({
      configPath,
      configDir: dir,
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
      debounceMs: 120,
    });

    await writeFile(configPath, "a = 1\n");
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    await watcher?.stop();
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(reloads).toBe(0);
  });

  test("a directory that is not there is a warning, not a failure", async () => {
    const warnings: string[] = [];
    const watcher = startConfigWatcher({
      configPath: "/definitely/missing/config.toml",
      configDir: "/definitely/missing",
      reload: () => Promise.resolve(),
      log: { warn: (msg) => warnings.push(msg) },
    });

    expect(watcher).toBeUndefined();
    expect(warnings).toEqual(["Config hot reload watcher could not start"]);
  });
});
