import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resultCharsFor, subagentEnabled, timeoutFor, toolGrants } from "../src/config/app.ts";
import { loadConfig } from "../src/config/loader.ts";
import { restartRequiredChanges } from "../src/config/restart.ts";
import { attemptMatrixBridge, unusableReason } from "../src/connections/matrix/start.ts";
import { resolveListenAddr } from "../src/daemon/startup.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import { mcpConfigView } from "../src/runtime.ts";
import { buildSessionHistorySnapshot, type HandshakeRegistry } from "../src/swp/handshake.ts";
import { toolLimitsFrom } from "../src/tools/dispatch.ts";
import { handleGenerateImage } from "../src/tools/images.ts";
import { toSpec } from "../src/tools/mcp_registry.ts";
import { setTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";
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
  expect([app.presence.statuses, app.marks.tags, app.matrix, app.image.model]).toEqual([
    ["asleep", "at sea"],
    ["funny"],
    { enabled: true, homeserver_url: "https://matrix.example", user_id: "@ada:example", room_id: "!room:example", mirror_user_messages: false },
    "openai:gpt-image",
  ]);

  await writeFile(join(root, "config.toml"), "[triggers]\n[compaction]\n[dreaming]\n[presence]\n[marks]\n[matrix]\n[image]\n");
  const bare = loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} }).app;
  expect([bare.triggers.enabled, bare.compaction.enabled, bare.dreaming.enabled, bare.presence.statuses, bare.marks.tags, bare.matrix, bare.image.model]).toEqual([
    false, true, false, ["asleep", "busy", "away"], ["didn't look hard enough", "out of character", "too long", "repetitive"],
    { enabled: false, homeserver_url: "", user_id: "", room_id: "", mirror_user_messages: true }, undefined,
  ]);
});

test("a model named in [chat], [triggers], [compaction] or [dreaming] that can't be found is warned about under that section's key", async () => {
  const root = await mkdtemp(testTmp("shore-config-sections-"));
  await writeFile(join(root, "config.toml"), [
    '[chat]\nmodel = "nope"\n[triggers]\nmodel = "nope-a"\n[compaction]\nmodel = "nope-b"\n[dreaming]\nmodel = "ghost:nope-c"',
    '[subagents]\nmodel = "nope-d"\n[subagents.scout]\ndescription = "looks"\nprompt = "look"\nmodel = "nope-e"\n',
  ].join("\n"));
  const warned: (readonly (readonly [string, string])[])[] = [];
  loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: (_message, fields) => { warned.push(fields); } });
  expect(warned).toEqual([
    [["field", "chat.model"], ["name", "nope"]],
    [["field", "triggers.model"], ["name", "nope-a"]],
    [["field", "compaction.model"], ["name", "nope-b"]],
    [["field", "dreaming.model"], ["name", "ghost:nope-c"], ["provider", "ghost"]],
    [["field", "subagents.model"], ["name", "nope-d"]],
    [["field", "subagents.scout.model"], ["name", "nope-e"]],
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

async function sections(): Promise<{ root: string; load: (toml: string) => Promise<ReturnType<typeof loadConfig>>; warned: string[] }> {
  const root = await mkdtemp(testTmp("shore-config-sections-"));
  const warned: string[] = [];
  return {
    root,
    warned,
    load: async (toml) => {
      await writeFile(join(root, "config.toml"), toml);
      return loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root, K: "k" }, onWarn: (message) => { warned.push(message); } });
    },
  };
}

