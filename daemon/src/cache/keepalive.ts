import { shoreLog } from "../log.ts";

import { CacheKeepalive, type KeepaliveSnapshot } from "./schedule.ts";
import { KEEPALIVE_REWRITE_TOKENS } from "./tracker.ts";
import { reportsCacheWrites } from "../llm/cache_capability.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import {
  beginCallAttempt,
  prepareCallAccounting,
  recordGenerate,
  recordGenerateError,
  type CallAttempt,
} from "../ledger/record.ts";
import { createHash } from "node:crypto";

import type {
  GenerateResponse,
  Sdk,
  SidecarRequest,
  SystemContent,
  Usage,
  WireMessage,
} from "../llm/types.ts";

const KEEPALIVE_TICK_MS = 10_000;

export const DEFAULT_KEEPALIVE_MAX_SECS = 12 * 60 * 60;
const DEFAULT_MAX_IDLE_SECS = DEFAULT_KEEPALIVE_MAX_SECS;

export interface KeepalivePrefix extends SidecarRequest {
  keepalive_interval_ms?: number;
}

export interface KeepaliveEvent {
  character: string;
  outcome: "sent" | "cold" | "rewrote" | "failed" | "skipped" | "halted";
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
  armedFingerprint: string | undefined;
  lastCallFingerprint: string | undefined;
  consecutiveMisses: number;
}

export interface KeepaliveHalt {
  character: string;
  reason: string;
  at: number;
}

