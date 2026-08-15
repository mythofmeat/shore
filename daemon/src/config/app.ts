import { compareByCodePoint, sortedKeys } from "../util/sort.ts";
import { ConfigDuration, type ParseResult } from "./duration.ts";
import { invalidType } from "./models.ts";

type TomlValue = unknown;

type Table = Record<string, TomlValue>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedList(known: readonly string[]): string | undefined {
  if (known.length === 0) return undefined;
  if (known.length === 1) return `\`${known[0]}\``;
  if (known.length === 2) return `\`${known[0]}\` or \`${known[1]}\``;
  const head = known
    .slice(0, -1)
    .map((k) => `\`${k}\``)
    .join(", ");
  return `one of ${head}, \`${known[known.length - 1]}\``;
}

function unknownField(key: string, known: readonly string[]): string {
  const expected = expectedList(known);
  const suffix = expected === undefined ? "" : `, expected ${expected}`;
  return `unknown field \`${key}\`${suffix}`;
}

type Reader<T> = (value: TomlValue) => ParseResult<T>;

interface StructSpec<T> {
  name: string;
  fields: { [K in keyof T]?: Reader<T[K]> };
  required?: readonly (keyof T & string)[];
  noDefault?: readonly (keyof T & string)[];
  removed?: Readonly<Record<string, string>>;
  make: () => T;
}

function readStruct<T extends object>(spec: StructSpec<T>, value: TomlValue): ParseResult<T> {
  if (Array.isArray(value)) return readStructFromSeq(spec, value);
  if (!isTable(value)) return { err: invalidType(value, `struct ${spec.name}`) };

  const known = Object.keys(spec.fields);
  const out = spec.make();
  const seen = new Set<string>();

  for (const key of sortedKeys(value)) {
    const read = (spec.fields as Record<string, Reader<unknown> | undefined>)[key];
    if (read === undefined) {
      const moved = spec.removed?.[key];
      if (moved !== undefined) return { err: `\`${key}\` was removed — ${moved}` };
      return { err: unknownField(key, known) };
    }
    const parsed = read(value[key]);
    if ("err" in parsed) return parsed;
    (out as Record<string, unknown>)[key] = parsed.ok;
    seen.add(key);
  }

  for (const key of spec.required ?? []) {
    if (!seen.has(key)) return { err: `missing field \`${key}\`` };
  }
  return { ok: out };
}

function readStructFromSeq<T extends object>(
  spec: StructSpec<T>,
  seq: readonly TomlValue[],
): ParseResult<T> {
  const keys = Object.keys(spec.fields);
  const noDefault = new Set<string>(spec.noDefault ?? []);
  const out = spec.make();

  if (seq.length > keys.length) {
    return { err: `invalid length ${seq.length}, expected fewer elements in array` };
  }

  for (const [i, key] of keys.entries()) {
    if (i >= seq.length) {
      if (!noDefault.has(key)) continue;
      return {
        err: `invalid length ${i}, expected struct ${spec.name} with ${keys.length} elements`,
      };
    }
    const read = (spec.fields as Record<string, Reader<unknown>>)[key] as Reader<unknown>;
    const parsed = read(seq[i]);
    if ("err" in parsed) return parsed;
    (out as Record<string, unknown>)[key] = parsed.ok;
  }
  return { ok: out };
}

const readBool: Reader<boolean> = (v) =>
  typeof v === "boolean" ? { ok: v } : { err: invalidType(v, "a boolean") };

const readString: Reader<string> = (v) =>
  typeof v === "string" ? { ok: v } : { err: invalidType(v, "a string") };

function readUint(name: "usize" | "u32" | "u64"): Reader<number> {
  const max = name === "u32" ? 0xffff_ffff : Number.POSITIVE_INFINITY;
  return (v) => {
    if (typeof v !== "number" || !Number.isInteger(v)) return { err: invalidType(v, name) };
    if (v < 0 || v > max) return { err: `invalid value: integer \`${v}\`, expected ${name}` };
    return { ok: v };
  };
}

