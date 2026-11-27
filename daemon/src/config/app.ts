import { compareByCodePoint, sortedKeys } from "../util/sort.ts";
import { required } from "../util/required.ts";
import { ConfigDuration, type ParseResult } from "./duration.ts";
import { within } from "./failure.ts";
import { invalidType } from "./models.ts";
import { DEFAULT_MAX_INLINE_IMAGE_BYTES } from "../tools/media.ts";
import { DEFAULT_IMAGE_CACHE_BYTES } from "../storage/image_cache.ts";
import { parseToolsUser } from "../tools/character_user.ts";
import { normalizeWorkspacePath, pathComponents } from "../tools/workspace_path.ts";
import { TEXTS as TEXT_LIST } from "../texts/registry.ts";
import type { TextSetting } from "../texts/texts.ts";
import {
  API_MAX_IMAGE_EDGE,
  DEFAULT_IMAGE_SETTINGS,
  IMAGE_FORMATS,
  MAX_SENT_IMAGE_BYTES,
  type ImageFormat,
  type ImageSettings,
} from "../llm/image_settings.ts";

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

export type { ConfigSource as ConfigValueSource } from "../protocol/ConfigSource.ts";
import type { ConfigKind as ConfigTypeKind } from "../protocol/ConfigKind.ts";
import type { ConfigSource as ConfigValueSource } from "../protocol/ConfigSource.ts";

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
  others?: { into: string; item: ConfigTypeInfo };
}

const READER_TYPES = new WeakMap<Reader<never>, ConfigTypeInfo>();

function typed<T>(read: Reader<T>, info: ConfigTypeInfo): Reader<T> {
  READER_TYPES.set(read as unknown as Reader<never>, info);
  return read;
}

export function typeWords(info: ConfigTypeInfo): string {
  switch (info.kind) {
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "integer":
      return "integer";
    case "float":
      return "number";
    case "duration":
      return "duration";
    case "enum":
      return (info.variants ?? []).join(" | ");
    case "list":
      return `list of ${info.item === undefined ? "values" : typeWords(info.item)}`;
    case "map":
      return `table of ${info.item === undefined ? "values" : typeWords(info.item)}`;
    case "table":
      return "table";
    case "unknown":
      return "value";
  }
}

function typeOf(read: Reader<unknown>): ConfigTypeInfo {
  return READER_TYPES.get(read as unknown as Reader<never>) ?? { kind: "unknown" };
}

function shapeOf<T extends object>(spec: StructSpec<T>): TableShape {
  const fields: Record<string, ConfigTypeInfo> = {};
  for (const [key, read] of Object.entries(spec.fields)) {
    fields[key] = typeOf(read as Reader<unknown>);
  }
  const others = typeof spec.others === "object" ? { into: spec.others.into, item: typeOf(spec.others.read) } : undefined;
  return { name: spec.name, fields, ...(others === undefined ? {} : { others }) };
}

function struct<T extends object>(spec: StructSpec<T>): Reader<T> {
  return typed((v) => readStruct(spec, v), { kind: "table", table: () => shapeOf(spec) });
}

interface StructSpec<T> {
  name: string;
  fields: { [K in keyof T]?: Reader<T[K]> };
  required?: readonly (keyof T & string)[];
  alsoAccepted?: readonly string[];
  others?: "read elsewhere" | { into: keyof T & string; read: Reader<unknown> };
  make: () => T;
}

function readStruct<T extends object>(spec: StructSpec<T>, value: TomlValue): ParseResult<T> {
  if (!isTable(value)) return { err: invalidType(value, "table") };

  const elsewhere = new Set<string>(spec.alsoAccepted ?? []);
  const known = [...Object.keys(spec.fields), ...elsewhere];
  const out = spec.make();
  const seen = new Set<string>();

  for (const key of sortedKeys(value)) {
    const read = (spec.fields as Record<string, Reader<unknown> | undefined>)[key];
    if (read === undefined) {
      if (elsewhere.has(key) || spec.others === "read elsewhere") continue;
      if (spec.others === undefined) return { err: unknownField(key, known) };
      const other = spec.others.read(value[key]);
      if ("err" in other) return within(key, other);
      (out[spec.others.into] as Map<string, unknown>).set(key, other.ok);
      continue;
    }
    const parsed = read(value[key]);
    if ("err" in parsed) return within(key, parsed);
    (out as Record<string, unknown>)[key] = parsed.ok;
    seen.add(key);
  }

  for (const key of spec.required ?? []) {
    if (!seen.has(key)) return { err: `missing field \`${key}\`` };
  }
  return { ok: out };
}

const readBool: Reader<boolean> = typed(
  (v) => (typeof v === "boolean" ? { ok: v } : { err: invalidType(v, "boolean") }),
  { kind: "boolean" },
);

const readString: Reader<string> = typed(
  (v) => (typeof v === "string" ? { ok: v } : { err: invalidType(v, "string") }),
  { kind: "string" },
);

