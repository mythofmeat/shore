import { compareByCodePoint, sortedKeys } from "../util/sort.ts";
import { ConfigDuration, type ParseResult } from "./duration.ts";
import { invalidType } from "./models.ts";
import { DEFAULT_KEEPALIVE_MAX_SECS } from "./keepalive.ts";
import { canonicalConfigPath, CONFIG_SECTIONS, formatConfigPath } from "./surface.ts";

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

export type ConfigTypeKind =
  | "boolean"
  | "string"
  | "integer"
  | "float"
  | "duration"
  | "enum"
  | "list"
  | "map"
  | "table"
  | "unknown";

export type ConfigValueSource =
  | "chat_models"
  | "embedding_models"
  | "image_models"
  | "tools"
  | "subagents"
  | "characters"
  | "providers";

export interface ConfigTypeInfo {
  kind: ConfigTypeKind;
  optional?: boolean;
  variants?: readonly string[];
  width?: "usize" | "u32" | "u64";
  item?: ConfigTypeInfo;
  table?: () => TableShape;
  source?: ConfigValueSource;
  keySource?: ConfigValueSource;
}

export interface TableShape {
  name: string;
  fields: Record<string, ConfigTypeInfo>;
}

const READER_TYPES = new WeakMap<Reader<never>, ConfigTypeInfo>();

function typed<T>(read: Reader<T>, info: ConfigTypeInfo): Reader<T> {
  READER_TYPES.set(read as unknown as Reader<never>, info);
  return read;
}

function typeOf(read: Reader<unknown>): ConfigTypeInfo {
  return READER_TYPES.get(read as unknown as Reader<never>) ?? { kind: "unknown" };
}

function shapeOf<T extends object>(spec: StructSpec<T>): TableShape {
  const fields: Record<string, ConfigTypeInfo> = {};
  for (const [key, read] of Object.entries(spec.fields)) {
    fields[key] = typeOf(read as Reader<unknown>);
  }
  return { name: spec.name, fields };
}

function struct<T extends object>(spec: StructSpec<T>): Reader<T> {
  return typed((v) => readStruct(spec, v), { kind: "table", table: () => shapeOf(spec) });
}

interface StructSpec<T> {
  name: string;
  fields: { [K in keyof T]?: Reader<T[K]> };
  required?: readonly (keyof T & string)[];
  noDefault?: readonly (keyof T & string)[];
  removed?: Readonly<Record<string, string>>;
  alsoAccepted?: readonly string[];
  make: () => T;
}