const readUsize = readUint("usize");
const readU32 = readUint("u32");
const readU64 = readUint("u64");

const readF64: Reader<number> = (v) =>
  typeof v === "number" ? { ok: v } : { err: invalidType(v, "f64") };

const readDuration: Reader<ConfigDuration> = (v) => ConfigDuration.deserialize(v);

function readSeq<T>(inner: Reader<T>): Reader<T[]> {
  return (v) => {
    if (!Array.isArray(v)) return { err: invalidType(v, "a sequence") };
    const out: T[] = [];
    for (const item of v) {
      const parsed = inner(item);
      if ("err" in parsed) return parsed;
      out.push(parsed.ok);
    }
    return { ok: out };
  };
}

const readStringSeq = readSeq(readString);
const readF64Seq = readSeq(readF64);

function readMap<V>(inner: Reader<V>): Reader<Map<string, V>> {
  return (v) => {
    if (!isTable(v)) return { err: invalidType(v, "a map") };
    const out = new Map<string, V>();
    for (const key of sortedKeys(v)) {
      const parsed = inner(v[key]);
      if ("err" in parsed) return parsed;
      out.set(key, parsed.ok);
    }
    return { ok: out };
  };
}

function readEnum<T extends string>(variants: readonly T[]): Reader<T> {
  return (v) => {
    if (typeof v !== "string") {
      return { err: "invalid type: unit variant, expected string only" };
    }
    if (!(variants as readonly string[]).includes(v)) {
      return { err: `unknown variant \`${v}\`, expected ${expectedList(variants) ?? ""}` };
    }
    return { ok: v as T };
  };
}

function optional<T>(inner: Reader<T>): Reader<T | undefined> {
  return inner as Reader<T | undefined>;
}

export interface DaemonConfig {
  addr: string;
}

const defaultDaemonConfig = (): DaemonConfig => ({
  addr: "127.0.0.1:7320",
});

const DAEMON: StructSpec<DaemonConfig> = {
  name: "DaemonConfig",
  make: defaultDaemonConfig,
  fields: {
    addr: readString,
  },
};

export interface BackgroundDefaultsConfig {
  model: string | undefined;
  heartbeat: string | undefined;
  compaction: string | undefined;
}

const defaultBackgroundDefaults = (): BackgroundDefaultsConfig => ({
  model: undefined,
  heartbeat: undefined,
  compaction: undefined,
});

const BACKGROUND: StructSpec<BackgroundDefaultsConfig> = {
  name: "BackgroundDefaultsConfig",
  noDefault: ["model", "heartbeat", "compaction"],
  make: defaultBackgroundDefaults,
  fields: {
    model: optional(readString),
    heartbeat: optional(readString),
    compaction: optional(readString),
  },
};

export interface DefaultsConfig {
  model: string | undefined;
  background: BackgroundDefaultsConfig;
  embedding: string | undefined;
  image_generation: string | undefined;
  subagent_model: string | undefined;
  display_name: string | undefined;
  stream: boolean;
}

const defaultDefaultsConfig = (): DefaultsConfig => ({
  model: undefined,
  background: defaultBackgroundDefaults(),
  embedding: undefined,
  image_generation: undefined,
  subagent_model: undefined,
  display_name: undefined,
  stream: true,
});

const DEFAULTS: StructSpec<DefaultsConfig> = {
  name: "DefaultsConfig",
  noDefault: ["model", "embedding", "image_generation", "subagent_model", "display_name"],
  removed: { heartbeat: "set it under `[defaults.background]` as `heartbeat`" },
  make: defaultDefaultsConfig,
  fields: {
    model: optional(readString),
    background: (v) => readStruct(BACKGROUND, v),
    embedding: optional(readString),
    image_generation: optional(readString),
    subagent_model: optional(readString),
    display_name: optional(readString),
    stream: readBool,
  },
};

export type BackgroundTask = "heartbeat" | "compaction";

export function resolveBackgroundModelName(
  defaults: DefaultsConfig,
  task: BackgroundTask,
): string | undefined {
  return defaults.background[task] ?? defaults.background.model;
}

