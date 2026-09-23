import { parseOperationInput } from "../src/operations/contracts.ts";
import { recordedValue, recording } from "./support/rerecord.ts";
import { writePromptSnapshotFile } from "./support/storage.ts";
import { required } from "../src/util/required.ts";

import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import rawFixture from "./command_captures/config_commands.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);

import {
  config,
  configCheck,
  configReload,
  reportedDefaults,
  tools,
  type ConfigContext,
  type ConfigRuntime,
} from "../src/commands/config.ts";
import { CommandError } from "../src/commands/errors.ts";
import { loadCharacterConfig, loadConfig } from "../src/config/loader.ts";
import { modelInfo, modelRoles, resetModel, switchModel } from "../src/commands/models.ts";
import { testTmp } from "./support/tmp.ts";

interface Row {
  name: string;
  note?: string;
  state_after: Record<string, unknown>;
  changed_after?: string[];
  ok?: unknown;
  err?: { code: string; message: string };
}

type Section =
  | "tools"
  | "config_check"
  | "config_reload";

const rowLocations = new WeakMap<Row, [Section, number]>();

const row = (section: Section, name: string): Row => {
  const found = (fixture[section] as unknown as Row[]).find((r) => r.name === name);
  if (found === undefined) throw new Error(`no fixture row named ${JSON.stringify(name)}`);
  rowLocations.set(found, [section, (fixture[section] as unknown as Row[]).indexOf(found)]);
  return found;
};

interface World {
  root: string;
  ctx: ConfigContext;
  calls: string[];
}

function recorder(calls: string[]): ConfigRuntime {
  return {
    reloadRuntimeConfig: () => calls.push("reloadRuntimeConfig"),
    adoptGlobalConfig: () => calls.push("adoptGlobalConfig"),
    notifyPromptSnapshotRefreshed: (c) => calls.push(`notifyPromptSnapshotRefreshed:${c}`),
  };
}

async function build(
  character: string | undefined,
  configToml: string,
  extra: [path: string, text: string][] = [],
): Promise<World> {
  const root = await mkdtemp(testTmp("shore-config-cmd-"));
  for (const [path, text] of extra) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  const configPath = join(root, "config", "config.toml");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, configToml);

  const env = {
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: join(root, "data-home"),
    XDG_CACHE_HOME: join(root, "cache-home"),
    XDG_RUNTIME_DIR: join(root, "run-home"),
  };
  const onWarn = () => {};
  const loaded = loadConfig(configPath, { env, onWarn });
  await mkdir(loaded.dirs.data, { recursive: true });

  const calls: string[] = [];
  return {
    root,
    calls,
    ctx: {
      config: loaded,
      configPath,
      characterName: character,
      activeModel: undefined,
      runtime: recorder(calls),
      env,
    },
  };
}

test("the background model command accepts an explicit SDK model absent from discovery", async () => {
  const w = await build("ada", "[providers.claude_agent]\nsdk = \"claude_agent\"\n");
  const selected = switchModel({ ...w.ctx, dataDir: w.ctx.config.dirs.data }, {
    name: "claude_agent:claude-opus-4-8", background_task: "compaction",
  });
  expect(selected).toMatchObject({ active: "claude_agent:claude-opus-4-8", role: "compaction" });
  expect(loadConfig(w.ctx.configPath, { env: required(w.ctx.env) }).app.defaults.background.compaction)
    .toBe("claude_agent:claude-opus-4-8");
});

test("resetting compaction inherits the thread model while heartbeat and subagents inherit the character model", async () => {
  const w = await build("ada", '[chat]\nmodel = "anthropic:beta-id"\n[chat."anthropic:alpha-id"]\n[chat."anthropic:beta-id"]\n');
  const ctx = { ...w.ctx, dataDir: w.ctx.config.dirs.data, thread: "side", threadModel: "anthropic:alpha-id" };
  switchModel(ctx, { name: "anthropic:beta-id", background_task: "compaction" });
  expect(modelRoles(ctx).find((role) => role.role === "compaction")).toMatchObject({ model: "anthropic:beta-id", source: "compaction.model" });
  expect(resetModel(ctx, { background_task: "compaction" })).toMatchObject({ active: "anthropic:alpha-id", source: "inherits chat" });
  expect(modelInfo(ctx, { background_task: "compaction" })).toMatchObject({ qualified_name: "anthropic:alpha-id" });
  expect(modelRoles(ctx).find((role) => role.role === "compaction")).toMatchObject({ model: "anthropic:alpha-id", source: "inherits chat" });
  expect(resetModel(ctx, { background_task: "heartbeat" })).toMatchObject({ active: "anthropic:beta-id" });
  expect(resetModel(ctx, { subagent: "all" })).toMatchObject({ active: "anthropic:beta-id" });
});

