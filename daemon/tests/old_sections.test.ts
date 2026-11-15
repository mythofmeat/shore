import { expect, test } from "bun:test";

import { withCurrentNames, withoutHeartbeatSection } from "../src/config/old_sections.ts";

const read = (text: string): unknown => Bun.TOML.parse(text);

test("a config with no [heartbeat] section is left exactly as it was written", () => {
  for (const written of [
    "",
    '# mine\n[chat]\nmodel = "a:b"\n\n[triggers]\nenabled = true\n',
    "heartbeat = 3\n",
    '[[heartbeat]]\nenabled = true\n\n[[heartbeat]]\nenabled = false\n',
    "[heartbeat\nenabled = true\n",
  ]) expect(withoutHeartbeatSection(written)).toBe(written);
});

test("the settings a [heartbeat] section had that still exist move to [triggers] under their names there, and the rest go with the section", () => {
  const written = [
    "# mine", "[chat]", 'model = "a:b"', "",
    "# own time", "[heartbeat]", "enabled = true", 'default_interval = "24h"', 'min_interval = "4h"', 'max_interval = "48h"', "defer_on_activity = true",
    "max_idle_turns = 256", 'idle_timeout = "10d"', "max_wrap_up_rounds = 2", 'model = "anthropic:a \\"quoted\\" one"', "",
    "[compaction]", "min_turns = 4", "",
  ].join("\n");
  const now = withoutHeartbeatSection(written);
  expect(read(now)).toEqual({
    chat: { model: "a:b" },
    compaction: { min_turns: 4 },
    triggers: { enabled: true, model: 'anthropic:a "quoted" one', max_idle_wakes: 256, idle_timeout: "10d", max_wrap_up_rounds: 2 },
  });
  expect(now).toStartWith('# mine\n[chat]\nmodel = "a:b"\n');
  expect(now).not.toContain("heartbeat");
  expect(now).not.toContain("own time");

  expect(withoutHeartbeatSection("[heartbeat]\nenabled = false\n")).toBe("[triggers]\nenabled = false\n");
  expect(withoutHeartbeatSection('[chat]\nmodel = "openai:gpt-test"\n[heartbeat]\nenabled = false\n')).toBe('[chat]\nmodel = "openai:gpt-test"\n[triggers]\nenabled = false\n');
  expect(read(withoutHeartbeatSection('heartbeat.enabled = true\nheartbeat.idle_timeout = "3d"\n'))).toEqual({ triggers: { enabled: true, idle_timeout: "3d" } });
  expect(read(withoutHeartbeatSection('[heartbeat]\ndefault_interval = "1h"\n'))).toEqual({});
});

test("a setting [triggers] already has keeps its value, and the others join it in that section", () => {
  const now = withoutHeartbeatSection('[heartbeat]\nenabled = true\nmax_idle_turns = 9\n\n[triggers]\nenabled = false\nwake_cooldown = "2h"\n\n[chat]\ndisplay_name = "eve"\n');
  expect(read(now)).toEqual({ triggers: { enabled: false, wake_cooldown: "2h", max_idle_wakes: 9 }, chat: { display_name: "eve" } });
  expect(now).toBe('[triggers]\nenabled = false\nwake_cooldown = "2h"\nmax_idle_wakes = 9\n\n[chat]\ndisplay_name = "eve"\n');
});

test("a budget or plan limit that paused the heartbeat pauses wakes, under whichever of its settings said so, and everything else is left as written", () => {
  const written = [
    "[heartbeat]", "enabled = true", "",
    "[[budgets]]", 'name = "pause_heartbeat"', 'limit_action = "pause_heartbeat"', "warn_action = 'pause_heartbeat'", 'pace_action="pause_heartbeat"', 'pace_warn_action   =   "pause_heartbeat"', "",
    "[[budgets]]", 'name = "other"', 'limit_action = "block"', 'pace_warn_action = "pause_background"', "",
    "[plan_limits]", 'limit_action = "pause_heartbeat" # at the limit', "",
  ].join("\n");
  const now = withCurrentNames(written);
  expect(now.split("\n")).toEqual([
    "[[budgets]]", 'name = "pause_heartbeat"', 'limit_action = "pause_wakes"', "warn_action = 'pause_wakes'", 'pace_action="pause_wakes"', 'pace_warn_action   =   "pause_wakes"', "",
    "[[budgets]]", 'name = "other"', 'limit_action = "block"', 'pace_warn_action = "pause_background"', "",
    "[plan_limits]", 'limit_action = "pause_wakes" # at the limit', "",
    "[triggers]", "enabled = true", "",
  ]);
  expect(withCurrentNames('budgets = [{ name = "beats", limit_action = "pause_heartbeat" }]\n')).toBe('budgets = [{ name = "beats", limit_action = "pause_wakes" }]\n');
  const untouched = '[[budgets]]\nname = "beats"\nlimit_action = "pause_wakes"\nnote = "pause_heartbeat"\n';
  expect(withCurrentNames(untouched)).toBe(untouched);
});

test("a budget that counted the heartbeat's calls counts a wake's, by call type or by kind, and a budget's other settings are left as written", () => {
  const written = [
    "[[budgets]]", 'name = "beats"', "cost_usd = 1", 'call_type = "heartbeat"', "",
    "[[budgets]]", 'name = "loops"', "cost_usd = 1", "call_type='heartbeat_tool_loop'", 'usage_kinds = ["message", "heartbeat", \'heartbeat\']', "",
    "[[budgets]]", 'name = "heartbeat"', "cost_usd = 1", 'call_type = "message"', 'usage_kinds = []', 'character = "heartbeat"', "",
  ].join("\n");
  expect(withCurrentNames(written).split("\n")).toEqual([
    "[[budgets]]", 'name = "beats"', "cost_usd = 1", 'call_type = "wake"', "",
    "[[budgets]]", 'name = "loops"', "cost_usd = 1", "call_type='wake_tool_loop'", 'usage_kinds = ["message", "wake", \'wake\']', "",
    "[[budgets]]", 'name = "heartbeat"', "cost_usd = 1", 'call_type = "message"', 'usage_kinds = []', 'character = "heartbeat"', "",
  ]);
});