export function resolveDisplayName(
  defaults: DefaultsConfig,
  env: Record<string, string | undefined> = process.env,
): string {
  return defaults.display_name ?? env["USER"] ?? "User";
}

export type UserTimestampMode = "auto" | "always" | "never";

const USER_TIMESTAMP_MODES: readonly UserTimestampMode[] = ["auto", "always", "never"];

export interface HeartbeatConfig {
  enabled: boolean;
  fallback_heartbeat_interval: ConfigDuration;
  dormant_after_heartbeat_turns: number;
  dormant_after_idle_time: ConfigDuration;
  minimum_heartbeat_latency: ConfigDuration;
  wrap_up_grace_rounds: number;
}

const defaultHeartbeatConfig = (): HeartbeatConfig => ({
  enabled: true,
  fallback_heartbeat_interval: ConfigDuration.fromSecs(3600),
  dormant_after_heartbeat_turns: 3,
  dormant_after_idle_time: ConfigDuration.fromSecs(172_800),
  minimum_heartbeat_latency: ConfigDuration.fromSecs(3600),
  wrap_up_grace_rounds: 3,
});

const HEARTBEAT: StructSpec<HeartbeatConfig> = {
  name: "HeartbeatConfig",
  make: defaultHeartbeatConfig,
  fields: {
    enabled: readBool,
    fallback_heartbeat_interval: readDuration,
    dormant_after_heartbeat_turns: readU32,
    dormant_after_idle_time: readDuration,
    minimum_heartbeat_latency: readDuration,
    wrap_up_grace_rounds: readU32,
  },
};

export interface AutonomyConfig {
  enabled: boolean;
  heartbeat: HeartbeatConfig;
}

const defaultAutonomyConfig = (): AutonomyConfig => ({
  enabled: false,
  heartbeat: defaultHeartbeatConfig(),
});

const AUTONOMY: StructSpec<AutonomyConfig> = {
  name: "AutonomyConfig",
  make: defaultAutonomyConfig,
  fields: {
    enabled: readBool,
    heartbeat: (v) => readStruct(HEARTBEAT, v),
  },
};

export interface CacheConfig {
  keepalive_max: ConfigDuration;
  forensics: boolean;
}

export const defaultCacheConfig = (): CacheConfig => ({
  keepalive_max: ConfigDuration.fromSecs(43_200),
  forensics: false,
});

const CACHE: StructSpec<CacheConfig> = {
  name: "CacheConfig",
  make: defaultCacheConfig,
  fields: {
    keepalive_max: readDuration,
    forensics: readBool,
  },
};

export interface BehaviorConfig {
  autonomy: AutonomyConfig;
  user_message_timestamps: UserTimestampMode;
}

const defaultBehaviorConfig = (): BehaviorConfig => ({
  autonomy: defaultAutonomyConfig(),
  user_message_timestamps: "auto",
});

const BEHAVIOR: StructSpec<BehaviorConfig> = {
  name: "BehaviorConfig",
  make: defaultBehaviorConfig,
  fields: {
    autonomy: (v) => readStruct(AUTONOMY, v),
    user_message_timestamps: readEnum(USER_TIMESTAMP_MODES),
  },
};

export interface SearchConfig {
  api_key_env: string;
  result_limit: number;
  search_depth: string;
  include_answer: boolean;
}

export const defaultSearchConfig = (): SearchConfig => ({
  api_key_env: "TAVILY_API_KEY",
  result_limit: 10,
  search_depth: "advanced",
  include_answer: true,
});

const SEARCH: StructSpec<SearchConfig> = {
  name: "SearchConfig",
  make: defaultSearchConfig,
  fields: {
    api_key_env: readString,
    result_limit: readU32,
    search_depth: readString,
    include_answer: readBool,
  },
};

export interface ToolOverride {
  max_result_chars: number | undefined;
  timeout: ConfigDuration | undefined;
}

const TOOL_OVERRIDE: StructSpec<ToolOverride> = {
  name: "ToolOverride",
  make: () => ({ max_result_chars: undefined, timeout: undefined }),
  fields: {
    max_result_chars: optional(readUsize),
    timeout: optional(readDuration),
  },
};

