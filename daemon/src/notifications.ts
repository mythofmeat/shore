/**
 * Push notifications for autonomous events.
 *
 * Port of `crates/daemon/src/notifications.rs` plus the `[notifications]`
 * subtree of `crates/common/src/config/app.rs`. Three backends: `notify-send`
 * (Linux desktop), ntfy (mobile push), and a user shell command template.
 *
 * Dispatch is fire-and-forget by design — a notification that fails must not
 * disturb the generation that triggered it, so every delivery error is logged
 * and dropped.
 */

import { ConfigDuration, type ParseResult } from "./config/duration.ts";
import { invalidType } from "./config/models.ts";

/** Events that can trigger a push notification. */
export type NotificationEvent =
  | "autonomous_message"
  | "cache_warning"
  | "compaction_complete"
  | "error"
  | "message_complete"
  | "usage_warning";

/** Notification delivery backend. Mirrors Rust `NotificationBackend`. */
export type NotificationBackend = "notify_send" | "ntfy" | "command";

export interface NtfyConfig {
  url: string;
  topic: string;
  token: string;
}

export interface CommandNotifyConfig {
  /** Shell command template. `{title}` and `{body}` are the placeholders. */
  template: string;
}

/**
 * Per-event toggles.
 *
 * The doc comment on the Rust struct says "All default to true (fire when
 * enabled)". Five of the six do. `message_complete` is `#[serde(default)]` on a
 * `bool`, so it defaults to **false** — every ordinary chat reply would
 * otherwise raise a desktop notification. The comment is stale; the defaults
 * below are what the code does.
 */
export interface NotificationEventsConfig {
  autonomous_message: boolean;
  cache_warning: boolean;
  compaction_complete: boolean;
  error: boolean;
  message_complete: boolean;
  usage_warning: boolean;
}

export interface NotificationsConfig {
  enabled: boolean;
  backend: NotificationBackend;
  ntfy: NtfyConfig;
  command: CommandNotifyConfig;
  /** Only fire `message_complete` when generation took longer than this.
   *  Zero means always. */
  generation_threshold: ConfigDuration;
  events: NotificationEventsConfig;
}

export function defaultNtfyConfig(): NtfyConfig {
  return { url: "https://ntfy.sh", topic: "", token: "" };
}

export function defaultNotificationEvents(): NotificationEventsConfig {
  return {
    autonomous_message: true,
    cache_warning: true,
    compaction_complete: true,
    error: true,
    message_complete: false,
    usage_warning: true,
  };
}

export function defaultNotificationsConfig(): NotificationsConfig {
  return {
    enabled: false,
    backend: "notify_send",
    ntfy: defaultNtfyConfig(),
    command: { template: "" },
    generation_threshold: ConfigDuration.fromSecs(0),
    events: defaultNotificationEvents(),
  };
}

// ── Config parsing ──────────────────────────────────────────────────────

const NOTIFICATIONS_KEYS = [
  "enabled",
  "backend",
  "ntfy",
  "command",
  "generation_threshold",
  "events",
] as const;

const NTFY_KEYS = ["url", "topic", "token"] as const;
const COMMAND_KEYS = ["template"] as const;
const EVENT_KEYS: readonly NotificationEvent[] = [
  "autonomous_message",
  "cache_warning",
  "compaction_complete",
  "error",
  "message_complete",
  "usage_warning",
];

const BACKENDS: readonly NotificationBackend[] = ["notify_send", "ntfy", "command"];

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How serde phrases the accepted set for `deny_unknown_fields` and for an
 * unknown enum variant. Shared with `config/providers.ts` in spirit but not in
 * code — that copy is private to its module and the two lists never overlap.
 *
 * That copy also carries a two-field branch (`` `a` or `b` ``), which this one
 * does not: nothing in the `[notifications]` subtree has exactly two fields, so
 * the branch was unreachable and mutation testing could not tell it from its
 * own absence. Add it back alongside the first two-field table.
 */
function expectedList(known: readonly string[]): string {
  if (known.length === 1) return `\`${known[0]}\``;
  const head = known
    .slice(0, -1)
    .map((k) => `\`${k}\``)
    .join(", ");
  return `one of ${head}, \`${known[known.length - 1]}\``;
}

