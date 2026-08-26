import { shoreLog } from "./log.ts";

import type { NotificationsConfig, NtfyConfig } from "./config/app.ts";

export type NotificationEvent =
  | "autonomous_message"
  | "cache_warning"
  | "compaction_complete"
  | "error"
  | "message_complete"
  | "usage_warning";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export function truncateSummary(s: string, max: number): string {
  const bytes = ENCODER.encode(s);
  if (bytes.length <= max) return s;
  let end = max;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return `${DECODER.decode(bytes.subarray(0, end))}…`;
}

const PLACEHOLDER = /\{(title|body)\}/g;

export function expandArgv(argv: readonly string[], title: string, body: string): string[] {
  const fill = (arg: string) =>
    arg.replaceAll(PLACEHOLDER, (_, name) => (name === "title" ? title : body));
  return argv.map((arg, i) => (i === 0 ? arg : fill(arg)));
}

export function ntfyUrl(config: NtfyConfig): string {
  return `${config.url.replace(/\/+$/, "")}/${config.topic}`;
}

const HTTP_TIMEOUT_MS = 10_000;

const SUMMARY_MAX_BYTES = 200;

export interface NotificationSink {
  notifySend(title: string, body: string): Promise<void>;
  ntfy(config: NtfyConfig, title: string, body: string): Promise<void>;
  command(argv: readonly string[], title: string, body: string): Promise<void>;
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

  async command(argv, title, body) {
    const exe = argv[0];
    if (exe === undefined) throw new Error("notification command is not configured");
    const proc = Bun.spawn(expandArgv(argv, title, body), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`notification command ${exe} exited ${code}`);
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
      shoreLog.warn(`shore: notification dispatch failed: ${String(e)}`);
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
        return this.#sink.command(this.#config.command, title, body);
    }
  }
}
