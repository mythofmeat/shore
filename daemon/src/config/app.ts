/**
 * `AppConfig` — the whole `config.toml` schema.
 *
 * Port of `crates/common/src/config/app.rs`, which is a serde struct tree and
 * almost nothing else: the behaviour worth porting is the *deserializer's*, not
 * any code the Rust wrote by hand.
 *
 * Field names are TOML keys, so they stay snake_case. That is the point — the
 * schema below can be read straight against `CONFIGURATION.md` and against the
 * Rust struct, and the parse errors quote the same identifiers a user typed.
 *
 * ## The walk order is load-bearing
 *
 * `parse_config_table` reaches `AppConfig` as `toml::Value::Table(t).try_into()`.
 * A `toml::Table` is a `BTreeMap` (the crate is built without `preserve_order`),
 * so serde's derived visitor consumes entries in **code point order**, not
 * document order — see {@link readStruct}. The unit tests in `app.rs` use
 * `toml::from_str`, which walks the document instead, so they cannot see the
 * difference and a port written against them alone would report a different key
 * than the daemon does. `app_parity.json` records every case through both paths
 * for exactly this reason.
 *
 * ## Overlap with the narrow views elsewhere in this tree
 *
 * `ToolsConfigView`, `SubagentConfigView` (`tools/registry.ts`),
 * `McpServerConfigView` (`tools/mcp_registry.ts`), `RetrievalConfig`
 * (`memory/workspace_index.ts`), `UsageConfig` (`ledger/budget.ts`) and
 * `NotificationsConfig` (`notifications.ts`) each read a slice of this schema.
 * They were written narrow on purpose, before there was an `AppConfig` to take
 * a slice *of*. The types here are the end state; those views get deleted as
 * their modules are cut over to a `LoadedConfig`, which is the commit after
 * `parse_config_table`.
 *
 * Do **not** reach for `notifications.ts`'s `readNotificationsConfig` from
 * here. It is correct for its own call path, which receives a document, and it
 * checks unknown fields in a pass before reading values. Arriving at the same
 * section through `AppConfig` means the table path, sorted keys, and serde's
 * interleaving of the two checks.
 */

import { compareByCodePoint, sortedKeys } from "../sort.ts";
import { ConfigDuration, type ParseResult } from "./duration.ts";
import { invalidType } from "./models.ts";

/** A parsed TOML value. */
type TomlValue = unknown;

/** A parsed TOML table. */
type Table = Record<string, TomlValue>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── serde parity primitives ─────────────────────────────────────────────

/**
 * How serde phrases the accepted set of a `deny_unknown_fields` struct or of a
 * unit-variant enum.
 *
 * Two fields get `` `a` or `b` ``; three or more get `one of ...`. A struct
 * with *no* declared fields gets nothing at all — that shape is reachable here
 * (see {@link readFlattenOnly}) and serde omits the clause rather than printing
 * an empty list.
 *
 * `config/providers.ts` and `notifications.ts` each carry a private copy of
 * this. They stay private until their modules take their sections from
 * `AppConfig` instead of parsing their own; merging them now would mean editing
 * two frozen, green ports for no behaviour change.
 */
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

/** Reads one field's value. */
type Reader<T> = (value: TomlValue) => ParseResult<T>;

/**
 * A `deny_unknown_fields` struct: its serde name, its fields in *declaration*
 * order, which of them have no default, and a fresh instance carrying every
 * default.
 */
interface StructSpec<T> {
  name: string;
  /** Insertion order is declaration order, which decides both the `expected
   *  one of ...` list and which missing field is reported first. */
  fields: { [K in keyof T]?: Reader<T[K]> };
  /**
   * Fields serde reports as missing when a **table** omits them.
   *
   * Narrower than {@link StructSpec.noDefault}: serde fills a bare `Option<T>`
   * with `None` on the map path even without `#[serde(default)]`, so only
   * genuinely mandatory fields belong here.
   */
  required?: readonly (keyof T & string)[];
  /**
   * Fields with no `#[serde(default)]` at all, which is what the **sequence**
   * path cares about — there, an `Option<T>` is not filled in for free.
   */
  noDefault?: readonly (keyof T & string)[];
  make: () => T;
}