test("[tools] holds the tools that are on, the limits for all of them, and a table of its own limits for any one tool", async () => {
  const { load } = await sections();
  const { app } = await load([
    "[tools]", 'enabled = ["bash", "read"]', 'mcp = ["search"]', 'timeout = "90s"', "max_result_chars = 1234", "max_inline_image_bytes = 99", 'pass_env = ["HOME_X"]', "no_new_privs = false",
    "[tools.bash]", 'timeout = "10m"', "max_result_chars = 77",
    "[tools.read]", "max_inline_image_bytes = 5",
    "[mcp.search]", 'command = "srch"', "",
  ].join("\n"));
  expect([app.tools.enabled, app.tools.mcp, app.tools.pass_env, app.tools.no_new_privs]).toEqual([["bash", "read"], ["search"], ["HOME_X"], false]);
  expect(toolGrants(app.tools)).toEqual(["bash", "read", "mcp__search__*"]);
  expect([resultCharsFor(app.tools, "bash"), resultCharsFor(app.tools, "read"), resultCharsFor(app.tools, "edit")]).toEqual([77, 1234, 1234]);
  expect([timeoutFor(app.tools, "bash")?.asMillis(), timeoutFor(app.tools, "read")?.asMillis()]).toEqual([600_000, 90_000]);
  expect(toolLimitsFrom(app.tools)).toEqual({
    max_result_chars: 1234,
    max_inline_image_bytes: 99,
    timeout_ms: 90_000,
    config: { bash: { max_result_chars: 77, timeout_ms: 600_000 }, read: { max_inline_image_bytes: 5 } },
  });

  const bare = (await load("[tools]\n")).app.tools;
  expect([bare.enabled, bare.mcp, bare.max_result_chars, bare.timeout.asMillis(), bare.no_new_privs, [...bare.per_tool]]).toEqual([[], [], 50_000, 300_000, true, []]);

  expect(await outcomeOf(load("[tools.bash]\nbogus = 1\n"))).toThrow("unknown field `tools.bash.bogus`");
  expect(await outcomeOf(load("[tools.bash]\ntimeout = 5\n"))).toThrow("expected a duration string");
  expect(await outcomeOf(load('[tools]\nenabled_tools = ["bash"]\n'))).toThrow("tools.enabled_tools must be a table");
  expect(await outcomeOf(load('[tools.config.bash]\ntimeout = "1m"\n'))).toThrow("unknown field `tools.config.bash`");
});

test("[subagents] holds the model they share, the ones that are on, and a table defining each", async () => {
  const { load } = await sections();
  const providers = '[providers.anthropic]\napi_key_env = "K"\n';
  const { app } = await load([
    "[subagents]", 'model = "anthropic:claude-x"', 'enabled = ["scout"]',
    "[subagents.scout]", 'description = "looks"', 'prompt = "look"', 'tools = ["read"]', "max_tool_rounds = 4", 'timeout = "2m"',
    "[subagents.idle]", 'description = "rests"', 'prompt = "rest"', 'model = "anthropic:claude-y"',
    providers,
  ].join("\n"));
  expect([app.subagents.model, app.subagents.enabled, [...app.subagents.agents.keys()]]).toEqual(["anthropic:claude-x", ["scout"], ["idle", "scout"]]);
  const scout = app.subagents.agents.get("scout");
  expect([scout?.description, scout?.prompt, scout?.tools, scout?.model, scout?.max_tool_rounds, scout?.timeout?.asMillis()]).toEqual(["looks", "look", ["read"], undefined, 4, 120_000]);
  expect(app.subagents.agents.get("idle")?.model).toBe("anthropic:claude-y");
  expect([subagentEnabled(app.subagents, "scout"), subagentEnabled(app.subagents, "idle")]).toEqual([true, false]);
  expect(toolLimitsFrom(app.tools, app.subagents.agents).config).toEqual({ ask_idle: { timeout_ms: 3_600_000 }, ask_scout: { timeout_ms: 120_000 } });

  const bare = (await load("[subagents]\n")).app.subagents;
  expect([bare.model, bare.enabled, [...bare.agents]]).toEqual([undefined, [], []]);

  const scoutOn = '[subagents]\nenabled = ["scout"]\n[subagents.scout]\ndescription = "looks"\nprompt = "look"\n';
  expect(await outcomeOf(load(scoutOn))).toThrow("subagents.scout is enabled but resolves to no model; set subagents.scout.model, subagents.model, or chat.model");
  expect(await outcomeOf(load(`${scoutOn}model = "ghost:nope"\n`))).toThrow('subagents.scout resolves to model "ghost:nope"');
  expect((await load(`${scoutOn}[chat]\nmodel = "anthropic:claude-x"\n${providers}`)).app.subagents.enabled).toEqual(["scout"]);
  expect(await outcomeOf(load('[subagents.scout]\ndescription = "looks"\n'))).toThrow("missing field `prompt`");
  expect(await outcomeOf(load('[subagents.scout]\ndescription = "looks"\nprompt = "look"\nmax_iterations = 3\n'))).toThrow("unknown field `subagents.scout.max_iterations`");
  expect(await outcomeOf(load('[defaults]\nsubagent_model = "anthropic:claude-x"\n'))).toThrow("unknown field `defaults`, expected one of ");
});

