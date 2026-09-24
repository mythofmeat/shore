import { shoreLog } from "../log.ts";

import { CacheKeepalive, type KeepaliveSnapshot } from "./schedule.ts";
import { KEEPALIVE_REWRITE_TOKENS } from "./tracker.ts";
import { DEFAULT_KEEPALIVE_PINGS, keepaliveWindowSecs } from "../config/keepalive.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import { MAIN_THREAD } from "../config/dirs.ts";
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

export interface KeepalivePrefix extends SidecarRequest {
  keepalive_interval_ms?: number;
  keepalive_pings?: number;
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

export interface KeepaliveDrain {
  events: KeepaliveEvent[];
  schedules: KeepaliveSchedule[];
}

export interface PingNowOutcome {
  status: "sent" | "skipped" | "failed";
  cold: boolean;
  usage?: Usage;
  reason?: "no_prefix" | "budget" | "halted";
  detail?: string;
}

export type PingSender = (
  req: SidecarRequest,
  signal?: AbortSignal,
) => Promise<GenerateResponse>;

interface Entry {
  keepalive: CacheKeepalive;
  prefix: KeepalivePrefix | undefined;
  inFlight: boolean;
  armedFingerprint: string | undefined;
  lastCallFingerprint: string | undefined;
  consecutiveMisses: number;
}

export interface KeepaliveHalt {
  character: string;
  model: string;
  reason: string;
  at: number;
}

export function keepaliveModelKey(req: Pick<SidecarRequest, "sdk" | "model" | "provider_key">): string {
  return `${req.provider_key ?? req.sdk}:${req.model}`;
}

function haltKey(req: Pick<SidecarRequest, "sdk" | "model" | "provider_key">): string {
  return JSON.stringify([req.provider_key ?? req.sdk, req.sdk, req.model]);
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
  _sdk: Sdk,
): boolean {
  return usage.cache_read_tokens === 0;
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
  windowSecs?: number;
}

export interface KeepaliveServiceOptions {
  ledgerPath?: string;
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
  const { keepalive_interval_ms: _cadence, keepalive_pings: _pings, context, ...request } = prefix;
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
      ...(labels.windowSecs === undefined ? {} : { keepalive_window_secs: labels.windowSecs }),
    };
  }
  return ping;
}

export class KeepaliveService {
  readonly #entries = new Map<string, Entry>();
  readonly #send: PingSender;
  readonly #now: () => number;
  readonly #ledgerPath: string | undefined;
  readonly #runActivity: <T>(run: () => Promise<T>) => Promise<T>;
  #sink: KeepaliveEventSink | undefined;
  readonly #halts = new Map<string, KeepaliveHalt>();
  #lastHalt: KeepaliveHalt | undefined;

  constructor(
    send: PingSender,
    now: () => number = () => Date.now(),
    opts: KeepaliveServiceOptions = {},
  ) {
    this.#send = send;
    this.#now = now;
    this.#ledgerPath = opts.ledgerPath;
    this.#runActivity = opts.runActivity ?? (async (run) => await run());
  }

  #labels(entry: Entry): KeepaliveCallLabels {
    return {
      ...(this.#ledgerPath === undefined ? {} : { ledgerPath: this.#ledgerPath }),
      windowSecs: keepaliveWindowSecs(entry.keepalive.interval, entry.keepalive.maxPings),
    };
  }

  onEvent(sink: KeepaliveEventSink): void {
    this.#sink = sink;
  }

  get halted(): KeepaliveHalt | undefined {
    return this.#lastHalt;
  }

  haltFor(req: Pick<SidecarRequest, "sdk" | "model" | "provider_key">): KeepaliveHalt | undefined {
    return this.#halts.get(haltKey(req));
  }

