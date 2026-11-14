import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readFileSync } from "node:fs";

import { config, schemaOf, tools, type ConfigContext, type ConfigRuntime } from "../src/commands/config.ts";
import { modelSettings, switchModel } from "../src/commands/models.ts";
import { describeTool, resolveTool, type RunToolContext } from "../src/commands/run_tool.ts";
import { loadConfig } from "../src/config/loader.ts";
import { testTmp } from "./support/tmp.ts";

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

describe("the switch for a character's own time", () => {
  test("is shown under [triggers], on or off, beside what else the user set there", async () => {
    const on = await build(undefined, "[triggers]\nenabled = true\nmax_idle_wakes = 9\n");
    expect(config(on.ctx, { key: "triggers.enabled" })).toMatchObject({ key: "triggers.enabled", config: true });
    expect(config(on.ctx, { key: "triggers.max_idle_wakes" })).toMatchObject({ config: 9 });
    const off = await build(undefined, '[chat]\ndisplay_name = "eve"\n');
    expect(config(off.ctx, { key: "triggers.enabled" })).toMatchObject({ key: "triggers.enabled", config: false });
  });
});

describe("[chat] in config output", () => {
  const CHAT = [
    "[chat]", 'model = "anthropic:claude-x"', 'display_name = "eve"', 'user_timestamps = "always"', 'reasoning_replay = "none"', "max_retries = 2", 'retry_backoff = "3s"',
    '[chat."anthropic:claude-x"]', "temperature = 0.5", 'reasoning_replay = "all"', "max_tool_rounds = 9",
    '[chat."anthropic:claude-y"]', "max_output_tokens = 1000",
    "[providers.anthropic]", 'api_key_env = "K"', "temperature = 0.7",
    '[image."openai:gpt-image"]', 'size = "1024x1024"', "",
  ].join("\n");
  const settings = {
    model: "anthropic:claude-x", display_name: "eve", system_prompt: null, user_timestamps: "always", reasoning_replay: "none", max_retries: 2, retry_backoff: "3s",
  };
  const profiles = {
    "anthropic:claude-x": { temperature: 0.5, reasoning_replay: "all", max_tool_rounds: 9 },
    "anthropic:claude-y": { max_output_tokens: 1000 },
  };

  test("the section shows the chat settings and each model's own settings together, and the providers and image models beside it", async () => {
    const w = await build(undefined, CHAT);
    const shown = (config(w.ctx, {}) as { config: Record<string, unknown> }).config;
    expect(shown.chat).toEqual({ ...profiles, ...settings });
    expect(Object.keys(shown.chat as object)).toEqual([...Object.keys(profiles), ...Object.keys(settings)]);
    expect(shown.providers).toEqual({ anthropic: { api_key_env: "K", temperature: 0.7 } });
    expect(shown.image).toEqual({ "openai:gpt-image": { size: "1024x1024" }, model: null });
  });

  test("a setting or a model's settings can be asked for by key, and a config with no model settings shows only the chat settings", async () => {
    const w = await build(undefined, CHAT);
    expect(config(w.ctx, { key: "chat.reasoning_replay" })).toMatchObject({ key: "chat.reasoning_replay", config: "none" });
    expect(config(w.ctx, { key: 'chat."anthropic:claude-x"' })).toMatchObject({ config: profiles["anthropic:claude-x"] });
    expect(config(w.ctx, { key: 'chat."anthropic:claude-x".reasoning_replay' })).toMatchObject({ config: "all" });

    const plain = await build(undefined, '[chat]\ndisplay_name = "eve"\n');
    const shown = (config(plain.ctx, {}) as { config: Record<string, unknown> }).config;
    expect(shown.chat).toEqual({ model: null, display_name: "eve", system_prompt: null, user_timestamps: "auto", reasoning_replay: "all", max_retries: null, retry_backoff: null });
    expect([shown.providers, shown.image]).toEqual([{}, { model: null }]);
  });
});