export interface ToolsConfig {
  enabled_tools: string[];
  enabled_subagents: string[];
  max_result_chars: number;
  timeout: ConfigDuration;
  web_search: SearchConfig;
  config: Map<string, ToolOverride>;
}

export const defaultToolsConfig = (): ToolsConfig => ({
  enabled_tools: [],
  enabled_subagents: [],
  max_result_chars: 50_000,
  timeout: ConfigDuration.fromSecs(300),
  web_search: defaultSearchConfig(),
  config: new Map(),
});

const TOOLS: StructSpec<ToolsConfig> = {
  name: "ToolsConfig",
  make: defaultToolsConfig,
  fields: {
    enabled_tools: readStringSeq,
    enabled_subagents: readStringSeq,
    max_result_chars: readUsize,
    timeout: readDuration,
    web_search: (v) => readStruct(SEARCH, v),
    config: readMap((v) => readStruct(TOOL_OVERRIDE, v)),
  },
};

export function toolPatternMatches(pattern: string, name: string): boolean {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : pattern === name;
}

export function toolEnabled(tools: ToolsConfig, name: string): boolean {
  return tools.enabled_tools.some((p) => toolPatternMatches(p, name));
}

export function subagentEnabled(tools: ToolsConfig, name: string): boolean {
  return tools.enabled_subagents.includes(name);
}

export function anyToolEnabled(tools: ToolsConfig): boolean {
  return tools.enabled_tools.length > 0 || tools.enabled_subagents.length > 0;
}

export function resultCharsFor(tools: ToolsConfig, name: string): number {
  return tools.config.get(name)?.max_result_chars ?? tools.max_result_chars;
}

export function timeoutFor(tools: ToolsConfig, name: string): ConfigDuration | undefined {
  const resolved = tools.config.get(name)?.timeout ?? tools.timeout;
  return resolved.asMillisExact() > 0n ? resolved : undefined;
}

export interface CompactionConfig {
  enabled: boolean;
  idle_trigger: ConfigDuration;
  archive_after: ConfigDuration;
  min_turns: number;
  max_turns: number;
  max_context_tokens: number;
  keep_recent_turns: number;
}

export const defaultCompactionConfig = (): CompactionConfig => ({
  enabled: true,
  idle_trigger: ConfigDuration.fromSecs(7200),
  archive_after: ConfigDuration.fromSecs(0),
  min_turns: 12,
  max_turns: 30,
  max_context_tokens: 200_000,
  keep_recent_turns: 2,
});

const COMPACTION: StructSpec<CompactionConfig> = {
  name: "CompactionConfig",
  make: defaultCompactionConfig,
  fields: {
    enabled: readBool,
    idle_trigger: readDuration,
    archive_after: readDuration,
    min_turns: readUsize,
    max_turns: readUsize,
    max_context_tokens: readUsize,
    keep_recent_turns: readUsize,
  },
};

function rejectFractionalSeconds(field: string, value: ConfigDuration): string | undefined {
  const millis = value.asMillisExact();
  if (millis % 1000n === 0n) return undefined;
  return (
    `${field} is ${millis}ms. Idle thresholds must be a whole number of seconds: ` +
    "the compaction triggers truncate to seconds before comparing, so a " +
    `value like \`1.5s\` would fire early. Use \`${millis / 1000n}s\` or ` +
    `\`${millis / 1000n + 1n}s\`.`
  );
}

export function validateCompaction(compaction: CompactionConfig): string | undefined {
  if (!compaction.enabled) return undefined;

  const idle = rejectFractionalSeconds(
    "memory.compaction.idle_trigger",
    compaction.idle_trigger,
  );
  if (idle !== undefined) return idle;
  const archive = rejectFractionalSeconds(
    "memory.compaction.archive_after",
    compaction.archive_after,
  );
  if (archive !== undefined) return archive;

  const k = compaction.keep_recent_turns;
  if (compaction.min_turns <= k || compaction.max_turns <= k) {
    return (
      `memory.compaction.min_turns (${compaction.min_turns}) and max_turns ` +
      `(${compaction.max_turns}) must both be greater than keep_recent_turns ` +
      `(${k}); raise the turn thresholds or lower keep_recent_turns`
    );
  }
  if (compaction.max_turns < compaction.min_turns) {
    return (
      `memory.compaction.max_turns (${compaction.max_turns}) must be >= ` +
      `min_turns (${compaction.min_turns})`
    );
  }
  return undefined;
}