/**
 * The first unknown key, in **document order**.
 *
 * Not code-point order, which is what the model catalog and provider registry
 * use — and the difference is the parse path, not a disagreement. Those two
 * receive a materialized `toml::Table`, which is a `BTreeMap`, so iterating it
 * sorts. This section is deserialized straight off the document by
 * `toml::from_str`, which visits keys as it reads them, so `zzz` before `aaa`
 * reports `zzz`. Pinned both directions in the fixture, because getting it
 * backwards is invisible until a config has two unknown keys.
 */
function unknownField(
  table: Record<string, unknown>,
  known: readonly string[],
): string | undefined {
  for (const key of Object.keys(table)) {
    if (!known.includes(key)) {
      return `unknown field \`${key}\`, expected ${expectedList(known)}`;
    }
  }
  return undefined;
}

function readBoolField(
  table: Record<string, unknown>,
  key: string,
  fallback: boolean,
): ParseResult<boolean> {
  const value = table[key];
  if (value === undefined) return { ok: fallback };
  if (typeof value !== "boolean") return { err: invalidType(value, "a boolean") };
  return { ok: value };
}

function readStringField(
  table: Record<string, unknown>,
  key: string,
  fallback: string,
): ParseResult<string> {
  const value = table[key];
  if (value === undefined) return { ok: fallback };
  if (typeof value !== "string") return { err: invalidType(value, "a string") };
  return { ok: value };
}

function readNtfy(value: unknown): ParseResult<NtfyConfig> {
  if (!isTable(value)) return { err: invalidType(value, "struct NtfyConfig") };
  const unknown = unknownField(value, NTFY_KEYS);
  if (unknown !== undefined) return { err: unknown };

  const out = defaultNtfyConfig();
  for (const key of NTFY_KEYS) {
    const read = readStringField(value, key, out[key]);
    if ("err" in read) return read;
    out[key] = read.ok;
  }
  return { ok: out };
}

function readCommand(value: unknown): ParseResult<CommandNotifyConfig> {
  if (!isTable(value)) return { err: invalidType(value, "struct CommandNotifyConfig") };
  const unknown = unknownField(value, COMMAND_KEYS);
  if (unknown !== undefined) return { err: unknown };

  const template = readStringField(value, "template", "");
  if ("err" in template) return template;
  return { ok: { template: template.ok } };
}

function readEvents(value: unknown): ParseResult<NotificationEventsConfig> {
  if (!isTable(value)) return { err: invalidType(value, "struct NotificationEventsConfig") };
  const unknown = unknownField(value, EVENT_KEYS);
  if (unknown !== undefined) return { err: unknown };

  const out = defaultNotificationEvents();
  for (const key of EVENT_KEYS) {
    const read = readBoolField(value, key, out[key]);
    if ("err" in read) return read;
    out[key] = read.ok;
  }
  return { ok: out };
}

function readBackend(value: unknown): ParseResult<NotificationBackend> {
  // Not serde's `invalid type: …`. A unit-variant enum asks the TOML
  // deserializer for an enum, and `toml` answers a non-string with its own
  // message before serde ever sees the value.
  if (typeof value !== "string") return { err: "wanted string or table" };
  if (!BACKENDS.includes(value as NotificationBackend)) {
    return { err: `unknown variant \`${value}\`, expected ${expectedList(BACKENDS)}` };
  }
  return { ok: value as NotificationBackend };
}

/** Parse the `[notifications]` table. Every field is optional; the struct is
 *  `deny_unknown_fields`, and so is every table under it. */