describe("[tools], [subagents] and [notifications] in config output", () => {
  const TOML = [
    "[tools]", 'enabled = ["bash", "read", "nope"]', 'mcp = ["search", "gone"]', 'timeout = "90s"',
    "[tools.bash]", 'timeout = "10m"', "max_result_chars = 77",
    "[subagents]", 'model = "anthropic:claude-x"', 'enabled = ["scout", "ghost"]',
    "[subagents.scout]", 'description = "looks"', 'prompt = "look"', 'tools = ["read", "mcp__search__find", "mcp__gone__x", "nope"]', "max_tool_rounds = 4",
    "[subagents.idle]", 'description = "rests"', 'prompt = "rest"', 'model = "anthropic:claude-y"',
    "[mcp.search]", 'command = "srch"', 'working_dir = "tools/search"',
    "[notifications]", 'via = "ntfy"', 'events = ["usage_warning", "error"]', 'min_generation_duration = "30s"',
    "[providers.anthropic]", 'api_key_env = "K"', "",
  ].join("\n");

  test("each section shows its settings and the tables written under it side by side", async () => {
    const w = await build(undefined, TOML);
    const shown = (config(w.ctx, {}) as { config: Record<string, Record<string, unknown>> }).config;
    expect(shown.tools).toEqual({
      enabled: ["bash", "read", "nope"], mcp: ["search", "gone"], max_result_chars: 50_000, max_inline_image_bytes: 5_242_880, timeout: "90s", user: null, pass_env: [], no_new_privs: true,
      bash: { max_result_chars: 77, timeout: "10m" },
    });
    expect(shown.subagents).toEqual({
      model: "anthropic:claude-x", enabled: ["scout", "ghost"],
      idle: { description: "rests", prompt: "rest", tools: [], model: "anthropic:claude-y", max_tool_rounds: null, timeout: null },
      scout: { description: "looks", prompt: "look", tools: ["read", "mcp__search__find", "mcp__gone__x", "nope"], model: null, max_tool_rounds: 4, timeout: null },
    });
    expect(shown.mcp).toEqual({ search: { command: "srch", args: [], env: {}, working_dir: "tools/search", user: null, url: null, headers: {}, bearer_token_env: null } });
    expect(shown.notifications).toMatchObject({ via: "ntfy", events: ["error", "usage_warning"], min_generation_duration: "30s", url: "https://ntfy.sh", topic: "" });
    expect(shown.matrix).toBeNull();

    expect(config(w.ctx, { key: "tools.bash.timeout" })).toMatchObject({ key: "tools.bash.timeout", config: "10m", defaults: null });
    expect(config(w.ctx, { key: "subagents.scout.max_tool_rounds" })).toMatchObject({ config: 4 });
    expect(config(w.ctx, { key: "notifications.via" })).toMatchObject({ config: "ntfy", defaults: "off" });
    expect(config(w.ctx, { key: "notifications.events" })).toMatchObject({ defaults: ["autonomous_message", "message_complete"] });
    expect(config(w.ctx, { key: "notifications.min_generation_duration" })).toMatchObject({ defaults: "0s" });
    expect(() => config(w.ctx, { key: "tools.per_tool" })).toThrow("Config section not found: tools.per_tool");
    expect(() => config(w.ctx, { key: "subagents.agents" })).toThrow("Config section not found: subagents.agents");

    const plain = (config((await build(undefined, '[chat]\ndisplay_name = "eve"\n')).ctx, {}) as { config: Record<string, Record<string, unknown>>; defaults: Record<string, unknown> });
    expect(Object.keys(plain.config.tools ?? {})).toEqual(["enabled", "mcp", "max_result_chars", "max_inline_image_bytes", "timeout", "user", "pass_env", "no_new_privs"]);
    expect(plain.config.subagents).toEqual({ model: null, enabled: [] });
    expect(plain.defaults.subagents).toEqual({ model: null, enabled: [] });
  });

  test("the list of settings has a row for every tool and sub-agent written in the file, and marks what needs a restart", async () => {
    const w = await build(undefined, TOML);
    const rows = new Map(schemaOf(w.ctx).map((row) => [row.key, row]));
    const keys = [...rows.keys()];
    expect(keys.filter((key) => /^tools\..+\.timeout$/.test(key))).toEqual(['tools."<name>".timeout', "tools.bash.timeout"]);
    expect(keys.filter((key) => /^subagents\..+\.prompt$/.test(key))).toEqual(['subagents."<name>".prompt', "subagents.idle.prompt", "subagents.scout.prompt"]);
    expect(keys.filter((key) => key.endsWith(".working_dir"))).toEqual(['mcp."<name>".working_dir', "mcp.search.working_dir"]);
    expect(rows.get("tools.bash")).toMatchObject({ kind: "table", settable: false });
    expect(rows.get("tools")).toMatchObject({ kind: "table", key_source: "tools" });
    expect(rows.get("subagents")).toMatchObject({ kind: "table", key_source: "subagents" });
    expect(rows.get("subagents.model")).toMatchObject({ kind: "string", optional: true, source: "chat_models" });
    expect(rows.get("subagents.enabled")).toMatchObject({ kind: "list", source: "subagents" });
    expect(rows.get("notifications.via")).toMatchObject({ kind: "enum", values: ["off", "notify_send", "ntfy", "command"], settable: true, restart_required: true });
    expect(rows.get("notifications.events")).toMatchObject({
      kind: "list", item_kind: "enum", settable: true, values: ["autonomous_message", "cache_warning", "compaction_complete", "error", "message_complete", "usage_warning"],
    });
    expect([rows.get("matrix")?.restart_required, rows.get("matrix.homeserver_url")?.restart_required, rows.get("daemon.listen_addr")?.restart_required]).toEqual([true, true, true]);
    expect([rows.get("tools.enabled")?.restart_required, rows.get("marks.tags")?.restart_required, rows.get("image.model")?.restart_required]).toEqual([false, false, false]);
    for (const gone of ["tools.per_tool", "subagents.agents", "notifications.enabled", "notifications.backend", "notifications.ntfy.url", "matrix.homeserver", "defaults.subagent_model"]) {
      expect(keys.filter((key) => key === gone || key.startsWith(`${gone}.`))).toEqual([]);
    }
  });

  test("shore tools lists each tool with who may use it and each sub-agent, and warns about names that lead nowhere", async () => {
    const w = await build(undefined, TOML);
    const listed = tools(w.ctx, ["mcp__search__find", "mcp__search__add"]);
    expect(listed.tools.find((row) => row.tool === "read")).toEqual({ tool: "read", main: true, subagents: ["scout"] });
    expect(listed.tools.find((row) => row.tool === "bash")).toEqual({ tool: "bash", main: true, subagents: [] });
    expect(listed.tools.find((row) => row.tool === "edit")).toEqual({ tool: "edit", main: false, subagents: [] });
    expect(listed.subagents).toEqual([
      { name: "idle", enabled: false, tools: [], model: "anthropic:claude-y" },
      { name: "scout", enabled: true, tools: ["read", "mcp__search__find", "mcp__gone__x", "nope"], model: null },
    ]);
    expect(listed.mcp).toEqual(["mcp__search__add", "mcp__search__find"]);
    expect(listed.warnings).toEqual([
      "tools.enabled references unknown tool 'nope'",
      "tools.mcp references MCP server 'gone' with no [mcp.gone] definition",
      "subagents.enabled references undefined subagent 'ghost'",
      "subagent 'scout' references unknown tool 'mcp__gone__x'",
      "subagent 'scout' references unknown tool 'nope'",
    ]);
  });
});

