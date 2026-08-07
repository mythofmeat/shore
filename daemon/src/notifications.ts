import { ConfigDuration, type ParseResult } from "./config/duration.ts";
import { invalidType } from "./config/models.ts";

export type NotificationEvent =
  | "autonomous_message"
  | "cache_warning"
  | "compaction_complete"
  | "error"
  | "message_complete"
  | "usage_warning";

export type NotificationBackend = "notify_send" | "ntfy" | "command";

export interface NtfyConfig {
  url: string;
  topic: string;
  token: string;
}

export interface CommandNotifyConfig {
  template: string;
}

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

function expectedList(known: readonly string[]): string {
  if (known.length === 1) return `\`${known[0]}\``;
  const head = known
    .slice(0, -1)
    .map((k) => `\`${k}\``)
    .join(", ");
  return `one of ${head}, \`${known[known.length - 1]}\``;
}

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
  if (typeof value !== "string") return { err: "wanted string or table" };
  if (!BACKENDS.includes(value as NotificationBackend)) {
    return { err: `unknown variant \`${value}\`, expected ${expectedList(BACKENDS)}` };
  }
  return { ok: value as NotificationBackend };
}

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

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export function truncateSummary(s: string, max: number): string {
  const bytes = ENCODER.encode(s);
  if (bytes.length <= max) return s;
  let end = max;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return `${DECODER.decode(bytes.subarray(0, end))}…`;
}

export function shellEscape(s: string): string {
  return s.replaceAll("'", "'\\''").replaceAll("`", "").replaceAll("$(", "(");
}

export function renderCommandTemplate(template: string, title: string, body: string): string {
  return template.replaceAll("{title}", shellEscape(title)).replaceAll("{body}", shellEscape(body));
}

export function ntfyUrl(config: NtfyConfig): string {
  return `${config.url.replace(/\/+$/, "")}/${config.topic}`;
}

const HTTP_TIMEOUT_MS = 10_000;

export const SUMMARY_MAX_BYTES = 200;

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

export class NotificationService {
  readonly #config: NotificationsConfig;
  readonly #sink: NotificationSink;

  constructor(config: NotificationsConfig, sink: NotificationSink = realSink) {
    this.#config = config;
    this.#sink = sink;
  }

  isEventEnabled(event: NotificationEvent): boolean {
    return this.#config.events[event];
  }

  shouldNotify(event: NotificationEvent): boolean {
    return this.#config.enabled && this.isEventEnabled(event);
  }

  notify(event: NotificationEvent, title: string, body: string): void {
    if (!this.shouldNotify(event)) return;
    const summary = truncateSummary(body, SUMMARY_MAX_BYTES);
    void this.#dispatch(title, summary).catch((e: unknown) => {
      console.warn(`shore: notification dispatch failed: ${String(e)}`);
    });
  }

  notifyMessageComplete(title: string, body: string, totalMs: number): void {
    if (!this.meetsGenerationThreshold(totalMs)) return;
    this.notify("message_complete", title, body);
  }

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
