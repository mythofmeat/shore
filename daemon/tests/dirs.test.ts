/**
 * Recorded cases for dirs.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import fixture from "./config_fixtures/dirs.json" with { type: "json" };

import {
  characterActiveJsonl,
  characterCompactionManifest,
  characterConfigDir,
  characterDataDir,
  characterMemoryDir,
  characterSegmentsDir,
  characterWorkspaceDir,
  characterWorkspaceFile,
  discoverCharacters,
  loadCharacterDefinition,
  pluginsDir,
  resolvePromptTemplate,
  NoHomeDirectoryError,
  resolveShoreDirs,
  resolveUserDefinition,
  rustJoin,
  type Env,
} from "../src/config/dirs.ts";
import {
  ConfigError,
  deepMerge,
  loadCharacterConfigTable,
  loadRawConfigTable,
  parentOf,
  type ConfigErrorKind,
} from "../src/config/loader.ts";

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "dirs-parity-"));
  roots.push(dir);
  return dir;
}

/** Rebuild a case's scripted tree under a fresh root. */
function build(files: { path: string; content: string }[], dirs: string[] = []): string {
  const root = scratch();
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const f of files) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.content);
  }
  return root;
}

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const passwdHome = () => fixture.passwd_home as string;

describe("the fixture is real", () => {

  test("it names `main` as its source, not the worktree", () => {
    expect(fixture._header.join(" ")).toContain("GENERATED from `main`");
  });
});

describe("ShoreDirs.resolve", () => {
  for (const c of fixture.shore_dirs) {
    test(c.name, () => {
      const got = resolveShoreDirs(c.env as Env, passwdHome);
      expect(got.config).toBe(c.config);
      expect(got.data).toBe(c.data);
      expect(got.runtime).toBe(c.runtime);
      expect(got.cache).toBe(c.cache);
    });
  }

  test("the cases cover both the override and the platform branch", () => {
    // A fixture of only-SHORE_* cases would pass against a resolver that
    // ignored XDG entirely, and vice versa.
    const names = fixture.shore_dirs.map((c) => c.name).join(" ");
    expect(names).toContain("SHORE_*");
    expect(names).toContain("platform defaults");
    const withoutAnyEnv = fixture.shore_dirs.filter(
      (c) => Object.keys(c.env).length === 0,
    );
    expect(withoutAnyEnv.length).toBeGreaterThan(0);
  });
});