const scrub = (value: unknown, root: string): unknown =>
  JSON.parse(JSON.stringify(value ?? null).split(root).join("<root>"));

const stateOf = (w: World): unknown =>
  scrub(
    {
      active_model: w.ctx.activeModel ?? null,
      autonomy_enabled: w.ctx.config.app.behavior.autonomy.enabled,
      defaults_model: w.ctx.config.app.defaults.model ?? null,
      chat_models: w.ctx.config.models.chat.size,
    },
    w.root,
  );

async function check(r: Row, w: World, run: () => unknown): Promise<void> {
  let result: unknown;
  let thrown: unknown;
  try { result = await run(); } catch (error) { thrown = error; }
  const pointer = required(rowLocations.get(r));
  const capture = "tests/command_captures/config_commands.json";
  recordedValue(capture, [...pointer, "state_after"], stateOf(w));
  if (r.err !== undefined) {
    expect(thrown, r.name).toBeInstanceOf(CommandError);
    expect((thrown as CommandError).code, r.name).toBe(r.err.code as never);
    const actual = { code: (thrown as CommandError).code, message: (thrown as Error).message.split(w.root).join("<root>") };
    recordedValue(capture, [...pointer, "err"], actual);
    if (!recording) expect<unknown>(actual, r.name).toEqual(r.err);
  } else {
    expect(thrown, r.name).toBeUndefined();
    const actual = scrub(result, w.root);
    recordedValue(capture, [...pointer, "ok"], actual);
    if (!recording) expect(actual, r.name).toEqual(r.ok as never);
  }
  if (!recording) expect(stateOf(w), `${r.name} (state_after)`).toEqual(r.state_after as never);
}

const FURNISHED = "[chat]\nmodel = \"anthropic:claude-primary\"\n\n[providers.anthropic]\napi_key_env = \"SHORE_FIXTURE_KEY_SET\"\n[chat.\"anthropic:claude-primary\"]\n\n[providers.anthropic_secondary]\nsdk = \"anthropic\"\napi_key_env = \"SHORE_FIXTURE_KEY_MISSING\"\n[chat.\"anthropic_secondary:claude-secondary\"]\n\n[subagents]\nenabled = [\"researcher\", \"ghost\"]\n\n[subagents.researcher]\ndescription = \"Looks things up\"\nprompt = \"You look things up.\"\ntools = [\"web_search\", \"also_not_real\"]\nmodel = \"anthropic:claude-primary\"\n\n[subagents.idle]\ndescription = \"Never enabled\"\nprompt = \"You are idle.\"\ntools = [\"bash\", \"idle_not_real\"]\n\n[tools]\nenabled = [\"web_search\", \"not_a_real_tool\"]\n\n[heartbeat]\nenabled = true\n";

const BARE = "";

const ENV = { SHORE_FIXTURE_KEY_SET: "sk-present", SHORE_FIXTURE_KEY_BLANK: "" } as NodeJS.ProcessEnv;

async function seedPromptFiles(
  w: World,
  soul: string,
  soulSnapshot: string | undefined,
  user: string,
): Promise<void> {
  const workspace = join(w.ctx.config.dirs.config, "characters", "mid", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), soul);
  await writeFile(join(workspace, "USER.md"), user);

  const snapshot = join(w.ctx.config.dirs.data, "mid", "active_prompt");
  if (soulSnapshot !== undefined) writePromptSnapshotFile(join(snapshot, "SOUL.md"), soulSnapshot);
  writePromptSnapshotFile(join(snapshot, "USER.md"), user);
}