function readUint(name: "usize" | "u32" | "u64"): Reader<number> {
  const max = name === "u32" ? 0xffff_ffff : Number.POSITIVE_INFINITY;
  return typed(
    (v) => {
      if (typeof v !== "number" || !Number.isInteger(v)) return { err: invalidType(v, "integer") };
      if (v < 0 || v > max) return { err: `invalid value: integer \`${v}\`, expected an integer from 0${max === Number.POSITIVE_INFINITY ? "" : ` to ${String(max)}`}` };
      return { ok: v };
    },
    { kind: "integer", width: name },
  );
}

const readUsize = readUint("usize");
const readU32 = readUint("u32");

const readF64: Reader<number> = typed(
  (v) => (typeof v === "number" ? { ok: v } : { err: invalidType(v, "number") }),
  { kind: "float" },
);

const readDuration: Reader<ConfigDuration> = typed((v) => ConfigDuration.deserialize(v), {
  kind: "duration",
});

function readSeq<T>(inner: Reader<T>): Reader<T[]> {
  return typed(
    (v) => {
      if (!Array.isArray(v)) return { err: invalidType(v, typeWords({ kind: "list", item: typeOf(inner) })) };
      const out: T[] = [];
      for (const [index, item] of v.entries()) {
        const parsed = inner(item);
        if ("err" in parsed) return within(index, parsed);
        out.push(parsed.ok);
      }
      return { ok: out };
    },
    { kind: "list", item: typeOf(inner as Reader<unknown>) },
  );
}

const readStringSeq = readSeq(readString);

const readToolsUser: Reader<string> = typed(
  (v) => {
    if (typeof v !== "string") return { err: invalidType(v, "string") };
    const parsed = parseToolsUser(v);
    return "err" in parsed ? { err: parsed.err } : { ok: v };
  },
  { kind: "string" },
);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const readEnvNameSeq = readSeq(typed(
  (v) => {
    if (typeof v !== "string") return { err: invalidType(v, "string") };
    return ENV_NAME.test(v) ? { ok: v } : { err: `\`${v}\` is not an environment variable name` };
  },
  { kind: "string" },
));
const readF64Seq = readSeq(readF64);

function readMap<V>(inner: Reader<V>): Reader<Map<string, V>> {
  return typed(
    (v) => {
      if (!isTable(v)) return { err: invalidType(v, typeWords({ kind: "map", item: typeOf(inner) })) };
      const out = new Map<string, V>();
      for (const key of sortedKeys(v)) {
        const parsed = inner(v[key]);
        if ("err" in parsed) return within(key, parsed);
        out.set(key, parsed.ok);
      }
      return { ok: out };
    },
    { kind: "map", item: typeOf(inner as Reader<unknown>) },
  );
}

function suggests<T>(inner: Reader<T>, source: ConfigValueSource): Reader<T> {
  return typed((v) => inner(v), { ...typeOf(inner as Reader<unknown>), source });
}

const readChatModelName = suggests(readString, "chat_models");
const readToolNameSeq = readSeq(suggests(readString, "tools"));
const readSubagentNameSeq = readSeq(suggests(readString, "subagents"));