/**
 * Deserialize a struct the way serde's derived `Visitor` does.
 *
 * The entry walk is sorted, because the source is a `BTreeMap`. Each entry is
 * resolved to a field and its value read **immediately**, before the next entry
 * is looked at — so an unknown key and a badly-typed value race, and whichever
 * sorts first is the one reported. A port that checked every key for
 * unknown-ness first and only then read values would answer differently on
 * `[behavior] zzz_unknown = 1` plus `[behavior.autonomy] enabled = "yes"`:
 * serde descends into `autonomy` (which sorts first) and reports the bad
 * boolean, never reaching `zzz_unknown`.
 *
 * Missing required fields are checked only after the walk, and in declaration
 * order rather than sorted order — a `[subagents.x]` with neither key reports
 * `description`, not whichever of the two sorts first.
 *
 * Sorting that second loop is the one unkillable mutant in this port's
 * mutation pass, and it is a true equivalent rather than a gap: `SubagentConfig`
 * is the only struct with more than one required field, and its two happen to
 * be in sorted order already. The loop stays in declaration order because that
 * is what serde does, not because a case can currently tell.
 */
function readStruct<T extends object>(spec: StructSpec<T>, value: TomlValue): ParseResult<T> {
  if (Array.isArray(value)) return readStructFromSeq(spec, value);
  if (!isTable(value)) return { err: invalidType(value, `struct ${spec.name}`) };

  const known = Object.keys(spec.fields);
  const out = spec.make();
  const seen = new Set<string>();

  for (const key of sortedKeys(value)) {
    const read = (spec.fields as Record<string, Reader<unknown> | undefined>)[key];
    if (read === undefined) return { err: unknownField(key, known) };
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

/**
 * The other half of a derived struct visitor: `visit_seq`, which fills fields
 * **positionally** from a TOML array.
 *
 * `[behavior] autonomy = []` is therefore not an error — it is an
 * `AutonomyConfig` of pure defaults, and `autonomy = [true]` sets `enabled` and
 * defaults the rest. Nobody writes a config this way on purpose; the reason to
 * port it is that a mistyped `= []` must go the same way in both
 * implementations, and here it succeeds rather than failing.
 *
 * When the array runs out, each remaining field is filled from its
 * `#[serde(default)]` — and the first one that has none stops the whole parse,
 * reporting the number of fields filled *so far* rather than the array's
 * length. `advanced = []` says `invalid length 2`, not `0`, because
 * `api_payload_logging` and `cache_forensics` were defaulted before `editor`
 * (a bare `Option`, which does not count as defaulted here) ran out.
 *
 * Elements past the last field are an error — on this path. Reading the same
 * document with `toml::from_str` ignores them, which is one of only two places
 * the two paths reach different *outcomes* rather than different messages.
 */
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

/**
 * A struct whose only member is `#[serde(flatten)] extra: BTreeMap<..>`, under
 * `#[serde(deny_unknown_fields)]` — `[connections.telegram]` and
 * `[connections.discord]`.
 *
 * The two attributes do not compose: serde documents `flatten` as unsupported
 * alongside `deny_unknown_fields`, and what the combination actually produces
 * is a struct that accepts **nothing**. `extra` never receives a key, and any
 * key at all is rejected as unknown — with no `expected` clause, because there
 * are no declared fields to list.
 *
 * So `[connections.telegram] bot_token = "..."` is a hard config-load failure
 * today, not the "reserved for future use" the Rust's doc comment claims. That
 * is ported as-is rather than fixed: nothing reads `connections`, so the only
 * observable behaviour is the rejection, and quietly starting to accept keys
 * here would be a change to what configs load rather than a port of one.
 */
function readFlattenOnly(name: string, value: TomlValue): ParseResult<Map<string, TomlValue>> {
  if (!isTable(value)) return { err: invalidType(value, `struct ${name}`) };
  for (const key of sortedKeys(value)) return { err: unknownField(key, []) };
  return { ok: new Map() };
}

const readBool: Reader<boolean> = (v) =>
  typeof v === "boolean" ? { ok: v } : { err: invalidType(v, "a boolean") };

const readString: Reader<string> = (v) =>
  typeof v === "string" ? { ok: v } : { err: invalidType(v, "a string") };

/**
 * An unsigned integer field.
 *
 * Only `u32` gets a ceiling. `usize` and `u64` are 64-bit, and a TOML integer
 * tops out at `i64::MAX`, so no config can overflow either — and imposing
 * `Number.MAX_SAFE_INTEGER` as a stand-in would reject `max_image_size =
 * 9007199254740993`, which the daemon accepts.
 *
 * A TOML *float* is rejected even when it has no fractional part — `20000.0` is
 * not a `usize` to serde. This port cannot reproduce that: `Bun.TOML.parse`
 * yields the JavaScript number `20000` for both spellings, and nothing in the
 * parsed value distinguishes them. The fixture records the Rust's answer for
 * `20000.0` and `1e3` so the gap is written down; the replay asserts what this
 * code actually does.
 */
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

/** `f64`. A TOML integer widens, which is why `cost_usd = 10` is accepted. */
const readF64: Reader<number> = (v) =>
  typeof v === "number" ? { ok: v } : { err: invalidType(v, "f64") };

/** `PathBuf`, whose serde expecting-string differs from a plain `String`'s. */
const readPath: Reader<string> = (v) =>
  typeof v === "string" ? { ok: v } : { err: invalidType(v, "path string") };

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

/**
 * A `BTreeMap<String, V>`, kept as a `Map` in code point order.
 *
 * The order is not decoration. `subagents` and `mcp` decide the order tools are
 * offered to the model, which is the head of the Anthropic cache key; a
 * `Record` would leave it at whatever order the TOML document happened to use.
 */
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

/**
 * A unit-variant enum.
 *
 * A non-string never reaches the variant check: the deserializer is asked for
 * an enum, sees a scalar, and answers first — and *which* answer depends on the
 * path. `toml::Value`'s deserializer, which is the one production goes through,
 * says `invalid type: unit variant, expected string only`. Reading the same
 * document with `toml::from_str` gets `wanted string or table` instead, which
 * is the message `notifications.ts` carries and is correct for its own path.
 */
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

/** `Option<T>`: TOML has no null, so a present key always carries a value. */
function optional<T>(inner: Reader<T>): Reader<T | undefined> {
  return inner as Reader<T | undefined>;
}

// ── [daemon] ────────────────────────────────────────────────────────────

/**
 * One key, deliberately.
 *
 * `unsafe_allow_remote_access` and `allowed_hosts` both lived here until every
 * client had to present a token (`config/token.ts`). They were two ways to
 * answer a question that no longer gets asked: where the daemon is bound does
 * not decide who may talk to it.
 */
export interface DaemonConfig {
  addr: string;
}

export const defaultDaemonConfig = (): DaemonConfig => ({
  addr: "127.0.0.1:7320",
});

const DAEMON: StructSpec<DaemonConfig> = {
  name: "DaemonConfig",
  make: defaultDaemonConfig,
  fields: {
    addr: readString,
  },
};

// ── [defaults] ──────────────────────────────────────────────────────────

export interface BackgroundDefaultsConfig {
  model: string | undefined;
  heartbeat: string | undefined;
  compaction: string | undefined;
}

export const defaultBackgroundDefaults = (): BackgroundDefaultsConfig => ({
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
  /** **Deprecated** shorthand for `background.heartbeat`; see
   *  {@link normalizeDeprecatedAliases}. */
  heartbeat: string | undefined;
  embedding: string | undefined;
  image_generation: string | undefined;
  subagent_model: string | undefined;
  display_name: string | undefined;
  stream: boolean;
}

export const defaultDefaultsConfig = (): DefaultsConfig => ({
  model: undefined,
  background: defaultBackgroundDefaults(),
  heartbeat: undefined,
  embedding: undefined,
  image_generation: undefined,
  subagent_model: undefined,
  display_name: undefined,
  stream: true,
});

const DEFAULTS: StructSpec<DefaultsConfig> = {
  name: "DefaultsConfig",
  // `heartbeat` is absent: it is the one `Option` here carrying an explicit
  // `#[serde(default)]`, being the deprecated alias.
  noDefault: ["model", "embedding", "image_generation", "subagent_model", "display_name"],
  make: defaultDefaultsConfig,
  fields: {
    model: optional(readString),
    background: (v) => readStruct(BACKGROUND, v),
    heartbeat: optional(readString),
    embedding: optional(readString),
    image_generation: optional(readString),
    subagent_model: optional(readString),
    display_name: optional(readString),
    stream: readBool,
  },
};

/** Which background task a model is being resolved for. */
export type BackgroundTask = "heartbeat" | "compaction";

/**
 * The *explicitly configured* background model name: `background.<task>`, then
 * `background.model`.
 *
 * `undefined` does not mean "no model" — it means no background-specific one,
 * and the caller falls through to the character's active chat model, then
 * `defaults.model`, then the first chat model in the catalog. Those rungs need
 * per-character runtime state this config does not see, which is why they live
 * in the per-task resolvers instead. In particular `defaults.model` is **not**
 * consulted here: it is the chat default, and a character that has switched
 * models should have its background work follow.
 */
export function resolveBackgroundModelName(
  defaults: DefaultsConfig,
  task: BackgroundTask,
): string | undefined {
  return defaults.background[task] ?? defaults.background.model;
}

/** The user's display name: config, then `$USER`, then `"User"`. */
export function resolveDisplayName(
  defaults: DefaultsConfig,
  env: Record<string, string | undefined> = process.env,
): string {
  return defaults.display_name ?? env["USER"] ?? "User";
}

/**
 * Migrate the legacy top-level `defaults.heartbeat` into
 * `defaults.background.heartbeat`, in place.
 *
 * The new key wins; the old one is cleared either way, which is what makes this
 * idempotent. Warnings go to stderr rather than `tracing`, matching the rest of
 * the sidecar.
 */
export function normalizeDeprecatedAliases(defaults: DefaultsConfig): void {
  const value = defaults.heartbeat;
  if (value === undefined) return;
  defaults.heartbeat = undefined;

  if (defaults.background.heartbeat === undefined) {
    console.warn(
      `\`defaults.heartbeat = ${JSON.stringify(value)}\` is deprecated; ` +
        "move it under `[defaults.background]` as `heartbeat`.",
    );
    defaults.background.heartbeat = value;
  } else {
    console.warn(
      "`defaults.heartbeat` is deprecated and was ignored " +
        "because `defaults.background.heartbeat` is already set.",
    );
  }
}

// ── [behavior] ──────────────────────────────────────────────────────────

/** Time markers injected ahead of user messages during prompt assembly. */
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

export const defaultHeartbeatConfig = (): HeartbeatConfig => ({
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
  /** Longest gap after real activity that the cache keepalive keeps pinging
   *  for. Independent of the per-model cadence. */
  cache_keepalive_max: ConfigDuration;
}

export const defaultAutonomyConfig = (): AutonomyConfig => ({
  enabled: false,
  heartbeat: defaultHeartbeatConfig(),
  cache_keepalive_max: ConfigDuration.fromSecs(43_200),
});

const AUTONOMY: StructSpec<AutonomyConfig> = {
  name: "AutonomyConfig",
  make: defaultAutonomyConfig,
  fields: {
    enabled: readBool,
    heartbeat: (v) => readStruct(HEARTBEAT, v),
    cache_keepalive_max: readDuration,
  },
};

export interface BehaviorConfig {
  autonomy: AutonomyConfig;
  user_message_timestamps: UserTimestampMode;
}

export const defaultBehaviorConfig = (): BehaviorConfig => ({
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

// ── [tools] ─────────────────────────────────────────────────────────────

export interface SearchConfig {
  api_key_env: string;
  result_limit: number;
  search_depth: string;
  include_answer: boolean;
}

export const defaultSearchConfig = (): SearchConfig => ({
  api_key_env: "TAVILY_API_KEY",
  result_limit: 5,
  search_depth: "basic",
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

/** Per-tool override table `[tools.config.<name>]`. */
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
  max_result_chars: 20_000,
  // Long enough that no tool reaches it by working, short enough that a wedged
  // one does not hold the turn open for the rest of the day.
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

/**
 * Whether allowlist `pattern` matches tool `name`.
 *
 * A trailing `*` is a prefix glob (`mcp__hue__*` matches `mcp__hue__set`); any
 * other pattern is an exact match, so a `*` in the middle is a literal
 * asterisk. Fail-closed on purpose: a tool an MCP server adds later is not
 * granted until a pattern covers it.
 */
export function toolPatternMatches(pattern: string, name: string): boolean {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : pattern === name;
}

/** Whether `name` is allowed by the enabled-tools allowlist. */
export function toolEnabled(tools: ToolsConfig, name: string): boolean {
  return tools.enabled_tools.some((p) => toolPatternMatches(p, name));
}

/** Whether sub-agent `name`'s `ask_<name>` tool is exposed. Exact match only —
 *  the sub-agent allowlist takes no globs. */
export function subagentEnabled(tools: ToolsConfig, name: string): boolean {
  return tools.enabled_subagents.includes(name);
}

/** Whether any tool or sub-agent is offered, i.e. tool use is active. */
export function anyToolEnabled(tools: ToolsConfig): boolean {
  return tools.enabled_tools.length > 0 || tools.enabled_subagents.length > 0;
}

/** Effective per-tool result cap: the tool's override, else the global. */
export function resultCharsFor(tools: ToolsConfig, name: string): number {
  return tools.config.get(name)?.max_result_chars ?? tools.max_result_chars;
}

/**
 * Effective per-tool deadline, or `undefined` for "runs until it returns".
 *
 * Zero is the escape hatch at both levels: a global `timeout = 0` removes the
 * deadline from every tool that does not set its own, and a per-tool `0`
 * removes it from that one tool while the global still applies to the rest.
 */
export function timeoutFor(tools: ToolsConfig, name: string): ConfigDuration | undefined {
  const resolved = tools.config.get(name)?.timeout ?? tools.timeout;
  return resolved.asMillisExact() > 0n ? resolved : undefined;
}

// ── [memory] ────────────────────────────────────────────────────────────

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
  idle_trigger: ConfigDuration.fromSecs(1800),
  archive_after: ConfigDuration.fromSecs(0),
  min_turns: 8,
  max_turns: 16,
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

/**
 * Reject an idle threshold that is not a whole number of seconds.
 *
 * Compaction truncates both sides to seconds before comparing, so an
 * `idle_trigger` of `1.5s` does not wait 1.5s — it fires at 1.2s of idleness.
 * Rather than let a value mean something other than what it says, the range
 * where the truncation is observable stops being representable. Nothing is
 * lost: these are minutes-to-hours thresholds typed into `config.toml`, and
 * they mean nothing at millisecond resolution. Zero stays valid — it is how
 * these fields spell "off".
 */
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

/**
 * The invariants that make compaction meaningful, as an error message or
 * `undefined`.
 *
 * Both turn thresholds must exceed `keep_recent_turns` — otherwise a pass would
 * have nothing to compact — and `max_turns` must not undercut `min_turns`.
 * Config load treats a violation as a hard error so the daemon refuses to start
 * (and a reload keeps the previous config) rather than silently disabling
 * compaction, and with it the deep-idle archive. A disabled config is always
 * valid.
 */
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

/**
 * Whether to replay prior turns' extended-thinking blocks.
 *
 * **`all` is the right answer nearly everywhere, and `none` is a compatibility
 * escape hatch — not a cost knob.** The name reads like it saves tokens. It
 * does not, on any provider Shore ships against:
 *
 * - Anthropic keeps prior-turn thinking in context by default on the models
 *   Shore runs, bills input only for the blocks actually shown to Claude, and
 *   documents no intelligence cost for preserving them. Stripping client-side
 *   removes blocks the API would have filtered for free.
 * - Gemini and Kimi K2.5+/K3 require the replay; Z.AI and OpenRouter carry it
 *   in a provider-specific envelope the adapter replays from.
 * - Native DeepSeek discards inbound reasoning server-side, so the setting is
 *   inert there either way (measured 2026-08-08; see `llm/replay.ts`).
 *
 * The one real use is a generic OpenAI-compatible backend that **rejects**
 * inbound `reasoning_content` with an API error. Set `none` for that model to
 * make the request go through.
 *
 * Both modes are prompt-cache-safe: a given history always projects to the same
 * bytes, so neither rewrites something already sent.
 *
 * ## Why there is no context-reclaiming mode here
 *
 * Anthropic's supported way to reclaim context from thinking is the server-side
 * `clear_thinking_20251015` context-editing strategy, not client-side
 * stripping. It is tunable (`keep: {type: "thinking_turns", value: N}`) where
 * this setting is binary, and it reports what it cleared instead of leaving the
 * cost inferred. Shore does not implement it, deliberately: it invalidates the
 * cache at the point where clearing occurs, which is the same trade this
 * setting makes, only stated out loud — and Shore already has a compaction
 * system that owns context pressure. Revisit if compaction starts firing
 * earlier than it should because thinking is what filled the window.
 */
export type ThinkingReplay = "all" | "none";

/**
 * Parse the wire form, tolerating the legacy stringy bools.
 *
 * `last_turn` is a retired third mode that kept only the most-recent assistant
 * turn's thinking. It still maps to `all` rather than being rejected, because
 * rejecting it would stop the daemon starting on any config that still carries
 * it. It was removed because it is the only mode that rewrites already-sent
 * bytes: deleting the trailing turn's thinking one turn later invalidates every
 * cache breakpoint at or past that turn, so each request re-wrote an exchange
 * that `all` reads for free.
 *
 * Case-sensitive — `"All"` is not a variant.
 */
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

export const defaultThinkingConfig = (): ThinkingConfig => ({
  replay_prior_thinking: "all",
});

/**
 * `replay_prior_thinking` accepts the legacy bool as well as the string, via an
 * untagged `enum BoolOrStr` — hence the error text on anything that is neither,
 * which names a type the config file never mentions.
 */
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

export type RetrievalMode = "auto" | "lexical" | "hybrid";
export type RetrievalBinaryMode = "skip" | "metadata" | "try_embed";

const RETRIEVAL_MODES: readonly RetrievalMode[] = ["auto", "lexical", "hybrid"];
const BINARY_MODES: readonly RetrievalBinaryMode[] = ["skip", "metadata", "try_embed"];

export interface RetrievalConfig {
  mode: RetrievalMode;
  max_file_bytes: number;
  max_indexed_files: number;
  max_total_indexed_bytes: number;
  max_embed_chars_per_file: number;
  binary: RetrievalBinaryMode;
}

export const defaultRetrievalConfig = (): RetrievalConfig => ({
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
  /** Push the character's workspace repo after a successful compaction. A repo
   *  with no remote is skipped silently; a failed push never fails the pass. */
  git_push: boolean;
}

export const defaultMemoryConfig = (): MemoryConfig => ({
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

// ── [connections] ───────────────────────────────────────────────────────

/**
 * Reserved for future use — and, today, unable to hold anything.
 *
 * This is the flattened `extra` map itself, not a struct wrapping it, because
 * that is what serde flattening produces on the wire: `[connections.telegram]`
 * serializes as `{}`, with no `extra` key in sight. It is always empty; see
 * {@link readFlattenOnly}.
 */
export type ReservedConnectionConfig = Map<string, TomlValue>;

export interface ConnectionsConfig {
  telegram: ReservedConnectionConfig | undefined;
  discord: ReservedConnectionConfig | undefined;
}

export const defaultConnectionsConfig = (): ConnectionsConfig => ({
  telegram: undefined,
  discord: undefined,
});

const CONNECTIONS: StructSpec<ConnectionsConfig> = {
  name: "ConnectionsConfig",
  make: defaultConnectionsConfig,
  fields: {
    telegram: (v) => readFlattenOnly("TelegramConfig", v),
    discord: (v) => readFlattenOnly("DiscordConfig", v),
  },
};

// ── [notifications] ─────────────────────────────────────────────────────

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

export const defaultNtfyConfig = (): NtfyConfig => ({
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
  /** Shell command template; `{title}` and `{body}` are the placeholders. */
  template: string;
}

const COMMAND_NOTIFY: StructSpec<CommandNotifyConfig> = {
  name: "CommandNotifyConfig",
  make: () => ({ template: "" }),
  fields: { template: readString },
};

/**
 * Per-event toggles.
 *
 * The Rust's doc comment says "All default to true (fire when enabled)". Five
 * of the six do. `message_complete` is a plain `#[serde(default)]` bool and so
 * defaults to **false** — every ordinary chat reply would otherwise raise a
 * desktop notification. The comment is stale; the defaults here are what the
 * code does.
 */
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
  cache_warning: true,
  compaction_complete: true,
  error: true,
  message_complete: false,
  usage_warning: true,
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
  /** Only fire `message_complete` when generation took longer than this. Zero
   *  means always. */
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

// ── [usage] ─────────────────────────────────────────────────────────────

export type UsageBudgetPeriod = "hour" | "day" | "week" | "month";
/** See `ledger/budget.ts` for why `pause_heartbeat` is not `pause_background`
 *  with a shorter list. */
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

/**
 * Relative length, ascending — used to check that a budget's pace period is
 * strictly shorter than the period it subdivides.
 *
 * An ordering over nominal length, not a conversion factor: a month is not a
 * fixed number of weeks, which is why pace division uses the real window bounds
 * rather than a ratio of these ranks.
 */
export function budgetPeriodRank(period: UsageBudgetPeriod): number {
  return BUDGET_PERIODS.indexOf(period);
}

/** 0 = Monday .. 6 = Sunday, matching chrono's `num_days_from_monday`. */
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
  /** Sub-window used to pace spend inside `period`; must be strictly shorter.
   *  Stepped from the budget's own window start, so `reset_hour` anchors both
   *  and the sub-windows tile the period exactly. */
  pace_period: UsageBudgetPeriod | undefined;
  pace_action: UsageBudgetAction | undefined;
  pace_warn_at: number[] | undefined;
  /**
   * Appended rather than filed next to `warn_at`, and `pace_warn_action` after
   * it, because this struct also deserializes from a positional array — a key
   * inserted mid-list would silently re-map every field after it for anyone
   * writing `budgets = [[...]]`. New keys go on the end.
   *
   * What crossing a `warn_at` threshold does, beyond the warning itself. Unset
   * means it does nothing, which is what it always did.
   */
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
    // Overwritten by the walk or reported missing; never observed.
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

/** Effective pace enforcement action; `warn` unless overridden — exceeding a
 *  single sub-window is expected, and the budget's own `limit` is the real cap. */
export function budgetPaceAction(budget: UsageBudgetConfig): UsageBudgetAction {
  return budget.pace_action ?? "warn";
}

/** Effective pace warning thresholds, falling back to the budget's own. An
 *  explicit empty list is an override, not an absence. */
export function budgetPaceWarnAt(budget: UsageBudgetConfig): readonly number[] {
  return budget.pace_warn_at ?? budget.warn_at;
}

export interface UsageSpikeWarningsConfig {
  enabled: boolean;
  period: UsageBudgetPeriod;
  multiplier: number;
  min_cost_usd: number;
}

export const defaultSpikeWarnings = (): UsageSpikeWarningsConfig => ({
  enabled: false,
  period: "hour",
  multiplier: 3.0,
  min_cost_usd: 1.0,
});

const SPIKE_WARNINGS: StructSpec<UsageSpikeWarningsConfig> = {
  name: "UsageSpikeWarningsConfig",
  make: defaultSpikeWarnings,
  fields: {
    enabled: readBool,
    period: readEnum(BUDGET_PERIODS),
    multiplier: readF64,
    min_cost_usd: readF64,
  },
};

export interface UsageConfig {
  /** Calendar timezone for named windows. `local` or `utc`. */
  timezone: string;
  /** Compaction can reduce future prompt size, so it is allowed to run over a
   *  blocking budget by default. */
  allow_compaction_over_budget: boolean;
  budgets: UsageBudgetConfig[];
  spike_warnings: UsageSpikeWarningsConfig;
}

export const defaultUsageConfig = (): UsageConfig => ({
  timezone: "local",
  allow_compaction_over_budget: true,
  budgets: [],
  spike_warnings: defaultSpikeWarnings(),
});

const USAGE: StructSpec<UsageConfig> = {
  name: "UsageConfig",
  make: defaultUsageConfig,
  fields: {
    timezone: readString,
    allow_compaction_over_budget: readBool,
    budgets: readSeq((v) => readStruct(BUDGET, v)),
    spike_warnings: (v) => readStruct(SPIKE_WARNINGS, v),
  },
};

// ── [advanced] ──────────────────────────────────────────────────────────

export interface LlmSidecarConfig {
  enabled: boolean;
  /** Unix socket path; `<runtime_dir>/llm.sock` when unset. */
  socket_path: string | undefined;
}

export const defaultLlmSidecarConfig = (): LlmSidecarConfig => ({
  enabled: true,
  socket_path: undefined,
});

const LLM_SIDECAR: StructSpec<LlmSidecarConfig> = {
  name: "LlmSidecarConfig",
  noDefault: ["socket_path"],
  make: defaultLlmSidecarConfig,
  fields: { enabled: readBool, socket_path: optional(readPath) },
};

export interface AdvancedConfig {
  /** Deprecated and ignored. Per-call payload capture is always on; the key is
   *  still accepted so older configs keep loading. */
  api_payload_logging: boolean;
  cache_forensics: boolean;
  editor: string | undefined;
  max_retries: number | undefined;
  retry_backoff: ConfigDuration | undefined;
  /** Images above this size are scaled down and re-encoded as JPEG. 0 disables
   *  resizing. */
  max_image_size: number;
  llm_sidecar: LlmSidecarConfig;
}

export const defaultAdvancedConfig = (): AdvancedConfig => ({
  api_payload_logging: false,
  cache_forensics: false,
  editor: undefined,
  max_retries: undefined,
  retry_backoff: undefined,
  max_image_size: 2_000_000,
  llm_sidecar: defaultLlmSidecarConfig(),
});

const ADVANCED: StructSpec<AdvancedConfig> = {
  name: "AdvancedConfig",
  noDefault: ["editor", "max_retries", "retry_backoff"],
  make: defaultAdvancedConfig,
  fields: {
    api_payload_logging: readBool,
    cache_forensics: readBool,
    editor: optional(readString),
    max_retries: optional(readU32),
    retry_backoff: optional(readDuration),
    max_image_size: readU64,
    llm_sidecar: (v) => readStruct(LLM_SIDECAR, v),
  },
};

// ── [subagents.<name>] and [mcp.<name>] ─────────────────────────────────

/**
 * One delegated sub-agent, surfaced as an `ask_<name>(query)` tool.
 *
 * Running it spins up a nested tool loop on `model` over the listed `tools` and
 * returns the agent's final text. `ask_*` tools are never offered to a
 * sub-agent, so nesting is hard-capped at one level.
 */
export interface SubagentConfig {
  description: string;
  prompt: string;
  tools: string[];
  /** Falls back to `defaults.subagent_model`, then `defaults.model`. Keep it
   *  cheap — cost reduction is the point. */
  model: string | undefined;
  /** `undefined` uses the resolved model's own cap. */
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

/**
 * One MCP server the daemon connects to as a client — an external process
 * (stdio) or remote endpoint (HTTP), never daemon code.
 *
 * Exactly one transport should be set, `command` or `url`. That is not enforced
 * here: `validate_mcp_servers` checks it at load time, so the schema stays a
 * schema.
 */
export interface McpServerConfig {
  command: string | undefined;
  args: string[];
  /** The natural home for per-server secrets, since the server reads them from
   *  its environment. */
  env: Map<string, string>;
  /** Working directory for a stdio server; inherits the daemon's cwd when
   *  unset. Ignored by HTTP servers. */
  cwd: string | undefined;
  url: string | undefined;
  /**
   * Extra HTTP request headers, sent on every request to an HTTP server.
   * Ignored by stdio servers, which `validate_mcp_servers` rejects rather than
   * silently dropping.
   *
   * This is where a bearer token goes, and it is the reason the key exists:
   * an HTTP server is reachable by anything that can reach its port, so most
   * of them gate `/mcp` behind one. `env` cannot carry it — that configures
   * the *child process* shore spawns, and an HTTP server has none.
   *
   * Values are literal, like `env`'s, rather than naming environment
   * variables the way `api_key_env` does. Both sit in the same config
   * directory with the same exposure, so the indirection would buy nothing.
   *
   * Appended rather than filed next to `url`: `McpServerConfig` also
   * deserializes positionally, and a key inserted mid-list silently re-maps
   * every field after it.
   */
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

// ── AppConfig ───────────────────────────────────────────────────────────

export interface AppConfig {
  daemon: DaemonConfig;
  defaults: DefaultsConfig;
  behavior: BehaviorConfig;
  tools: ToolsConfig;
  memory: MemoryConfig;
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
    connections: (v) => readStruct(CONNECTIONS, v),
    notifications: (v) => readStruct(NOTIFICATIONS, v),
    usage: (v) => readStruct(USAGE, v),
    advanced: (v) => readStruct(ADVANCED, v),
    subagents: readMap((v) => readStruct(SUBAGENT, v)),
    mcp: readMap((v) => readStruct(MCP_SERVER, v)),
  },
};

/**
 * Deserialize a merged raw TOML table into an `AppConfig`.
 *
 * The table is the one `loadRawConfigTable` produces, minus the sections
 * `parse_config_table` removes first (`chat`, `embedding`, `image_generation`,
 * `providers`) — this function rejects those as unknown fields, exactly as the
 * Rust would if they were left in.
 */
export function parseAppConfig(table: TomlValue): ParseResult<AppConfig> {
  return readStruct(APP, table);
}

/** Keys of a `Map` in the code point order a Rust `BTreeMap` yields. */
export function mapKeysInOrder(map: ReadonlyMap<string, unknown>): string[] {
  return [...map.keys()].sort(compareByCodePoint);
}