export function readNotificationsConfig(value: unknown): ParseResult<NotificationsConfig> {
  if (!isTable(value)) return { err: invalidType(value, "struct NotificationsConfig") };
  const unknown = unknownField(value, NOTIFICATIONS_KEYS);
  if (unknown !== undefined) return { err: unknown };

  const out = defaultNotificationsConfig();

  const enabled = readBoolField(value, "enabled", out.enabled);
  if ("err" in enabled) return enabled;
  out.enabled = enabled.ok;

  if (value["backend"] !== undefined) {
    const backend = readBackend(value["backend"]);
    if ("err" in backend) return backend;
    out.backend = backend.ok;
  }

  if (value["ntfy"] !== undefined) {
    const ntfy = readNtfy(value["ntfy"]);
    if ("err" in ntfy) return ntfy;
    out.ntfy = ntfy.ok;
  }

  if (value["command"] !== undefined) {
    const command = readCommand(value["command"]);
    if ("err" in command) return command;
    out.command = command.ok;
  }

  if (value["generation_threshold"] !== undefined) {
    // Not `parse`: the field takes a bare number too, and it means *seconds*.
    const parsed = ConfigDuration.deserialize(value["generation_threshold"]);
    if ("err" in parsed) return parsed;
    out.generation_threshold = parsed.ok;
  }

  if (value["events"] !== undefined) {
    const events = readEvents(value["events"]);
    if ("err" in events) return events;
    out.events = events.ok;
  }

  return { ok: out };
}

// ── Summary truncation ──────────────────────────────────────────────────

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/**
 * Truncate to at most `max` **bytes**, appending an ellipsis when anything was
 * cut. Port of `shore_common::diagnostics::truncate_summary`.
 *
 * `max` counts UTF-8 bytes, not characters and not UTF-16 units: the Rust
 * compares `s.len()`. A body of 100 emoji is 400 bytes and gets cut; a
 * `.length`-based port would have let it through whole. The cut then snaps back
 * to a code-point boundary the way `floor_char_boundary` does, so the last
 * character is dropped rather than split into replacement bytes.
 *
 * Note the ellipsis is appended *past* the cap — the result can be `max + 3`
 * bytes long. That is what the Rust does.
 */
export function truncateSummary(s: string, max: number): string {
  const bytes = ENCODER.encode(s);
  if (bytes.length <= max) return s;
  // Back up over UTF-8 continuation bytes (0b10xxxxxx) to the start of the
  // character straddling the cut. `max < bytes.length` here, so the index is
  // always in range.
  let end = max;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return `${DECODER.decode(bytes.subarray(0, end))}…`;
}

// ── Shell escaping ──────────────────────────────────────────────────────

/**
 * Escape a string for embedding in a single-quoted shell argument.
 *
 * `'` becomes `'\''` (end quote, escaped quote, re-open), backticks are
 * dropped, and `$(` is defanged to `(`.
 *
 * Two things this deliberately does not do, both inherited:
 *
 * * It does **not** wrap the result in quotes, despite the Rust doc comment
 *   saying it does. The `{title}`/`{body}` placeholders are substituted into
 *   the user's own template, and the template supplies the quoting — that is
 *   why the `'` escaping is written for a single-quoted context.
 * * It leaves `;`, `&`, `|`, `>` and newlines alone. Inside the single quotes
 *   the template is expected to provide, none of them are metacharacters, and
 *   the quote escaping is what keeps content from escaping that context. A
 *   template that omits the quotes is a template that runs its own content;
 *   this function is defence in depth, not the boundary.
 *
 * Rust's `str::replace` replaces *every* occurrence. JavaScript's
 * `String.replace` with a string pattern replaces only the first, so all three
 * of these must be `replaceAll` — a single backtick left behind is the whole
 * difference between escaped and not.
 *
 * The backtick pass must precede the `$(` pass: removing a backtick can *create*
 * a `$(` that was not in the input (`` $`( ``). The quote pass is order-free
 * against both — `'\''` contains no backtick and no `$` — so only that one pair
 * is load-bearing, and mutation testing agrees.
 */
export function shellEscape(s: string): string {
  return s.replaceAll("'", "'\\''").replaceAll("`", "").replaceAll("$(", "(");
}

/** Render a command template with the escaped title and body substituted. */
export function renderCommandTemplate(template: string, title: string, body: string): string {
  return template.replaceAll("{title}", shellEscape(title)).replaceAll("{body}", shellEscape(body));
}

/**
 * The ntfy POST URL: the configured base with any trailing slashes removed,
 * then the topic. `trim_end_matches('/')` strips *all* trailing slashes, not
 * just one, so `https://ntfy.sh///` and `https://ntfy.sh` agree.
 */