export type ThinkingReplay = "all" | "none";

export function parseThinkingReplay(s: string): ThinkingReplay | undefined {
  switch (s) {
    case "all":
    case "true":
    case "last_turn":
      return "all";
    case "none":
    case "false":
      return "none";
    default:
      return undefined;
  }
}

export interface ThinkingConfig {
  replay_prior_thinking: ThinkingReplay;
}

const defaultThinkingConfig = (): ThinkingConfig => ({
  replay_prior_thinking: "all",
});

const readThinkingReplay: Reader<ThinkingReplay> = (v) => {
  if (typeof v === "boolean") return { ok: v ? "all" : "none" };
  if (typeof v !== "string") {
    return { err: "data did not match any variant of untagged enum BoolOrStr" };
  }
  const parsed = parseThinkingReplay(v);
  if (parsed === undefined) {
    return {
      err:
        `invalid replay_prior_thinking ${JSON.stringify(v)}; ` +
        'expected "all", "none" (or legacy true/false)',
    };
  }
  return { ok: parsed };
};

const THINKING: StructSpec<ThinkingConfig> = {
  name: "ThinkingConfig",
  make: defaultThinkingConfig,
  fields: { replay_prior_thinking: readThinkingReplay },
};

export type RetrievalMode = "auto" | "lexical" | "hybrid" | "vector";
export type RetrievalBinaryMode = "skip" | "metadata" | "try_embed";

const RETRIEVAL_MODES: readonly RetrievalMode[] = ["auto", "lexical", "hybrid", "vector"];
const BINARY_MODES: readonly RetrievalBinaryMode[] = ["skip", "metadata", "try_embed"];

export interface RetrievalConfig {
  mode: RetrievalMode;
  max_file_bytes: number;
  max_indexed_files: number;
  max_total_indexed_bytes: number;
  max_embed_chars_per_file: number;
  binary: RetrievalBinaryMode;
}

const defaultRetrievalConfig = (): RetrievalConfig => ({
  mode: "auto",
  max_file_bytes: 2 * 1024 * 1024,
  max_indexed_files: 50_000,
  max_total_indexed_bytes: 1024 * 1024 * 1024,
  max_embed_chars_per_file: 4_000,
  binary: "skip",
});

const RETRIEVAL: StructSpec<RetrievalConfig> = {
  name: "RetrievalConfig",
  make: defaultRetrievalConfig,
  fields: {
    mode: readEnum(RETRIEVAL_MODES),
    max_file_bytes: readU64,
    max_indexed_files: readUsize,
    max_total_indexed_bytes: readU64,
    max_embed_chars_per_file: readUsize,
    binary: readEnum(BINARY_MODES),
  },
};

export interface MemoryConfig {
  compaction: CompactionConfig;
  thinking: ThinkingConfig;
  retrieval: RetrievalConfig;
  git_push: boolean;
}

const defaultMemoryConfig = (): MemoryConfig => ({
  compaction: defaultCompactionConfig(),
  thinking: defaultThinkingConfig(),
  retrieval: defaultRetrievalConfig(),
  git_push: false,
});

const MEMORY: StructSpec<MemoryConfig> = {
  name: "MemoryConfig",
  make: defaultMemoryConfig,
  fields: {
    compaction: (v) => readStruct(COMPACTION, v),
    thinking: (v) => readStruct(THINKING, v),
    retrieval: (v) => readStruct(RETRIEVAL, v),
    git_push: readBool,
  },
};

export interface MatrixConfig {
  enabled: boolean;
  homeserver: string;
  user_id: string;
  room_id: string;
  mirror_all: boolean;
}

