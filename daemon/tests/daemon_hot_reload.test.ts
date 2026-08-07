/**
 * The config watcher, and what it refuses to notice.
 *
 * The path filter is replayed from `hot_reload.rs`'s own tests, because the
 * line it draws is a design decision rather than an implementation detail: the
 * config tree also holds every character's prompts and memory, and a save in
 * there must not become a reload.
 *
 * That is not a performance concern. A prompt file is part of the cached
 * prefix; a character writing its own memory mid-turn would otherwise
 * invalidate the cache it is talking through, and the keepalive would pay for
 * a write that buys nothing.
 *
 * The watcher itself is driven over a real directory, because the two things
 * worth knowing about it — that a burst coalesces into one reload, and that
 * stopping really stops — are both about timing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pathTriggersReload, startConfigWatcher } from "../src/daemon/hot_reload.ts";

const DIR = "/tmp/shore-test-config";
const FILE = join(DIR, "config.toml");

const stoppers: (() => void)[] = [];
/** Removed after each test: a harness runs this suite once per mutant, and
 *  `/tmp` is a tmpfs with a fixed inode budget. */
const roots: string[] = [];

afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A temp directory this suite will clean up. */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shore-watch-"));
  roots.push(root);
  return root;
}

/** Wait until `check` holds, or give up. */
async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    // The only event a *first* character produces. `create_dir_all` makes
    // `characters/<n>/workspace` faster than the recursive watcher registers a
    // watch on each new level, so nothing below `characters` is ever reported —
    // see the watcher case that drives this over a real directory.
    expect(pathTriggersReload(DIR, FILE, join(DIR, "characters"))).toBe(true);
  });

  test("SOUL.md reloads for a character the registry does not have yet", () => {
    // The file's *existence* is what makes a directory a character, so this one
    // write is not only a prompt edit.
    const known = (name: string) => name === "Alice";
    expect(
      pathTriggersReload(DIR, FILE, join(DIR, "characters/Bob/workspace/SOUL.md"), known),
    ).toBe(true);
  });

  test("SOUL.md is still ignored for a character it already has", () => {
    // The rule this exemption is carved out of, and the reason it is narrow: a
    // save must not become a prompt activation boundary, and a character
    // rewriting its own prompt must not invalidate the prefix it is talking
    // through.
    const known = (name: string) => name === "Alice";
    expect(
      pathTriggersReload(DIR, FILE, join(DIR, "characters/Alice/workspace/SOUL.md"), known),
    ).toBe(false);
    // Nothing else in the workspace is exempt, known or not.
    expect(
      pathTriggersReload(DIR, FILE, join(DIR, "characters/Bob/workspace/MEMORY.md"), known),
    ).toBe(false);
    expect(
      pathTriggersReload(DIR, FILE, join(DIR, "characters/Bob/workspace/memory/facts.toml"), known),
    ).toBe(false);
  });

  test("the config file counts wherever it is", () => {
    // `--config /etc/shore.toml` puts the file outside the tree being watched;
    // the daemon still reloads on it, because it is the file it was started
    // with. (The watcher will not *see* it there — the rule is what matters.)
    expect(pathTriggersReload(DIR, "/etc/shore.toml", "/etc/shore.toml")).toBe(true);
    expect(pathTriggersReload(DIR, FILE, "/etc/other.toml")).toBe(false);
  });

  test("everything else under the tree is left alone", () => {
    expect(pathTriggersReload(DIR, FILE, join(DIR, "notes.md"))).toBe(false);
    expect(pathTriggersReload(DIR, FILE, join(DIR, "prompts/system.md"))).toBe(false);
    expect(pathTriggersReload(DIR, FILE, join(DIR, "conf.d/README.md"))).toBe(false);
    expect(pathTriggersReload(DIR, FILE, join(DIR, ".env.example"))).toBe(false);
    // `.env` is the root *file*, not any path whose first segment is `.env`
    // and not any file called that.
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
    stoppers.push(() => watcher?.stop());

    await writeFile(configPath, "a = 1\n");
    await writeFile(join(dir, "models.toml"), "b = 2\n");
    await writeFile(configPath, "a = 2\n");

    await until(() => reloads.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // An editor writing one file produces several events and a `git checkout`
    // produces hundreds; the debounce is what turns that into one reload.
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
    stoppers.push(() => watcher?.stop());

    // Spaced wider than half the window: a debounce that armed a fresh timer
    // per event instead of resetting one would fire partway through and split
    // this into two reloads — two config loads and two full character rescans.
    await writeFile(configPath, "a = 1\n");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await writeFile(join(dir, "models.toml"), "b = 2\n");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await writeFile(configPath, "a = 2\n");

    await until(() => reloads.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toEqual([configPath, join(dir, "models.toml")].sort());
  });

  test("scaffolding a first character reloads without a restart", async () => {
    // The regression, driven the way `shore character --new` actually does it:
    // one `create_dir_all` of three levels, then the write. On Linux the
    // recursive watcher cannot register a watch on `characters/` before `<n>`
    // and `workspace/` already exist, so the ONLY event that arrives is
    // `characters` — every path below it is lost. While that path was ignored,
    // a first character stayed invisible until an unrelated edit happened to
    // trigger a reload, and the daemon had to be restarted.
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
      // No character exists yet, which is the whole point.
      knownCharacter: () => false,
      debounceMs: 60,
    });
    stoppers.push(() => watcher?.stop());

    await mkdir(join(dir, "characters", "ada", "workspace"), { recursive: true });
    await writeFile(join(dir, "characters", "ada", "workspace", "SOUL.md"), "You are ada.\n");

    await until(() => reloads.length > 0);
    // The debounce is what makes this work rather than a race: the reload runs
    // after the window, by which time `SOUL.md` is on disk and the rescan that
    // `characters` triggered can see it.
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

    // A second burst queues behind the first, which is still loading.
    await writeFile(join(dir, "models.toml"), "b = 2\n");
    await new Promise((resolve) => setTimeout(resolve, 120));

    watcher?.stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The queued one must not run: shutdown stops the watcher before the
    // registry is let go, and a reload landing after would adopt into nothing.
    expect(calls).toBe(1);
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
    stoppers.push(() => watcher?.stop());

    await writeFile(join(workspace, "facts.toml"), "x = 1\n");
    await writeFile(join(dir, "characters", "ada", "workspace", "SOUL.md"), "hi\n");
    await new Promise((resolve) => setTimeout(resolve, 250));

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
    // Inside the debounce window: the reload is armed and has not fired.
    await new Promise((resolve) => setTimeout(resolve, 30));
    watcher?.stop();
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Shutdown stops the watcher before the registry is let go; a reload that
    // landed after would be adopting into nothing.
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

    // A daemon that refused to run because it could not watch for edits would
    // be trading the service for a convenience.
    expect(watcher).toBeUndefined();
    expect(warnings).toEqual(["Config hot reload watcher could not start"]);
  });
});
