import { removeTomlTable, setTomlValue, tomlKeyDefined } from "./toml_edit.ts";

const HEARTBEAT_SETTINGS_KEPT: readonly (readonly [was: string, now: string])[] = [
  ["enabled", "enabled"],
  ["model", "model"],
  ["max_idle_turns", "max_idle_wakes"],
  ["idle_timeout", "idle_timeout"],
  ["max_wrap_up_rounds", "max_wrap_up_rounds"],
];

function tableIn(source: string, name: string): Record<string, unknown> | undefined {
  try {
    const found = (Bun.TOML.parse(source) as Record<string, unknown>)[name];
    return typeof found === "object" && !Array.isArray(found) ? found as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function withoutHeartbeatSection(source: string): string {
  const old = tableIn(source, "heartbeat");
  if (old === undefined) return source;
  let text = source;
  for (const [was, now] of HEARTBEAT_SETTINGS_KEPT) {
    const value = old[was];
    if (value === undefined || tomlKeyDefined(text, ["triggers", now])) continue;
    text = setTomlValue(text, ["triggers", now], JSON.stringify(value)).text;
  }
  return removeTomlTable(text, ["heartbeat"]);
}

const PAUSED_HEARTBEAT = /\b(pace_warn_action|limit_action|warn_action|pace_action)(\s*=\s*)(["'])pause_heartbeat\3/g;

const HEARTBEAT_CALL_TYPE = /\b(call_type\s*=\s*)(["'])heartbeat(_tool_loop)?\2/g;
const USAGE_KINDS = /\busage_kinds\s*=\s*\[[^\]]*\]/g;
const HEARTBEAT_KIND = /(["'])heartbeat\1/g;

export function withCurrentNames(source: string): string {
  return withoutHeartbeatSection(source)
    .replace(PAUSED_HEARTBEAT, "$1$2$3pause_wakes$3")
    .replace(HEARTBEAT_CALL_TYPE, "$1$2wake$3$2")
    .replace(USAGE_KINDS, (kinds) => kinds.replace(HEARTBEAT_KIND, "$1wake$1"));
}