export function ntfyUrl(config: NtfyConfig): string {
  return `${config.url.replace(/\/+$/, "")}/${config.topic}`;
}

// ── The service ─────────────────────────────────────────────────────────

/** How long a delivery may take before it is abandoned. */
const HTTP_TIMEOUT_MS = 10_000;

/** The body cap `notify` applies. Titles are not truncated. */
export const SUMMARY_MAX_BYTES = 200;

/**
 * One delivery attempt. Injected so tests can observe dispatch without
 * spawning processes or reaching the network; the default hits the real thing.
 */
export interface NotificationSink {
  notifySend(title: string, body: string): Promise<void>;
  ntfy(config: NtfyConfig, title: string, body: string): Promise<void>;
  command(template: string, title: string, body: string): Promise<void>;
}

export const realSink: NotificationSink = {
  async notifySend(title, body) {
    const proc = Bun.spawn(["notify-send", "--app-name=shore", title, body], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  },

  async ntfy(config, title, body) {
    if (config.topic === "") throw new Error("ntfy topic is not configured");
    const headers: Record<string, string> = { Title: title };
    if (config.token !== "") headers["Authorization"] = `Bearer ${config.token}`;
    const resp = await fetch(ntfyUrl(config), {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`ntfy returned ${resp.status}`);
  },

  async command(template, title, body) {
    if (template === "") throw new Error("notification command template is not configured");
    const proc = Bun.spawn(["sh", "-c", renderCommandTemplate(template, title, body)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  },
};

/**
 * Notification dispatcher, shared by the autonomy manager, the generation
 * handler, and compaction.
 */
export class NotificationService {
  readonly #config: NotificationsConfig;
  readonly #sink: NotificationSink;

  constructor(config: NotificationsConfig, sink: NotificationSink = realSink) {
    this.#config = config;
    this.#sink = sink;
  }

  /** Whether this event's toggle is on, ignoring the master switch. */
  isEventEnabled(event: NotificationEvent): boolean {
    return this.#config.events[event];
  }

  /** Whether `notify` would dispatch this event at all. */
  shouldNotify(event: NotificationEvent): boolean {
    return this.#config.enabled && this.isEventEnabled(event);
  }

  /**
   * Fire-and-forget dispatch. Returns immediately; delivery happens on its own
   * and its failures are logged, never raised.
   */
  notify(event: NotificationEvent, title: string, body: string): void {
    if (!this.shouldNotify(event)) return;
    const summary = truncateSummary(body, SUMMARY_MAX_BYTES);
    void this.#dispatch(title, summary).catch((e: unknown) => {
      console.warn(`shore: notification dispatch failed: ${String(e)}`);
    });
  }

  /**
   * Fire a `message_complete` notification, but only when generation took at
   * least as long as the configured threshold. A threshold of zero always
   * notifies — the comparison is skipped rather than trivially true, so a
   * generation that reported `0 ms` still fires.
   */
  notifyMessageComplete(title: string, body: string, totalMs: number): void {
    if (!this.meetsGenerationThreshold(totalMs)) return;
    this.notify("message_complete", title, body);
  }

  /**
   * The threshold half of {@link notifyMessageComplete}, separated so it can be
   * checked without dispatching.
   *
   * The zero test is redundant — `totalMs >= 0n` is already always true — and it
   * is kept because the Rust carries the same redundancy (`threshold_ms > 0 &&
   * total_ms < threshold_ms`), where it reads as the documented "0 means always
   * notify". Mutation testing duly finds it unkillable.
   */
  meetsGenerationThreshold(totalMs: number): boolean {
    const thresholdMs = this.#config.generation_threshold.asMillisExact();
    return thresholdMs === 0n || BigInt(totalMs) >= thresholdMs;
  }

  async #dispatch(title: string, body: string): Promise<void> {
    switch (this.#config.backend) {
      case "notify_send":
        return this.#sink.notifySend(title, body);
      case "ntfy":
        return this.#sink.ntfy(this.#config.ntfy, title, body);
      case "command":
        return this.#sink.command(this.#config.command.template, title, body);
    }
  }
}
