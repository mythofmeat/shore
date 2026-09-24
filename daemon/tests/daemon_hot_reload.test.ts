import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DebounceClock,
  type DirectoryWatch,
  pathTriggersReload,
  startConfigWatcher,
} from "../src/daemon/hot_reload.ts";
import { until } from "./support/until.ts";

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

interface FakeClock {
  readonly clock: DebounceClock;
  advance: (ms: number) => void;
  armed: () => number;
}

function fakeClock(): FakeClock {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fire: () => void }>();
  return {
    clock: {
      set: (fire, ms) => {
        nextId += 1;
        timers.set(nextId, { at: now + ms, fire });
        return nextId;
      },
      clear: (handle) => {
        timers.delete(handle as number);
      },
    },
    advance: (ms) => {
      now += ms;
      const due = [...timers].filter(([, t]) => t.at <= now).sort(([, a], [, b]) => a.at - b.at);
      for (const [id, t] of due) {
        timers.delete(id);
        t.fire();
      }
    },
    armed: () => timers.size,
  };
}

interface FakeWatch {
  readonly watchDirectory: DirectoryWatch;
  change: (name: string) => void;
}

function fakeWatch(): FakeWatch {
  const listeners: ((name: string) => void)[] = [];
  return {
    watchDirectory: (_dir, onChange) => {
      listeners.push(onChange);
      return { close: () => listeners.splice(listeners.indexOf(onChange), 1) };
    },
    change: (name) => {
      for (const listener of listeners) listener(name);
    },
  };
}

async function settled(): Promise<void> {
  await Bun.sleep(0);
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
  function watched(
    reload: (paths: readonly string[]) => Promise<void>,
    debounceMs: number,
  ): { time: FakeClock; fs: FakeWatch; watcher: { stop: () => Promise<void> } } {
    const time = fakeClock();
    const fs = fakeWatch();
    const watcher = startConfigWatcher({
      configPath: FILE,
      configDir: DIR,
      reload,
      debounceMs,
      clock: time.clock,
      watchDirectory: fs.watchDirectory,
    });
    if (watcher === undefined) throw new Error("the fake watch always starts");
    stoppers.push(() => watcher.stop());
    return { time, fs, watcher };
  }

  test("a burst of edits is one reload, carrying every path", async () => {
    const reloads: string[][] = [];
    const { time, fs } = watched((paths) => {
      reloads.push([...paths]);
      return Promise.resolve();
    }, 60);

    fs.change("config.toml");
    fs.change("models.toml");
    fs.change("config.toml");
    time.advance(59);
    await settled();
    expect(reloads).toHaveLength(0);

    time.advance(1);
    await settled();
    expect(reloads).toEqual([[FILE, join(DIR, "models.toml")].sort()]);
  });

  test("events spread across the window are still one reload", async () => {
    const reloads: string[][] = [];
    const { time, fs } = watched((paths) => {
      reloads.push([...paths]);
      return Promise.resolve();
    }, 150);

    fs.change("config.toml");
    time.advance(80);
    fs.change("models.toml");
    time.advance(80);
    fs.change("config.toml");
    time.advance(149);
    await settled();
    expect(reloads).toHaveLength(0);

    time.advance(1);
    await settled();
    expect(reloads).toEqual([[FILE, join(DIR, "models.toml")].sort()]);
  });

  test("a reload queued behind a slow one is dropped when the watcher stops", async () => {
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { time, fs, watcher } = watched(async () => {
      calls += 1;
      if (calls === 1) await gate;
    }, 40);

    fs.change("config.toml");
    time.advance(40);
    await settled();
    expect(calls).toBe(1);

    fs.change("models.toml");
    time.advance(40);
    const stopping = watcher.stop();
    release();
    await stopping;
    await settled();

    expect(calls).toBe(1);
  });

  test("stop waits for a reload already in flight", async () => {
    let started = 0;
    let finished = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { time, fs, watcher } = watched(async () => {
      started += 1;
      await gate;
      finished += 1;
    }, 40);

    fs.change("config.toml");
    time.advance(40);
    await settled();
    expect(started).toBe(1);

    let stopped = false;
    const stopping = watcher.stop().then(() => {
      stopped = true;
    });
    await settled();
    expect(stopped).toBe(false);
    expect(finished).toBe(0);

    release();
    await stopping;
    expect(finished).toBe(1);
  });

  test("a workspace save does not wake it at all", () => {
    let reloads = 0;
    const { time, fs } = watched(() => {
      reloads += 1;
      return Promise.resolve();
    }, 40);

    fs.change("characters/ada/workspace/memory/facts.toml");
    fs.change("characters/ada/workspace/SOUL.md");

    expect(time.armed()).toBe(0);
    expect(reloads).toBe(0);
  });

  test("stopping stops it, including a debounce already ticking", async () => {
    let reloads = 0;
    const { time, fs, watcher } = watched(() => {
      reloads += 1;
      return Promise.resolve();
    }, 120);

    fs.change("config.toml");
    time.advance(30);
    await watcher.stop();
    time.advance(1_000);
    await settled();

    expect(reloads).toBe(0);
  });

  test("scaffolding a first character reloads on the real filesystem", async () => {
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

    await until(() => reloads.length > 0, "a reload for the new character");
    expect(reloads[0]).toContain(join(dir, "characters"));
  });

  test("a directory that is not there is a warning, not a failure", () => {
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
