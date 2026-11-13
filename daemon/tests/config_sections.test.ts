import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../src/config/loader.ts";
import { restartRequiredChanges } from "../src/config/restart.ts";
import { resolveListenAddr } from "../src/daemon/startup.ts";
import { buildSessionHistorySnapshot, type HandshakeRegistry } from "../src/swp/handshake.ts";
import { testTmp } from "./support/tmp.ts";

async function reading(): Promise<{ write: (toml: string) => Promise<void>; read: () => unknown[] }> {
  const root = await mkdtemp(testTmp("shore-config-sections-"));
  return {
    write: async (toml) => { await writeFile(join(root, "config.toml"), toml); },
    read: () => {
      const { compaction, dreaming } = loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} }).app;
      return [
        compaction.enabled, compaction.model, compaction.write_memory, compaction.label_segments, Number(compaction.idle_after.asSecs()),
        Number(compaction.archive_after.asSecs()), compaction.min_turns, compaction.max_turns, compaction.max_context_tokens,
        compaction.keep_recent_turns, compaction.git_push, dreaming.enabled, dreaming.model,
      ];
    },
  };
}

test("[compaction] and [dreaming] are read under the names in the file, a model for each among them, and a new install compacts after two idle hours and pushes nothing", async () => {
  const { write, read } = await reading();
  await write('[chat]\ndisplay_name = "eve"\n');
  expect(read()).toEqual([true, undefined, true, true, 7200, 0, 12, 30, 200_000, 2, false, false, undefined]);

  await write([
    "[compaction]", "enabled = false", 'model = "anthropic:claude-haiku-5-5"', "write_memory = false", "label_segments = false", 'idle_after = "40m"',
    'archive_after = "3d"', "min_turns = 4", "max_turns = 40", "max_context_tokens = 500000", "keep_recent_turns = 0", "git_push = true",
    "[dreaming]", "enabled = true", 'model = "anthropic:claude-sonnet-5-5"', "",
  ].join("\n"));
  expect(read()).toEqual([false, "anthropic:claude-haiku-5-5", false, false, 2400, 259_200, 4, 40, 500_000, 0, true, true, "anthropic:claude-sonnet-5-5"]);

  await write('[compaction]\nidle_trigger = "1h"\n');
  expect(read).toThrow("unknown field `compaction.idle_trigger`");
  await write("[memory.compaction]\nenabled = false\n");
  expect(read).toThrow("unknown field `memory`, expected one of ");
});

test("a compaction setting that can't work is refused, naming the key as the file has it", async () => {
  const { write, read } = await reading();
  await write('[compaction]\nidle_after = "1500ms"\n');
  expect(read).toThrow("compaction.idle_after is 1500ms. Idle thresholds must be a whole number of seconds: the compaction triggers truncate to seconds before comparing, so a value like `1.5s` would fire early. Use `1s` or `2s`.");
  await write('[compaction]\narchive_after = "2500ms"\n');
  expect(read).toThrow("compaction.archive_after is 2500ms. Idle thresholds must be a whole number of seconds: the compaction triggers truncate to seconds before comparing, so a value like `1.5s` would fire early. Use `2s` or `3s`.");
  await write("[compaction]\nmin_turns = 2\nkeep_recent_turns = 2\n");
  expect(read).toThrow("compaction.min_turns (2) and max_turns (30) must both be greater than keep_recent_turns (2); raise the turn thresholds or lower keep_recent_turns");
  await write("[compaction]\nmin_turns = 20\nmax_turns = 10\n");
  expect(read).toThrow("compaction.max_turns (10) must be >= min_turns (20)");

  await write('[compaction]\nenabled = false\nidle_after = "1500ms"\nmin_turns = 20\nmax_turns = 10\n');
  expect(read()[0]).toBe(false);
});

test("[presence], [marks], [matrix] and [image] are read from the file, and a section with nothing under its heading leaves the defaults", async () => {
  const root = await mkdtemp(testTmp("shore-sections-config-"));
  await writeFile(join(root, "config.toml"), [
    "[presence]", 'statuses = ["asleep", "at sea"]',
    "[marks]", 'tags = ["funny"]',
    "[matrix]", "enabled = true", 'homeserver_url = "https://matrix.example"', 'user_id = "@ada:example"', 'room_id = "!room:example"', "mirror_user_messages = false",
    "[image]", 'model = "openai:gpt-image"', "",
  ].join("\n"));
  const { app } = loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} });
  expect([app.presence.statuses, app.marks.tags, app.connections.matrix, app.defaults.image_generation]).toEqual([
    ["asleep", "at sea"],
    ["funny"],
    { enabled: true, homeserver: "https://matrix.example", user_id: "@ada:example", room_id: "!room:example", mirror_all: false },
    "openai:gpt-image",
  ]);

  await writeFile(join(root, "config.toml"), "[triggers]\n[compaction]\n[dreaming]\n[presence]\n[marks]\n[matrix]\n[image]\n");
  const bare = loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} }).app;
  expect([bare.triggers.enabled, bare.compaction.enabled, bare.dreaming.enabled, bare.presence.statuses, bare.marks.tags, bare.connections.matrix, bare.defaults.image_generation]).toEqual([
    false, true, false, ["asleep", "busy", "away"], ["didn't look hard enough", "out of character", "too long", "repetitive"],
    { enabled: false, homeserver: "", user_id: "", room_id: "", mirror_all: true }, undefined,
  ]);
});

