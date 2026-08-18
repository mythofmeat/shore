import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fixture from "./engine_fixtures/characters.json" with { type: "json" };

import {
  CharacterConfigError,
  CharacterError,
  CharacterRegistry,
  EngineCharacterNotFound,
} from "../src/characters.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { compareByCodePoint } from "../src/util/sort.ts";

interface Step {
  op: string;
  state: { available: string[]; snapshots: string[] };
  name?: string;
  soul?: boolean;
  toml?: string;
  path?: string;
  body?: string;
  requested?: string | null;
  result?: unknown;
  error?: string;
  summary?: {
    available_before: number;
    available_after: number;
    character_discovery_changed: boolean;
    dropped_engines: number;
  };
}

interface Scenario {
  name: string;
  seed: {
    global_toml: string | null;
    raw_table: boolean;
    characters: { name: string; soul: boolean }[];
  };
  steps: Step[];
}

const scenarios = fixture.scenarios as unknown as Scenario[];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-characters-"));
  roots.push(root);
  return root;
}

function writeCharacter(configDir: string, name: string, soul: boolean): void {
  const dir = join(configDir, "characters", name);
  if (soul) {
    mkdirSync(join(dir, "workspace"), { recursive: true });
    writeFileSync(join(dir, "workspace", "SOUL.md"), `${name} soul`);
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "character.md"), `${name} legacy`);
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function snapshotsOnDisk(dataDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => isDir(join(dataDir, name, "active_prompt")))
    .sort(compareByCodePoint);
}

const RUST_NONE_AVAILABLE =
  "no characters available — create one at characters/<name>/workspace/SOUL.md";

function withResolvedSoulPath(result: unknown, configDir: string): unknown {
  if (typeof result !== "object" || result === null) return result;
  const record = result as Record<string, unknown>;
  if (record["err"] !== RUST_NONE_AVAILABLE) return result;
  return {
    ...record,
    err:
      `no characters available — create one at ${configDir}/characters/<name>/workspace/SOUL.md, ` +
      "or run: shore character --new <name>",
  };
}

function configMarks(config: LoadedConfig): unknown {
  return {
    stream: config.app.defaults.stream,
    display_name: config.app.defaults.display_name ?? null,
    addr: config.app.daemon.addr,
  };
}

function newForTest(configDir: string, dataDir: string, root: string): LoadedConfig {
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

function loadFrom(path: string): LoadedConfig {
  return loadConfig(path, { onWarn: () => {} });
}

describe("the fixture is real", () => {
  test("every scenario is a run, not a call", () => {
    for (const s of scenarios) expect(s.steps.length).toBeGreaterThan(1);
    expect(scenarios.length).toBeGreaterThan(15);
  });
});

describe("CharacterRegistry", () => {
  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const root = makeRoot();
      const configDir = join(root, "config");
      const dataDir = join(root, "data");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(dataDir, { recursive: true });

      const engineIds: object[] = [];
      const engineId = (engine: object): number => {
        const seen = engineIds.indexOf(engine);
        if (seen >= 0) return seen;
        engineIds.push(engine);
        return engineIds.length - 1;
      };

      let registry: CharacterRegistry | undefined;

      for (const [index, step] of scenario.steps.entries()) {
        const where = `${scenario.name} step ${String(index)} (${step.op})`;

        switch (step.op) {
          case "new": {
            writeFileSync(join(configDir, "config.toml"), scenario.seed.global_toml as string);
            seedCharacters(configDir, scenario);
            registry = await CharacterRegistry.create(
              configDir,
              dataDir,
              loadFrom(join(configDir, "config.toml")),
            );
            break;
          }
          case "new_for_test": {
            seedCharacters(configDir, scenario);
            registry = await CharacterRegistry.create(
              configDir,
              dataDir,
              newForTest(configDir, dataDir, root),
            );
            break;
          }

          case "fs:add_character":
            writeCharacter(configDir, step.name as string, step.soul as boolean);
            break;
          case "fs:remove_character":
            rmSync(join(configDir, "characters", step.name as string), {
              recursive: true,
              force: true,
            });
            break;
          case "fs:write_character_config": {
            const dir = join(configDir, "characters", step.name as string);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "config.toml"), step.toml as string);
            break;
          }
          case "fs:write": {
            const path = join(configDir, step.path as string);
            mkdirSync(join(path, ".."), { recursive: true });
            writeFileSync(path, step.body as string);
            break;
          }
          case "fs:block_data_dir":
            writeFileSync(join(dataDir, step.name as string), "not a directory");
            break;

          case "refresh":
            await required(registry, where).refresh();
            break;

          case "has_character":
            expect(
              required(registry, where).hasCharacter(step.name as string),
              where,
            ).toBe(step.result as boolean);
            break;

          case "resolve_character": {
            const requested = step.requested ?? undefined;
            let got: unknown;
            try {
              got = { ok: required(registry, where).resolveCharacter(requested) };
            } catch (e) {
              if (!(e instanceof CharacterError)) throw e;
              got = { err: e.message, variant: e.kind };
            }
            expect(got, where).toEqual(withResolvedSoulPath(step.result, configDir));
            break;
          }

          case "get_or_create": {
            let got: unknown;
            try {
              const engine = await required(registry, where).getOrCreate(step.name as string);
              got = {
                ok: true,
                engine: engineId(engine),
                root: rootOf(engine.characterDir, dataDir, configDir),
                leaf: basename(engine.characterDir),
              };
            } catch (e) {
              if (!(e instanceof EngineCharacterNotFound)) throw e;
              got = { err: e.message };
            }
            expect(got, where).toEqual(step.result);
            break;
          }

          case "effective_config": {
            const reg = required(registry, where);
            if (step.error !== undefined) {
              expect(() => reg.effectiveConfig(step.name as string), where).toThrow(step.error);
            } else {
              expect(configMarks(reg.effectiveConfig(step.name as string)), where).toEqual(
                step.result,
              );
            }
            break;
          }

          case "invalidate_configs":
            required(registry, where).invalidateConfigs();
            break;

          case "set_runtime_effective_config": {
            const path = join(root, "runtime_override.toml");
            writeFileSync(path, step.toml as string);
            required(registry, where).setRuntimeEffectiveConfig(
              step.name as string,
              loadFrom(path),
            );
            break;
          }

          case "set_global_config": {
            const path = join(configDir, "config.toml");
            writeFileSync(path, step.toml as string);
            required(registry, where).setGlobalConfig(loadFrom(path));
            break;
          }

          case "set_global_config_elsewhere": {
            const dir = join(root, "elsewhere");
            mkdirSync(dir, { recursive: true });
            const path = join(dir, "config.toml");
            writeFileSync(path, step.toml as string);
            required(registry, where).setGlobalConfig(loadFrom(path));
            break;
          }

          case "reload_runtime_state": {
            const reg = required(registry, where);
            const summary = await reg.reloadRuntimeState(reg.globalConfig());
            expect(summary, where).toEqual({
              availableBefore: step.summary?.available_before as number,
              availableAfter: step.summary?.available_after as number,
              characterDiscoveryChanged: step.summary
                ?.character_discovery_changed as boolean,
              droppedEngines: step.summary?.dropped_engines as number,
            });
            break;
          }

          case "character_definition":
            expect(
              required(registry, where).characterDefinition(step.name as string) ?? null,
              where,
            ).toBe(step.result as string | null);
            break;

          case "user_definition":
            expect(
              required(registry, where).userDefinition(step.name as string) ?? null,
              where,
            ).toBe(step.result as string | null);
            break;

          default:
            throw new Error(`${where}: unhandled op`);
        }

        const reg = required(registry, where);
        expect(
          {
            available: [...reg.availableCharacters()],
            snapshots: snapshotsOnDisk(dataDir),
          },
          `${where}: state`,
        ).toEqual(step.state);
      }
    });
  }
});