export const defaultMatrixConfig = (): MatrixConfig => ({
  enabled: false,
  homeserver: "",
  user_id: "",
  room_id: "",
  mirror_all: true,
});

const MATRIX: StructSpec<MatrixConfig> = {
  name: "MatrixConfig",
  make: defaultMatrixConfig,
  fields: {
    enabled: readBool,
    homeserver: readString,
    user_id: readString,
    room_id: readString,
    mirror_all: readBool,
  },
};

export interface ConnectionsConfig {
  matrix: MatrixConfig | undefined;
}

const defaultConnectionsConfig = (): ConnectionsConfig => ({
  matrix: undefined,
});

const CONNECTIONS: StructSpec<ConnectionsConfig> = {
  name: "ConnectionsConfig",
  make: defaultConnectionsConfig,
  fields: {
    matrix: (v) => readStruct(MATRIX, v),
  },
};

export type NotificationBackend = "notify_send" | "ntfy" | "command";

const NOTIFICATION_BACKENDS: readonly NotificationBackend[] = [
  "notify_send",
  "ntfy",
  "command",
];

export interface NtfyConfig {
  url: string;
  topic: string;
  token: string;
}

const defaultNtfyConfig = (): NtfyConfig => ({
  url: "https://ntfy.sh",
  topic: "",
  token: "",
});

const NTFY: StructSpec<NtfyConfig> = {
  name: "NtfyConfig",
  make: defaultNtfyConfig,
  fields: { url: readString, topic: readString, token: readString },
};

export interface CommandNotifyConfig {
  template: string;
}

const COMMAND_NOTIFY: StructSpec<CommandNotifyConfig> = {
  name: "CommandNotifyConfig",
  make: () => ({ template: "" }),
  fields: { template: readString },
};

export interface NotificationEventsConfig {
  autonomous_message: boolean;
  cache_warning: boolean;
  compaction_complete: boolean;
  error: boolean;
  message_complete: boolean;
  usage_warning: boolean;
}

export const defaultNotificationEvents = (): NotificationEventsConfig => ({
  autonomous_message: true,
  cache_warning: false,
  compaction_complete: false,
  error: false,
  message_complete: true,
  usage_warning: false,
});

const NOTIFICATION_EVENTS: StructSpec<NotificationEventsConfig> = {
  name: "NotificationEventsConfig",
  make: defaultNotificationEvents,
  fields: {
    autonomous_message: readBool,
    cache_warning: readBool,
    compaction_complete: readBool,
    error: readBool,
    message_complete: readBool,
    usage_warning: readBool,
  },
};

export interface NotificationsConfig {
  enabled: boolean;
  backend: NotificationBackend;
  ntfy: NtfyConfig;
  command: CommandNotifyConfig;
  generation_threshold: ConfigDuration;
  events: NotificationEventsConfig;
}

export const defaultNotificationsConfig = (): NotificationsConfig => ({
  enabled: false,
  backend: "notify_send",
  ntfy: defaultNtfyConfig(),
  command: { template: "" },
  generation_threshold: ConfigDuration.fromSecs(0),
  events: defaultNotificationEvents(),
});

const NOTIFICATIONS: StructSpec<NotificationsConfig> = {
  name: "NotificationsConfig",
  make: defaultNotificationsConfig,
  fields: {
    enabled: readBool,
    backend: readEnum(NOTIFICATION_BACKENDS),
    ntfy: (v) => readStruct(NTFY, v),
    command: (v) => readStruct(COMMAND_NOTIFY, v),
    generation_threshold: readDuration,
    events: (v) => readStruct(NOTIFICATION_EVENTS, v),
  },
};

export type UsageBudgetPeriod = "hour" | "day" | "week" | "month";
export type UsageBudgetAction = "warn" | "block" | "pause_background" | "pause_heartbeat";
export type BudgetWeekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