test("a model named in [chat], [triggers], [compaction] or [dreaming] that can't be found is warned about under that section's key", async () => {
  const root = await mkdtemp(testTmp("shore-config-sections-"));
  await writeFile(join(root, "config.toml"), '[chat]\nmodel = "nope"\n[triggers]\nmodel = "nope-a"\n[compaction]\nmodel = "nope-b"\n[dreaming]\nmodel = "ghost:nope-c"\n');
  const warned: (readonly (readonly [string, string])[])[] = [];
  loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: (_message, fields) => { warned.push(fields); } });
  expect(warned).toEqual([
    [["field", "chat.model"], ["name", "nope"]],
    [["field", "triggers.model"], ["name", "nope-a"]],
    [["field", "compaction.model"], ["name", "nope-b"]],
    [["field", "dreaming.model"], ["name", "ghost:nope-c"], ["provider", "ghost"]],
  ]);
});

test("[daemon] holds the address Shore listens on and the cache forensics switch, and a change to it, to [matrix] or to [notifications] needs a restart", async () => {
  const root = await mkdtemp(testTmp("shore-config-sections-"));
  const loaded = async (toml: string) => {
    await writeFile(join(root, "config.toml"), toml);
    return loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} });
  };
  const plain = await loaded('[chat]\ndisplay_name = "eve"\n');
  expect([plain.app.daemon.listen_addr, plain.app.daemon.cache_forensics]).toEqual(["127.0.0.1:7320", false]);
  const set = await loaded('[daemon]\nlisten_addr = "0.0.0.0:7000"\ncache_forensics = true\n');
  expect([set.app.daemon.listen_addr, set.app.daemon.cache_forensics]).toEqual(["0.0.0.0:7000", true]);

  expect(resolveListenAddr(undefined, undefined, set)).toEqual(["0.0.0.0:7000", "config"]);
  expect(resolveListenAddr(undefined, "  ", set)).toEqual(["0.0.0.0:7000", "config"]);
  expect(resolveListenAddr(undefined, "10.0.0.1:1", set)).toEqual(["10.0.0.1:1", "env"]);
  expect(resolveListenAddr("10.0.0.2:2", "10.0.0.1:1", set)).toEqual(["10.0.0.2:2", "cli"]);

  expect(restartRequiredChanges(plain, plain)).toEqual([]);
  expect(restartRequiredChanges(plain, set)).toEqual(["[daemon]"]);
  expect(restartRequiredChanges(plain, await loaded('[matrix]\nenabled = true\nhomeserver_url = "https://matrix.example"\n'))).toEqual(["[matrix]"]);
  expect(restartRequiredChanges(plain, await loaded('[notifications]\ntopic = "shore"\n'))).toEqual(["[notifications]"]);
  expect(restartRequiredChanges(plain, await loaded('[presence]\nstatuses = ["at sea"]\n[marks]\ntags = ["funny"]\n'))).toEqual([]);
});

test("a client that connects with no character open is told the model in use: the one it asked for, else chat.model, else the first model configured, else none", async () => {
  const root = await mkdtemp(testTmp("shore-config-sections-"));
  const told = async (toml: string, asked?: string): Promise<unknown> => {
    await writeFile(join(root, "config.toml"), toml);
    const loaded = loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root, K: "k" }, onWarn: () => {} });
    const registry: HandshakeRegistry = {
      availableCharacters: () => [],
      globalConfig: () => loaded,
      effectiveConfig: () => loaded,
      getOrCreate: () => Promise.reject(new Error("no character is open")),
      listThreads: () => [],
    };
    return (await buildSessionHistorySnapshot(registry, null, null, asked)).config;
  };
  const profile = '[chat."anthropic:claude-y"]\nmax_output_tokens = 1000\n[providers.anthropic]\napi_key_env = "K"\n';
  expect(await told(`[chat]\nmodel = "anthropic:claude-x"\n${profile}`, "anthropic:claude-z")).toEqual({ active_model: "anthropic:claude-z" });
  expect(await told(`[chat]\nmodel = "anthropic:claude-x"\n${profile}`)).toEqual({ active_model: "anthropic:claude-x" });
  expect(await told(profile)).toEqual({ active_model: "anthropic:claude-y" });
  expect(await told('[chat]\ndisplay_name = "eve"\n')).toEqual({ active_model: null });
});
