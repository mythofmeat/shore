import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { pathTriggersReload, startConfigWatcher, type DebounceClock, type DirectoryWatch } from "../src/daemon/hot_reload.ts";

const CONFIG = "/srv/shore/config";
const CONFIG_PATH = join(CONFIG, "config.toml");

describe("which changes reload the config", () => {
  test.each([
    [CONFIG_PATH, true],
    ["/elsewhere/shore.toml", false],
    [CONFIG, false],
    [join(CONFIG, ".env"), true],
    [join(CONFIG, "sub", ".env"), false],
    [join(CONFIG, "conf.d"), true],
    [join(CONFIG, "conf.d", "keys.toml"), true],
    [join(CONFIG, "conf.d", "notes.txt"), false],
    [join(CONFIG, "characters"), true],
    [join(CONFIG, "characters", "ada"), true],
    [join(CONFIG, "characters", "ada", "config.toml"), true],
    [join(CONFIG, "characters", "ada", "character.md"), true],
    [join(CONFIG, "characters", "ada", "avatar.png"), false],
    [join(CONFIG, "characters", "ada", "prompts", "extra.toml"), true],
    [join(CONFIG, "characters", "ada", "prompts", "wake.md"), false],
    [join(CONFIG, "characters", "ada", "workspace"), false],
    [join(CONFIG, "characters", "ada", "workspace", "SOUL.md"), false],
    [join(CONFIG, "characters", "ada", "workspace", "TRIGGERS.toml"), false],
    [join(CONFIG, "other.toml"), true],
    [join(CONFIG, "prompts", "wake.md"), false],
    [join(CONFIG, "prompts"), false],
    [`${CONFIG}/./.env`, true],
    [`${CONFIG}//conf.d/keys.toml`, true],
  ])("%s → %p", (path, reloads) => {
    expect(pathTriggersReload(CONFIG, CONFIG_PATH, path)).toBe(reloads);
  });

  test("the config file reloads wherever it is, and the config directory itself never does, whatever it is called", () => {
    expect(pathTriggersReload(CONFIG, "/etc/shore/main.conf", "/etc/shore/main.conf")).toBe(true);
    expect(pathTriggersReload("/srv/conf.toml", "/srv/conf.toml/config.toml", "/srv/conf.toml")).toBe(false);
  });

  test("a relative config directory and path are taken from the working directory", () => {
    expect(pathTriggersReload("config", "config/config.toml", resolve("config", "config.toml"))).toBe(true);
    expect(pathTriggersReload("config", "config/config.toml", resolve("config", "characters", "bo"))).toBe(true);
  });
});

interface Harness {
  reloads: string[][];
  logs: string[];
  delays: number[];
  due: () => (() => void)[];
  fire: () => void;
  pending: () => number;
  change: (name: string) => void;
  fail: (error: unknown) => void;
  closed: () => boolean;
}

function harness(reload?: (paths: readonly string[]) => Promise<void>): Harness & { watcher: ReturnType<typeof startConfigWatcher> } {
  const timers = new Map<number, () => void>();
  let next = 0;
  const delays: number[] = [];
  const clock: DebounceClock = {
    set: (fire, ms) => { delays.push(ms); timers.set(++next, fire); return next; },
    clear: (handle) => { timers.delete(handle as number); },
  };
  let onChange: (name: string) => void = () => {};
  let onError: (error: unknown) => void = () => {};
  let closed = false;
  const watched: string[] = [];
  const watchDirectory: DirectoryWatch = (dir, change, error) => {
    watched.push(dir);
    onChange = change;
    onError = error;
    return { close: () => { closed = true; } };
  };
  const reloads: string[][] = [];
  const logs: string[] = [];
  const watcher = startConfigWatcher({
    configPath: CONFIG_PATH,
    configDir: CONFIG,
    reload: reload ?? (async (paths) => { reloads.push([...paths]); }),
    log: {
      info: (msg, fields) => logs.push(`info ${msg} ${JSON.stringify(fields ?? {})}`),
      warn: (msg, fields) => logs.push(`warn ${msg} ${JSON.stringify(fields ?? {})}`),
    },
    debounceMs: 25,
    clock,
    watchDirectory,
  });
  expect(watched).toEqual([CONFIG]);
  return {
    watcher,
    reloads,
    logs,
    delays,
    due: () => [...timers.values()],
    fire: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const run of due) run();
    },
    pending: () => timers.size,
    change: (name) => onChange(name),
    fail: (error) => onError(error),
    closed: () => closed,
  };
}

const settle = () => new Promise<void>((_resolve) => { setTimeout(_resolve, 0); });

