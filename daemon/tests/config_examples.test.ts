import { expect, test } from "bun:test";
import { parseConfigTable } from "../src/config/loader.ts";
import { resolveShoreDirs } from "../src/config/dirs.ts";
const CONFIG_EXAMPLES = [
  { title: "Provider and a qualified model override", text: "[providers.anthropic]\napi_key_env = \"ANTHROPIC_API_KEY\"\ncache_ttl = \"1h\"\n\n[chat]\nmodel = \"anthropic:claude-opus-4-8\"\n\n[chat.\"anthropic:claude-opus-4-8\"]\nmax_output_tokens = 16384\n" },
  { title: "Background work and a budget", text: `[heartbeat]
enabled = true
default_interval = "6h"
min_interval = "4h"

[compaction]
idle_after = "50m"
min_turns = 4
keep_recent_turns = 0

[[budgets]]
name = "weekly"
cost_usd = 15
period = "week"
pace_period = "day"
warn_fractions = [0.9, 1.0]
limit_action = "block"
allow_compaction = true
` },
  { title: "Notifications and an MCP server", text: "[notifications]\ntoken_env = \"NTFY_TOKEN\"\nevents = [\"error\", \"message_complete\"]\nmin_generation_duration = \"10s\"\nurl = \"https://ntfy.example.invalid\"\ntopic = \"your-private-topic\"\nvia = \"ntfy\"\n\n[mcp.reference]\nurl = \"https://mcp.example.invalid\"\n" },
  { title: "A character override", text: "budgets = [{ name = \"this-character\", cost_usd = 5, period = \"day\", limit_action = \"block\", allow_compaction = false }]\n\n[chat]\nmodel = \"anthropic:claude-opus-4-8\"\n\n[heartbeat]\nenabled = false\n" },
  { title: "Claude plan limits", text: `[plan_limits.five_hour]
warn_fractions = [0.8, 0.95]
limit_fraction = 1.0
limit_action = "pause_background"

[plan_limits.seven_day]
warn_fractions = [0.75, 0.9]
limit_fraction = 0.9
limit_action = "pause_background"
` },
  { title: "A character whose heartbeat stops early in the week", text: "[plan_limits.seven_day]\nlimit_fraction = 0.6\nlimit_action = \"pause_heartbeat\"\n" },
] as const;

for (const example of CONFIG_EXAMPLES) test(`configuration example: ${example.title}`, () => {
  const loaded = parseConfigTable(Bun.TOML.parse(example.text) as Record<string, unknown>, resolveShoreDirs({}), () => {});

  expect(loaded.app).toBeDefined();
});