describe("tools", () => {
  const cases: [name: string, toml: string][] = [
    ["the furnished surface, with every warning kind", FURNISHED],
    ["an empty config still lists every registered tool", BARE],
  ];
  for (const [name, toml] of cases) {
    test(name, async () => {
      const w = await build("mid", toml);
      await check(row("tools", name), w, () => tools(w.ctx));
    });
  }

  const withSubagent = (extra: string, subagentTools: string): string =>
    '[chat."anthropic:claude-primary"]\n' +
    "[chat]\nmodel = \"anthropic:claude-primary\"\n" +
    extra +
    "[subagents]\nenabled = [\"probe\"]\n" +
    "[subagents.probe]\ndescription = \"d\"\nprompt = \"p\"\nmodel = \"anthropic:claude-primary\"\n" +
    `tools = [${subagentTools}]\n`;

  test("a configured mcp server's tools are not reported as unknown", async () => {
    const w = await build(
      "mid",
      withSubagent('\n[mcp.whoop]\nurl = "http://mcp-whoop:3000/mcp"\n', '"mcp__whoop__*"'),
    );
    const out = tools(w.ctx) as { warnings: string[] };
    expect(out.warnings.filter((x) => x.includes("mcp__whoop__"))).toEqual([]);
  });

  test("an mcp server name with an underscore still resolves", async () => {
    const w = await build(
      "mid",
      withSubagent(
        '\n[mcp.listening_stats]\nurl = "http://mcp-listening-stats:3000/mcp"\n',
        '"mcp__listening_stats__*"',
      ),
    );
    const out = tools(w.ctx) as { warnings: string[] };
    expect(out.warnings.filter((x) => x.includes("mcp__listening_stats__"))).toEqual([]);
  });

  test("a provider-only config is not reported as having no models", async () => {
    const w = await build(
      "mid",
      '\n[providers.anthropic]\nsdk = "anthropic"\napi_key_env = "SHORE_FIXTURE_KEY_SET"\n',
    );
    const out = configCheck(w.ctx, ENV) as { warnings: string[]; providers: number };
    expect(out.providers).toBe(1);
    expect(out.warnings.filter((x) => x.includes("No chat models configured"))).toEqual([]);
  });

  test("an mcp tool for a server that is not configured is still unknown", async () => {
    const w = await build("mid", withSubagent("", '"mcp__nosuchserver__*"'));
    const out = tools(w.ctx) as { warnings: string[] };
    expect(out.warnings.some((x) => x.includes("mcp__nosuchserver__"))).toBe(true);
  });
});

describe("configCheck", () => {
  const cases: [name: string, toml: string][] = [
    ["a config with a missing api key env var", FURNISHED],
    ["no models at all", BARE],
    [
      "a default model that is not in the catalog",
      "[chat]\nmodel = \"nonexistent\"\n",
    ],
    ["models but no default set", "[chat.\"anthropic:claude-primary\"]\n"],
    [
      "an api key env var that is set but empty",
      "[providers.anthropic]\napi_key_env = \"SHORE_FIXTURE_KEY_BLANK\"\n[chat.\"anthropic:claude-blank\"]\n",
    ],
  ];
  for (const [name, toml] of cases) {
    test(name, async () => {
      const w = await build("mid", toml);
      await check(row("config_check", name), w, () => configCheck(w.ctx, ENV));
    });
  }

  test("a provider:model_id default is a working setup, not two warnings", async () => {
    const w = await build(
      "mid",
      '\n[providers.deepseek]\napi_key_env = "SHORE_FIXTURE_KEY_SET"\n\n' +
        "[chat]\nmodel = \"deepseek:deepseek-v4-flash\"\n",
    );
    const result = configCheck(w.ctx, ENV) as { warnings: string[]; info: string[] };

    expect(result.warnings).toEqual([]);
    expect(result.info).toContain("Default model: deepseek:deepseek-v4-flash");
  });

  test("a default naming an unconfigured provider is still called out", async () => {
    const w = await build("mid", "[chat]\nmodel = \"ghost:whatever\"\n");
    const result = configCheck(w.ctx, ENV) as { warnings: string[] };

    expect(result.warnings).toContain('Default model "ghost:whatever" not found in catalog');
  });
});