export function prefixFingerprint(req: {
  system?: SystemContent | undefined;
  messages: readonly WireMessage[];
}): string {
  const shape = [
    (req.system ?? []).map((b) => b.text),
    req.messages.map((m) => [m.role, JSON.stringify(m.content)]),
  ];
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

export function prefixIsStale(entry: {
  armedFingerprint: string | undefined;
  lastCallFingerprint: string | undefined;
}): boolean {
  if (entry.armedFingerprint === undefined) return false;
  if (entry.lastCallFingerprint === undefined) return false;
  return entry.armedFingerprint !== entry.lastCallFingerprint;
}

export function pingLandedCold(
  usage: {
    cache_read_tokens: number;
    cache_creation_tokens: number;
  },
  sdk: Sdk,
): boolean {
  if (!reportsCacheWrites(sdk)) return usage.cache_read_tokens === 0;
  return usage.cache_read_tokens === 0 && usage.cache_creation_tokens > 0;
}

export function pingRewrotePrefix(usage: {
  cache_read_tokens: number;
  cache_creation_tokens: number;
}): boolean {
  if (usage.cache_read_tokens === 0 && usage.cache_creation_tokens > 0) return false;
  return usage.cache_creation_tokens >= KEEPALIVE_REWRITE_TOKENS;
}

export interface KeepaliveCallLabels {
  ledgerPath?: string;
  maxIdleSecs?: number;
}

export interface KeepaliveServiceOptions {
  ledgerPath?: string;
  maxIdleSecs?: () => number;
  runActivity?: <T>(run: () => Promise<T>) => Promise<T>;
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
  readonly #runActivity: <T>(run: () => Promise<T>) => Promise<T>;
  #sink: KeepaliveEventSink | undefined;
  #halt: KeepaliveHalt | undefined;

  constructor(
    send: PingSender,
    now: () => number = () => Date.now(),
    opts: KeepaliveServiceOptions = {},
  ) {
    this.#send = send;
    this.#now = now;
    this.#ledgerPath = opts.ledgerPath;
    this.#configuredMaxIdleSecs = opts.maxIdleSecs ?? (() => DEFAULT_MAX_IDLE_SECS);
    this.#runActivity = opts.runActivity ?? (async (run) => await run());
  }

  #labels(entry: Entry): KeepaliveCallLabels {
    return {
      ...(this.#ledgerPath === undefined ? {} : { ledgerPath: this.#ledgerPath }),
      maxIdleSecs: entry.maxIdleSecs,
    };
  }

  onEvent(sink: KeepaliveEventSink): void {
    this.#sink = sink;
  }

  get halted(): KeepaliveHalt | undefined {
    return this.#halt;
  }

  #haltAll(character: string, sdk: Sdk, usage: Usage): void {
    const evidence = reportsCacheWrites(sdk)
      ? `The first wrote ${String(usage.cache_creation_tokens)} tokens, which should have left ` +
        `an entry the second one read — it did not. The cache is not holding what shore writes ` +
        `to it`
      : `Neither read a single cached token, and on ${sdk} the cache is implicit: the entry the ` +
        `real turn left behind is the one a ping reads, so reading nothing twice means there is ` +
        `nothing there to keep alive`;
    const reason =
      `two keepalive pings in a row missed with nothing in between. ${evidence}, so every ` +
      `further ping would pay full price for nothing. All keepalives are stopped for the life ` +
      `of this daemon; nothing resumes them, because nothing that causes this is fixable at runtime`;
    this.#halt = { character, reason, at: this.#now() };
    shoreLog.error(`shore: KEEPALIVE HALTED (${character}) — ${reason}`);
    this.#push({
      character,
      outcome: "halted",
      detail: `Cache keepalive HALTED: ${reason}`,
      at: this.#now(),
    });
    for (const [, other] of this.#entries) other.keepalive.onCacheInvalidated();
  }

  arm(prefix: KeepalivePrefix, warm = false): void {
    const character = prefix.context?.character;
    if (character === undefined) return;
    const maxIdleSecs = prefix.context?.keepalive_max_secs ?? this.#configuredMaxIdleSecs();
    const entry = this.#entryFor(character, maxIdleSecs);
    entry.prefix = prefix;
    entry.armedFingerprint = prefixFingerprint(prefix);
    entry.lastCallFingerprint = undefined;
    entry.keepalive.setInterval(prefix.keepalive_interval_ms, prefix.model, this.#now());
    if (warm) entry.keepalive.onPrefixWarmed(this.#now());
  }

  disarm(character: string): void {
    const entry = this.#entries.get(character);
    if (entry === undefined) return;
    entry.prefix = undefined;
    entry.keepalive.onCacheInvalidated();
  }

  observe(
    character: string,
    model: string,
    callType: string,
    maxIdleSecs?: number,
    fingerprint?: string,
    usage?: Pick<Usage, "cache_read_tokens">,
  ): void {
    if (callType === "keepalive") return;
    const entry =
      this.#entries.get(character) ??
      this.#entryFor(character, maxIdleSecs ?? this.#configuredMaxIdleSecs());
    if (fingerprint !== undefined && entry.prefix?.model === model) {
      entry.lastCallFingerprint = fingerprint;
    }
    if (usage !== undefined && usage.cache_read_tokens > 0) entry.consecutiveMisses = 0;
    entry.keepalive.onCacheWarmed(model, this.#now());
  }

  forgetMisses(character: string): void {
    const entry = this.#entries.get(character);
    if (entry !== undefined) entry.consecutiveMisses = 0;
  }

  nextPingAt(character: string): number | undefined {
    return this.#entries.get(character)?.keepalive.nextPingAt;
  }

  intervalFor(character: string): number | undefined {
    return this.#entries.get(character)?.keepalive.interval;
  }

  async primeNow(character: string): Promise<PingNowOutcome> {
    const outcome = await this.pingNow(character);
    if (outcome.status !== "sent") return outcome;
    const entry = this.#entries.get(character);
    const model = entry?.prefix?.model;
    if (entry !== undefined && model !== undefined) {
      entry.keepalive.onCacheWarmed(model, this.#now());
    }
    return outcome;
  }

  async pingNow(character: string): Promise<PingNowOutcome> {
    return await this.#runActivity(async () => await this.#pingNow(character));
  }

  async #pingNow(character: string): Promise<PingNowOutcome> {
    const entry = this.#entries.get(character);
    const prefix = entry?.prefix;
    if (entry === undefined || prefix === undefined) {
      return { status: "skipped", cold: false, reason: "no_prefix", detail: "no cached request" };
    }
    const ping = buildKeepalivePing(prefix, this.#labels(entry));
    await prepareCallAccounting(ping, fetch, this.#now());
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
    let attempt: CallAttempt | undefined;
    try {
      attempt = ping.context?.ledger === undefined ? undefined : beginCallAttempt(ping.context, ping);
      const response = await this.#send(ping);
      await attempt?.pricingReady;
      recordGenerate(ping.context, ping, response, attempt);
      return {
        status: "sent",
        cold: pingLandedCold(response.usage, prefix.sdk),
        usage: response.usage,
      };
    } catch (e) {
      await attempt?.pricingReady;
      recordGenerateError(ping.context, ping, startedAt, this.#now, attempt);
      return { status: "failed", cold: false, detail: truncate(String(e), 160) };
    }
  }

  async tick(): Promise<void> {
    if (this.#halt !== undefined) return;
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
          shoreLog.error(`shore: keepalive ping failed for ${character}: ${String(e)}`);
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
      armedFingerprint: undefined,
      lastCallFingerprint: undefined,
      consecutiveMisses: 0,
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
      await this.#runActivity(async () => await this.#pingInner(character, entry));
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

    if (prefixIsStale(entry)) {
      this.#skip(
        character,
        entry,
        "the last real call sent a different prefix, so this ping would write a fresh entry " +
          "for one already superseded; the next real turn re-arms it",
      );
      return;
    }

    const ping = buildKeepalivePing(prefix, this.#labels(entry));

    await prepareCallAccounting(ping, fetch, this.#now());
    const blocked = budgetBlockFor(ping, this.#now());
    if (blocked !== undefined) {
      this.#skip(character, entry, `usage budget "${blocked.budget_name}"`);
      return;
    }

    const startedAt = this.#now();
    let attempt: CallAttempt | undefined;
    let response: GenerateResponse;
    try {
      attempt = ping.context?.ledger === undefined ? undefined : beginCallAttempt(ping.context, ping);
      response = await this.#send(ping);
    } catch (e) {
      await attempt?.pricingReady;
      recordGenerateError(ping.context, ping, startedAt, this.#now, attempt);
      entry.keepalive.onPingFailed(this.#now());
      this.#push({
        character,
        outcome: "failed",
        detail: `Cache keepalive ping failed: ${truncate(String(e), 160)}`,
        at: this.#now(),
      });
      return;
    }

    await attempt?.pricingReady;
    recordGenerate(ping.context, ping, response, attempt);

    const usage = response.usage;
    if (pingLandedCold(usage, prefix.sdk)) {
      entry.consecutiveMisses += 1;
      if (entry.consecutiveMisses >= 2) {
        this.#haltAll(character, prefix.sdk, usage);
        return;
      }
      entry.keepalive.onCacheInvalidated();
      this.#push({
        character,
        outcome: "cold",
        detail:
          `Cache refresh ping (COLD — ${reportsCacheWrites(prefix.sdk) ? "wrote cache" : "read nothing"}, ` +
          `disarmed; cache_read: ${usage.cache_read_tokens}, input: ${usage.input_tokens})`,
        at: this.#now(),
      });
      return;
    }
    entry.consecutiveMisses = 0;

    if (pingRewrotePrefix(usage)) {
      entry.keepalive.onPingSucceeded(this.#now());
      this.#push({
        character,
        outcome: "rewrote",
        detail:
          `Cache refresh ping rewrote the prefix — it had moved under the ping ` +
          `(cache_read: ${usage.cache_read_tokens}, cache_write: ${usage.cache_creation_tokens}); ` +
          `the entry it just wrote is what the next ping reads`,
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