test("[mcp.<name>] is read under the names in the file, and a server starts in its working_dir", async () => {
  const { load } = await sections();
  const loaded = await load([
    "[mcp.search]", 'command = "srch"', 'args = ["-x"]', 'working_dir = "tools/search"', 'user = "1000"', "[mcp.search.env]", 'TOKEN = "s3"',
    "[mcp.plain]", 'command = "/usr/bin/plain"',
    "[mcp.remote]", 'url = "https://mcp.example"', "",
  ].join("\n"));
  expect(loaded.app.mcp.get("search")?.working_dir).toBe("tools/search");
  const view = mcpConfigView(loaded, {});
  expect(view).toEqual({
    plain: { command: "/usr/bin/plain", args: [], env: {}, headers: {} },
    remote: { args: [], env: {}, url: "https://mcp.example", headers: {} },
    search: { command: "srch", args: ["-x"], env: { TOKEN: "s3" }, cwd: "tools/search", user: "1000", headers: {} },
  });
  expect(toSpec("search", view["search"] ?? {}, "/plugins")?.transport).toMatchObject({ kind: "stdio", cwd: "/plugins/tools/search", args: ["-x"] });
  expect(toSpec("plain", view["plain"] ?? {}, "/plugins")?.transport).toEqual({ kind: "stdio", command: "/usr/bin/plain", args: [], env: {} });

  expect(await outcomeOf(load('[mcp.search]\ncommand = "srch"\ncwd = "/w"\n'))).toThrow("unknown field `mcp.search.cwd`");
});

test("[notifications] is read under the names in the file: how to deliver, which events, and a new install delivers nothing", async () => {
  const { load } = await sections();
  const read = async (toml: string): Promise<unknown[]> => {
    const { via, events, min_generation_duration: least, url, topic, token_env: tokenEnv, command, push_topic: pushTopic, push_every: pushEvery } = (await load(toml)).app.notifications;
    return [via, events, least.asMillis(), url, topic, tokenEnv, command, pushTopic, pushEvery.asMillis()];
  };
  expect(await read("[notifications]\n")).toEqual(["off", ["autonomous_message", "message_complete"], 0, "https://ntfy.sh", "", undefined, [], "", 86_400_000]);
  expect(await read([
    "[notifications]", 'via = "ntfy"', 'events = ["usage_warning", "error", "error"]', 'min_generation_duration = "30s"', 'url = "https://ntfy.example"', 'topic = "shore"',
    'token_env = "NTFY_TOKEN"', 'command = ["say", "{title}"]', 'push_topic = "ada"', 'push_every = "2h"', "",
  ].join("\n"))).toEqual(["ntfy", ["error", "usage_warning"], 30_000, "https://ntfy.example", "shore", "NTFY_TOKEN", ["say", "{title}"], "ada", 7_200_000]);
  expect((await read("[notifications]\nevents = []\n"))[1]).toEqual([]);

  expect(await outcomeOf(load('[notifications]\nvia = "pigeon"\n'))).toThrow("notifications.via must be off, notify_send, ntfy, command");
  expect(await outcomeOf(load('[notifications]\nevents = ["error", "nope"]\n'))).toThrow("notifications.events contains an unknown event");
  expect(await outcomeOf(load('[notifications]\nevents = "error"\n'))).toThrow('invalid type: string "error", expected a sequence');
  expect(await outcomeOf(load("[notifications.events]\nerror = true\n"))).toThrow("invalid type: map, expected a sequence");
  expect(await outcomeOf(load("[notifications]\nenabled = true\n"))).toThrow("unknown field `notifications.enabled`");
  expect(await outcomeOf(load('[notifications.ntfy]\ntopic = "shore"\n'))).toThrow("unknown field `notifications.ntfy`");
});