describe("config read", () => {
  test("the whole config includes current settings and defaults", async () => {
    const w = await build("mid", FURNISHED);
    const result = config(w.ctx, {}) as { config: Record<string, unknown>; defaults: unknown };
    expect(result.defaults).toEqual(reportedDefaults());
    expect(result.config).toMatchObject({ chat: { model: "anthropic:claude-primary" }, heartbeat: { enabled: true } });
    expect(result.config).not.toHaveProperty("defaults");
    for (const key of ["tools", "subagents"]) {
      expect(config(w.ctx, { key })).toEqual({ key, config: result.config[key], defaults: reportedDefaults()[key] });
    }
    expect(() => parseOperationInput("config", { key: 7 })).toThrow();
    expect(config(w.ctx, { value: "true" })).toEqual(result);
    expect(() => config(w.ctx, { key: "nosuchsection" })).toThrow("Config section not found");
  });
});

describe("config read walks dots", () => {
  const cases: [key: string, value: unknown][] = [
    ["chat.model", "anthropic:claude-primary"],
        ["heartbeat.enabled", true],
    ["daemon.listen_addr", "127.0.0.1:7320"],
    ["tools.enabled", ["web_search", "not_a_real_tool"]],
  ];
  for (const [key, value] of cases) {
    test(`\`${key}\` reads back`, async () => {
      const w = await build("mid", FURNISHED);
      const ok = config(w.ctx, { key }) as { key: string; config: unknown };
      expect(ok.key).toBe(key);
      expect(ok.config).toEqual(value as never);
    });
  }







  test("the default baseline is scoped to the same key", async () => {
    const w = await build("mid", FURNISHED);
    const ok = config(w.ctx, { key: "heartbeat.enabled" }) as { config: unknown; defaults: unknown };
    expect(ok.config).toBe(true);
    expect(ok.defaults).toBe(false);
  });

  test("a key whose value is null is found, not missing", async () => {
    const w = await build("mid", FURNISHED);
    const ok = config(w.ctx, { key: "chat.display_name" }) as { config: unknown };
    expect(ok.config).toBeNull();
  });

  const misses: [why: string, key: string][] = [
    ["an unknown leaf", "defaults.nosuchkey"],
    ["an unknown branch", "nosuchsection.nosuchkey"],
    ["a walk through a scalar", "defaults.stream.deeper"],
    ["a walk into an array", "tools.enabled_tools.0"],
    ["a trailing dot", "defaults."],
  ];
  for (const [why, key] of misses) {
    test(`${why} is still not_found`, async () => {
      const w = await build("mid", FURNISHED);
      expect(() => config(w.ctx, { key })).toThrow(`Config section not found: ${key}`);
    });
  }
});

describe("config set", () => {
  const cases: [string, string, unknown][] = [
    ["chat.model", "anthropic_secondary:claude-secondary", "anthropic_secondary:claude-secondary"],
    ["heartbeat.enabled", "false", false],
    ["compaction.idle_after", "90m", "90m"],
    ["chat.display_name", "Ellie", "Ellie"],
    ["subagents.enabled", "researcher,idle", ["researcher", "idle"]],
  ];
  for (const [key, value, expected] of cases) test(`writes ${key}`, async () => {
    const w = await build("mid", FURNISHED);
    const result = config(w.ctx, { key, value }) as { value: unknown; file: string };
    expect(result.value).toEqual(expected);
    expect(result.file).toBe(w.ctx.configPath);
    expect(loadConfig(w.ctx.configPath, { ...(w.ctx.env === undefined ? {} : { env: w.ctx.env }), onWarn: () => {} })).toBeDefined();
  });

  const invalid: [string, string, string][] = [
    ["chat.model", "ghost", "not found"],
    ["heartbeat.enabled", "maybe", "expected true or false"],
    ["memory.mode", "x", "not found"],
    ["cache.keepalive_for", "90m", "not found"],
    ["compaction", "x", "table"],
    ["chat.user_timestamps", "sometimes", "not one of"],
    ["defaults.stream", "true", "not found"],
    ["stream", "yes", "not found"],
  ];
  for (const [key, value, error] of invalid) test(`rejects ${key} = ${value}`, async () => {
    const w = await build("mid", FURNISHED);
    const before = await readFile(w.ctx.configPath, "utf8");
    expect(() => config(w.ctx, { key, value })).toThrow(error);
    expect(await readFile(w.ctx.configPath, "utf8")).toBe(before);
  });

  test("a saved preference masks the fallback model", async () => {
    const w = await build("mid", FURNISHED);
    w.ctx.activeModel = "anthropic:claude-primary";
    expect(config(w.ctx, { key: "chat.model", value: "anthropic_secondary:claude-secondary" })).toMatchObject({ masked_by_preference: "anthropic:claude-primary" });
  });

  test("an ordinary edit keeps comments and untouched lines", async () => {
    const w = await build("mid", FURNISHED);
    const before = await readFile(w.ctx.configPath, "utf8");
    config(w.ctx, { key: "heartbeat.enabled", value: "false" });
    expect(await readFile(w.ctx.configPath, "utf8")).toBe(before.replace("enabled = true", "enabled = false"));
  });
});