function readStruct<T extends object>(spec: StructSpec<T>, value: TomlValue): ParseResult<T> {
  if (Array.isArray(value)) return readStructFromSeq(spec, value);
  if (!isTable(value)) return { err: invalidType(value, `struct ${spec.name}`) };

  const elsewhere = new Set<string>(spec.alsoAccepted ?? []);
  const known = [...Object.keys(spec.fields), ...elsewhere];
  const out = spec.make();
  const seen = new Set<string>();

  for (const key of sortedKeys(value)) {
    const read = (spec.fields as Record<string, Reader<unknown> | undefined>)[key];
    if (read === undefined) {
      if (elsewhere.has(key)) continue;
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

const readBool: Reader<boolean> = typed(
  (v) => (typeof v === "boolean" ? { ok: v } : { err: invalidType(v, "a boolean") }),
  { kind: "boolean" },
);

const readString: Reader<string> = typed(
  (v) => (typeof v === "string" ? { ok: v } : { err: invalidType(v, "a string") }),
  { kind: "string" },
);

function readUint(name: "usize" | "u32" | "u64"): Reader<number> {
  const max = name === "u32" ? 0xffff_ffff : Number.POSITIVE_INFINITY;
  return typed(
    (v) => {
      if (typeof v !== "number" || !Number.isInteger(v)) return { err: invalidType(v, name) };
      if (v < 0 || v > max) return { err: `invalid value: integer \`${v}\`, expected ${name}` };
      return { ok: v };
    },
    { kind: "integer", width: name },
  );
}

const readUsize = readUint("usize");
const readU32 = readUint("u32");
const readU64 = readUint("u64");

const readF64: Reader<number> = typed(
  (v) => (typeof v === "number" ? { ok: v } : { err: invalidType(v, "f64") }),
  { kind: "float" },
);

const readDuration: Reader<ConfigDuration> = typed((v) => ConfigDuration.deserialize(v), {
  kind: "duration",
});

function readSeq<T>(inner: Reader<T>): Reader<T[]> {
  return typed(
    (v) => {
      if (!Array.isArray(v)) return { err: invalidType(v, "a sequence") };
      const out: T[] = [];
      for (const item of v) {
        const parsed = inner(item);
        if ("err" in parsed) return parsed;
        out.push(parsed.ok);
      }
      return { ok: out };
    },
    { kind: "list", item: typeOf(inner as Reader<unknown>) },
  );
}

const readStringSeq = readSeq(readString);
const readF64Seq = readSeq(readF64);

function readMap<V>(inner: Reader<V>, keySource?: ConfigValueSource): Reader<Map<string, V>> {
  return typed(
    (v) => {
      if (!isTable(v)) return { err: invalidType(v, "a map") };
      const out = new Map<string, V>();
      for (const key of sortedKeys(v)) {
        const parsed = inner(v[key]);
        if ("err" in parsed) return parsed;
        out.set(key, parsed.ok);
      }
      return { ok: out };
    },
    {
      kind: "map",
      item: typeOf(inner as Reader<unknown>),
      ...(keySource === undefined ? {} : { keySource }),
    },
  );
}

function suggests<T>(inner: Reader<T>, source: ConfigValueSource): Reader<T> {
  return typed((v) => inner(v), { ...typeOf(inner as Reader<unknown>), source });
}

const readChatModelName = suggests(readString, "chat_models");
const readEmbeddingModelName = suggests(readString, "embedding_models");
const readImageModelName = suggests(readString, "image_models");
const readToolNameSeq = readSeq(suggests(readString, "tools"));
const readSubagentNameSeq = readSeq(suggests(readString, "subagents"));

function readEnum<T extends string>(variants: readonly T[]): Reader<T> {
  return typed(
    (v) => {
      if (typeof v !== "string") {
        return { err: "invalid type: unit variant, expected string only" };
      }
      if (!(variants as readonly string[]).includes(v)) {
        return { err: `unknown variant \`${v}\`, expected ${expectedList(variants) ?? ""}` };
      }
      return { ok: v as T };
    },
    { kind: "enum", variants },
  );
}

function optional<T>(inner: Reader<T>): Reader<T | undefined> {
  return typed((v) => inner(v), { ...typeOf(inner as Reader<unknown>), optional: true });
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
    model: optional(readChatModelName),
    heartbeat: optional(readChatModelName),
    compaction: optional(readChatModelName),
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
  removed: { heartbeat: "set `heartbeat.model`" },
  make: defaultDefaultsConfig,
  fields: {
    model: optional(readChatModelName),
    background: struct(BACKGROUND),
    embedding: optional(readEmbeddingModelName),
    image_generation: optional(readImageModelName),
    subagent_model: optional(readChatModelName),
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
    heartbeat: struct(HEARTBEAT),
  },
};

export interface CacheConfig {
  keepalive_max: ConfigDuration;
  forensics: boolean;
}

export const defaultCacheConfig = (): CacheConfig => ({
  keepalive_max: ConfigDuration.fromSecs(DEFAULT_KEEPALIVE_MAX_SECS),
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
    autonomy: struct(AUTONOMY),
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
    enabled_tools: readToolNameSeq,
    enabled_subagents: readSubagentNameSeq,
    max_result_chars: readUsize,
    timeout: readDuration,
    web_search: struct(SEARCH),
    config: readMap(struct(TOOL_OVERRIDE), "tools"),
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
  write_memory: boolean;
  idle_trigger: ConfigDuration;
  archive_after: ConfigDuration;
  min_turns: number;
  max_turns: number;
  max_context_tokens: number;
  keep_recent_turns: number;
}

export const defaultCompactionConfig = (): CompactionConfig => ({
  enabled: true,
  write_memory: true,
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
    write_memory: readBool,
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

const THINKING_REPLAY_MODES: readonly ThinkingReplay[] = ["all", "none"];

const readThinkingReplay: Reader<ThinkingReplay> = typed(
  (v) => {
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
  },
  { kind: "enum", variants: THINKING_REPLAY_MODES },
);

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
  file_limits: MemoryFileLimitsConfig;
  thinking: ThinkingConfig;
  retrieval: RetrievalConfig;
  git_push: boolean;
}

export interface MemoryFileLimitsConfig {
  max_note_bytes: number;
  max_index_bytes: number;
  max_prompt_bytes: number;
}

const defaultMemoryFileLimitsConfig = (): MemoryFileLimitsConfig => ({
  max_note_bytes: 8 * 1024,
  max_index_bytes: 16 * 1024,
  max_prompt_bytes: 64 * 1024,
});

const MEMORY_FILE_LIMITS: StructSpec<MemoryFileLimitsConfig> = {
  name: "MemoryFileLimitsConfig",
  make: defaultMemoryFileLimitsConfig,
  fields: {
    max_note_bytes: readU64,
    max_index_bytes: readU64,
    max_prompt_bytes: readU64,
  },
};

const defaultMemoryConfig = (): MemoryConfig => ({
  compaction: defaultCompactionConfig(),
  file_limits: defaultMemoryFileLimitsConfig(),
  thinking: defaultThinkingConfig(),
  retrieval: defaultRetrievalConfig(),
  git_push: false,
});

const MEMORY: StructSpec<MemoryConfig> = {
  name: "MemoryConfig",
  removed: {
    backend: "Hindsight support was removed; delete [memory.backend]",
    recall: "automatic memory recall was removed; delete [memory.recall]",
    retain: "Hindsight retention was removed; delete [memory.retain]",
  },
  make: defaultMemoryConfig,
  fields: {
    compaction: struct(COMPACTION),
    file_limits: struct(MEMORY_FILE_LIMITS),
    thinking: struct(THINKING),
    retrieval: struct(RETRIEVAL),
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
    matrix: struct(MATRIX),
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

const NOTIFY_COMMAND_WAS_A_SHELL_TEMPLATE =
  "`notifications.command` is an argv list — `command = [\"notifier\", \"--title\", \"{title}\", \"--body\", \"{body}\"]`; notification content never reaches a shell";

const readNotifyCommand: Reader<string[]> = typed(
  (v) =>
    typeof v === "string" || (isTable(v) && "template" in v)
      ? { err: NOTIFY_COMMAND_WAS_A_SHELL_TEMPLATE }
      : readStringSeq(v),
  { kind: "list", item: { kind: "string" } },
);

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
  token_env?: string;
  enabled: boolean;
  backend: NotificationBackend;
  ntfy: NtfyConfig;
  command: string[];
  generation_threshold: ConfigDuration;
  events: NotificationEventsConfig;
}

export const defaultNotificationsConfig = (): NotificationsConfig => ({
  enabled: false,
  backend: "notify_send",
  ntfy: defaultNtfyConfig(),
  command: [],
  generation_threshold: ConfigDuration.fromSecs(0),
  events: defaultNotificationEvents(),
});

const NOTIFICATIONS: StructSpec<NotificationsConfig> = {
  name: "NotificationsConfig",
  make: defaultNotificationsConfig,
  fields: {
    token_env: optional(readString),
    enabled: readBool,
    backend: readEnum(NOTIFICATION_BACKENDS),
    ntfy: struct(NTFY),
    command: readNotifyCommand,
    generation_threshold: readDuration,
    events: struct(NOTIFICATION_EVENTS),
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
    character: optional(suggests(readString, "characters")),
    provider: optional(suggests(readString, "providers")),
    api_key: optional(readString),
    model: optional(readChatModelName),
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
    budgets: readSeq(struct(BUDGET)),
  },
};

export interface AdvancedConfig {
  max_retries: number | undefined;
  retry_backoff: ConfigDuration | undefined;
}

const defaultAdvancedConfig = (): AdvancedConfig => ({
  max_retries: undefined,
  retry_backoff: undefined,
});

const ADVANCED: StructSpec<AdvancedConfig> = {
  name: "AdvancedConfig",
  noDefault: ["max_retries", "retry_backoff"],
  removed: { editor: "shore uses $VISUAL, then $EDITOR, then vi" },
  make: defaultAdvancedConfig,
  fields: {
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
  timeout: ConfigDuration | undefined;
}

const SUBAGENT: StructSpec<SubagentConfig> = {
  name: "SubagentConfig",
  required: ["description", "prompt"],
  noDefault: ["description", "prompt", "model", "max_iterations", "timeout"],
  make: () => ({
    description: "",
    prompt: "",
    tools: [],
    model: undefined,
    max_iterations: undefined,
    timeout: undefined,
  }),
  fields: {
    description: readString,
    prompt: readString,
    tools: readToolNameSeq,
    model: optional(readChatModelName),
    max_iterations: optional(readU32),
    timeout: optional(readDuration),
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

export const CATALOG_SECTIONS = ["chat", "embedding", "image_generation", "providers"] as const;

const APP: StructSpec<AppConfig> = {
  name: "AppConfig",
  alsoAccepted: CATALOG_SECTIONS,
  make: defaultAppConfig,
  fields: {
    daemon: struct(DAEMON),
    defaults: struct(DEFAULTS),
    behavior: struct(BEHAVIOR),
    tools: struct(TOOLS),
    memory: struct(MEMORY),
    cache: struct(CACHE),
    connections: struct(CONNECTIONS),
    notifications: struct(NOTIFICATIONS),
    usage: struct(USAGE),
    advanced: struct(ADVANCED),
    subagents: readMap(struct(SUBAGENT)),
    mcp: readMap(struct(MCP_SERVER)),
  },
};

export function parseAppConfig(table: TomlValue): ParseResult<AppConfig> {
  return readStruct(APP, table);
}

export function validateAppConfigLayer(table: Table): ParseResult<AppConfig> {
  const problem = layerShapeProblem(table, { kind: "table", table: appConfigShape }, []);
  if (problem !== undefined) return { err: problem };
  const complete = structuredClone(table);
  if (isTable(complete.subagents)) for (const value of Object.values(complete.subagents)) {
    if (isTable(value)) { value.description ??= ""; value.prompt ??= ""; }
  }
  return parseAppConfig(complete);
}

function layerShapeProblem(value: unknown, info: ConfigTypeInfo, path: string[]): string | undefined {
  if (info.kind === "table") {
    if (Array.isArray(value)) return `${formatConfigPath(canonicalConfigPath(path))}: must be a table; convert the legacy array encoding to named fields`;
    if (!isTable(value)) return undefined;
    const fields = info.table?.().fields ?? {};
    for (const [key, child] of Object.entries(value)) {
      const type = fields[key];
      if (type === undefined) continue;
      const problem = layerShapeProblem(child, type, [...path, key]);
      if (problem !== undefined) return problem;
    }
  } else if (info.item !== undefined && (info.kind === "map" && isTable(value) || info.kind === "list" && Array.isArray(value))) {
    for (const [key, child] of Object.entries(value)) {
      const problem = layerShapeProblem(child, info.item, [...path, key]);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

export function appConfigShape(): TableShape {
  return shapeOf(APP);
}

export function acceptedTopLevelSections(): string[] {
  return [...CONFIG_SECTIONS];
}

export function mapKeysInOrder(map: ReadonlyMap<string, unknown>): string[] {
  return [...map.keys()].sort(compareByCodePoint);
}
