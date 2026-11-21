import indexText from "../../prompts/guide/index.md" with { type: "text" };
import messagesText from "../../prompts/guide/messages.md" with { type: "text" };
import threadsText from "../../prompts/guide/threads.md" with { type: "text" };
import toolsOffText from "../../prompts/guide/tools_off.md" with { type: "text" };
import triggersText from "../../prompts/guide/triggers.md" with { type: "text" };
import wakesText from "../../prompts/guide/wakes.md" with { type: "text" };

import { PUSH_CHARS } from "../autonomy/push.ts";
import { DEFAULT_WAKE_LIMIT_MS, WAKE_QUIET_MS } from "../autonomy/runner.ts";
import { CHECK_ERROR_CHARS, CHECK_OUTPUT_CHARS } from "../autonomy/trigger_check.ts";
import { triggerSettings } from "../autonomy/trigger_service.ts";
import { ConfigDuration } from "../config/duration.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { renderTemplate } from "../engine/prompt.ts";
import { InvalidArgs } from "./errors.ts";
import { byteSize, MAX_THREAD_PIN_BYTES, MAX_THREAD_PINS_BYTES } from "./thread_file_text.ts";

const GUIDE_TOPICS = ["triggers", "wakes", "threads", "messages"] as const;

type GuideTopic = (typeof GUIDE_TOPICS)[number];

const TOPIC_TEXT: Record<GuideTopic, string> = {
  triggers: triggersText.trimEnd(),
  wakes: wakesText.trimEnd(),
  threads: threadsText.trimEnd(),
  messages: messagesText.trimEnd(),
};

const INDEX = indexText.trimEnd();

const TOOLS_OFF = toolsOffText.trimEnd();

export interface GuideTool {
  name: string;
  enabled: boolean;
}

function span(ms: number): string {
  return ConfigDuration.fromMillis(ms).toString();
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function either(holds: boolean, whenTrue: string, whenFalse: string): [string, string] {
  return [holds ? whenTrue : whenFalse, "yes"];
}

export function guideValues(config: LoadedConfig, userName: string): Map<string, string> {
  const { notifications, triggers: limits } = config.app;
  const triggers = triggerSettings(config.app);
  return new Map([
    ["user", userName],
    either(triggers.enabled, "triggers_on", "triggers_off"),
    either(triggers.checks, "checks_on", "checks_off"),
    ["wake_cooldown", span(triggers.wakeCooldownMs)],
    ["check_time_limit", span(triggers.checkLimitMs)],
    ["max_wake_limit", span(triggers.maxWakeLimitMs)],
    ["default_wake_limit", span(DEFAULT_WAKE_LIMIT_MS)],
    ["check_output_chars", count(CHECK_OUTPUT_CHARS)],
    ["check_error_chars", count(CHECK_ERROR_CHARS)],
    ["wrap_up_rounds", String(limits.max_wrap_up_rounds)],
    ["wake_quiet", span(WAKE_QUIET_MS)],
    ["dormant_after_wakes", String(limits.max_idle_wakes)],
    ["dormant_after_idle", limits.idle_timeout.toString()],
    ["thread_pin_size", byteSize(MAX_THREAD_PIN_BYTES)],
    ["thread_pins_size", byteSize(MAX_THREAD_PINS_BYTES)],
    either(notifications.push_topic !== "", "push_on", "push_off"),
    ["push_every", notifications.push_every.toString()],
    ["push_chars", count(PUSH_CHARS)],
  ]);
}

export function readGuide(input: Record<string, unknown>, values: ReadonlyMap<string, string>, tools: readonly GuideTool[]): string {
  const asked = typeof input["topic"] === "string" ? input["topic"].trim() : "";
  const vars = new Map([...values, ...tools.map((tool): [string, string] => [tool.name, tool.name])]);
  if (asked === "") return renderTemplate(INDEX, vars);
  const topic = GUIDE_TOPICS.find((each) => each === asked);
  if (topic === undefined) throw new InvalidArgs(`there is no topic ${JSON.stringify(asked)}; the topics are ${GUIDE_TOPICS.join(", ")}`);
  const text = TOPIC_TEXT[topic];
  const off = tools.filter((tool) => !tool.enabled && text.includes(`{{${tool.name}}}`)).map((tool) => `\`${tool.name}\``).join(", ");
  return renderTemplate(off === "" ? text : `${text}\n\n${TOOLS_OFF}`, new Map([...vars, ["tools_off", off]]));
}