describe("ShoreDirs.resolve, where the fixture cannot reach", () => {
  // Not fixture-generated: the generator cannot run as an account with no
  // passwd entry, so this branch is pinned by construction rather than by
  // replay. It used to assert the Rust's literals faithfully — `config` came
  // back as `"~/.config/shore"`, a *relative* path whose first component is a
  // directory literally named `~`, created wherever the process started.
  // Nothing on either side expands a tilde, so that was never a home
  // directory; #45 replaced it with a refusal.

  test("with no HOME and no passwd entry, resolution refuses", () => {
    expect(() => resolveShoreDirs({}, () => undefined)).toThrow(NoHomeDirectoryError);
  });

  test("the refusal says which variables would fix it", () => {
    // The message is the entire user interface of this failure: whoever hits it
    // is inside a container wondering why shore will not start.
    let message = "";
    try {
      resolveShoreDirs({}, () => undefined);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("SHORE_CONFIG_DIR");
    expect(message).toContain("XDG_CONFIG_HOME");
    expect(message).toContain("passwd");
  });

  test("an override is enough on its own, with no home anywhere", () => {
    // The escape hatch the message points at has to actually work — and it has
    // to work for each directory independently, since they refuse independently.
    const got = resolveShoreDirs(
      {
        SHORE_CONFIG_DIR: "/srv/cfg",
        SHORE_DATA_DIR: "/srv/data",
        SHORE_CACHE_DIR: "/srv/cache",
      },
      () => undefined,
    );
    expect(got.config).toBe("/srv/cfg");
    expect(got.data).toBe("/srv/data");
    expect(got.cache).toBe("/srv/cache");
    // runtime never refuses: the temp dir is a correct answer for it.
    expect(got.runtime).toBe(join(tmpdir(), "shore"));
  });

  test("XDG alone is enough too, and still gets its /shore suffix", () => {
    const got = resolveShoreDirs(
      {
        XDG_CONFIG_HOME: "/x/cfg",
        XDG_DATA_HOME: "/x/data",
        XDG_CACHE_HOME: "/x/cache",
      },
      () => undefined,
    );
    expect(got.config).toBe("/x/cfg/shore");
    expect(got.data).toBe("/x/data/shore");
    expect(got.cache).toBe("/x/cache/shore");
  });

  test("a home from passwd alone still resolves everything", () => {
    // The case that made the tilde unreachable in practice, and the reason
    // this was latent rather than a live bug.
    const got = resolveShoreDirs({}, () => "/home/u");
    expect(got.config).toBe("/home/u/.config/shore");
    expect(got.data).toBe("/home/u/.local/share/shore");
    expect(got.cache).toBe("/home/u/.cache/shore");
  });
});

describe("deep_merge", () => {
  for (const c of fixture.deep_merge) {
    test(c.name, () => {
      const base = Bun.TOML.parse(c.base) as Record<string, unknown>;
      deepMerge(base, Bun.TOML.parse(c.overlay) as Record<string, unknown>);
      expect(base).toEqual(c.merged as Record<string, unknown>);
    });
  }

  test("both the recurse and the replace branch are represented", () => {
    const names = fixture.deep_merge.map((c) => c.name).join(" ");
    expect(names).toContain("recurse");
    expect(names).toContain("replaced wholesale");
  });
});

describe("path helpers", () => {
  for (const c of fixture.paths) {
    test(`base=${JSON.stringify(c.base)} name=${JSON.stringify(c.name)}`, () => {
      expect(characterConfigDir(c.base, c.name)).toBe(c.character_config_dir);
      expect(characterWorkspaceDir(c.base, c.name)).toBe(c.character_workspace_dir);
      expect(characterWorkspaceFile(c.base, c.name, "SOUL.md")).toBe(
        c.character_workspace_file,
      );
      expect(characterMemoryDir(c.base, c.name)).toBe(c.character_memory_dir);
      expect(characterDataDir(c.base, c.name)).toBe(c.character_data_dir);
      expect(characterActiveJsonl(c.base, c.name)).toBe(c.character_active_jsonl);
      expect(characterSegmentsDir(c.base, c.name)).toBe(c.character_segments_dir);
      expect(characterCompactionManifest(c.base, c.name)).toBe(
        c.character_compaction_manifest,
      );
      expect(pluginsDir(c.base)).toBe(c.plugins_dir);
    });
  }

  test("an absolute character name swallows the base, and the fixture says so", () => {
    // This is the property `node:path`'s join does not have, and the one with
    // security weight: a name arriving over the wire can escape the data dir
    // entirely. If this case ever leaves the fixture, the port silently becomes
    // stricter than the daemon and the two write to different files.
    const absolute = fixture.paths.find((c) => c.name.startsWith("/"));
    expect(absolute).toBeDefined();
    expect((absolute as { character_data_dir: string }).character_data_dir).toBe("/etc");
    expect(characterDataDir("/base", "/etc")).toBe("/etc");
  });

  test("rustJoin does not normalize, where node's join would", () => {
    expect(rustJoin("/a", "..", "b")).toBe("/a/../b");
    expect(join("/a", "..", "b")).toBe("/b");
    expect(rustJoin("a//b", "c")).toBe("a//b/c");
  });
});

describe("load_raw_config_table", () => {
  for (const c of fixture.raw_config) {
    test(c.name, () => {
      const root = build(c.files);
      const env: Env = {
        SHORE_CONFIG_DIR: root,
        SHORE_DATA_DIR: join(root, "data"),
        SHORE_RUNTIME_DIR: join(root, "run"),
        SHORE_CACHE_DIR: join(root, "cache"),
      };
      const explicit = c.config_path === null ? undefined : join(root, c.config_path);

      if ("error_kind" in c && c.error_kind !== undefined) {
        let caught: unknown;
        try {
          loadRawConfigTable(explicit, { env, homeLookup: passwdHome });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).kind).toBe(c.error_kind as ConfigErrorKind);
        return;
      }

      const ok = (c as { ok: { table: Record<string, unknown>; config_dir_rel: string } }).ok;
      const got = loadRawConfigTable(explicit, { env, homeLookup: passwdHome });
      expect(got.table).toEqual(ok.table);
      // The generator recorded the config dir relative to its own temp root.
      const wantDir = ok.config_dir_rel === "" ? root : join(root, ok.config_dir_rel);
      expect(got.dirs.config).toBe(wantDir);
    });
  }

  test("both outcomes are represented", () => {
    // A fixture of only-Ok cases would pass against a loader that never threw.
    const errs = fixture.raw_config.filter((c) => "error_kind" in c);
    const oks = fixture.raw_config.filter((c) => "ok" in c);
    expect(errs.length).toBeGreaterThanOrEqual(3);
    expect(oks.length).toBeGreaterThanOrEqual(8);
  });

  test("Bun's TOML parser accepts an unterminated table header Rust rejects", () => {
    // The third Bun.TOML divergence this branch has hit, after the `\\U` escape
    // (model_resolution) and the nan/inf literals (stream) — and the worst
    // of them, because it turns a *fatal* config error into a plausible-looking
    // success rather than into wrong data.
    //
    // `[unclosed` is rejected by the Rust `toml` crate. Bun reads it as the
    // table `[unclosed]`, so a typo that stops the daemon dead would load
    // silently here. No TypeScript on this parser can see the Rust's answer, so
    // the case is absent from the fixture rather than asserted, and the
    // config.toml parse-error case uses input both halves reject.
    //
    // Not worked around: the only cheap guard is a scan for an unmatched `[`,
    // which false-rejects a multi-line string containing one — trading a
    // silent accept for a silent reject on valid config.
    expect(Bun.TOML.parse("[unclosed")).toEqual({ unclosed: {} });
    expect(Bun.TOML.parse("[[a]\nx=1")).toEqual({ a: [{ x: 1 }] });
    expect(() => Bun.TOML.parse("this is not toml")).toThrow();
    expect(() => Bun.TOML.parse("= nope")).toThrow();
  });

  test("a missing config.toml is not written by the loader itself", () => {
    // The Rust writes a starter file as a side effect. That is opt-in here, so
    // the default must leave the directory alone.
    const root = build([]);
    const env: Env = { SHORE_CONFIG_DIR: root };
    const got = loadRawConfigTable(undefined, { env, homeLookup: passwdHome });
    expect(got.table).toEqual({});
    expect(() => require("node:fs").statSync(join(root, "config.toml"))).toThrow();
  });
});