test("[image] holds the model pictures are made with beside each image model's own settings, and a mistake in either names the file and the key", async () => {
  const { root, load } = await sections();
  const loaded = await load('[image]\nmodel = "openai:gpt-image"\n[image."openai:gpt-image"]\nsize = "1024x1024"\n[image."openai:other"]\nquality = "high"\n');
  expect(loaded.app.image).toEqual({ model: "openai:gpt-image" });
  expect([...loaded.models.imageGeneration]).toEqual([["openai:gpt-image", { size: "1024x1024" }], ["openai:other", { quality: "high" }]]);
  expect([...(await load("[image]\n")).models.imageGeneration]).toEqual([]);

  expect(await outcomeOf(load('[image."openai:gpt-image"]\nsize = 5\n'))).toThrow(
    `${join(root, "config.toml")}: [image."openai:gpt-image"] is not a valid \`provider:model_id\` settings table: invalid type: integer \`5\`, expected a string. Identity is the key (e.g. \`[image."openai:dall-e-3"]\`)`,
  );
  expect(await outcomeOf(load('[image]\nmodel = "gpt-image"\n'))).toThrow('image.model "gpt-image" must be a `provider:model_id` identity');
  expect(await outcomeOf(load('[image_generation."openai:gpt-image"]\nsize = "1024x1024"\n'))).toThrow("unknown field `image_generation`, expected one of ");
  expect(await outcomeOf(handleGenerateImage({ prompt: "a cat" }, root, undefined, async () => { throw new Error("no call expected"); }))).toThrow("no image model is configured; set image.model");
});

test("the tools a reply runs are given the image model [image] names and a way to ask a sub-agent only when one is defined", async () => {
  const { root, load } = await sections();
  setTestEnv("SHORE_TEST_IMAGE_KEY", "k");
  const context = async (toml: string) => {
    const loaded = await load(`${toml}[providers.openai]\napi_key_env = "SHORE_TEST_IMAGE_KEY"\n`);
    return await buildToolContext({ ...loaded, dirs: { ...loaded.dirs, data: join(root, "data"), cache: join(root, "cache") } }, join(root, "data"), "ada", { runSubagent: () => async () => "asked" });
  };
  const profiles = '[image."openai:first"]\nsize = "512x512"\n[image."openai:second"]\nsize = "1024x1024"\n';
  const chosen = await context(`[image]\nmodel = "openai:second"\n${profiles}`);
  expect(chosen.imageGenConfig).toMatchObject({ provider: "openai", model_id: "second", size: "1024x1024", api_key: "k" });
  expect((await context(profiles)).imageGenConfig).toBeUndefined();
  expect(chosen.runSubagent).toBeUndefined();

  const withAgent = await context('[subagents.scout]\ndescription = "looks"\nprompt = "look"\n');
  expect(await withAgent.runSubagent?.("scout", "find it")).toBe("asked");
});

test("the Matrix bridge signs in to [matrix]'s homeserver_url as its user_id", async () => {
  const { root, load } = await sections();
  const loaded = await load('[matrix]\nenabled = true\nhomeserver_url = "https://matrix.example"\nuser_id = "@ada:example"\n');
  const signIns: unknown[] = [];
  const outcome = await attemptMatrixBridge({
    config: { ...loaded, dirs: { ...loaded.dirs, data: join(root, "data") } },
    server: {} as never,
    env: { SHORE_MATRIX_ACCESS_TOKEN: "tk" },
    login: async (options) => { signIns.push(options); throw new Error("no homeserver in a test"); },
  });
  expect(signIns).toEqual([{ homeserver: "https://matrix.example", userId: "@ada:example", accessToken: "tk" }]);
  expect(outcome.kind).toBe("failed");
});

test("the Matrix bridge says which of [matrix]'s settings it still needs", () => {
  const matrix = { enabled: true, homeserver_url: "https://matrix.example", user_id: "@ada:example", room_id: "", mirror_user_messages: true };
  expect(unusableReason({ ...matrix, homeserver_url: " ", user_id: "" }, { accessToken: "t", password: undefined, deviceId: undefined })).toBe("[matrix] is missing homeserver_url and user_id");
  expect(unusableReason({ ...matrix, user_id: "" }, { accessToken: "t", password: undefined, deviceId: undefined })).toBe("[matrix] is missing user_id");
  expect(unusableReason(matrix, { accessToken: "t", password: undefined, deviceId: undefined })).toBeUndefined();
});
