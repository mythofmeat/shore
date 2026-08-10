import { CacheKeepalive, type KeepaliveSnapshot } from "./schedule.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import { recordGenerate, recordGenerateError } from "../ledger/record.ts";
import type { GenerateResponse, SidecarRequest, Usage, WireMessage } from "../llm/types.ts";

const KEEPALIVE_TICK_MS = 10_000;

export const DEFAULT_KEEPALIVE_MAX_SECS = 12 * 60 * 60;
const DEFAULT_MAX_IDLE_SECS = DEFAULT_KEEPALIVE_MAX_SECS;

export interface KeepalivePrefix extends SidecarRequest {
  keepalive_interval_ms?: number;
}

export interface KeepaliveEvent {
  character: string;
  outcome: "sent" | "cold" | "failed" | "skipped";
  detail: string;
  at: number;
}

export type KeepaliveEventSink = (event: KeepaliveEvent) => void;

export interface KeepaliveSchedule extends KeepaliveSnapshot {
  character: string;
}

export interface KeepaliveRestore extends KeepaliveSnapshot {
  character: string;
  max_idle_secs: number;
}

export interface KeepaliveDrain {
  events: KeepaliveEvent[];
  schedules: KeepaliveSchedule[];
}

export interface PingNowOutcome {
  status: "sent" | "skipped" | "failed";
  cold: boolean;
  usage?: Usage;
  reason?: "no_prefix" | "budget";
  detail?: string;
}

export type PingSender = (
  req: SidecarRequest,
  signal?: AbortSignal,
) => Promise<GenerateResponse>;

interface Entry {
  keepalive: CacheKeepalive;
  maxIdleSecs: number;
  prefix: KeepalivePrefix | undefined;
  inFlight: boolean;
}

export function pingLandedCold(usage: {
  cache_read_tokens: number;
  cache_creation_tokens: number;
}): boolean {
  return usage.cache_read_tokens === 0 && usage.cache_creation_tokens > 0;
}

export interface KeepaliveCallLabels {
  ledgerPath?: string;
  maxIdleSecs?: number;
}

export interface KeepaliveServiceOptions {
  ledgerPath?: string;
  maxIdleSecs?: () => number;
}

export function buildKeepalivePing(
  prefix: KeepalivePrefix,
  labels: KeepaliveCallLabels = {},
): SidecarRequest {
  const trailingUserTurn: WireMessage = {
    role: "user",
    content: [{ type: "text", text: "." }],
  };
  const { keepalive_interval_ms: _cadence, context, ...request } = prefix;
  const ping: SidecarRequest = {
    ...request,
    max_tokens: 1,
    messages: [...prefix.messages, trailingUserTurn],
  };
  if (context !== undefined) {
    const { rid: _stale, ...carried } = context;
    ping.context = {
      ...carried,
      call_type: "keepalive",
      ...(labels.ledgerPath === undefined ? {} : { ledger: labels.ledgerPath }),
      ...(labels.maxIdleSecs === undefined ? {} : { keepalive_max_secs: labels.maxIdleSecs }),
    };
  }
  return ping;
}

export class KeepaliveService {
  readonly #entries = new Map<string, Entry>();
  readonly #send: PingSender;
  readonly #now: () => number;
  readonly #ledgerPath: string | undefined;
  readonly #configuredMaxIdleSecs: () => number;
  #sink: KeepaliveEventSink | undefined;

  constructor(
    send: PingSender,
    now: () => number = () => Date.now(),
    opts: KeepaliveServiceOptions = {},
  ) {
    this.#send = send;
    this.#now = now;
    this.#ledgerPath = opts.ledgerPath;
    this.#configuredMaxIdleSecs = opts.maxIdleSecs ?? (() => DEFAULT_MAX_IDLE_SECS);
  }

  #labels(): KeepaliveCallLabels {
    return {
      ...(this.#ledgerPath === undefined ? {} : { ledgerPath: this.#ledgerPath }),
      maxIdleSecs: this.#configuredMaxIdleSecs(),
    };
  }

  onEvent(sink: KeepaliveEventSink): void {
    this.#sink = sink;
  }