const BUDGET_PERIODS: readonly UsageBudgetPeriod[] = ["hour", "day", "week", "month"];
const BUDGET_ACTIONS: readonly UsageBudgetAction[] = [
  "warn",
  "block",
  "pause_background",
  "pause_heartbeat",
];
const BUDGET_WEEKDAYS: readonly BudgetWeekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export function budgetPeriodRank(period: UsageBudgetPeriod): number {
  return BUDGET_PERIODS.indexOf(period);
}

export function numDaysFromMonday(day: BudgetWeekday): number {
  return BUDGET_WEEKDAYS.indexOf(day);
}

export interface UsageBudgetConfig {
  name: string;
  period: UsageBudgetPeriod;
  cost_usd: number;
  warn_at: number[];
  limit: UsageBudgetAction;
  character: string | undefined;
  provider: string | undefined;
  api_key: string | undefined;
  model: string | undefined;
  call_type: string | undefined;
  usage_kind: string[];
  allow_compaction_over_budget: boolean | undefined;
  reset_hour: number | undefined;
  reset_day_of_week: BudgetWeekday | undefined;
  reset_day_of_month: number | undefined;
  pace_period: UsageBudgetPeriod | undefined;
  pace_action: UsageBudgetAction | undefined;
  pace_warn_at: number[] | undefined;
  warn_action: UsageBudgetAction | undefined;
  pace_warn_action: UsageBudgetAction | undefined;
}

const BUDGET: StructSpec<UsageBudgetConfig> = {
  name: "UsageBudgetConfig",
  required: ["cost_usd"],
  noDefault: ["cost_usd"],
  make: () => ({
    name: "",
    period: "day",
    cost_usd: 0,
    warn_at: [0.8, 1.0],
    limit: "warn",
    character: undefined,
    provider: undefined,
    api_key: undefined,
    model: undefined,
    call_type: undefined,
    usage_kind: [],
    allow_compaction_over_budget: undefined,
    reset_hour: undefined,
    reset_day_of_week: undefined,
    reset_day_of_month: undefined,
    pace_period: undefined,
    pace_action: undefined,
    pace_warn_at: undefined,
    warn_action: undefined,
    pace_warn_action: undefined,
  }),
  fields: {
    name: readString,
    period: readEnum(BUDGET_PERIODS),
    cost_usd: readF64,
    warn_at: readF64Seq,
    limit: readEnum(BUDGET_ACTIONS),
    character: optional(readString),
    provider: optional(readString),
    api_key: optional(readString),
    model: optional(readString),
    call_type: optional(readString),
    usage_kind: readStringSeq,
    allow_compaction_over_budget: optional(readBool),
    reset_hour: optional(readU32),
    reset_day_of_week: optional(readEnum(BUDGET_WEEKDAYS)),
    reset_day_of_month: optional(readU32),
    pace_period: optional(readEnum(BUDGET_PERIODS)),
    pace_action: optional(readEnum(BUDGET_ACTIONS)),
    pace_warn_at: optional(readF64Seq),
    warn_action: optional(readEnum(BUDGET_ACTIONS)),
    pace_warn_action: optional(readEnum(BUDGET_ACTIONS)),
  },
};

export function budgetPaceAction(budget: UsageBudgetConfig): UsageBudgetAction {
  return budget.pace_action ?? "warn";
}

export function budgetPaceWarnAt(budget: UsageBudgetConfig): readonly number[] {
  return budget.pace_warn_at ?? budget.warn_at;
}

export interface UsageConfig {
  timezone: string;
  allow_compaction_over_budget: boolean;
  budgets: UsageBudgetConfig[];
}

const defaultUsageConfig = (): UsageConfig => ({
  timezone: "local",
  allow_compaction_over_budget: false,
  budgets: [],
});

const USAGE: StructSpec<UsageConfig> = {
  name: "UsageConfig",
  make: defaultUsageConfig,
  fields: {
    timezone: readString,
    allow_compaction_over_budget: readBool,
    budgets: readSeq((v) => readStruct(BUDGET, v)),
  },
};

export interface AdvancedConfig {
  editor: string | undefined;
  max_retries: number | undefined;
  retry_backoff: ConfigDuration | undefined;
}