  haltsFor(character: string): KeepaliveHalt[] {
    const armed = this.#entries.get(character)?.prefix;
    const own = armed === undefined ? undefined : this.haltFor(armed);
    const others = [...this.#halts.values()].filter((halt) => halt !== own).reverse();
    return own === undefined ? others : [own, ...others];
  }

  #haltModel(character: string, prefix: KeepalivePrefix, usage: Usage): void {
    const sdk = prefix.sdk;
    const model = keepaliveModelKey(prefix);
    const evidence = `Neither read any cached tokens on ${sdk}; the latest wrote ` +
      `${usage.cache_creation_tokens} tokens. There is no evidence that the prefix is being reused`;
    const reason =
      `two keepalive pings in a row missed with nothing in between. ${evidence}, so every ` +
      `further ping would pay full price for nothing. Keepalives for ${model} are stopped for the ` +
      `life of this daemon; nothing resumes them, because nothing that causes this is fixable at runtime`;
    const halt = { character, model, reason, at: this.#now() };
    const key = haltKey(prefix);
    this.#halts.set(key, halt);
    this.#lastHalt = halt;
    shoreLog.error(`shore: KEEPALIVE HALTED (${character}) — ${reason}`);
    this.#push({
      character,
      outcome: "halted",
      detail: `Cache keepalive HALTED: ${reason}`,
      at: this.#now(),
    });
    for (const [, other] of this.#entries) {
      if (other.prefix !== undefined && haltKey(other.prefix) === key) other.keepalive.onCacheInvalidated();
    }
  }

  arm(prefix: KeepalivePrefix, warm = false): void {
    const character = prefix.context?.character;
    if (character === undefined) return;
    const entry = this.#entryFor(character);
    entry.prefix = prefix;
    entry.armedFingerprint = prefixFingerprint(prefix);
    entry.lastCallFingerprint = undefined;
    const interval = this.haltFor(prefix) === undefined ? prefix.keepalive_interval_ms : undefined;
    entry.keepalive.setMaxPings(prefix.keepalive_pings ?? DEFAULT_KEEPALIVE_PINGS);
    entry.keepalive.setInterval(interval, prefix.model, this.#now());
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
    fingerprint?: string,
    usage?: Pick<Usage, "cache_read_tokens">,
  ): void {
    if (callType === "keepalive" || callType === "heartbeat" || callType === "heartbeat_tool_loop") return;
    const entry = this.#entryFor(character);
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

  warmThread(character: string): string | undefined {
    const prefix = this.#entries.get(character)?.prefix;
    if (prefix === undefined) return undefined;
    return prefix.context?.thread ?? MAIN_THREAD;
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
      if ((outcome.usage?.cache_read_tokens ?? 0) > 0 || (outcome.usage?.cache_creation_tokens ?? 0) > 0) {
        entry.keepalive.onCacheWarmed(model, this.#now());
      } else {
        entry.keepalive.onCacheInvalidated();
      }
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
    const halt = this.haltFor(prefix);
    if (halt !== undefined) {
      return { status: "skipped", cold: false, reason: "halted", detail: halt.reason };
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

  restore(character: string, snapshot: KeepaliveSnapshot): boolean {
    return this.#entryFor(character).keepalive.restore(snapshot, this.#now());
  }

  scheduleFor(character: string): KeepaliveSnapshot | undefined {
    return this.#entries.get(character)?.keepalive.snapshot();
  }

  #entryFor(character: string): Entry {
    const existing = this.#entries.get(character);
    if (existing !== undefined) return existing;
    const entry: Entry = {
      keepalive: new CacheKeepalive(DEFAULT_KEEPALIVE_PINGS),
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

    if (this.haltFor(prefix) !== undefined) {
      entry.keepalive.onCacheInvalidated();
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
        this.#haltModel(character, prefix, usage);
        return;
      }
      entry.keepalive.onCacheInvalidated();
      this.#push({
        character,
        outcome: "cold",
        detail:
          `Cache refresh ping (COLD — ${usage.cache_creation_tokens > 0 ? "wrote cache" : "read nothing"}, ` +
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