describe("configReload", () => {
  test("check mode reports without applying", async () => {
    const w = await build("mid", FURNISHED);
    await check(row("config_reload", "check mode reports without applying"), w, () =>
      configReload(w.ctx, {}),
    );
    expect(w.calls).toEqual([]);
  });

  test("a truthy non-boolean apply is rejected before configuration effects", async () => {
    const w = await build("mid", FURNISHED);
    expect(() => parseOperationInput("config_reload", { apply: 1, refresh_prompts: 1 })).toThrow();
    expect(w.calls).toEqual([]);
  });

  test("apply adopts the config on disk", async () => {
    const w = await build("mid", FURNISHED);
    await writeFile(
      w.ctx.configPath,
      "[chat.\"anthropic:claude-third\"]\n" +
        "[chat]\nmodel = \"anthropic:claude-third\"\n",
    );
    await check(row("config_reload", "apply adopts the config on disk"), w, () =>
      configReload(w.ctx, { apply: true }),
    );
    expect(w.calls).toEqual(["adoptGlobalConfig", "reloadRuntimeConfig"]);
  });

  test("a broken config aborts before adopting anything", async () => {
    const w = await build("mid", FURNISHED);
    await writeFile(w.ctx.configPath, "this is not toml [[[");
    await check(row("config_reload", "a broken config aborts before adopting anything"), w, () =>
      configReload(w.ctx, { apply: true }),
    );
    expect(w.calls).toEqual([]);
  });

  test("a broken character overlay aborts the reload", async () => {
    const w = await build("mid", FURNISHED, [
      ["config/characters/broken/workspace/SOUL.md", "x"],
      ["config/characters/broken/config.toml", "nope = [[["],
    ]);
    await check(row("config_reload", "a broken character overlay aborts the reload"), w, () =>
      configReload(w.ctx, { apply: true }),
    );
    expect(w.calls).toEqual([]);
  });

  test("reload with no character context previews and applies global configuration", async () => {
    const w = await build(undefined, FURNISHED);
    expect(await configReload(w.ctx, {})).toMatchObject({ applied: false, character: null, changed_prompt_files: [] });
    expect(w.calls).toEqual([]);
    expect(await configReload(w.ctx, { apply: null, refresh_prompts: null })).toMatchObject({ applied: false, character: null });
    expect(w.calls).toEqual([]);
    expect(await configReload(w.ctx, { apply: true })).toMatchObject({ applied: true, character: null, prompts_refreshed: false });
    expect(w.calls).toEqual(["adoptGlobalConfig", "reloadRuntimeConfig"]);
    expect(configReload(w.ctx, { apply: true, refresh_prompts: true })).rejects.toThrow("requires a character context");
  });

  test("check mode lists the prompt files that differ", async () => {
    const w = await build("mid", FURNISHED);
    await seedPromptFiles(w, "canonical soul", "stale soul", "shared user");
    await check(row("config_reload", "check mode lists the prompt files that differ"), w, () =>
      configReload(w.ctx, {}),
    );
  });

  test("a prompt file with no snapshot at all is changed", async () => {
    const w = await build("mid", FURNISHED);
    await seedPromptFiles(w, "canonical soul", undefined, "shared user");
    await check(row("config_reload", "a prompt file with no snapshot at all is changed"), w, () =>
      configReload(w.ctx, {}),
    );
  });

  test("apply with refresh_prompts activates the pending edits", async () => {
    const w = await build("mid", FURNISHED);
    await seedPromptFiles(w, "canonical soul", "stale soul", "shared user");
    const r = row("config_reload", "apply with refresh_prompts activates the pending edits");
    await check(r, w, () => configReload(w.ctx, { apply: true, refresh_prompts: true }));

    const { changedPromptFiles } = await import("../src/memory/deferred_edits.ts");
    expect(
      await changedPromptFiles(
        join(w.ctx.config.dirs.data, "mid"),
        w.ctx.config.dirs.config,
        "mid",
      ),
    ).toEqual(r.changed_after as string[]);

    expect(w.calls).toEqual([
      "notifyPromptSnapshotRefreshed:mid",
      "adoptGlobalConfig",
      "reloadRuntimeConfig",
    ]);
  });

  test("apply without refresh_prompts leaves the snapshot alone", async () => {
    const w = await build("mid", FURNISHED);
    await seedPromptFiles(w, "canonical soul", "stale soul", "shared user");
    const r = row("config_reload", "apply without refresh_prompts leaves the snapshot alone");
    await check(r, w, () => configReload(w.ctx, { apply: true, refresh_prompts: false }));

    const { changedPromptFiles } = await import("../src/memory/deferred_edits.ts");
    expect(
      await changedPromptFiles(
        join(w.ctx.config.dirs.data, "mid"),
        w.ctx.config.dirs.config,
        "mid",
      ),
    ).toEqual(r.changed_after as string[]);
    expect(w.calls).not.toContain("notifyPromptSnapshotRefreshed:mid");
  });
});