describe("the config watcher", () => {
  test("says it started, and reloads once for a burst of changes, with each changed path once, in order", async () => {
    const h = harness();
    expect(h.logs).toEqual([`info Config hot reload watcher started {"config_path":"${CONFIG_PATH}","config_dir":"${CONFIG}"}`]);
    h.change("conf.d/b.toml");
    h.change("config.toml");
    h.change("conf.d/b.toml");
    h.change("prompts/wake.md");
    expect(h.pending()).toBe(1);
    expect(h.delays).toEqual([25, 25, 25]);
    h.fire();
    await settle();
    expect(h.reloads).toEqual([[join(CONFIG, "conf.d", "b.toml"), CONFIG_PATH]]);

    h.fire();
    await settle();
    expect(h.reloads).toHaveLength(1);
  });

  test("a change that reloads nothing sets no timer", () => {
    const h = harness();
    h.change("prompts/wake.md");
    h.change("characters/ada/workspace/notes.toml");
    expect(h.pending()).toBe(0);
  });

  test("runs one reload at a time, and a reload that throws is logged and leaves the next one to run", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    let calls = 0;
    const h = harness(async (paths) => {
      calls++;
      order.push(`start ${paths.join(",")}`);
      if (calls === 1) await new Promise<void>((_resolve) => { release = _resolve; });
      if (calls === 2) throw new Error("bad toml");
      order.push(`end ${paths.join(",")}`);
    });
    h.change("config.toml");
    h.fire();
    await settle();
    h.change("conf.d/a.toml");
    h.fire();
    await settle();
    expect(order).toEqual([`start ${CONFIG_PATH}`]);
    release();
    await settle();
    await settle();
    h.change("characters/ada");
    h.fire();
    await settle();
    await settle();
    expect(order).toEqual([
      `start ${CONFIG_PATH}`, `end ${CONFIG_PATH}`,
      `start ${join(CONFIG, "conf.d", "a.toml")}`,
      `start ${join(CONFIG, "characters", "ada")}`, `end ${join(CONFIG, "characters", "ada")}`,
    ]);
    expect(h.logs).toContain('warn Config hot reload threw {"error":"Error: bad toml"}');
  });

  test("a watcher error is logged", () => {
    const h = harness();
    h.fail(new Error("too many files"));
    expect(h.logs.at(-1)).toBe('warn Config hot reload watcher error {"error":"Error: too many files"}');
  });

  test("stopping drops a pending change, closes the watch, waits for a reload under way, and says so", async () => {
    let release: () => void = () => {};
    const seen: string[][] = [];
    const h = harness(async (paths) => {
      seen.push([...paths]);
      await new Promise<void>((_resolve) => { release = _resolve; });
    });
    h.change("config.toml");
    h.fire();
    await settle();
    h.change("conf.d/a.toml");
    expect(h.pending()).toBe(1);

    let stopped = false;
    const stopping = h.watcher?.stop().then(() => { stopped = true; });
    expect(h.pending()).toBe(0);
    expect(h.closed()).toBe(true);
    await settle();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(h.logs.at(-1)).toBe("info Config hot reload watcher stopped {}");

    h.change("config.toml");
    h.fire();
    await settle();
    expect(seen).toEqual([[CONFIG_PATH]]);
  });

  test("a change that comes due as it stops does not reload, nor does one queued behind a reload under way", async () => {
    const h = harness();
    h.change("config.toml");
    const due = h.due();
    await h.watcher?.stop();
    for (const run of due) run();
    await settle();
    expect(h.reloads).toEqual([]);

    let release: () => void = () => {};
    const seen: string[][] = [];
    const busy = harness(async (paths) => {
      seen.push([...paths]);
      if (seen.length === 1) await new Promise<void>((_resolve) => { release = _resolve; });
    });
    busy.change("config.toml");
    busy.fire();
    await settle();
    busy.change("conf.d/a.toml");
    busy.fire();
    const stopping = busy.watcher?.stop();
    release();
    await stopping;
    expect(seen).toEqual([[CONFIG_PATH]]);
  });

  test("a watch that can't start is logged, and there is no watcher", () => {
    const logs: string[] = [];
    const watcher = startConfigWatcher({
      configPath: CONFIG_PATH,
      configDir: CONFIG,
      reload: async () => {},
      log: { warn: (msg, fields) => logs.push(`${msg} ${JSON.stringify(fields ?? {})}`) },
      watchDirectory: () => { throw new Error("ENOSPC"); },
    });
    expect(watcher).toBeUndefined();
    expect(logs).toEqual([`Config hot reload watcher could not start {"config_dir":"${CONFIG}","error":"Error: ENOSPC"}`]);
  });
});
