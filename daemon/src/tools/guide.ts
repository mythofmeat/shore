import diaryText from "../../prompts/guide/diary.md" with { type: "text" };
import indexText from "../../prompts/guide/index.md" with { type: "text" };
import messagesText from "../../prompts/guide/messages.md" with { type: "text" };
import threadsText from "../../prompts/guide/threads.md" with { type: "text" };
import toolsOffText from "../../prompts/guide/tools_off.md" with { type: "text" };
import triggersText from "../../prompts/guide/triggers.md" with { type: "text" };
import wakesText from "../../prompts/guide/wakes.md" with { type: "text" };

import { DIARY_KEPT, DIARY_NOTE_CHARS, DIARY_SHOWN, DIARY_WINDOW_MS } from "../autonomy/diary.ts";
import { HEARTBEAT_TIME_LIMIT_MS, HEARTBEAT_WRAP_UP_MS } from "../autonomy/heartbeat_loop.ts";
import { HEARTBEAT_TRIGGER } from "../autonomy/own_time.ts";
import { PUSH_CHARS } from "../autonomy/push.ts";
import { WAKE_QUIET_MS } from "../autonomy/runner.ts";
import { CHECK_ERROR_CHARS, CHECK_OUTPUT_CHARS } from "../autonomy/trigger_check.ts";
import { arrivalCheckLimitMs } from "../autonomy/trigger_loop.ts";
import { triggerSettings } from "../autonomy/trigger_service.ts";
import { ConfigDuration } from "../config/duration.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { renderTemplate } from "../engine/prompt.ts";
import { InvalidArgs } from "./errors.ts";
import { byteSize, MAX_THREAD_FILE_BYTES, MAX_THREAD_FILES_BYTES } from "./thread_file_text.ts";

const GUIDE_TOPICS = ["triggers", "wakes", "diary", "threads", "messages"] as const;

type GuideTopic = (typeof GUIDE_TOPICS)[number];

const TOPIC_TEXT: Record<GuideTopic, string> = {
  triggers: triggersText.trimEnd(),
  wakes: wakesText.trimEnd(),
  diary: diaryText.trimEnd(),
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
  const { autonomy, presence } = config.app.behavior;
  const { heartbeat } = autonomy;
  const { notifications } = config.app;
  const triggers = triggerSettings(config.app);
  const statuses = presence.statuses.map((status) => `\`${status}\``).join(", ");
  const defaultMs = Math.min(Math.max(heartbeat.default_interval.asMillis(), heartbeat.min_interval.asMillis()), heartbeat.max_interval.asMillis());
  return new Map([
    ["user", userName],
    either(triggers.enabled, "own_time_on", "own_time_off"),
    either(triggers.checks, "checks_on", "checks_off"),
    either(autonomy.triggers.off.includes(HEARTBEAT_TRIGGER), "heartbeat_off", "heartbeat_on"),
    ["wake_cooldown", span(triggers.wakeCooldownMs)],
    ["check_time_limit", span(triggers.checkLimitMs)],
    ["arrival_check_limit", span(arrivalCheckLimitMs(triggers.checkLimitMs))],
    ["max_wake_limit", span(triggers.maxWakeLimitMs)],
    ["default_wake_limit", span(HEARTBEAT_TIME_LIMIT_MS)],
    ["check_output_chars", count(CHECK_OUTPUT_CHARS)],
    ["check_error_chars", count(CHECK_ERROR_CHARS)],
    ["min_interval", heartbeat.min_interval.toString()],
    ["max_interval", heartbeat.max_interval.toString()],
    ["default_interval", span(defaultMs)],
    either(heartbeat.defer_on_activity, "wake_defers", "wake_stays"),
    ["heartbeat_limit", span(HEARTBEAT_TIME_LIMIT_MS)],
    ["heartbeat_nudge_after", span(HEARTBEAT_TIME_LIMIT_MS - HEARTBEAT_WRAP_UP_MS)],
    ["wrap_up_rounds", String(heartbeat.wrap_up_grace_rounds)],
    ["wake_quiet", span(WAKE_QUIET_MS)],
    ["dormant_after_turns", String(heartbeat.dormant_after_heartbeat_turns)],
    ["dormant_after_idle", heartbeat.dormant_after_idle_time.toString()],
    ["diary_note_chars", count(DIARY_NOTE_CHARS)],
    ["diary_window", span(DIARY_WINDOW_MS)],
    ["diary_shown", String(DIARY_SHOWN)],
    ["diary_kept", String(DIARY_KEPT)],
    ["thread_file_size", byteSize(MAX_THREAD_FILE_BYTES)],
    ["thread_files_size", byteSize(MAX_THREAD_FILES_BYTES)],
    either(notifications.push_topic !== "", "push_on", "push_off"),
    ["push_every", notifications.push_every.toString()],
    ["push_chars", count(PUSH_CHARS)],
    statuses === "" ? ["no_statuses", "yes"] : ["statuses", statuses],
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