function readEnum<T extends string>(variants: readonly T[]): Reader<T> {
  return typed(
    (v) => {
      if (typeof v !== "string") {
        return { err: invalidType(v, typeWords({ kind: "enum", variants })) };
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

export interface WebConfig {
  enabled: boolean;
  bind_addr: string;
  public_origin: string | undefined;
  tls_cert: string | undefined;
  tls_key: string | undefined;
  max_connections: number;
  max_queued_bytes: number;
  session_lifetime: ConfigDuration;
}

export const defaultWebConfig = (): WebConfig => ({
  enabled: true,
  bind_addr: "127.0.0.1:7340",
  public_origin: undefined,
  tls_cert: undefined,
  tls_key: undefined,
  max_connections: 16,
  max_queued_bytes: 32 * 1024 * 1024,
  session_lifetime: ConfigDuration.fromSecs(30 * 24 * 60 * 60),
});

const WEB: StructSpec<WebConfig> = {
  name: "WebConfig",
  make: defaultWebConfig,
  fields: {
    enabled: readBool,
    bind_addr: readString,
    public_origin: optional(readString),
    tls_cert: optional(readString),
    tls_key: optional(readString),
    max_connections: readUsize,
    max_queued_bytes: readUsize,
    session_lifetime: readDuration,
  },
};

export interface DaemonConfig {
  image_cache_bytes: number;
  shutdown_grace: ConfigDuration;
  cache_forensics: boolean;
  web: WebConfig;
}

const defaultDaemonConfig = (): DaemonConfig => ({
  image_cache_bytes: DEFAULT_IMAGE_CACHE_BYTES,
  shutdown_grace: ConfigDuration.fromSecs(29 * 60),
  cache_forensics: false,
  web: defaultWebConfig(),
});

const DAEMON: StructSpec<DaemonConfig> = {
  name: "DaemonConfig",
  make: defaultDaemonConfig,
  fields: {
    image_cache_bytes: readUsize,
    shutdown_grace: readDuration,
    cache_forensics: readBool,
    web: struct(WEB),
  },
};

export type BackgroundTask = "wake";

export function resolveBackgroundModelName(
  app: Pick<AppConfig, "triggers">,
  task: BackgroundTask,
): string | undefined {
  return { wake: app.triggers }[task].model;
}

export function resolveDisplayName(
  chat: Pick<ChatConfig, "display_name">,
  env: Record<string, string | undefined> = process.env,
): string {
  return chat.display_name ?? env["USER"] ?? "User";
}

type UserTimestampMode = "auto" | "always" | "never";

const USER_TIMESTAMP_MODES: readonly UserTimestampMode[] = ["auto", "always", "never"];

export interface TriggersConfig {
  enabled: boolean;
  model: string | undefined;
  wake_cooldown: ConfigDuration;
  check_time_limit: ConfigDuration;
  max_wake_limit: ConfigDuration;
  max_wrap_up_rounds: number;
  max_idle_wakes: number;
  idle_timeout: ConfigDuration;
  off: string[];
}

export const defaultTriggersConfig = (): TriggersConfig => ({
  enabled: false,
  model: undefined,
  wake_cooldown: ConfigDuration.fromSecs(3600),
  check_time_limit: ConfigDuration.fromSecs(60),
  max_wake_limit: ConfigDuration.fromSecs(7200),
  max_wrap_up_rounds: 3,
  max_idle_wakes: 3,
  idle_timeout: ConfigDuration.fromSecs(172_800),
  off: [],
});

export function validateTriggers(triggers: TriggersConfig): string | undefined {
  if (triggers.check_time_limit.asMillisExact() <= 0n) return "triggers.check_time_limit must be greater than zero";
  return undefined;
}

const TRIGGERS: StructSpec<TriggersConfig> = {
  name: "TriggersConfig",
  make: defaultTriggersConfig,
  fields: {
    enabled: readBool,
    model: optional(readChatModelName),
    wake_cooldown: readDuration,
    check_time_limit: readDuration,
    max_wake_limit: readDuration,
    max_wrap_up_rounds: readU32,
    max_idle_wakes: readU32,
    idle_timeout: readDuration,
    off: readStringSeq,
  },
};

export interface MarksConfig {
  like_tags: string[];
  dislike_tags: string[];
}

export type MarkTagList = keyof MarksConfig;

export const defaultMarksConfig = (): MarksConfig => ({
  like_tags: [],
  dislike_tags: ["didn't look hard enough", "out of character", "too long", "repetitive"],
});

export const MAX_MARK_TAG_CHARS = 80;

export function markTagList(kind: "like" | "dislike"): MarkTagList {
  return kind === "like" ? "like_tags" : "dislike_tags";
}

export function validateMarks(marks: MarksConfig): string | undefined {
  for (const list of ["like_tags", "dislike_tags"] as const) {
    const tags = marks[list];
    const wrong = tags.find((tag) => tag.trim() !== tag || tag === "" || Array.from(tag).length > MAX_MARK_TAG_CHARS);
    if (wrong !== undefined) return `marks.${list} has ${JSON.stringify(wrong)}; a tag is 1 to ${String(MAX_MARK_TAG_CHARS)} characters with no space at either end`;
    const repeated = tags.find((tag, index) => tags.indexOf(tag) !== index);
    if (repeated !== undefined) return `marks.${list} lists ${JSON.stringify(repeated)} twice`;
  }
  return undefined;
}

const MARKS: StructSpec<MarksConfig> = {
  name: "MarksConfig",
  make: defaultMarksConfig,
  fields: { like_tags: readStringSeq, dislike_tags: readStringSeq },
};

interface ToolOverride {
  max_result_chars: number | undefined;
  max_inline_image_bytes?: number;
  timeout: ConfigDuration | undefined;
}

const TOOL_OVERRIDE: StructSpec<ToolOverride> = {
  name: "ToolOverride",
  make: () => ({ max_result_chars: undefined, timeout: undefined }),
  fields: {
    max_result_chars: optional(readUsize),
    max_inline_image_bytes: optional(readUsize),
    timeout: optional(readDuration),
  },
};

export interface ToolsConfig {
  enabled: string[];
  mcp: string[];
  max_result_chars: number;
  max_inline_image_bytes: number;
  timeout: ConfigDuration;
  user: string | undefined;
  pass_env: string[];
  no_new_privs: boolean;
  per_tool: Map<string, ToolOverride>;
}

export const defaultToolsConfig = (): ToolsConfig => ({
  enabled: [],
  mcp: [],
  max_result_chars: 50_000,
  max_inline_image_bytes: DEFAULT_MAX_INLINE_IMAGE_BYTES,
  timeout: ConfigDuration.fromSecs(300),
  user: undefined,
  pass_env: [],
  no_new_privs: true,
  per_tool: new Map(),
});

const TOOLS: StructSpec<ToolsConfig> = {
  name: "ToolsConfig",
  make: defaultToolsConfig,
  others: { into: "per_tool", read: struct(TOOL_OVERRIDE) },
  fields: {
    enabled: readToolNameSeq,
    mcp: readStringSeq,
    max_result_chars: readUsize,
    max_inline_image_bytes: readUsize,
    timeout: readDuration,
    user: optional(readToolsUser),
    pass_env: readEnvNameSeq,
    no_new_privs: readBool,
  },
};

export const TOOLS_NOW_PART_OF: ReadonlyMap<string, string> = new Map([
  ["list_threads", "threads"],
  ["start_thread", "threads"],
  ["start_sealed_thread", "threads"],
  ["edit_thread", "threads"],
  ["search_chat_logs", "chat_logs"],
  ["read_chat_logs", "chat_logs"],
  ["send_push", "send_message"],
]);

export function toolPatternMatches(pattern: string, name: string): boolean {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : pattern === name;
}

export function toolGrants(tools: Pick<ToolsConfig, "enabled" | "mcp">): string[] {
  return [...tools.enabled, ...tools.mcp.map((server) => `mcp__${server}__*`)];
}

export function toolEnabled(tools: ToolsConfig, name: string): boolean {
  return toolGrants(tools).some((p) => toolPatternMatches(p, name));
}

export function subagentEnabled(subagents: Pick<SubagentsConfig, "enabled">, name: string): boolean {
  return subagents.enabled.includes(name);
}

export function anyToolEnabled(app: Pick<AppConfig, "tools" | "subagents">): boolean {
  return app.tools.enabled.length > 0 || app.tools.mcp.length > 0 || app.subagents.enabled.length > 0;
}

export function resultCharsFor(tools: ToolsConfig, name: string): number {
  return tools.per_tool.get(name)?.max_result_chars ?? tools.max_result_chars;
}

export function timeoutFor(tools: ToolsConfig, name: string): ConfigDuration | undefined {
  const resolved = tools.per_tool.get(name)?.timeout ?? tools.timeout;
  return resolved.asMillisExact() > 0n ? resolved : undefined;
}

export interface ImageOverride {
  max_tokens: number | undefined;
  max_edge: number | undefined;
  format: ImageFormat | undefined;
  quality: number | undefined;
  png_compression: number | undefined;
  png_palette: boolean | undefined;
  max_bytes: number | undefined;
}

interface ImageReadConfig extends ImageOverride {
  tell_model: boolean;
  allow_original: boolean;
}

export interface ImagesConfig extends ImageSettings {
  read: ImageReadConfig;
  upload: ImageOverride;
  mcp: ImageOverride;
}

export type ImageOrigin = "read" | "upload" | "mcp";

const noImageOverride = (): ImageOverride => ({
  max_tokens: undefined,
  max_edge: undefined,
  format: undefined,
  quality: undefined,
  png_compression: undefined,
  png_palette: undefined,
  max_bytes: undefined,
});

const IMAGE_OVERRIDE_FIELDS = {
  max_tokens: optional(readU32),
  max_edge: optional(readU32),
  format: optional(readEnum(IMAGE_FORMATS)),
  quality: optional(readU32),
  png_compression: optional(readU32),
  png_palette: optional(readBool),
  max_bytes: optional(readUsize),
};

const IMAGE_OVERRIDE: StructSpec<ImageOverride> = {
  name: "ImageOverride",
  make: noImageOverride,
  fields: IMAGE_OVERRIDE_FIELDS,
};

const IMAGE_READ: StructSpec<ImageReadConfig> = {
  name: "ImageReadConfig",
  make: () => ({ ...noImageOverride(), tell_model: true, allow_original: true }),
  fields: { ...IMAGE_OVERRIDE_FIELDS, tell_model: readBool, allow_original: readBool },
};

export const defaultImagesConfig = (): ImagesConfig => ({
  ...DEFAULT_IMAGE_SETTINGS,
  read: IMAGE_READ.make(),
  upload: noImageOverride(),
  mcp: noImageOverride(),
});

const IMAGES: StructSpec<ImagesConfig> = {
  name: "ImagesConfig",
  make: defaultImagesConfig,
  fields: {
    max_tokens: readU32,
    max_edge: readU32,
    format: readEnum(IMAGE_FORMATS),
    quality: readU32,
    png_compression: readU32,
    png_palette: readBool,
    max_bytes: readUsize,
    read: struct(IMAGE_READ),
    upload: struct(IMAGE_OVERRIDE),
    mcp: struct(IMAGE_OVERRIDE),
  },
};

export function imageSettingsFor(images: ImagesConfig, origin: ImageOrigin): ImageSettings {
  const override = images[origin];
  return {
    max_tokens: override.max_tokens ?? images.max_tokens,
    max_edge: override.max_edge ?? images.max_edge,
    format: override.format ?? images.format,
    quality: override.quality ?? images.quality,
    png_compression: override.png_compression ?? images.png_compression,
    png_palette: override.png_palette ?? images.png_palette,
    max_bytes: override.max_bytes ?? images.max_bytes,
  };
}

export function validateImages(images: ImagesConfig): string | undefined {
  for (const [section, settings] of [["images", images], ["images.read", images.read], ["images.upload", images.upload], ["images.mcp", images.mcp]] as const) {
    const problem = imageSettingsProblem(settings);
    if (problem !== undefined) return `${section}.${problem}`;
  }
  return undefined;
}

function imageSettingsProblem(settings: ImageOverride | ImageSettings): string | undefined {
  const outside = (value: number | undefined, low: number, high: number): boolean =>
    value !== undefined && (value < low || value > high);
  if (outside(settings.max_edge, 1, API_MAX_IMAGE_EDGE)) {
    return `max_edge is ${String(settings.max_edge)}; it must be from 1 to ${String(API_MAX_IMAGE_EDGE)} pixels, the most the API accepts`;
  }
  if (outside(settings.quality, 1, 100)) return `quality is ${String(settings.quality)}; it must be from 1 to 100`;
  if (outside(settings.png_compression, 0, 9)) return `png_compression is ${String(settings.png_compression)}; it must be a zlib level from 0 to 9`;
  if (outside(settings.max_bytes, 1, MAX_SENT_IMAGE_BYTES)) {
    return `max_bytes is ${String(settings.max_bytes)}; it must be from 1 to ${String(MAX_SENT_IMAGE_BYTES)}, which keeps each image under the 5 MB base64 limit on every platform`;
  }
  return undefined;
}

export interface CompactionConfig {
  enabled: boolean;
  label_segments: boolean;
  idle_after: ConfigDuration;
  archive_after: ConfigDuration;
  min_turns: number;
  max_turns: number;
  max_context_tokens: number;
  keep_recent_turns: number;
  git_push: boolean;
}

export const defaultCompactionConfig = (): CompactionConfig => ({
  enabled: true,
  label_segments: true,
  idle_after: ConfigDuration.fromSecs(7200),
  archive_after: ConfigDuration.fromSecs(0),
  min_turns: 12,
  max_turns: 30,
  max_context_tokens: 200_000,
  keep_recent_turns: 2,
  git_push: false,
});

const COMPACTION: StructSpec<CompactionConfig> = {
  name: "CompactionConfig",
  make: defaultCompactionConfig,
  fields: {
    enabled: readBool,
    label_segments: readBool,
    idle_after: readDuration,
    archive_after: readDuration,
    min_turns: readUsize,
    max_turns: readUsize,
    max_context_tokens: readUsize,
    keep_recent_turns: readUsize,
    git_push: readBool,
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
    "compaction.idle_after",
    compaction.idle_after,
  );
  if (idle !== undefined) return idle;
  const archive = rejectFractionalSeconds(
    "compaction.archive_after",
    compaction.archive_after,
  );
  if (archive !== undefined) return archive;

  const k = compaction.keep_recent_turns;
  if (compaction.min_turns <= k || compaction.max_turns <= k) {
    return (
      `compaction.min_turns (${compaction.min_turns}) and max_turns ` +
      `(${compaction.max_turns}) must both be greater than keep_recent_turns ` +
      `(${k}); raise the turn thresholds or lower keep_recent_turns`
    );
  }
  if (compaction.max_turns < compaction.min_turns) {
    return (
      `compaction.max_turns (${compaction.max_turns}) must be >= ` +
      `min_turns (${compaction.min_turns})`
    );
  }
  return undefined;
}

export type ThinkingReplay = "all" | "none";

const THINKING_REPLAY_MODES: readonly ThinkingReplay[] = ["all", "none"];


export interface ChatConfig {
  model: string | undefined;
  display_name: string | undefined;
  system_prompt: string | undefined;
  user_timestamps: UserTimestampMode;
  reasoning_replay: ThinkingReplay;
  max_retries: number | undefined;
  retry_backoff: ConfigDuration | undefined;
}

const defaultChatConfig = (): ChatConfig => ({
  model: undefined,
  display_name: undefined,
  system_prompt: undefined,
  user_timestamps: "auto",
  reasoning_replay: "all",
  max_retries: undefined,
  retry_backoff: undefined,
});

const CHAT: StructSpec<ChatConfig> = {
  name: "ChatConfig",
  make: defaultChatConfig,
  others: "read elsewhere",
  fields: {
    model: optional(readChatModelName),
    display_name: optional(readString),
    system_prompt: optional(readString),
    user_timestamps: readEnum(USER_TIMESTAMP_MODES),
    reasoning_replay: readEnum(THINKING_REPLAY_MODES),
    max_retries: optional(readU32),
    retry_backoff: optional(readDuration),
  },
};

export function chatModelProfiles(chat: Table | undefined): Table | undefined {
  if (chat === undefined) return undefined;
  return Object.fromEntries(Object.entries(chat).filter(([key]) => !(key in CHAT.fields)));
}

const DAY_WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export function parseDayWindow(raw: string): { startMinute: number; endMinute: number } | undefined {
  const match = DAY_WINDOW.exec(raw.trim());
  if (match === null) return undefined;
  const [, startHour, startMinute, endHour, endMinute] = match.map(Number);
  const start = (startHour ?? 0) * 60 + (startMinute ?? 0);
  const end = (endHour ?? 0) * 60 + (endMinute ?? 0);
  return start === end ? undefined : { startMinute: start, endMinute: end };
}

export interface MatrixConfig {
  enabled: boolean;
  homeserver_url: string;
  user_id: string;
  room_id: string;
  mirror_user_messages: boolean;
}

export const defaultMatrixConfig = (): MatrixConfig => ({
  enabled: false,
  homeserver_url: "",
  user_id: "",
  room_id: "",
  mirror_user_messages: true,
});

const MATRIX: StructSpec<MatrixConfig> = {
  name: "MatrixConfig",
  make: defaultMatrixConfig,
  fields: {
    enabled: readBool,
    homeserver_url: readString,
    user_id: readString,
    room_id: readString,
    mirror_user_messages: readBool,
  },
};

export type NotificationVia = "off" | "notify_send" | "ntfy" | "command";

const NOTIFICATION_VIAS: readonly NotificationVia[] = ["off", "notify_send", "ntfy", "command"];

export const NOTIFICATION_EVENTS = ["autonomous_message", "cache_warning", "compaction_complete", "error", "message_complete", "usage_warning"] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

const readNotificationEvents: Reader<NotificationEvent[]> = typed(
  (v) => {
    if (!Array.isArray(v)) return { err: invalidType(v, typeWords({ kind: "list", item: { kind: "enum", variants: NOTIFICATION_EVENTS } })) };
    if (v.some((event) => !(NOTIFICATION_EVENTS as readonly unknown[]).includes(event))) return { err: "notifications.events contains an unknown event" };
    return { ok: NOTIFICATION_EVENTS.filter((event) => v.includes(event)) };
  },
  { kind: "list", item: { kind: "enum", variants: NOTIFICATION_EVENTS } },
);

export interface NotificationsConfig {
  via: NotificationVia;
  events: NotificationEvent[];
  min_generation_duration: ConfigDuration;
  url: string;
  topic: string;
  token_env?: string;
  command: string[];
  push_topic: string;
  push_every: ConfigDuration;
}

export const defaultNotificationsConfig = (): NotificationsConfig => ({
  via: "off",
  events: ["autonomous_message", "message_complete"],
  min_generation_duration: ConfigDuration.fromSecs(0),
  url: "https://ntfy.sh",
  topic: "",
  command: [],
  push_topic: "",
  push_every: ConfigDuration.fromSecs(86_400),
});

const NOTIFICATIONS: StructSpec<NotificationsConfig> = {
  name: "NotificationsConfig",
  make: defaultNotificationsConfig,
  fields: {
    via: readEnum(NOTIFICATION_VIAS),
    events: readNotificationEvents,
    min_generation_duration: readDuration,
    url: readString,
    topic: readString,
    token_env: optional(readString),
    command: readStringSeq,
    push_topic: readString,
    push_every: readDuration,
  },
};

export type UsageBudgetPeriod = "hour" | "day" | "week" | "month";
export type UsageBudgetAction = "warn" | "block" | "pause_background" | "pause_wakes";
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
  "pause_wakes",
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
  warn_fractions: number[];
  limit_action: UsageBudgetAction;
  character: string | undefined;
  provider: string | undefined;
  api_key: string | undefined;
  model: string | undefined;
  call_type: string | undefined;
  usage_kinds: string[];
  allow_compaction: boolean;
  reset_hour: number | undefined;
  reset_day_of_week: BudgetWeekday | undefined;
  reset_day_of_month: number | undefined;
  pace_period: UsageBudgetPeriod | undefined;
  pace_action: UsageBudgetAction | undefined;
  pace_warn_fractions: number[] | undefined;
  warn_action: UsageBudgetAction | undefined;
  pace_warn_action: UsageBudgetAction | undefined;
}

const BUDGET: StructSpec<UsageBudgetConfig> = {
  name: "UsageBudgetConfig",
  required: ["cost_usd"],
  make: () => ({
    name: "",
    period: "day",
    cost_usd: 0,
    warn_fractions: [0.8, 1.0],
    limit_action: "warn",
    character: undefined,
    provider: undefined,
    api_key: undefined,
    model: undefined,
    call_type: undefined,
    usage_kinds: [],
    allow_compaction: false,
    reset_hour: undefined,
    reset_day_of_week: undefined,
    reset_day_of_month: undefined,
    pace_period: undefined,
    pace_action: undefined,
    pace_warn_fractions: undefined,
    warn_action: undefined,
    pace_warn_action: undefined,
  }),
  fields: {
    name: readString,
    period: readEnum(BUDGET_PERIODS),
    cost_usd: readF64,
    warn_fractions: readF64Seq,
    limit_action: readEnum(BUDGET_ACTIONS),
    character: optional(suggests(readString, "characters")),
    provider: optional(suggests(readString, "providers")),
    api_key: optional(readString),
    model: optional(readChatModelName),
    call_type: optional(readString),
    usage_kinds: readStringSeq,
    allow_compaction: readBool,
    reset_hour: optional(readU32),
    reset_day_of_week: optional(readEnum(BUDGET_WEEKDAYS)),
    reset_day_of_month: optional(readU32),
    pace_period: optional(readEnum(BUDGET_PERIODS)),
    pace_action: optional(readEnum(BUDGET_ACTIONS)),
    pace_warn_fractions: optional(readF64Seq),
    warn_action: optional(readEnum(BUDGET_ACTIONS)),
    pace_warn_action: optional(readEnum(BUDGET_ACTIONS)),
  },
};

export const newUsageBudget = (): UsageBudgetConfig => BUDGET.make();

export interface PlanLimitPolicyConfig {
  warn_fractions: number[];
  limit_fraction: number;
  limit_action: UsageBudgetAction;
}

export const defaultPlanLimitPolicy = (): PlanLimitPolicyConfig => ({
  warn_fractions: [0.8, 0.95],
  limit_fraction: 1,
  limit_action: "pause_background",
});

const PLAN_LIMIT_POLICY: StructSpec<PlanLimitPolicyConfig> = {
  name: "PlanLimitPolicyConfig",
  make: defaultPlanLimitPolicy,
  fields: {
    warn_fractions: readF64Seq,
    limit_fraction: readF64,
    limit_action: readEnum(BUDGET_ACTIONS),
  },
};

export interface PlanLimitsConfig {
  five_hour: PlanLimitPolicyConfig;
  seven_day: PlanLimitPolicyConfig;
}

export const defaultPlanLimitsConfig = (): PlanLimitsConfig => ({
  five_hour: defaultPlanLimitPolicy(),
  seven_day: defaultPlanLimitPolicy(),
});

const PLAN_LIMITS: StructSpec<PlanLimitsConfig> = {
  name: "PlanLimitsConfig",
  make: defaultPlanLimitsConfig,
  fields: {
    five_hour: struct(PLAN_LIMIT_POLICY),
    seven_day: struct(PLAN_LIMIT_POLICY),
  },
};

export interface UsageConfig {
  timezone: string;
}

const defaultUsageConfig = (): UsageConfig => ({ timezone: "local" });

const USAGE: StructSpec<UsageConfig> = {
  name: "UsageConfig",
  make: defaultUsageConfig,
  fields: { timezone: readString },
};

export interface SubagentConfig {
  description: string;
  prompt: string;
  tools: string[];
  model: string | undefined;
  max_tool_rounds: number | undefined;
  timeout: ConfigDuration | undefined;
}

const SUBAGENT: StructSpec<SubagentConfig> = {
  name: "SubagentConfig",
  required: ["description", "prompt"],
  make: () => ({
    description: "",
    prompt: "",
    tools: [],
    model: undefined,
    max_tool_rounds: undefined,
    timeout: undefined,
  }),
  fields: {
    description: readString,
    prompt: readString,
    tools: readToolNameSeq,
    model: optional(readChatModelName),
    max_tool_rounds: optional(readU32),
    timeout: optional(readDuration),
  },
};

export interface SubagentsConfig {
  model: string | undefined;
  enabled: string[];
  agents: Map<string, SubagentConfig>;
}

export const defaultSubagentsConfig = (): SubagentsConfig => ({
  model: undefined,
  enabled: [],
  agents: new Map(),
});

const SUBAGENTS: StructSpec<SubagentsConfig> = {
  name: "SubagentsConfig",
  make: defaultSubagentsConfig,
  others: { into: "agents", read: struct(SUBAGENT) },
  fields: {
    model: optional(readChatModelName),
    enabled: readSubagentNameSeq,
  },
};

export interface McpServerConfig {
  command: string | undefined;
  args: string[];
  env: Map<string, string>;
  working_dir: string | undefined;
  user?: string | undefined;
  url: string | undefined;
  headers: Map<string, string>;
  bearer_token_env: string | undefined;
}

const MCP_SERVER: StructSpec<McpServerConfig> = {
  name: "McpServerConfig",
  make: () => ({
    command: undefined,
    args: [],
    env: new Map(),
    working_dir: undefined,
    user: undefined,
    url: undefined,
    headers: new Map(),
    bearer_token_env: undefined,
  }),
  fields: {
    command: optional(readString),
    args: readStringSeq,
    env: readMap(readString),
    working_dir: optional(readString),
    user: optional(readToolsUser),
    url: optional(readString),
    headers: readMap(readString),
    bearer_token_env: optional(readString),
  },
};

export function mcpBearerToken(
  server: Pick<McpServerConfig, "bearer_token_env">,
  env: Record<string, string | undefined>,
): string | undefined {
  const token = server.bearer_token_env === undefined ? undefined : env[server.bearer_token_env];
  return typeof token === "string" && token !== "" ? token : undefined;
}

export const SHORE_PROMPT_PARTS = ["system_prompt", "thread", "thread_pins"] as const;

export type ShorePromptPart = (typeof SHORE_PROMPT_PARTS)[number];

interface PromptPartFields {
  file: string | undefined;
  workspace: string | undefined;
  shore: ShorePromptPart | undefined;
}

export type PromptPart = { file: string } | { workspace: string } | { shore: ShorePromptPart };

const readPromptWorkspacePath: Reader<string> = typed(
  (v) => {
    if (typeof v !== "string") return { err: invalidType(v, "string") };
    const path = promptWorkspacePath(v);
    return path === undefined ? { err: `\`${v}\` is not a path inside the workspace` } : { ok: path };
  },
  { kind: "string" },
);

const PROMPT_PART: StructSpec<PromptPartFields> = {
  name: "PromptPart",
  make: () => ({ file: undefined, workspace: undefined, shore: undefined }),
  fields: {
    file: optional(readString),
    workspace: optional(readPromptWorkspacePath),
    shore: optional(readEnum(SHORE_PROMPT_PARTS)),
  },
};

const readPromptPart: Reader<PromptPart> = typed(
  (v) => {
    const parsed = readStruct(PROMPT_PART, v);
    if ("err" in parsed) return parsed;
    const { file, workspace, shore } = parsed.ok;
    const given = [file, workspace, shore].filter((value) => value !== undefined).length;
    if (given !== 1) return { err: "a prompt part takes exactly one of `file`, `workspace` or `shore`" };
    return { ok: file !== undefined ? { file } : workspace !== undefined ? { workspace } : { shore: required(shore) } };
  },
  { kind: "table", table: () => shapeOf(PROMPT_PART) },
);

export function promptWorkspacePath(raw: string): string | undefined {
  const parts = pathComponents(normalizeWorkspacePath(raw));
  return parts.length === 0 || parts.includes("..") ? undefined : parts.join("/");
}

export function promptWorkspaceFiles(parts: readonly PromptPart[]): string[] {
  return [...new Set(parts.flatMap((part) => "workspace" in part ? [part.workspace] : []))];
}

const readTextOrOff: Reader<TextSetting> = typed(
  (v) => (typeof v === "string" || v === false ? { ok: v } : { err: invalidType(v, "a file path, or false to switch it off") }),
  { kind: "string" },
);

const readNeededText: Reader<TextSetting> = typed(
  (v) => (typeof v === "string" ? { ok: v } : { err: `${invalidType(v, "a file path")}; this text can't be switched off` }),
  { kind: "string" },
);

const readFixedText: Reader<TextSetting> = typed(
  () => ({ err: "this text can't be replaced yet" }),
  { kind: "string" },
);

const TEXTS: StructSpec<Record<string, TextSetting | undefined>> = {
  name: "Texts",
  make: () => ({}),
  fields: Object.fromEntries(TEXT_LIST.map((spec) => [spec.name, spec.fixed ? readFixedText : spec.required ? readNeededText : readTextOrOff])),
};

export interface AppConfig {
  daemon: DaemonConfig;
  chat: ChatConfig;
  prompt: PromptPart[];
  texts: Record<string, TextSetting | undefined>;
  images: ImagesConfig;
  triggers: TriggersConfig;
  marks: MarksConfig;
  compaction: CompactionConfig;
  tools: ToolsConfig;
  subagents: SubagentsConfig;
  budgets: UsageBudgetConfig[];
  plan_limits: PlanLimitsConfig;
  notifications: NotificationsConfig;
  mcp: Map<string, McpServerConfig>;
  matrix: MatrixConfig | undefined;
  usage: UsageConfig;
}

export const defaultAppConfig = (): AppConfig => ({
  daemon: defaultDaemonConfig(),
  chat: defaultChatConfig(),
  prompt: [],
  texts: {},
  images: defaultImagesConfig(),
  triggers: defaultTriggersConfig(),
  marks: defaultMarksConfig(),
  compaction: defaultCompactionConfig(),
  tools: defaultToolsConfig(),
  subagents: defaultSubagentsConfig(),
  budgets: [],
  plan_limits: defaultPlanLimitsConfig(),
  notifications: defaultNotificationsConfig(),
  mcp: new Map(),
  matrix: undefined,
  usage: defaultUsageConfig(),
});

const APP: StructSpec<AppConfig> = {
  name: "AppConfig",
  alsoAccepted: ["providers"],
  make: defaultAppConfig,
  fields: {
    daemon: struct(DAEMON),
    chat: struct(CHAT),
    prompt: readSeq(readPromptPart),
    texts: struct(TEXTS),
    images: struct(IMAGES),
    triggers: struct(TRIGGERS),
    marks: struct(MARKS),
    compaction: struct(COMPACTION),
    tools: struct(TOOLS),
    subagents: struct(SUBAGENTS),
    budgets: readSeq(struct(BUDGET)),
    plan_limits: struct(PLAN_LIMITS),
    notifications: struct(NOTIFICATIONS),
    mcp: readMap(struct(MCP_SERVER)),
    matrix: struct(MATRIX),
    usage: struct(USAGE),
  },
};

export function parseAppConfig(table: TomlValue): ParseResult<AppConfig> {
  return readStruct(APP, table);
}

export function validateAppConfigLayer(table: Table): ParseResult<AppConfig> {
  const complete = structuredClone(table);
  if (isTable(complete.subagents)) for (const value of Object.values(complete.subagents)) {
    if (isTable(value)) { value.description ??= ""; value.prompt ??= ""; }
  }
  return parseAppConfig(complete);
}

export function appConfigShape(): TableShape {
  return shapeOf(APP);
}

export function mapKeysInOrder(map: ReadonlyMap<string, unknown>): string[] {
  return [...map.keys()].sort(compareByCodePoint);
}