describe("secrets in config output", () => {
  const SECRETS = `
[notifications]
url = "https://ntfy.example.com"
topic = "shore"
token_env = "NTFY_TOKEN"
[mcp.weather]
command = "weather-mcp"
[mcp.weather.env]
WEATHER_API_KEY = "env_do_not_leak"
[mcp.remote]
url = "https://mcp.example.com"
[mcp.remote.headers]
Authorization = "Bearer hdr_do_not_leak"
`;
  const sentinels = ["env_do_not_leak", "hdr_do_not_leak"];

  test("a full config dump redacts them", async () => {
    const w = await build(undefined, SECRETS);
    const blob = JSON.stringify(config(w.ctx, {}));
    for (const sentinel of sentinels) expect(blob).not.toContain(sentinel);
    expect(blob).toContain("<redacted>");
  });

  test("asking for the key directly redacts it too", async () => {
    const w = await build(undefined, SECRETS);
    expect(config(w.ctx, { key: "mcp.weather.env.WEATHER_API_KEY" })).toMatchObject({
      key: "mcp.weather.env.WEATHER_API_KEY",
      config: "<redacted>",
    });
    const headers = JSON.stringify(config(w.ctx, { key: "mcp" }));
    expect(headers).not.toContain("hdr_do_not_leak");
    expect(headers).not.toContain("env_do_not_leak");
  });

  test("non-secret neighbours are still readable", async () => {
    const w = await build(undefined, SECRETS);
    expect(config(w.ctx, { key: "notifications.url" })).toMatchObject({
      config: "https://ntfy.example.com",
    });
    expect(config(w.ctx, { key: "mcp.weather.command" })).toMatchObject({
      config: "weather-mcp",
    });
  });

  test("an unset secret reads as empty", async () => {
    const w = await build(undefined, '[mcp.weather]\ncommand="weather-mcp"\n[mcp.weather.env]\nWEATHER_API_KEY=""');
    expect(config(w.ctx, { key: "mcp.weather.env.WEATHER_API_KEY" })).toMatchObject({ config: "" });
  });
});


test("config reload compares restart sections with the adopted global configuration", async () => {
  const w = await build("ada", "[notifications]\nvia = \"off\"\n");
  const global = w.ctx.config;
  const overlay = join(global.dirs.config, "characters", "ada");
  await mkdir(overlay, { recursive: true });
  await writeFile(join(overlay, "config.toml"), "[notifications]\nvia = \"notify_send\"\n");
  w.ctx.config = required(loadCharacterConfig(global, "ada"));
  w.ctx.runtime.globalConfig = () => global;
  expect((await configReload(w.ctx, {})).restart_required).toBeUndefined();
  await writeFile(w.ctx.configPath, "[notifications]\nvia = \"notify_send\"\n");
  expect((await configReload(w.ctx, {})).restart_required).toEqual(["[notifications]"]);
});