describe("Path::parent, which is how --config picks the config directory", () => {
  for (const c of fixture.parent_of) {
    test(`${JSON.stringify(c.input)} -> ${JSON.stringify(c.parent)}`, () => {
      expect(parentOf(c.input)).toBe(c.parent);
    });
  }

  test("the shapes that differ from a naive rsplit are present", () => {
    const inputs = fixture.parent_of.map((c) => c.input);
    // A bare filename yields "", the root yields ".", and a trailing separator
    // is not a component. Drop any of the three and the port can rsplit on "/"
    // and still pass.
    expect(inputs).toContain("config.toml");
    expect(inputs).toContain("/");
    expect(inputs).toContain("a/b/");
  });
});

describe("per-character config merge", () => {
  for (const c of fixture.char_config) {
    test(c.name, () => {
      const files = [{ path: "config.toml", content: c.global }];
      if (c.overlay !== null) {
        files.push({ path: "characters/aria/config.toml", content: c.overlay });
      }
      const root = build(files);
      const env: Env = { SHORE_CONFIG_DIR: root };
      const global = loadRawConfigTable(undefined, { env, homeLookup: passwdHome });
      const merged = loadCharacterConfigTable(global, "aria");
      expect(merged ?? null).toEqual(c.merged as Record<string, unknown> | null);
    });
  }

  test("merging does not mutate the global table", () => {
    // The Rust clones before merging. Sharing the object instead would leak one
    // character's overrides into the next character's config, which is the kind
    // of bug that only shows up with two characters loaded.
    const root = build([
      { path: "config.toml", content: "[defaults]\nstream = true" },
      { path: "characters/aria/config.toml", content: "[defaults]\nstream = false" },
    ]);
    const global = loadRawConfigTable(undefined, {
      env: { SHORE_CONFIG_DIR: root },
      homeLookup: passwdHome,
    });
    const before = structuredClone(global.table);
    loadCharacterConfigTable(global, "aria");
    expect(global.table).toEqual(before);
  });

  test("both the override and the no-override outcome are represented", () => {
    expect(fixture.char_config.some((c) => c.merged === null)).toBe(true);
    expect(fixture.char_config.some((c) => c.merged !== null)).toBe(true);
  });
});

describe("character discovery", () => {
  for (const c of fixture.discovery) {
    test(c.name, () => {
      const root = build(c.files, c.dirs);
      expect(discoverCharacters(root)).toEqual(c.discovered);
      expect(loadCharacterDefinition(root, c.probe) ?? null).toEqual(c.definition);
      expect(resolveUserDefinition(root, c.probe) ?? null).toEqual(c.user);
      expect(resolvePromptTemplate(root, c.probe, "compaction.md") ?? null).toEqual(
        c.prompt_compaction,
      );
    });
  }

  test("discovery is pinned above the BMP, where UTF-16 order disagrees", () => {
    const unicode = fixture.discovery.find((c) => c.name.includes("code point"));
    expect(unicode).toBeDefined();
    const names = (unicode as { discovered: string[] }).discovered;
    // Rust's byte order puts U+FB00 before U+1F3B5; JS's default sort does not.
    expect([...names].sort()).not.toEqual(names);
  });
});