describe("sub-agents in the model and tool commands", () => {
  const TOML = [
    "[chat]", 'model = "anthropic:claude-x"',
    "[subagents]", 'enabled = ["scout"]',
    "[subagents.scout]", 'description = "looks for {{user}}"', 'prompt = "look"',
    "[subagents.idle]", 'description = "rests"', 'prompt = "rest"', 'model = "anthropic:claude-y"',
    "[providers.anthropic]", 'api_key_env = "K"', "",
  ].join("\n");

  test("giving every sub-agent one model writes subagents.model and clears the models that sub-agents had of their own", async () => {
    const w = await build(undefined, TOML);
    const models = { ...w.ctx, dataDir: w.ctx.config.dirs.data };
    const switched = switchModel(models, { name: "anthropic:claude-z", subagent: "all", include_hidden: true });
    expect(switched).toMatchObject({ target: "role", role: "sub-agents", active: "anthropic:claude-z", config_key: "subagents.model", cleared: ["subagents.idle.model"] });
    const written = Bun.TOML.parse(readFileSync(w.ctx.configPath, "utf8")) as { subagents: Record<string, unknown> };
    expect(written.subagents).toEqual({
      enabled: ["scout"], model: "anthropic:claude-z",
      scout: { description: "looks for {{user}}", prompt: "look" },
      idle: { description: "rests", prompt: "rest" },
    });

    expect(() => modelSettings(models, { key: "scout" })).toThrow("scout is a sub-agent, not a setting; write --subagent=scout to target it");
    expect(() => modelSettings(models, { key: "bogus" })).toThrow("unknown setting key: bogus; supported: ");
  });

  test("a sub-agent can be looked up as a tool: whether it is on, what it is for, and what it takes", async () => {
    const w = await build(undefined, TOML);
    const loaded = w.ctx.config;
    expect([resolveTool("ask_scout", loaded, []).kind, resolveTool("ask_scout", loaded, []).enabled, resolveTool("ask_idle", loaded, []).enabled]).toEqual(["subagent", true, false]);
    expect(() => resolveTool("ask_ghost", loaded, [])).toThrow("There is no sub-agent named 'ghost'. Configured: idle, scout");

    const run = { config: loaded, mcpTools: () => [] } as unknown as RunToolContext;
    const described = describeTool("Ada", run, { tool: "ask_scout" });
    expect(described).toMatchObject({ mode: "tool_definition", tool: "ask_scout", kind: "subagent", enabled: true, description: `looks for ${process.env["USER"] ?? "User"}` });
    expect(Object.keys(described.input_schema["properties"] ?? {})).toEqual(["query"]);
    expect(describeTool("Ada", run, { tool: "ask_idle" })).toMatchObject({ enabled: false, description: "rests" });
    expect(() => describeTool("Ada", run, { tool: "ask_ghost" })).toThrow("There is no sub-agent named 'ghost'. Configured: idle, scout");
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
