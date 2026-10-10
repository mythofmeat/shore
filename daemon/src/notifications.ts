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

export interface NtfyDelivery extends NtfyConfig {
  token: string;
}

export function ntfyUrl(config: NtfyDelivery): string {
  return `${config.url.replace(/\/+$/, "")}/${config.topic}`;
}

const HTTP_TIMEOUT_MS = 10_000;

const SUMMARY_MAX_BYTES = 200;

export interface NotificationPicture {
  path: string;
  name: string;
}

export interface NotificationSink {
  notifySend(title: string, body: string, picture?: NotificationPicture): Promise<void>;
  ntfy(config: NtfyDelivery, title: string, body: string, picture?: NotificationPicture): Promise<void>;
  command(argv: readonly string[], title: string, body: string): Promise<void>;
}

export function headerText(text: string): string {
  return /^[\x20-\x7E]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;
}

async function ntfyAttachment(config: NtfyDelivery, headers: Record<string, string>, body: string, picture: NotificationPicture): Promise<boolean> {
  try {
    const resp = await fetch(ntfyUrl(config), {
      method: "PUT",
      headers: { ...headers, Message: headerText(body), Filename: headerText(picture.name) },
      body: Bun.file(picture.path),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (resp.ok) return true;
    shoreLog.warn(`shore: ntfy refused the picture (${String(resp.status)}); sending the notification without it`);
  } catch (e) {
    shoreLog.warn(`shore: ntfy could not take the picture; sending the notification without it: ${String(e)}`);
  }
  return false;
}

export const realSink: NotificationSink = {
  async notifySend(title, body, picture) {
    const proc = Bun.spawn(["notify-send", "--app-name=shore", ...(picture === undefined ? [] : [`--icon=${picture.path}`]), title, body], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  },

  async ntfy(config, title, body, picture) {
    if (config.topic === "") throw new Error("ntfy topic is not configured");
    const headers: Record<string, string> = { Title: headerText(title) };
    if (config.token !== "") headers["Authorization"] = `Bearer ${config.token}`;
    if (picture !== undefined && await ntfyAttachment(config, headers, body, picture)) return;
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

  notify(event: NotificationEvent, title: string, body: string, picture?: NotificationPicture): void {
    if (!this.shouldNotify(event)) return;
    const summary = truncateSummary(body, SUMMARY_MAX_BYTES);
    void this.#dispatch(title, summary, picture).catch((e: unknown) => {
      shoreLog.warn(`shore: notification dispatch failed: ${String(e)}`);
    });
  }

  notifyMessageComplete(title: string, body: string, totalMs: number, picture?: NotificationPicture): void {
    if (!this.meetsGenerationThreshold(totalMs)) return;
    this.notify("message_complete", title, body, picture);
  }

  meetsGenerationThreshold(totalMs: number): boolean {
    const thresholdMs = this.#config.generation_threshold.asMillisExact();
    return thresholdMs === 0n || BigInt(totalMs) >= thresholdMs;
  }

  async #dispatch(title: string, body: string, picture: NotificationPicture | undefined): Promise<void> {
    switch (this.#config.backend) {
      case "notify_send":
        return this.#sink.notifySend(title, body, picture);
      case "ntfy":
        return this.#sink.ntfy({
          ...this.#config.ntfy,
          token: this.#config.token_env === undefined ? "" : process.env[this.#config.token_env] ?? "",
        }, title, body, picture);
      case "command":
        return this.#sink.command(this.#config.command, title, body);
    }
  }
}
