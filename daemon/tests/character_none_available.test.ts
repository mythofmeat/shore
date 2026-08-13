/**
 * The message a fresh install sees first (#41).
 *
 * `no characters available` is what every command answers before a character
 * exists, so its path is the one piece of a new user's setup that has to be
 * unambiguous. The Rust wrote `characters/<name>/workspace/SOUL.md` — relative
 * to the config directory, and saying so nowhere.
 *
 * Not fixture-driven: the frozen captures in `characters.json` and
 * `command_path.json` record the Rust's string, and their replays
 * rewrite it into this shape rather than being edited. This is where the shape
 * itself is pinned.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CharacterError, CharacterRegistry } from "../src/characters.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-none-available-"));
  roots.push(root);
  return root;
}

function config(root: string, workspace?: string): LoadedConfig {
  return {
    app: defaultAppConfig(),
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs: {
      config: join(root, "config"),
      data: join(root, "data"),
      runtime: join(root, "runtime"),
      cache: join(root, "cache"),
      ...(workspace === undefined ? {} : { workspace }),
    },
    rawTable: undefined,
  } as LoadedConfig;
}

describe("CharacterError.noneAvailable", () => {
  test("names an absolute path under the config directory", () => {
    const err = CharacterError.noneAvailable("/home/user/.config/shore");
    expect(err.kind).toBe("none_available");
    expect(err.message).toBe(
      "no characters available — create one at " +
        "/home/user/.config/shore/characters/<name>/workspace/SOUL.md, " +
        "or run: shore character --new <name>",
    );
  });

  // The other half of #41: under a workspace root the old string named a
  // location that does not exist in that layout at all, so resolving the path
  // is what makes the message true rather than merely longer.
  test("follows SHORE_WORKSPACE_DIR when one is set", () => {
    const err = CharacterError.noneAvailable("/home/user/.config/shore", "/srv/workspaces");
    expect(err.message).toBe(
      "no characters available — create one at /srv/workspaces/<name>/SOUL.md, " +
        "or run: shore character --new <name>",
    );
  });
});

describe("an empty registry", () => {
  test("resolves against its own config directory", async () => {
    const root = makeRoot();
    const dirs = config(root);
    const registry = await CharacterRegistry.create(dirs.dirs.config, dirs.dirs.data, dirs);

    expect(registry.availableCharacters()).toEqual([]);
    expect(() => registry.resolveCharacter(undefined)).toThrow(
      `create one at ${join(root, "config")}/characters/<name>/workspace/SOUL.md`,
    );
  });

  // The registry reads the workspace root from the config it is holding *now*,
  // so the message has to follow a reload rather than a construction-time copy.
  test("follows the workspace root through setGlobalConfig", async () => {
    const root = makeRoot();
    const plain = config(root);
    const registry = await CharacterRegistry.create(plain.dirs.config, plain.dirs.data, plain);

    registry.setGlobalConfig(config(root, join(root, "elsewhere")));
    expect(() => registry.resolveCharacter(undefined)).toThrow(
      `create one at ${join(root, "elsewhere")}/<name>/SOUL.md`,
    );
  });
});