test("an invalid character overlay fails closed with the rejected field", async () => {
  const root = makeRoot();
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(join(configDir, "characters", "Alice", "workspace"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), "[defaults]\ndisplay_name = \"GLOBAL\"\n");
  writeFileSync(join(configDir, "characters", "Alice", "workspace", "SOUL.md"), "Alice");
  writeFileSync(
    join(configDir, "characters", "Alice", "config.toml"),
    "[behavior.autonomy]\ncache_keepalive_max = \"20h\"\n",
  );

  const registry = await CharacterRegistry.create(
    configDir,
    dataDir,
    loadFrom(join(configDir, "config.toml")),
  );

  expect(() => registry.effectiveConfig("Alice")).toThrow(CharacterConfigError);
  expect(() => registry.effectiveConfig("Alice")).toThrow(
    'invalid config for character "Alice": failed to parse config.toml: unknown field `cache_keepalive_max`, expected `enabled` or `heartbeat`',
  );
});

describe("the character a bare command lands on", () => {
  const registryWith = async (names: readonly string[]): Promise<CharacterRegistry> => {
    const root = makeRoot();
    const configDir = join(root, "config");
    const dataDir = join(root, "data");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(configDir, "config.toml"), "[defaults]\n");
    for (const name of names) writeCharacter(configDir, name, true);
    return await CharacterRegistry.create(
      configDir,
      dataDir,
      loadFrom(join(configDir, "config.toml")),
    );
  };

  test("a second character does not strand a session already on one", async () => {
    const registry = await registryWith(["ada"]);
    expect(registry.resolveCharacter(undefined)).toBe("ada");

    writeCharacter(registry.globalConfig().dirs.config, "bea", true);
    await registry.refresh();

    expect(registry.resolveCharacter(undefined)).toBe("ada");
  });

  test("naming one moves the selection, and it sticks", async () => {
    const registry = await registryWith(["ada", "bea"]);
    expect(registry.resolveCharacter("bea")).toBe("bea");
    expect(registry.resolveCharacter(undefined)).toBe("bea");
  });

  test("with nothing chosen yet, two characters is still ambiguous", async () => {
    const registry = await registryWith(["ada", "bea"]);
    expect(() => registry.resolveCharacter(undefined)).toThrow(/multiple characters available/);
  });

  test("a selection that disappears stops being the answer", async () => {
    const registry = await registryWith(["ada", "bea"]);
    expect(registry.resolveCharacter("ada")).toBe("ada");

    rmSync(join(registry.globalConfig().dirs.config, "characters", "ada"), {
      recursive: true,
      force: true,
    });
    await registry.refresh();

    expect(registry.selectedCharacter()).toBeUndefined();
    expect(registry.resolveCharacter(undefined)).toBe("bea");
  });
});

function seedCharacters(configDir: string, scenario: Scenario): void {
  for (const { name, soul } of scenario.seed.characters) {
    writeCharacter(configDir, name, soul);
  }
}

function rootOf(path: string, dataDir: string, configDir: string): string {
  if (path.startsWith(dataDir)) return "data";
  if (path.startsWith(configDir)) return "config";
  return "other";
}

function basename(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

function required(registry: CharacterRegistry | undefined, where: string): CharacterRegistry {
  if (registry === undefined) throw new Error(`${where}: registry not constructed yet`);
  return registry;
}
