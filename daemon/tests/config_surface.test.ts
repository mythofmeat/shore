import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharacterConfig, loadConfig, parseConfigTable } from "../src/config/loader.ts";
import { inlineImageBytesFor, toolLimitsFrom } from "../src/tools/dispatch.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { resolveShoreDirs } from "../src/config/dirs.ts";
import { serializeConfigValue } from "../src/config/serialize.ts";
import { parseConfigPath, publicConfig } from "../src/config/surface.ts";

const dirs = resolveShoreDirs({ SHORE_CONFIG_DIR: "/tmp/config-surface" });
const read = (text: string) => parseConfigTable(Bun.TOML.parse(text) as Record<string, unknown>, dirs, () => {});

describe("flat configuration", () => {
  test("only current configuration fields are accepted", () => {
    for (const text of [
      '[defaults]\nmodel="p:m"',
      '[daemon]\naddr="127.0.0.1:7320"',
      '[providers.p.defaults]\ntemperature=0.5',
      '[chat.p.model]\nmodel_id="m"',
      '[notifications]\nenabled=true',
      '[usage]\nallow_compaction_over_budget=true',
      '[chat."p:m"]\nreplay_prior_thinking=true',
    ]) expect(() => read(text)).toThrow();
    expect(() => read('[heartbeat]\ninterval=60')).toThrow();
    expect(() => read('[heartbeat]\ninterval="60"')).toThrow();
    expect(() => read('[chat]\nreasoning_replay=true')).toThrow();
  });

  test("inline image byte budgets parse, resolve, and round-trip through public config", () => {
    expect(inlineImageBytesFor(toolLimitsFrom(read("").app.tools), "read")).toBe(5 * 1024 * 1024);
    const cfg = read("[tools]\nmax_inline_image_bytes=1000\n[tools.read]\nmax_inline_image_bytes=2000");
    const limits = toolLimitsFrom(cfg.app.tools);
    expect(inlineImageBytesFor(limits, "read")).toBe(2000);
    expect(inlineImageBytesFor(limits, "mcp__srv__shot")).toBe(1000);
    const config = publicConfig(serializeConfigValue(cfg.app) as Record<string, unknown>);
    expect(config.tools).toMatchObject({ max_inline_image_bytes: 1000, read: { max_inline_image_bytes: 2000 } });
    const disabled = read("[tools]\nmax_inline_image_bytes=1000\n[tools.read]\nmax_inline_image_bytes=0");
    expect(inlineImageBytesFor(toolLimitsFrom(disabled.app.tools), "read")).toBe(0);
    for (const section of ["tools", "tools.read"]) {
      for (const value of ["-1", "1.5", '"5MB"']) {
        expect(() => read(`[${section}]\nmax_inline_image_bytes=${value}`)).toThrow();
      }
    }
  });

  test("included and character settings override current fields", () => {
    const root = mkdtempSync(join(tmpdir(), "shore-config-layers-"));
    try {
      mkdirSync(join(root, "conf.d"));
      mkdirSync(join(root, "characters", "alex"), { recursive: true });
      writeFileSync(join(root, "config.toml"), '[chat]\nmodel="gemini:first"\n[heartbeat]\nenabled=true\n[notifications]\nvia="ntfy"\nevents=["error"]');
      writeFileSync(join(root, "conf.d", "last.toml"), '[chat]\nmodel="gemini:last"\n[heartbeat]\nenabled=false\n[notifications]\nevents=["message_complete"]');
      writeFileSync(join(root, "characters", "alex", "config.toml"), '[[budgets]]\ncost_usd=5\nallow_compaction=true\n[notifications]\nvia="off"');
      const global = loadConfig(join(root, "config.toml"), { onWarn: () => {} });
      expect(global.app.defaults.model).toBe("gemini:last");
      expect(global.app.behavior.autonomy.enabled).toBe(false);
      expect(global.app.notifications.events).toMatchObject({ error: false, message_complete: true });
      const character = loadCharacterConfig(global, "alex", () => {});
      expect(character?.app.notifications.enabled).toBe(false);
      expect(character?.app.usage.budgets[0]).toMatchObject({ character: "alex", allow_compaction_over_budget: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the deployment-shaped settings retain their effective behavior", () => {
    const cfg = read(`
[chat]
display_name = "Alex"
user_timestamps = "always"
[embedding]
model = "local:embed"
[image]
model = "openrouter:image"
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









  test("unknown fields and malformed canonical containers fail", () => {
    expect(() => read('[heartbeat]\nintervall="1h"')).toThrow();
    expect(() => read('chat=[]')).toThrow("must be a table");
    expect(() => read('notifications=[]')).toThrow("must be a table");
    expect(() => read('[[budgets]]\ncost_usd=1\n[tools]\nbash=[]')).toThrow("tools.bash must be a table");
    expect(() => read('[chat."gemini:m"]\ntemperatur=0.5')).toThrow("unknown field");
    expect(() => read('[web_search]\ndepth="invented"')).toThrow("web_search.depth");
  });




});
