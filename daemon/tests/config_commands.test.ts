import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { config, type ConfigContext, type ConfigRuntime } from "../src/commands/config.ts";
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