  arm(prefix: KeepalivePrefix, warm = false): void {
    const character = prefix.context?.character;
    if (character === undefined) return;
    const maxIdleSecs = prefix.context?.keepalive_max_secs ?? this.#configuredMaxIdleSecs();
    const entry = this.#entryFor(character, maxIdleSecs);
    entry.prefix = prefix;
    entry.keepalive.setInterval(prefix.keepalive_interval_ms, prefix.model, this.#now());
    if (warm) entry.keepalive.onPrefixWarmed(this.#now());
  }

  disarm(character: string): void {
    const entry = this.#entries.get(character);
    if (entry === undefined) return;
    entry.prefix = undefined;
    entry.keepalive.onCacheInvalidated();
  }

  observe(character: string, model: string, callType: string, maxIdleSecs?: number): void {
    if (callType === "keepalive") return;
    const entry =
      this.#entries.get(character) ??
      this.#entryFor(character, maxIdleSecs ?? this.#configuredMaxIdleSecs());
    entry.keepalive.onCacheWarmed(model, this.#now());
  }

  async pingNow(character: string): Promise<PingNowOutcome> {
    const prefix = this.#entries.get(character)?.prefix;
    if (prefix === undefined) {
      return { status: "skipped", cold: false, reason: "no_prefix", detail: "no cached request" };
    }
    const ping = buildKeepalivePing(prefix, this.#labels());
    const blocked = budgetBlockFor(ping, this.#now());
    if (blocked !== undefined) {
      return {
        status: "skipped",
        cold: false,
        reason: "budget",
        detail: `usage budget "${blocked.budget_name}"`,
      };
    }
    const startedAt = this.#now();
    try {
      const response = await this.#send(ping);
      recordGenerate(ping.context, ping, response);
      return {
        status: "sent",
        cold: pingLandedCold(response.usage),
        usage: response.usage,
      };
    } catch (e) {
      recordGenerateError(ping.context, ping, startedAt, this.#now);
      return { status: "failed", cold: false, detail: truncate(String(e), 160) };
    }
  }

  async tick(): Promise<void> {
    const due: string[] = [];
    for (const [character, entry] of this.#entries) {
      if (entry.inFlight) continue;
      if (entry.keepalive.tick(this.#now()) !== "ping") continue;
      entry.inFlight = true;
      due.push(character);
    }
    await Promise.all(
      due.map(async (character) => {
        try {
          await this.#ping(character);
        } catch (e) {
          console.error(`shore: keepalive ping failed for ${character}: ${String(e)}`);
        }
      }),
    );
  }

  restore(character: string, snapshot: KeepaliveSnapshot, maxIdleSecs: number): boolean {
    const entry = this.#entryFor(character, maxIdleSecs);
    return entry.keepalive.restore(snapshot, this.#now());
  }

  scheduleFor(character: string): KeepaliveSnapshot | undefined {
    return this.#entries.get(character)?.keepalive.snapshot();
  }

  #entryFor(character: string, maxIdleSecs: number): Entry {
    const existing = this.#entries.get(character);
    if (existing !== undefined) {
      if (existing.maxIdleSecs === maxIdleSecs) return existing;
      const carried = existing.keepalive.snapshot();
      const rebuilt = new CacheKeepalive(maxIdleSecs * 1000);
      if (carried !== undefined) rebuilt.restore(carried, this.#now());
      existing.keepalive = rebuilt;
      existing.maxIdleSecs = maxIdleSecs;
      return existing;
    }
    const entry: Entry = {
      keepalive: new CacheKeepalive(maxIdleSecs * 1000),
      maxIdleSecs,
      prefix: undefined,
      inFlight: false,
    };
    this.#entries.set(character, entry);
    return entry;
  }

  #push(event: KeepaliveEvent): void {
    this.#sink?.(event);
  }

  async #ping(character: string): Promise<void> {
    const entry = this.#entries.get(character);
    if (entry === undefined) return;
    try {
      await this.#pingInner(character, entry);
    } finally {
      entry.inFlight = false;
    }
  }

  async #pingInner(character: string, entry: Entry): Promise<void> {
    const prefix = entry.prefix;
    if (prefix === undefined) {
      this.#skip(character, entry, "no cached request");
      return;
    }

    const ping = buildKeepalivePing(prefix, this.#labels());

    const blocked = budgetBlockFor(ping, this.#now());
    if (blocked !== undefined) {
      this.#skip(character, entry, `usage budget "${blocked.budget_name}"`);
      return;
    }

    const startedAt = this.#now();
    let response: GenerateResponse;
    try {
      response = await this.#send(ping);
    } catch (e) {
      recordGenerateError(ping.context, ping, startedAt, this.#now);
      entry.keepalive.onPingFailed(this.#now());
      this.#push({
        character,
        outcome: "failed",
        detail: `Cache keepalive ping failed: ${truncate(String(e), 160)}`,
        at: this.#now(),
      });
      return;
    }

    recordGenerate(ping.context, ping, response);

    const usage = response.usage;
    if (pingLandedCold(usage)) {
      entry.keepalive.onCacheInvalidated();
      this.#push({
        character,
        outcome: "cold",
        detail:
          `Cache refresh ping (COLD — wrote cache, disarmed; ` +
          `cache_read: ${usage.cache_read_tokens}, input: ${usage.input_tokens})`,
        at: this.#now(),
      });
      return;
    }

    entry.keepalive.onPingSucceeded(this.#now());
    this.#push({
      character,
      outcome: "sent",
      detail:
        `Cache refresh ping (cache_read: ${usage.cache_read_tokens}, ` +
        `input: ${usage.input_tokens})`,
      at: this.#now(),
    });
  }

  #skip(character: string, entry: Entry, why: string): void {
    entry.keepalive.onPingFailed(this.#now());
    this.#push({
      character,
      outcome: "skipped",
      detail: `Cache keepalive ping skipped: ${truncate(why, 160)}`,
      at: this.#now(),
    });
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function startKeepaliveTimer(
  service: KeepaliveService,
  everyMs: number = KEEPALIVE_TICK_MS,
): { stop: () => void } {
  const timer = setInterval(() => {
    void service.tick();
  }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