const defaultAdvancedConfig = (): AdvancedConfig => ({
  editor: undefined,
  max_retries: undefined,
  retry_backoff: undefined,
});

const ADVANCED: StructSpec<AdvancedConfig> = {
  name: "AdvancedConfig",
  noDefault: ["editor", "max_retries", "retry_backoff"],
  make: defaultAdvancedConfig,
  fields: {
    editor: optional(readString),
    max_retries: optional(readU32),
    retry_backoff: optional(readDuration),
  },
};

export interface SubagentConfig {
  description: string;
  prompt: string;
  tools: string[];
  model: string | undefined;
  max_iterations: number | undefined;
}

const SUBAGENT: StructSpec<SubagentConfig> = {
  name: "SubagentConfig",
  required: ["description", "prompt"],
  noDefault: ["description", "prompt", "model", "max_iterations"],
  make: () => ({
    description: "",
    prompt: "",
    tools: [],
    model: undefined,
    max_iterations: undefined,
  }),
  fields: {
    description: readString,
    prompt: readString,
    tools: readStringSeq,
    model: optional(readString),
    max_iterations: optional(readU32),
  },
};

export interface McpServerConfig {
  command: string | undefined;
  args: string[];
  env: Map<string, string>;
  cwd: string | undefined;
  url: string | undefined;
  headers: Map<string, string>;
}

const MCP_SERVER: StructSpec<McpServerConfig> = {
  name: "McpServerConfig",
  noDefault: ["command", "cwd", "url"],
  make: () => ({
    command: undefined,
    args: [],
    env: new Map(),
    cwd: undefined,
    url: undefined,
    headers: new Map(),
  }),
  fields: {
    command: optional(readString),
    args: readStringSeq,
    env: readMap(readString),
    cwd: optional(readString),
    url: optional(readString),
    headers: readMap(readString),
  },
};

export interface AppConfig {
  daemon: DaemonConfig;
  defaults: DefaultsConfig;
  behavior: BehaviorConfig;
  tools: ToolsConfig;
  memory: MemoryConfig;
  cache: CacheConfig;
  connections: ConnectionsConfig;
  notifications: NotificationsConfig;
  usage: UsageConfig;
  advanced: AdvancedConfig;
  subagents: Map<string, SubagentConfig>;
  mcp: Map<string, McpServerConfig>;
}

export const defaultAppConfig = (): AppConfig => ({
  daemon: defaultDaemonConfig(),
  defaults: defaultDefaultsConfig(),
  behavior: defaultBehaviorConfig(),
  tools: defaultToolsConfig(),
  memory: defaultMemoryConfig(),
  cache: defaultCacheConfig(),
  connections: defaultConnectionsConfig(),
  notifications: defaultNotificationsConfig(),
  usage: defaultUsageConfig(),
  advanced: defaultAdvancedConfig(),
  subagents: new Map(),
  mcp: new Map(),
});

const APP: StructSpec<AppConfig> = {
  name: "AppConfig",
  make: defaultAppConfig,
  fields: {
    daemon: (v) => readStruct(DAEMON, v),
    defaults: (v) => readStruct(DEFAULTS, v),
    behavior: (v) => readStruct(BEHAVIOR, v),
    tools: (v) => readStruct(TOOLS, v),
    memory: (v) => readStruct(MEMORY, v),
    cache: (v) => readStruct(CACHE, v),
    connections: (v) => readStruct(CONNECTIONS, v),
    notifications: (v) => readStruct(NOTIFICATIONS, v),
    usage: (v) => readStruct(USAGE, v),
    advanced: (v) => readStruct(ADVANCED, v),
    subagents: readMap((v) => readStruct(SUBAGENT, v)),
    mcp: readMap((v) => readStruct(MCP_SERVER, v)),
  },
};

export function parseAppConfig(table: TomlValue): ParseResult<AppConfig> {
  return readStruct(APP, table);
}

export function mapKeysInOrder(map: ReadonlyMap<string, unknown>): string[] {
  return [...map.keys()].sort(compareByCodePoint);
}
