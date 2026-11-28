import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { chmodSync, readFileSync } from "node:fs";

import { config, configReload, configSchemaCommand, schemaOf, tools, type ConfigContext, type ConfigRuntime } from "../src/commands/config.ts";
import { ALL_TOOLS } from "../src/tools/registry.ts";
import { ensureActivePromptSnapshot, loadActivePromptFile } from "../src/memory/deferred_edits.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { writeDurable } from "../src/storage/files.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import { outcomeOf } from "./support/outcome.ts";
import { listModels, modelInfo, modelSettings, resetModel, setModelSetting, switchModel } from "../src/commands/models.ts";
import { describeTool, resolveTool, type RunToolContext } from "../src/commands/run_tool.ts";
import { Texts } from "../src/texts/texts.ts";
import { loadConfig } from "../src/config/loader.ts";
import { shoreLog } from "../src/log.ts";
import { characterPreferencesPath, globalPreferencesPath } from "../src/config/preferences.ts";
import type { ModelSettingsDetail } from "../src/protocol/ModelSettingsDetail.ts";
import { testTmp } from "./support/tmp.ts";
import { CACHE_VERSION, cachePath, writeCache } from "../src/llm/discovery.ts";

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

describe("the switch for a character's triggers", () => {
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
    "[providers.anthropic]", 'api_key_env = "K"', "temperature = 0.7", "",
  ].join("\n");
  const settings = {
    model: "anthropic:claude-x", display_name: "eve", system_prompt: null, user_timestamps: "always", reasoning_replay: "none", max_retries: 2, retry_backoff: "3s",
  };
  const profiles = {
    "anthropic:claude-x": { temperature: 0.5, reasoning_replay: "all", max_tool_rounds: 9 },
    "anthropic:claude-y": { max_output_tokens: 1000 },
  };

  test("the section shows the chat settings and each model's own settings together, and the providers beside it", async () => {
    const w = await build(undefined, CHAT);
    const shown = (config(w.ctx, {}) as { config: Record<string, unknown> }).config;
    expect(shown.chat).toEqual({ ...profiles, ...settings });
    expect(Object.keys(shown.chat as object)).toEqual([...Object.keys(profiles), ...Object.keys(settings)]);
    expect(shown.providers).toEqual({ anthropic: { api_key_env: "K", temperature: 0.7 } });
  });

  test("a setting or a model's settings can be asked for by key, and a config with no model settings shows only the chat settings", async () => {
    const w = await build(undefined, CHAT);
    expect(config(w.ctx, { key: "chat.reasoning_replay" })).toMatchObject({ key: "chat.reasoning_replay", config: "none" });
    expect(config(w.ctx, { key: 'chat."anthropic:claude-x"' })).toMatchObject({ config: profiles["anthropic:claude-x"] });
    expect(config(w.ctx, { key: 'chat."anthropic:claude-x".reasoning_replay' })).toMatchObject({ config: "all" });

    const plain = await build(undefined, '[chat]\ndisplay_name = "eve"\n');
    const shown = (config(plain.ctx, {}) as { config: Record<string, unknown> }).config;
    expect(shown.chat).toEqual({ model: null, display_name: "eve", system_prompt: null, user_timestamps: "auto", reasoning_replay: "all", max_retries: null, retry_backoff: null });
    expect(shown.providers).toEqual({});
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
    expect([rows.get("matrix")?.restart_required, rows.get("matrix.homeserver_url")?.restart_required, rows.get("daemon.web.bind_addr")?.restart_required]).toEqual([true, true, true]);
    expect([rows.get("tools.enabled")?.restart_required, rows.get("marks.like_tags")?.restart_required, rows.get("marks.dislike_tags")?.restart_required]).toEqual([false, false, false]);
    for (const gone of ["tools.per_tool", "subagents.agents", "notifications.enabled", "notifications.backend", "notifications.ntfy.url", "matrix.homeserver", "defaults.subagent_model"]) {
      expect(keys.filter((key) => key === gone || key.startsWith(`${gone}.`))).toEqual([]);
    }
  });

  test("shore tools says which tool a name is part of now, for the character's tools and a sub-agent's", async () => {
    const w = await build(undefined, [
      "[tools]", 'enabled = ["read", "search_chat_logs", "threads", "nope"]',
      "[subagents.scout]", 'description = "looks"', 'prompt = "look"', 'tools = ["edit_thread", "chat_logs"]',
    ].join("\n"));
    const listed = tools(w.ctx);
    expect(listed.warnings).toEqual([
      "tools.enabled references 'search_chat_logs', which is now part of 'chat_logs'",
      "tools.enabled references unknown tool 'nope'",
      "subagent 'scout' references 'edit_thread', which is now part of 'threads'",
    ]);
    expect(listed.tools.filter((row) => row.main).map((row) => row.tool)).toEqual(["read", "threads"]);
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

describe("[[budgets]] and [plan_limits] in config output", () => {
  const TOML = [
    "[providers.openrouter]", "[[providers.openrouter.keys]]", 'name = "work"', 'api_key_env = "K"', "spend_limit_usd = 20",
    "[usage]", 'timezone = "utc"',
    "[[budgets]]", 'name = "daily"', "cost_usd = 5", 'limit_action = "block"', "allow_compaction = true", 'usage_kinds = ["background"]',
    "[[budgets]]", "cost_usd = 7", 'period = "week"', 'pace_period = "day"', "pace_warn_fractions = [0.7]",
    "[plan_limits.five_hour]", "warn_fractions = [0.5]", "",
  ].join("\n");

  test("the budgets the user wrote are shown under the file's names, each with whether compaction may pass it, and a key's spending limit is left with the key", async () => {
    const w = await build(undefined, TOML);
    const shown = (config(w.ctx, {}) as { config: Record<string, unknown> }).config;
    const unset = {
      character: null, provider: null, api_key: null, model: null, call_type: null, reset_hour: null, reset_day_of_week: null, reset_day_of_month: null,
      pace_period: null, pace_action: null, pace_warn_fractions: null, warn_action: null, pace_warn_action: null,
    };
    expect(shown.budgets).toEqual([
      { ...unset, name: "daily", period: "day", cost_usd: 5, warn_fractions: [0.8, 1], limit_action: "block", usage_kinds: ["background"], allow_compaction: true },
      { ...unset, name: "", period: "week", cost_usd: 7, warn_fractions: [0.8, 1], limit_action: "warn", usage_kinds: [], allow_compaction: false, pace_period: "day", pace_warn_fractions: [0.7] },
    ]);
    expect([shown.usage, shown.plan_limits]).toEqual([{ timezone: "utc" }, {
      five_hour: { warn_fractions: [0.5], limit_fraction: 1, limit_action: "pause_background" },
      seven_day: { warn_fractions: [0.8, 0.95], limit_fraction: 1, limit_action: "pause_background" },
    }]);
    expect(config(w.ctx, { key: "budgets" })).toMatchObject({ key: "budgets", config: shown.budgets, defaults: [] });
    expect(config(w.ctx, { key: "plan_limits.five_hour.warn_fractions" })).toMatchObject({ config: [0.5], defaults: [0.8, 0.95] });
    expect(() => config(w.ctx, { key: "usage.budgets" })).toThrow("Config section not found: usage.budgets");
  });

  test("the list of settings names a budget's settings as the file does", async () => {
    const w = await build(undefined, TOML);
    const rows = schemaOf(w.ctx).filter((row) => row.key.startsWith("budgets.") || row.key.startsWith("plan_limits.five_hour.") || row.key.startsWith("usage."));
    expect(rows.map((row) => `${row.key}: ${row.type}${row.optional ? "?" : ""}`)).toEqual([
      'budgets."<index>": table', 'budgets."<index>".allow_compaction: boolean', 'budgets."<index>".api_key: string?', 'budgets."<index>".call_type: string?',
      'budgets."<index>".character: string?', 'budgets."<index>".cost_usd: number', 'budgets."<index>".limit_action: warn | block | pause_background | pause_wakes',
      'budgets."<index>".model: string?', 'budgets."<index>".name: string', 'budgets."<index>".pace_action: warn | block | pause_background | pause_wakes?',
      'budgets."<index>".pace_period: hour | day | week | month?', 'budgets."<index>".pace_warn_action: warn | block | pause_background | pause_wakes?',
      'budgets."<index>".pace_warn_fractions: list of number?', 'budgets."<index>".period: hour | day | week | month', 'budgets."<index>".provider: string?',
      'budgets."<index>".reset_day_of_month: integer?', 'budgets."<index>".reset_day_of_week: monday | tuesday | wednesday | thursday | friday | saturday | sunday?',
      'budgets."<index>".reset_hour: integer?', 'budgets."<index>".usage_kinds: list of string', 'budgets."<index>".warn_action: warn | block | pause_background | pause_wakes?',
      'budgets."<index>".warn_fractions: list of number', "plan_limits.five_hour.limit_action: warn | block | pause_background | pause_wakes",
      "plan_limits.five_hour.limit_fraction: number", "plan_limits.five_hour.warn_fractions: list of number", "usage.timezone: string",
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

  test("a setting for a sub-agent with no model to go by, or one naming a model there isn't, is refused saying why", async () => {
    const bare = await build(undefined, TOML.replace('[chat]\nmodel = "anthropic:claude-x"\n', "").replace('enabled = ["scout"]', "enabled = []"));
    expect(() => setModelSetting({ ...bare.ctx, dataDir: bare.ctx.config.dirs.data }, { key: "reasoning_effort", value: "low", subagent: "scout" }))
      .toThrow("subagent 'scout' has no model: subagents.scout.model and defaults.subagent_model are unset, and no character is attached to inherit a chat model from");
    const unknown = await build(undefined, TOML.replace('model = "anthropic:claude-y"', 'model = "nowhere:nothing"'));
    expect(() => setModelSetting({ ...unknown.ctx, dataDir: unknown.ctx.config.dirs.data }, { key: "reasoning_effort", value: "low", subagent: "idle" })).toThrow("nowhere");
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

  test("a built-in or MCP tool is looked up with the description the character gets, the user's wording included, whether it is on, and what it takes", async () => {
    const w = await build(undefined, TOML);
    const loaded = w.ctx.config;
    await writeFile(join(loaded.dirs.config, "read.md"), "Read a file for {{user}}.\n");
    const mcp = [
      { full_name: "mcp__web__fetch", description: "Fetches a page", input_schema: { type: "object", properties: { url: { type: "string" } } } },
      { full_name: "mcp__web__bare", input_schema: { type: "object", properties: {} } },
    ];
    const tuned = { ...loaded, app: { ...loaded.app, texts: { tool_read: "read.md" }, chat: { ...loaded.app.chat, display_name: "Eve" }, tools: { ...loaded.app.tools, enabled: ["read", "mcp__web__fetch"] } } };
    const run = { config: tuned, mcpTools: () => mcp } as unknown as RunToolContext;
    const read = describeTool("Ada", run, { tool: "read" });
    expect([read.kind, read.enabled, read.description]).toEqual(["builtin", true, "Read a file for Eve."]);
    expect((read.input_schema["properties"] as Record<string, { description?: string }>)["file_path"]?.description).toBe(new Texts().render("tool_read_file_path"));
    expect([describeTool("Ada", run, { tool: "edit" }).enabled, describeTool("Ada", run, { tool: "edit" }).kind]).toEqual([false, "builtin"]);
    expect(describeTool("Ada", run, { tool: "mcp__web__fetch" })).toMatchObject({ kind: "mcp", enabled: true, description: "Fetches a page" });
    expect(describeTool("Ada", run, { tool: "mcp__web__bare" })).toMatchObject({ kind: "mcp", enabled: false, description: "" });
    expect(() => describeTool("Ada", run, { tool: "nope" })).toThrow("There is no tool named 'nope'. Built-in tools: read, edit, ");
    expect(() => describeTool("Ada", run, { tool: "mcp__web__gone" })).toThrow("There is no MCP tool named 'mcp__web__gone'. Connected: mcp__web__fetch, mcp__web__bare");
  });
});

describe("a model's settings in the model commands", () => {
  const TOML = [
    "[chat]", 'model = "anthropic:claude-x"',
    "[providers.anthropic]", 'api_key_env = "K"', "max_tool_rounds = 9",
    "[providers.openrouter]", 'api_key_env = "K"',
    "[providers.gemini]", 'api_key_env = "K"',
    "[providers.zai-api]", 'api_key_env = "K"',
    '[chat."anthropic:claude-x"]', "max_output_tokens = 4000",
    '[chat."openrouter:x/y"]', "max_output_tokens = 4000",
    '[chat."gemini:gemini-3-pro"]', 'gemini_thinking_mode = "level"',
    '[chat."zai-api:glm-9"]', "max_output_tokens = 4000", "",
  ].join("\n");
  const settingsOf = (models: Parameters<typeof modelSettings>[0], args: Parameters<typeof modelSettings>[1] = {}): ModelSettingsDetail =>
    modelSettings(models, args) as ModelSettingsDetail;
  const THREE = { reasoning_budget_tokens: 2048, reasoning_replay: "none", max_tool_rounds: 8 };
  const ROUTING = { openrouter_routing: { order: ["a"] } };

  test("each is saved, shown and written to the preferences file under the name config.toml uses", async () => {
    const w = await build("ada", TOML);
    const models = { ...w.ctx, dataDir: w.ctx.config.dirs.data };
    expect(settingsOf(models).effective_sampler).toMatchObject({ max_tool_rounds: 9, reasoning_budget_tokens: null, reasoning_replay: null, openrouter_routing: null });
    for (const [key, value] of Object.entries(THREE)) {
      expect(setModelSetting(models, { key, value, scope: "character" })).toMatchObject({ changed: true, key, value, model: "anthropic:claude-x", scope: "character" });
    }
    expect(setModelSetting(models, { key: "openrouter_routing", value: ROUTING.openrouter_routing, scope: "character", name: "openrouter:x/y" })).toMatchObject({ key: "openrouter_routing", value: ROUTING.openrouter_routing });
    expect(setModelSetting(models, { key: "gemini_thinking_mode", value: "budget", scope: "global", name: "gemini:gemini-3-pro" })).toMatchObject({ key: "gemini_thinking_mode", value: "budget" });
    expect(setModelSetting(models, { key: "zai_clear_reasoning", value: true, scope: "global", name: "zai-api:glm-9" })).toMatchObject({ key: "zai_clear_reasoning", value: true });

    expect(modelSettings(models, {})).toMatchObject({ effective_sampler: THREE, saved_character: THREE, saved_global: null });
    expect(modelSettings(models, { key: "max_tool_rounds" })).toMatchObject({ key: "max_tool_rounds" });
    expect(modelInfo(models, {})).toMatchObject({ ...THREE, openrouter_routing: null, gemini_thinking_mode: null, zai_clear_reasoning: null });
    expect(modelInfo(models, { name: "openrouter:x/y" })).toMatchObject({ ...ROUTING, reasoning_budget_tokens: null, max_tool_rounds: null });
    expect(modelInfo(models, { name: "gemini:gemini-3-pro" })).toMatchObject({ gemini_thinking_mode: "budget", reasoning_budget_tokens: null, max_tool_rounds: null });
    expect(settingsOf(models, { name: "gemini:gemini-3-pro" }).setting_schema.find((row) => row.key === "gemini_thinking_mode"))
      .toEqual({ key: "gemini_thinking_mode", kind: "string", applicability: "honored", suggestions: ["auto", "budget", "level"], allow_custom: false });
    expect(modelInfo(models, { name: "zai-api:glm-9" })).toMatchObject({ zai_clear_reasoning: true });

    const saved = (path: string): unknown => (Bun.TOML.parse(readFileSync(path, "utf8")) as { models: unknown }).models;
    expect(saved(characterPreferencesPath(models.dataDir, "ada"))).toEqual({ "anthropic:claude-x": THREE, "openrouter:x/y": ROUTING });
    expect(saved(globalPreferencesPath(models.dataDir))).toEqual({ "gemini:gemini-3-pro": { gemini_thinking_mode: "budget" }, "zai-api:glm-9": { zai_clear_reasoning: true } });

    expect(setModelSetting(models, { key: "openrouter_routing", value: '{"only":["z"]}', scope: "character", name: "openrouter:x/y" })).toMatchObject({ changed: true });
    expect(modelInfo(models, { name: "openrouter:x/y" })).toMatchObject({ openrouter_routing: { only: ["z"] } });
    expect(setModelSetting(models, { key: "gemini_thinking_mode", value: null, scope: "global", name: "gemini:gemini-3-pro" })).toMatchObject({ value: null });
    expect(modelInfo(models, { name: "gemini:gemini-3-pro" })).toMatchObject({ gemini_thinking_mode: "level" });
  });

  test("the list of a model's settings says what kind each is and whether a value outside its suggestions is taken, and the overview shows only what is saved", async () => {
    const w = await build("ada", TOML);
    const models = { ...w.ctx, dataDir: w.ctx.config.dirs.data };
    expect(settingsOf(models).setting_schema.map((row) => [row.key, row.kind, row.allow_custom, row.suggestions])).toEqual([
      ["temperature", "number", true, []], ["top_p", "number", true, []],
      ["reasoning_effort", "string", true, ["adaptive", "low", "medium", "high", "xhigh", "max", "off"]],
      ["reasoning_budget_tokens", "u32", true, ["1024", "2048", "4096", "8192", "16384", "32768"]],
      ["max_output_tokens", "u32", true, ["16384", "32768", "65536"]], ["cache_ttl", "duration", true, ["5m", "1h"]],
      ["cache_keepalive", "duration_or_off", true, ["off", "4m", "55m"]], ["cache_keepalive_pings", "u32", true, ["1", "2", "3"]],
      ["sdk", "string", false, ["anthropic", "openai", "openrouter", "gemini", "zai", "deepseek", "moonshot", "claude_agent", "nanogpt"]],
      ["reasoning_replay", "string", false, ["all", "none"]], ["max_tool_rounds", "u32", true, ["8", "16", "32", "64"]],
      ["openrouter_routing", "json_object", true, []], ["gemini_thinking_mode", "string", false, ["auto", "budget", "level"]],
      ["zai_clear_reasoning", "boolean", false, ["true", "false"]], ["supports_images", "boolean", false, ["true", "false"]],
    ]);

    setModelSetting(models, { key: "max_tool_rounds", value: 8, scope: "character" });
    setModelSetting(models, { key: "reasoning_replay", value: "none", scope: "global" });
    expect(modelSettings(models, { overview: true })).toMatchObject({
      overview: true,
      roles: [{ role: "chat", model: "anthropic:claude-x", settings: [{ key: "max_tool_rounds", value: 8, scope: "character" }, { key: "reasoning_replay", value: "none", scope: "global" }] }, { role: "sub-agents", settings: [] }],
    });
  });

  test("shore config keys gives each model setting its type, under a provider and under a model", async () => {
    const w = await build("ada", TOML);
    const rows = (prefix: string): string[] => schemaOf(w.ctx).filter((row) => row.key.startsWith(prefix) && !row.key.includes("keys")).map((row) => `${row.key.slice(prefix.length)}: ${row.type}${row.optional ? "?" : ""}`);
    const settings = [
      "cache_ttl: duration?", "gemini_thinking_mode: auto | budget | level?", "max_context_tokens: integer?", "max_output_tokens: integer?", "max_tool_rounds: integer?", "openrouter_routing: table?",
      "reasoning_budget_tokens: integer?", "reasoning_effort: string?", "reasoning_replay: all | none?", "sdk: string?", "supports_images: boolean?", "system_prompt: string?", "temperature: number?",
      "top_p: number?", "zai_clear_reasoning: boolean?",
    ];
    expect(rows('chat."openrouter:x/y".')).toEqual(settings);
    expect(rows("providers.anthropic.")).toEqual([
      "api_key_env: string?", "base_url: string?", "cache_ttl: duration?", "discover: boolean", "enabled: boolean", "gemini_thinking_mode: auto | budget | level?", "ignore_models: list of string",
      "max_context_tokens: integer?", "max_output_tokens: integer?", "max_tool_rounds: integer?", "no_auth: boolean", "openrouter_routing: table?", "pin: string?", "reasoning_budget_tokens: integer?",
      "reasoning_effort: string?", "reasoning_replay: all | none?", "sdk: string?", "subscription: boolean", "supports_images: boolean?", "system_prompt: string?", "temperature: number?",
      "top_p: number?", "zai_clear_reasoning: boolean?",
    ]);
  });

  test("the names from before are refused, and a value that can't be used is refused naming the setting", async () => {
    const w = await build("ada", TOML);
    const models = { ...w.ctx, dataDir: w.ctx.config.dirs.data };
    const supported = "supported: temperature, top_p, reasoning_effort, reasoning_budget_tokens, max_output_tokens, cache_ttl, cache_keepalive, cache_keepalive_pings, sdk, reasoning_replay, max_tool_rounds, openrouter_routing, gemini_thinking_mode, zai_clear_reasoning, supports_images";
    for (const [old, value] of [["budget_tokens", 1024], ["replay_prior_thinking", "all"], ["max_tool_iterations", 4], ["openrouter_provider", { a: 1 }], ["gemini_generation", 3], ["zai_clear_thinking", true]] as const) {
      expect(() => setModelSetting(models, { key: old, value, scope: "character" })).toThrow(`unknown setting key: ${old}; ${supported}`);
      expect(() => modelSettings(models, { key: old })).toThrow(`unknown setting key: ${old}; ${supported}`);
    }
    for (const [key, value, name, refusal] of [
      ["reasoning_budget_tokens", "lots", "anthropic:claude-x", 'reasoning_budget_tokens must be a non-negative integer fitting in u32, got "lots"'],
      ["reasoning_replay", "some", "openrouter:x/y", 'reasoning_replay must be "all" or "none"; got "some"'],
      ["max_tool_rounds", 0, "openrouter:x/y", "max_tool_rounds must be >= 1; unset it (null) for unlimited"],
      ["max_tool_rounds", "x", "openrouter:x/y", 'max_tool_rounds must be a non-negative integer fitting in u32, got "x"'],
      ["openrouter_routing", "nope", "openrouter:x/y", 'openrouter_routing must be a routing object, got "nope"'],
      ["openrouter_routing", [1], "openrouter:x/y", "openrouter_routing must be a routing object, got [1]"],
      ["openrouter_routing", { a: null }, "openrouter:x/y", "openrouter_routing must be a TOML-compatible object: unsupported unit type"],
      ["gemini_thinking_mode", "fast", "gemini:gemini-3-pro", "gemini_thinking_mode must be auto, budget, or level"],
      ["gemini_thinking_mode", 3, "gemini:gemini-3-pro", "gemini_thinking_mode must be auto, budget, or level"],
      ["zai_clear_reasoning", "maybe", "zai-api:glm-9", 'zai_clear_reasoning must be a boolean, got "maybe"'],
      ["gemini_thinking_mode", "level", "openrouter:x/y", "`gemini_thinking_mode` is not applicable to the `openrouter` sdk for this model"],
    ] as const) {
      expect(() => setModelSetting(models, { key, value, scope: "character", name })).toThrow(refusal);
    }
    expect(setModelSetting(models, { key: "reasoning_replay", value: true, scope: "character" })).toMatchObject({ key: "reasoning_replay", value: true });
    expect(settingsOf(models).effective_sampler).toMatchObject({ reasoning_replay: "all" });
  });

  test("a preferences file is read under the same names, and one that uses an old name or a value that can't be used is refused", async () => {
    const w = await build("ada", TOML);
    const models = { ...w.ctx, dataDir: w.ctx.config.dirs.data };
    const path = characterPreferencesPath(models.dataDir, "ada");
    await mkdir(dirname(path), { recursive: true });
    const having = async (text: string): Promise<() => unknown> => {
      await writeFile(path, text);
      return () => settingsOf(models, { name: "gemini:gemini-3-pro" }).saved_character;
    };
    expect((await having('[models."gemini:gemini-3-pro"]\nreasoning_budget_tokens = 5\nreasoning_replay = "all"\nmax_tool_rounds = 3\nopenrouter_routing = { a = 1 }\ngemini_thinking_mode = "auto"\nzai_clear_reasoning = false\n'))())
      .toMatchObject({ reasoning_budget_tokens: 5, reasoning_replay: "all", max_tool_rounds: 3, openrouter_routing: { a: 1 }, gemini_thinking_mode: "auto", zai_clear_reasoning: false });
    await writeFile(path, '[models."anthropic:claude-x"]\nmax_tool_rounds = 0\n');
    expect(modelSettings(models, {})).toMatchObject({ effective_sampler: { max_tool_rounds: 9 }, saved_character: { max_tool_rounds: 0 } });
    for (const [line, refusal] of [
      ["budget_tokens = 5", "unknown field `budget_tokens`, expected one of `temperature`"],
      ["gemini_generation = 3", "unknown field `gemini_generation`, expected one of `temperature`"],
      ['gemini_thinking_mode = "fast"', "preferences: gemini_thinking_mode must be auto, budget, or level"],
      ["gemini_thinking_mode = 3", "preferences: gemini_thinking_mode must be auto, budget, or level"],
      ['reasoning_replay = "some"', 'invalid reasoning_replay "some"; expected "all", "none"'],
      ['reasoning_budget_tokens = "5"', 'invalid type: string "5", expected u32'],
      ["max_tool_rounds = 1.5", "invalid type: floating point `1.5`, expected u32"],
      ['zai_clear_reasoning = "yes"', 'invalid type: string "yes", expected a boolean'],
    ] as const) {
      expect(await having(`[models."gemini:gemini-3-pro"]\n${line}\n`)).toThrow(refusal);
    }
  });
});

describe("the models wakes run on", () => {
  const TOML = (pins: string[]): string => [
    "[chat]", 'model = "anthropic:claude-x"', ...pins, "[providers.anthropic]", 'api_key_env = "K"',
    '[chat."anthropic:claude-x"]', "max_output_tokens = 4000", '[chat."anthropic:claude-y"]', "max_output_tokens = 4000", "",
  ].join("\n");
  const PINNED = ["[triggers]", 'model = "anthropic:claude-y"'];
  const reading = async (pins: string[], character?: string) => {
    const w = await build(character, TOML(pins));
    return { w, models: { ...w.ctx, dataDir: w.ctx.config.dirs.data } };
  };

  test("unpinning wakes clears their key, and they go back to the chat model", async () => {
    const { w, models } = await reading(PINNED);
    expect(resetModel(models, { background_task: "wake" })).toEqual({
      target: "role", active: "anthropic:claude-x", role: "wake", cleared: ["triggers.model"], source: "inherits chat", file: w.ctx.configPath,
      reset_to: "inherits chat", roles: [{ role: "wake", model: "anthropic:claude-x", source: "inherits chat" }],
    });
    expect(Bun.TOML.parse(readFileSync(w.ctx.configPath, "utf8"))).toMatchObject({ triggers: {} });
  });

  test("a character's wakes with no model pinned for them take their settings to the character's own chat model", async () => {
    const own = await reading([], "ada");
    expect((modelSettings({ ...own.models, homeThreadModel: "anthropic:claude-y" }, { background_task: "wake" }) as ModelSettingsDetail).model).toBe("anthropic:claude-y");
  });

  test("wakes with no model of their own and none to inherit are refused, naming them", async () => {
    const w = await build("ada", ["[providers.anthropic]", 'api_key_env = "K"', ""].join("\n"));
    expect(() => modelSettings({ ...w.ctx, dataDir: w.ctx.config.dirs.data }, { background_task: "wake" }))
      .toThrow("wake has no configured model and the catalog has no chat model to inherit");
  });

  test("unpinning every background task clears the key that was set", async () => {
    const { models } = await reading(PINNED);
    expect(resetModel(models, { background_task: "all" })).toMatchObject({
      active: "anthropic:claude-x", role: "background", cleared: ["triggers.model"], source: "inherits chat", reset_to: "inherits chat",
    });
  });
});

describe("the settings wakes run with", () => {
  const TOML = ["[chat]", 'model = "anthropic:claude-x"', "[providers.anthropic]", 'api_key_env = "K"', '[chat."anthropic:claude-x"]', "max_output_tokens = 4000", ""].join("\n");
  const wakes = (models: Parameters<typeof modelSettings>[0]): ModelSettingsDetail => modelSettings(models, { background_task: "wake" }) as ModelSettingsDetail;

  test("are kept under [background.wake], and the task is named wake wherever it is asked for", async () => {
    const w = await build("ada", TOML);
    const models = { ...w.ctx, dataDir: w.ctx.config.dirs.data };
    expect(setModelSetting(models, { key: "max_tool_rounds", value: 6, scope: "character", background_task: "wake" })).toMatchObject({ changed: true, key: "max_tool_rounds" });
    expect(readFileSync(characterPreferencesPath(models.dataDir, "ada"), "utf8")).toContain("[background.wake]\nmax_tool_rounds = 6\n");
    expect(wakes(models).saved_character).toMatchObject({ max_tool_rounds: 6 });
    expect(() => setModelSetting(models, { key: "max_tool_rounds", value: 6, scope: "character", background_task: "heartbeat" as never }))
      .toThrow("unknown background task: heartbeat; expected all or wake");
  });

  test("a preferences file from when the task was called heartbeat is read as it stands and rewritten under the new name, once", async () => {
    const w = await build("ada", TOML);
    const models = { ...w.ctx, dataDir: w.ctx.config.dirs.data };
    const path = characterPreferencesPath(models.dataDir, "ada");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '[background.heartbeat]\nmax_tool_rounds = 4\nreasoning_effort = "low"\n');
    expect(wakes(models).saved_character).toMatchObject({ max_tool_rounds: 4, reasoning_effort: "low" });
    const rewritten = readFileSync(path, "utf8");
    expect([rewritten.includes("[background.wake]\nreasoning_effort = \"low\"\nmax_tool_rounds = 4\n"), rewritten.includes("heartbeat")]).toEqual([true, false]);
    expect(wakes(models).saved_character).toMatchObject({ max_tool_rounds: 4, reasoning_effort: "low" });
    expect(readFileSync(path, "utf8")).toBe(rewritten);

    const byHand = "# tuned by hand\n[background.wake]\nmax_tool_rounds = 7\n";
    await writeFile(path, byHand);
    expect(wakes(models).saved_character).toMatchObject({ max_tool_rounds: 7 });
    expect(readFileSync(path, "utf8")).toBe(byHand);

    await writeFile(path, "[background.heartbeat]\nmax_tool_rounds = 4\n\n[background.wake]\nmax_tool_rounds = 9\n");
    expect(wakes(models).saved_character).toMatchObject({ max_tool_rounds: 9 });
    expect(readFileSync(path, "utf8")).not.toContain("heartbeat");

    await writeFile(path, "[background.compaction]\nmax_tool_rounds = 2\n");
    expect(() => wakes(models)).toThrow("unknown field `compaction`, expected `wake`");
  });

  test("an old preferences file that can't be rewritten is still read, and the daemon says it couldn't", async () => {
    const w = await build("ada", TOML);
    const models = { ...w.ctx, dataDir: w.ctx.config.dirs.data };
    const path = characterPreferencesPath(models.dataDir, "ada");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "[background.heartbeat]\nmax_tool_rounds = 4\n");
    chmodSync(path, 0o444);
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    try {
      expect(wakes(models).saved_character).toMatchObject({ max_tool_rounds: 4 });
      expect(warned.mock.calls.map((call) => String(call[0]).split(":").slice(0, 2).join(":"))).toEqual([
        `shore: could not rewrite ${path} with [background.heartbeat] as [background.wake]; it is read that way until it can be`,
      ]);
      expect(readFileSync(path, "utf8")).toBe("[background.heartbeat]\nmax_tool_rounds = 4\n");
    } finally {
      warned.mockRestore();
      chmodSync(path, 0o644);
    }
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

describe("reloading the config", () => {
  const PROMPT = '[[prompt]]\nworkspace = "SOUL.md"\n';

  async function reloadable(character: string | undefined): Promise<World & { workspace: string; data: string }> {
    const world = await build(character, `${PROMPT}[chat]\nmodel = "anthropic:first"\n`, [["config/characters/ada/workspace/SOUL.md", "Ada, first."]]);
    const data = join(world.ctx.config.dirs.data, "ada");
    await mkdir(data, { recursive: true });
    initializeDatabase(world.ctx.config.dirs.data);
    await ensureActivePromptSnapshot(data, characterWorkspace(world.ctx.config, "ada"));
    const workspace = join(world.root, "config", "characters", "ada", "workspace");
    await writeFile(join(workspace, "SOUL.md"), "Ada, second.");
    await writeFile(world.ctx.configPath, `${PROMPT}[chat]\nmodel = "anthropic:second"\n[daemon]\nshutdown_grace = "1m"\n`);
    return { ...world, workspace, data };
  }

  test("checked, loads the file fresh and changes nothing, naming what needs a restart and the prompt files changed since the snapshot", async () => {
    const world = await reloadable("ada");
    const before = world.ctx.config;
    expect(await configReload(world.ctx, {})).toEqual({
      applied: false, restart_required: ["[daemon]"], config_path: world.ctx.configPath, character: "ada", changed_prompt_files: ["SOUL.md"],
    });
    expect([world.ctx.config, world.calls]).toEqual([before, []]);

    const bare = await reloadable(undefined);
    await writeFile(bare.ctx.configPath, `${PROMPT}[chat]\nmodel = "anthropic:second"\n`);
    expect(await configReload(bare.ctx, { apply: false })).toEqual({ applied: false, config_path: bare.ctx.configPath, character: null, changed_prompt_files: [] });
  });

  test("measures what needs a restart against the config the daemon runs, when it has one", async () => {
    const world = await reloadable("ada");
    const running = loadConfig(world.ctx.configPath, { env: world.ctx.env ?? {}, onWarn: () => {} });
    expect(await configReload({ ...world.ctx, runtime: { ...world.ctx.runtime, globalConfig: () => running } }, {})).not.toHaveProperty("restart_required");
  });

  test("applied, takes the fresh config in, and with refresh_prompts also takes the changed prompt files in and says so", async () => {
    const world = await reloadable("ada");
    expect(await configReload(world.ctx, { apply: true })).toEqual({
      applied: true, restart_required: ["[daemon]"], config_path: world.ctx.configPath, character: "ada", changed_prompt_files: ["SOUL.md"], prompts_refreshed: false,
    });
    expect([world.ctx.config.app.chat.model, world.calls]).toEqual(["anthropic:second", ["adoptGlobalConfig", "reloadRuntimeConfig"]]);

    const refreshing = await reloadable("ada");
    writeDurable(join(refreshing.data, "threads", "main", "active.jsonl"), `${JSON.stringify({ msg_id: "m1", role: "user", content: "hi", images: [], content_blocks: [{ type: "text", text: "hi" }], timestamp: "2026-11-22T00:00:00Z" })}\n`);
    expect(await configReload(refreshing.ctx, { apply: true, refresh_prompts: true })).toMatchObject({ applied: true, changed_prompt_files: ["SOUL.md"], prompts_refreshed: true });
    expect(refreshing.calls).toEqual(["notifyPromptSnapshotRefreshed:ada", "adoptGlobalConfig", "reloadRuntimeConfig"]);
    expect(await loadActivePromptFile(refreshing.data, "SOUL.md")).toBe("Ada, second.");
  });

  test("is refused for a config or character overlay that doesn't load, a prompt refresh with no character, and a refresh that fails", async () => {
    const broken = await reloadable("ada");
    await writeFile(broken.ctx.configPath, "[chat\n");
    expect(await outcomeOf(configReload(broken.ctx, {}))).toThrow("Config error: ");

    const overlay = await reloadable("ada");
    await writeFile(join(overlay.root, "config", "characters", "ada", "config.toml"), "[chat\n");
    expect(await outcomeOf(configReload(overlay.ctx, {}))).toThrow("Config error in character overlay 'ada': ");

    const nobody = await reloadable(undefined);
    expect(await outcomeOf(configReload(nobody.ctx, { apply: true, refresh_prompts: true }))).toThrow("Refreshing prompts requires a character context");
    expect(nobody.calls).toEqual([]);

    const failing = await reloadable("ada");
    writeDurable(join(failing.data, "threads", "main", "active.jsonl"), `${JSON.stringify({ msg_id: "m1", role: "user", content: "hi", images: [], content_blocks: [{ type: "text", text: "hi" }], timestamp: "2026-11-22T00:00:00Z" })}\n`);
    await rm(join(failing.workspace, "SOUL.md"));
    await mkdir(join(failing.workspace, "SOUL.md"));
    expect(await outcomeOf(configReload(failing.ctx, { apply: true, refresh_prompts: true }))).toThrow("Failed to refresh active prompt snapshot: ");
    expect(failing.calls).toEqual([]);
  });
});

describe("the models and settings for wakes and sub-agents", () => {
  const TOML = [
    "[chat]", 'model = "anthropic:claude-x"',
    "[subagents]", 'enabled = ["scout"]', "[subagents.scout]", 'description = "d"', 'prompt = "p"', "[subagents.idle]", 'description = "r"', 'prompt = "r"', 'model = "anthropic:claude-y"',
    "[providers.anthropic]", 'api_key_env = "K"', "discover = true", 'ignore_models = ["claude-z"]', "[providers.nanogpt]", 'api_key_env = "K"',
    '[chat."anthropic:claude-x"]', "max_output_tokens = 4000", '[chat."anthropic:claude-y"]', "max_output_tokens = 4000", '[chat."nanogpt:m-1"]', "max_output_tokens = 100", "",
  ].join("\n");
  const world = async (character: string | null = "ada", pins: string[] = []) => {
    const w = await build(character ?? undefined, [...pins, TOML].join("\n"));
    await writeCache(cachePath(w.ctx.config.dirs.cache, "anthropic"), {
      version: CACHE_VERSION, provider_key: "anthropic", fetched_at: "2026-11-24T00:00:00Z",
      models: [{ provider_key: "anthropic", model_id: "claude-z", sdk: "anthropic", discovered_at: "2026-11-24T00:00:00Z" }],
    });
    return { w, models: { ...w.ctx, dataDir: w.ctx.config.dirs.data } };
  };
  const NO_KEEPALIVE = "cache_keepalive is not shorter than this model's 5m cache TTL, so each ping will land after the cache has already expired";
  const CLAUDE_X = { model: "anthropic:claude-x", provider: "anthropic", model_id: "claude-x" };

  test("pinning wakes to a model writes triggers.model, all means wakes, and a model has to be named", async () => {
    const { w, models } = await world();
    const pinned: ReturnType<typeof switchModel> = { target: "role", active: "anthropic:claude-y", qualified_name: "anthropic:claude-y", provider: "anthropic", model_id: "claude-y", changed: true, role: "wake", config_key: "triggers.model", cleared: [], file: w.ctx.configPath, restart_required: [] };
    expect(switchModel(models, { background_task: "wake", name: "anthropic:claude-y" })).toEqual(pinned);
    expect(Bun.TOML.parse(readFileSync(w.ctx.configPath, "utf8"))).toMatchObject({ triggers: { model: "anthropic:claude-y" } });
    expect(switchModel(models, { background_task: "all", name: "anthropic:claude-x" })).toMatchObject({ role: "background", active: "anthropic:claude-x", config_key: "triggers.model" });
    expect(Bun.TOML.parse(readFileSync(w.ctx.configPath, "utf8"))).toMatchObject({ triggers: { model: "anthropic:claude-x" } });
    expect(() => switchModel(models, { background_task: "wake" })).toThrow("missing model name");
    expect(() => switchModel(models, { background_task: "wake", name: "anthropic:claude-z" }), "a model the provider's ignore_models hides").toThrow('model "anthropic:claude-z" is hidden by providers.anthropic.ignore_models');
    expect(switchModel(models, { background_task: "wake", name: "anthropic:claude-z", include_hidden: true })).toMatchObject({ active: "anthropic:claude-z" });
  });

  test("a setting needs a key and a scope that is character or global", async () => {
    const { models } = await world();
    expect(() => setModelSetting(models, {} as Parameters<typeof setModelSetting>[1])).toThrow("missing key");
    expect(() => setModelSetting(models, { key: "max_tool_rounds", value: 3, scope: "elsewhere" as never })).toThrow('scope must be "character" or "global", got "elsewhere"');
  });

  test("a character's setting is judged with the global settings beside it, and warns when the keepalive can't outlast the cache", async () => {
    const { models } = await world();
    const named = { name: "anthropic:claude-x" };
    expect(setModelSetting(models, { ...named, key: "cache_ttl", value: "5m", scope: "character" }), "no keepalive is set").toEqual({ changed: true, scope: "character", ...CLAUDE_X, key: "cache_ttl", value: "5m" });
    expect(setModelSetting(models, { ...named, key: "cache_keepalive", value: "50m", scope: "global" }), "the character's TTL isn't the global one").toEqual({ changed: true, scope: "global", ...CLAUDE_X, key: "cache_keepalive", value: "50m" });
    expect(setModelSetting(models, { ...named, key: "cache_ttl", value: "5m", scope: "character" }), "the global keepalive").toEqual({ changed: true, scope: "character", ...CLAUDE_X, key: "cache_ttl", value: "5m", warning: NO_KEEPALIVE });
    expect(setModelSetting(models, { ...named, key: "cache_keepalive", value: "off", scope: "global" })).toEqual({ changed: true, scope: "global", ...CLAUDE_X, key: "cache_keepalive", value: "off" });
    expect(setModelSetting(models, { ...named, key: "cache_ttl", value: "5m", scope: "character" }), "keepalives are off for every character").toEqual({ changed: true, scope: "character", ...CLAUDE_X, key: "cache_ttl", value: "5m" });

    const own = await world();
    expect(setModelSetting(own.models, { key: "cache_keepalive", value: "55m", background_task: "wake" })).toEqual({ changed: true, scope: "character", ...CLAUDE_X, background_task: "wake", key: "cache_keepalive", value: "55m" });
    expect(setModelSetting(own.models, { key: "cache_ttl", value: "5m", background_task: "wake" })).toMatchObject({ warning: NO_KEEPALIVE });
    const wake = modelSettings(own.models, { background_task: "wake" }) as ModelSettingsDetail;
    expect([wake.effective_sampler.cache_ttl, wake.effective_sampler.cache_keepalive, wake.saved_character?.cache_keepalive, wake.scopes.cache_ttl, wake.scopes.cache_keepalive]).toEqual(["5m", "55m", "55m", "character_background", "character_background"]);
  });

  test("a setting for one sub-agent, or for every sub-agent on a model, is kept in its own section, and clearing it drops the section", async () => {
    const { models } = await world();
    expect(setModelSetting(models, { key: "max_tool_rounds", value: 3, subagent: "scout" })).toEqual({ changed: true, scope: "character", ...CLAUDE_X, subagent: "scout", key: "max_tool_rounds", value: 3 });
    expect(setModelSetting(models, { key: "max_tool_rounds", value: 4, subagent: "all" })).toEqual({ changed: true, scope: "character", ...CLAUDE_X, subagent: "all", applies_to: "every sub-agent on this model", key: "max_tool_rounds", value: 4 });
    const saved = () => readFileSync(characterPreferencesPath(models.dataDir, "ada"), "utf8");
    expect([saved().includes('[subagents."scout"]\nmax_tool_rounds = 3\n'), saved().includes('[subagent_models."anthropic:claude-x"]\nmax_tool_rounds = 4\n'), saved().includes("[models.")]).toEqual([true, true, false]);
    const chat = modelSettings(models, {}) as ModelSettingsDetail;
    expect([chat.effective_sampler.max_tool_rounds, chat.scopes.max_tool_rounds], "the chat model keeps its own").toEqual([null, null]);
    const detail = (subagent: string) => modelSettings(models, { subagent }) as ModelSettingsDetail;
    expect([detail("scout").effective_sampler.max_tool_rounds, detail("scout").saved_character?.max_tool_rounds, detail("scout").saved_global, detail("scout").scopes.max_tool_rounds]).toEqual([3, 3, null, "character_subagent"]);
    expect([detail("all").effective_sampler.max_tool_rounds, detail("all").saved_character?.max_tool_rounds, detail("all").scopes.max_tool_rounds]).toEqual([4, 4, "character_subagent_model"]);
    setModelSetting(models, { key: "max_tool_rounds", value: null, subagent: "scout" });
    expect([saved().includes("[subagents."), saved().includes("[subagent_models.")]).toEqual([false, true]);
    expect(detail("scout").effective_sampler.max_tool_rounds, "back to every sub-agent's").toBe(4);
  });

  test("NanoGPT models can't be switched to the native Gemini API", async () => {
    const { models } = await world();
    expect(() => setModelSetting(models, { key: "sdk", value: "gemini", name: "nanogpt:m-1" })).toThrow('NanoGPT does not expose the native Gemini API; use sdk = "nanogpt" for Gemini models (OpenAI-compatible chat completions)');
    expect(setModelSetting(models, { key: "sdk", value: "nanogpt", name: "nanogpt:m-1" })).toMatchObject({ changed: true, model: "nanogpt:m-1", key: "sdk" });
  });

  test("the overview lists each role with its model, where it comes from and what was set for it", async () => {
    const { models } = await world();
    setModelSetting(models, { key: "max_tool_rounds", value: 2, background_task: "wake" });
    setModelSetting(models, { key: "max_tool_rounds", value: 3, subagent: "scout" });
    expect(modelSettings(models, { overview: true })).toEqual({
      overview: true, character: "ada", inherited_count: 1,
      roles: [
        { role: "chat", flag: "--chat", model: "anthropic:claude-x", source: "character", inherited: false, settings: [], error: null },
        { role: "wake", flag: "--background=wake", model: "anthropic:claude-x", source: "inherits chat", inherited: true, settings: [{ key: "max_tool_rounds", value: 2, scope: "character" }], error: null },
        { role: "sub-agent: idle", flag: "--subagent=idle", model: "anthropic:claude-y", source: "subagents.idle.model", inherited: false, settings: [], error: null },
        { role: "sub-agent: scout", flag: "--subagent=scout", model: "anthropic:claude-x", source: "inherits sub-agents", inherited: true, settings: [{ key: "max_tool_rounds", value: 3, scope: "character" }], error: null },
      ],
    });
  });

  test("wakes pinned to a model of their own are listed with it, beside the chat model", async () => {
    const { models } = await world("ada", ["[triggers]", 'model = "anthropic:claude-y"']);
    expect(listModels(models, {}).roles).toEqual([
      { role: "chat", model: "anthropic:claude-x", source: "character" },
      { role: "wake", model: "anthropic:claude-y", source: "triggers.model" },
      { role: "sub-agents", model: "anthropic:claude-x", source: "inherits chat · 1 override" },
    ]);
  });

  test("with no character chosen there are no character settings to show", async () => {
    const { models } = await world(null);
    expect((modelSettings(models, {}) as ModelSettingsDetail).saved_character).toBeNull();
  });
});

test("the schema comes with the names a setting can be chosen from: the chat models, tools, sub-agents, characters and providers, each in order", async () => {
  const w = await build(undefined, [
    '[chat."anthropic:claude-y"]', "max_output_tokens = 10", '[chat."anthropic:claude-x"]', "max_output_tokens = 20",
    "[providers.local]", 'base_url = "http://localhost:1"', "[providers.anthropic]", 'api_key_env = "K"',
    "[subagents.scout]", 'description = "looks"', 'prompt = "look"', "[subagents.idle]", 'description = "rests"', 'prompt = "rest"', "",
  ].join("\n"), [["config/characters/bo/config.toml", ""], ["config/characters/ada/config.toml", ""]]);
  const { sources } = configSchemaCommand(w.ctx);
  expect(sources).toStrictEqual({
    chat_models: ["anthropic:claude-x", "anthropic:claude-y"],
    tools: ALL_TOOLS.map((tool) => tool.name).toSorted(),
    subagents: ["idle", "scout"],
    characters: ["ada", "bo"],
    providers: ["anthropic", "local"],
  });
});
