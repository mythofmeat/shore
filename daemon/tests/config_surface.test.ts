import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharacterConfig, loadConfig, parseConfigTable } from "../src/config/loader.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { resolveShoreDirs } from "../src/config/dirs.ts";
import { serializeConfigValue } from "../src/config/serialize.ts";
import { normalizeConfigSource, parseConfigPath, publicConfig, settingsDeprecations } from "../src/config/surface.ts";

const dirs = resolveShoreDirs({ SHORE_CONFIG_DIR: "/tmp/config-surface" });
const read = (text: string) => parseConfigTable(Bun.TOML.parse(text) as Record<string, unknown>, dirs, () => {});

describe("flat configuration", () => {
  test("the deployment-shaped settings retain their effective behavior", () => {
    const cfg = read(`
[chat]
display_name = "Alex"
user_timestamps = "always"
[embedding]
model = "local:embed"
[image]
model = "openrouter:image"
[cache]
keepalive_for = "20h"
[heartbeat]
enabled = true
interval = "6h"
min_interval = "4h"
max_idle_turns = 20
[compaction]
write_memory = true
idle_after = "50m"
min_turns = 4
max_turns = 50
keep_recent_turns = 0
max_context_tokens = 500000
git_push = true
[tools]
enabled = ["bash", "web_search"]
[tools.bash]
timeout = "10m"
[subagents]
enabled = ["internet"]
model = "deepseek:deepseek-flash"
[subagents.internet]
description = "Research"
prompt = "Find evidence."
tools = ["web_search"]
max_tool_rounds = 8
[[budgets]]
name = "weekly"
character = "assistant"
cost_usd = 15
period = "week"
pace_period = "day"
reset_day_of_week = "thursday"
reset_hour = 8
warn_fractions = [0.9, 1.0]
limit_action = "block"
pace_warn_fractions = [0.35, 1.0]
pace_warn_action = "pause_heartbeat"
allow_compaction = true
[notifications]
via = "ntfy"
topic = "test-only-topic"
min_generation_duration = "10s"
[providers.deepseek]
discover = true
[providers.openrouter]
discover = true
[providers.local]
base_url = "http://localhost:1/v1"
`);
    expect(cfg.app.defaults).toMatchObject({ display_name: "Alex", embedding: "local:embed", image_generation: "openrouter:image" });
    expect(cfg.app.behavior.autonomy.enabled).toBe(true);
    expect(cfg.app.behavior.autonomy.heartbeat.fallback_heartbeat_interval.toString()).toBe("6h");
    expect(cfg.app.memory.compaction.idle_trigger.toString()).toBe("50m");
    expect(cfg.app.memory.compaction.keep_recent_turns).toBe(0);
    expect(cfg.app.memory.git_push).toBe(true);
    expect(cfg.app.tools.config.get("bash")?.timeout?.toString()).toBe("10m");
    expect(cfg.app.subagents.get("internet")?.max_iterations).toBe(8);
    expect(cfg.app.usage.budgets[0]).toMatchObject({ cost_usd: 15, warn_at: [0.9, 1], allow_compaction_over_budget: true, limit: "block" });
    expect(cfg.app.notifications).toMatchObject({ enabled: true, backend: "ntfy" });
    expect(cfg.providers.get("deepseek")?.discovery.enabled).toBe(true);
    expect(cfg.deprecations).toEqual([]);
  });

  test("canonical defaults round trip without resurrecting retired sections", () => {
    const serialized = serializeConfigValue(defaultAppConfig()) as Record<string, unknown>;
    const flat = publicConfig(serialized);
    expect(flat.defaults).toBeUndefined();
    expect(flat.memory).toBeUndefined();
    expect(flat.behavior).toBeUndefined();
    const nonNull = JSON.parse(JSON.stringify(flat), (_key: string, value: unknown) => value === null ? undefined : value) as Record<string, unknown>;
    expect(serializeConfigValue(parseConfigTable(nonNull, dirs, () => {}).app)).toEqual(serialized);
  });

  test("qualified identities with punctuation and provider defaults resolve together", () => {
    const cfg = read(`
[chat]
model = "gemini:org/model.v3"
[chat."gemini:org/model.v3"]
max_output_tokens = 8192
gemini_thinking_mode = "level"
reasoning_budget_tokens = 2048
[providers.gemini]
discover = true
temperature = 0.25
`);
    const model = cfg.models.chat.get("gemini:org/model.v3");
    expect(model).toMatchObject({ temperature: 0.25, maxOutputTokens: 8192, geminiGeneration: 3, budgetTokens: 2048 });
    expect(parseConfigPath('chat."gemini:org/model.v3".max_output_tokens')).toEqual(["chat", "gemini:org/model.v3", "max_output_tokens"]);
  });

  test("two spellings in one source are rejected even when values match", () => {
    expect(() => read('[defaults]\nmodel="x:y"\n[chat]\nmodel="x:y"')).toThrow("conflicting declarations defaults.model and chat.model");
    expect(() => read('[behavior.autonomy]\nenabled=true\n[heartbeat]\nenabled=true')).toThrow("conflicting declarations");
    expect(() => read('[notifications]\nenabled=false\nvia="off"')).toThrow("conflicting declarations");
    expect(() => read('[providers.gemini]\ntemperature=0.5\n[providers.gemini.defaults]\ntemperature=0.5')).toThrow("conflicting declarations");
  });

  test("old notification backend alone never enables delivery", () => {
    expect(read('[notifications]\nbackend="ntfy"').app.notifications.enabled).toBe(false);
    expect(read('[notifications]\nvia="ntfy"').app.notifications.enabled).toBe(true);
    expect(read('[notifications]\nvia="off"\nevents=[]').app.notifications.events.message_complete).toBe(false);
  });

  test("legacy and flat layers preserve gates, event patches, and character budget scope", () => {
    const root = mkdtempSync(join(tmpdir(), "shore-flat-"));
    try {
      mkdirSync(join(root, "conf.d"));
      mkdirSync(join(root, "characters", "alex"), { recursive: true });
      writeFileSync(join(root, "config.toml"), '[chat]\nmodel="gemini:first"\n[heartbeat]\nenabled=true\n[notifications]\nvia="ntfy"\nevents=["error"]\n[usage]\nallow_compaction_over_budget=true');
      writeFileSync(join(root, "conf.d", "last.toml"), '[defaults]\nmodel="gemini:last"\n[behavior.autonomy.heartbeat]\nenabled=false\n[notifications.events]\nmessage_complete=true');
      writeFileSync(join(root, "characters", "alex", "config.toml"), '[[budgets]]\ncost_usd=5\nallow_compaction=false\n[notifications]\nvia="off"');
      const warnings: string[] = [];
      const global = loadConfig(join(root, "config.toml"), { onWarn: (message) => { warnings.push(message); } });
      expect(global.app.defaults.model).toBe("gemini:last");
      expect(global.app.behavior.autonomy.heartbeat.enabled).toBe(false);
      expect(global.app.notifications.events).toMatchObject({ error: true, message_complete: true, autonomous_message: false });
      const char = loadCharacterConfig(global, "alex", () => {});
      expect(char?.app.notifications.enabled).toBe(false);
      expect(char?.app.usage.budgets[0]).toMatchObject({ character: "alex", allow_compaction_over_budget: false });
      expect(warnings).toContain("Deprecated configuration");
      expect(global.deprecations?.some((entry) => entry.path === "defaults.model" && entry.source.endsWith("last.toml"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("warnings identify renamed model and budget leaves without exposing values", () => {
    const result = normalizeConfigSource({ providers: { gemini: { defaults: { budget_tokens: 4096 } } }, usage: { budgets: [{ warn_at: [0.8] }] } }, "/config/provider.toml");
    expect(result.deprecations.find((entry) => entry.path === "providers.gemini.defaults.budget_tokens")).toMatchObject({ source: "/config/provider.toml", replacement: "providers.gemini.reasoning_budget_tokens" });
    expect(result.deprecations.some((item) => item.path === 'usage.budgets.0.warn_at')).toBe(true);
    expect(JSON.stringify(result.deprecations)).not.toContain("4096");
    expect(settingsDeprecations({ models: { "gemini:a.b": { replay_prior_thinking: true } } }, "/data/alex/preferences/models.toml", true)[0]?.path).toBe('models."gemini:a.b".replay_prior_thinking');
    expect(() => read('[notifications]\ntoken_env="NTFY_KEY"\n[notifications.ntfy]\ntoken="test-secret"')).toThrow("conflicting declarations");
  });

  test("unknown fields and malformed canonical containers fail", () => {
    expect(() => read('[heartbeat]\nintervall="1h"')).toThrow();
    expect(() => read('chat=[]')).toThrow("must be a table");
    expect(() => read('notifications=[]')).toThrow("must be a table");
    expect(() => read('[[budgets]]\ncost_usd=1\n[tools]\nbash=[]')).toThrow("tools.bash: must be a table");
    expect(() => read('[chat."gemini:m"]\ntemperatur=0.5')).toThrow("unknown field");
    expect(() => read('[web_search]\ndepth="invented"')).toThrow("web_search.depth");
  });

  test("reports preserve reserved legacy definitions alongside canonical grants", () => {
    const legacy = read('[tools]\nenabled_tools=["bash"]\n[tools.config.enabled]\ntimeout="1m"\n[subagents.model]\ndescription="Legacy definition"\nprompt="Keep me"');
    const report = publicConfig(serializeConfigValue(legacy.app) as Record<string, unknown>);
    expect(report).toHaveProperty("tools.enabled", ["bash"]);
    expect(report).toHaveProperty("tools.config.enabled.timeout", "1m");
    expect(report).toHaveProperty("subagents.model.prompt", "Keep me");
  });

  test("a named legacy subagent using a newly reserved name remains readable", () => {
    const normalized = normalizeConfigSource({ subagents: { model: { description: "legacy", prompt: "p" } } });
    expect(normalized.table.subagents).toEqual({ model: { description: "legacy", prompt: "p" } });
  });
});
