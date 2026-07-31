/**
 * The keepalive scheduler: deciding when to ping, and pinging.
 *
 * `cache_keepalive.ts` is the state machine — pure, total on its inputs, and
 * pinned against the Rust it was ported from. This is the part around it that
 * has effects: it holds one schedule per character, learns about real calls
 * from the ledger funnel, runs the clock, and sends the ping.
 *
 * **The prefix is pushed, not rebuilt.** A ping must be byte-identical to the
 * cached request in every field that participates in the cache prefix, and the
 * body it clones is `request + this turn's response`, assembled by the daemon in
 * `handler/persistence.rs` from its own persisted content blocks. Reconstructing
 * that here would mean reimplementing the daemon's response-persistence
 * pipeline and hoping the two agree forever; a single divergent byte turns every
 * ping from a cache read at 0.1x into a cache write at 2.0x, which is the exact
 * failure this subsystem exists to prevent. So the daemon pushes the body it
 * already built (`POST /v1/keepalive/prefix`) and this side never authors one.
 *
 * **The clock is wall clock, deliberately, and this is a fix.** The Rust ran on
 * `tokio::time::Instant` — `CLOCK_MONOTONIC` on Linux, which does not advance
 * while the machine is suspended. The thing being tracked is a prefix expiring
 * on Anthropic's servers, and that runs on wall time. Suspend a laptop for two
 * hours and the monotonic schedule barely moves: it stays armed, and the next
 * ping lands on a prefix that died during sleep. `Date.now()` notices the gap.
 * (The Rust's own persistence path already used wall clock, via
 * `rfc3339_to_instant`, so the two halves disagreed with each other.)
 *
 * Wall clock's own hazard is a clock step, and it is the lesser one here: an NTP
 * correction of seconds against a 55-minute cadence changes nothing, and a large
 * backwards step only delays a ping, which is safe. The dangerous direction is
 * always "ping something cold", never "ping late".
 */

import { CacheKeepalive, type KeepaliveSnapshot } from "./cache_keepalive.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import { recordGenerate, recordGenerateError } from "../ledger/record.ts";
import type { GenerateResponse, SidecarRequest, Usage, WireMessage } from "../llm/types.ts";

/** How often the scheduler wakes to look for due pings. Matches the daemon's
 *  `TICK_INTERVAL`, which drove the schedule before it moved here. */
export const KEEPALIVE_TICK_MS = 10_000;

/** Ceiling on undrained events, so a daemon that stops draining cannot grow
 *  this without bound. Oldest go first; the newest are the ones worth keeping. */
const MAX_PENDING_EVENTS = 256;

/** `[behavior.autonomy].cache_keepalive_max`'s own default, for the window
 *  before any prefix has been pushed to carry the configured one. */
const DEFAULT_MAX_IDLE_SECS = 12 * 60 * 60;

/**
 * The body of `POST /v1/keepalive/prefix`: the request the daemon would send
 * next, plus the cadence to send it on.
 *
 * It is the ordinary outbound request shape (`SidecarRequest` — a flattened
 * `LlmRequest` plus `context`) so both sides reuse the serialization they
 * already have. `context.character` keys the schedule and
 * `context.keepalive_max_secs` supplies the idle ceiling, both already carried
 * on every call.
 */
export interface KeepalivePrefix extends SidecarRequest {
  /**
   * The model's `cache_keepalive` cadence, milliseconds. Absent means off,
   * which disarms rather than leaving a stale cadence running.
   *
   * Milliseconds because the config domain allows a sub-second cadence and
   * seconds would truncate it to zero — and a zero interval puts the next ping
   * at the moment of the last one, so every tick is due and the loop spins.
   */
  keepalive_interval_ms?: number;
}

/** What a ping did, for the daemon's heartbeat log. */
export interface KeepaliveEvent {
  character: string;
  outcome: "sent" | "cold" | "failed" | "skipped";
  /** Human-readable, already shaped for the heartbeat log line. */
  detail: string;
  /** Wall-clock ms, so the daemon logs when it happened rather than when it drained. */
  at: number;
}

/** One character's armed schedule, as the daemon persists it. */
export interface KeepaliveSchedule extends KeepaliveSnapshot {
  character: string;
}

/**
 * `POST /v1/keepalive/restore` — a schedule the daemon persisted, offered back
 * at character startup.
 *
 * The ceiling rides along because a restored character may not have been armed
 * yet, so there is no pushed prefix to read it from.
 */
export interface KeepaliveRestore extends KeepaliveSnapshot {
  character: string;
  max_idle_secs: number;
}

/** What the daemon collects on its tick. */
export interface KeepaliveDrain {
  events: KeepaliveEvent[];
  /** Every armed schedule. A character with nothing worth restoring is absent,
   *  which is how the daemon learns to clear its persisted copy. */
  schedules: KeepaliveSchedule[];
}

/**
 * `POST /v1/keepalive/ping-now` — what an on-demand ping did.
 *
 * The question the diagnostic exists to answer is `cold`: a ping that read
 * nothing and paid a write did not keep anything warm. Until this existed that
 * was only observable by waiting for the scheduler and reading the ledger
 * afterwards.
 */
export interface PingNowOutcome {
  status: "sent" | "skipped" | "failed";
  /** Read 0 having paid a write. Only meaningful when `status` is `sent`. */
  cold: boolean;
  usage?: Usage;
  /**
   * Machine-readable cause when skipped. `no_prefix` is load-bearing across the
   * seam: the daemon reads it to decide whether to rebuild the body from disk
   * and push before asking again. A prose `detail` would make that a
   * string-match on a log line.
   */
  reason?: "no_prefix" | "budget";
  /** Human-readable, for the command's output. */
  detail?: string;
}

/** Sends the ping. Injected so the scheduler does not reach for the provider
 *  table, and so a test can drive it without a socket. */
export type PingSender = (
  req: SidecarRequest,
  signal?: AbortSignal,
) => Promise<GenerateResponse>;

interface Entry {
  keepalive: CacheKeepalive;
  /** The ceiling the state machine was built with. It is readonly in there, so
   *  a config reload that changes it rebuilds through snapshot/restore. */
  maxIdleSecs: number;
  /** The body to ping from. Absent until the daemon pushes one. */
  prefix: KeepalivePrefix | undefined;
  /** Guards against a slow ping overlapping the next tick. */
  inFlight: boolean;
}

/**
 * Whether a ping that came back `200 OK` actually failed at its only job.
 *
 * Read 0 *and* paid a write means the prefix was already gone and this ping
 * recreated it at full price rather than refreshing it. Read 0 with no write
 * means caching was off or a non-cached fallback answered — not a cold write,
 * and must not be treated as one.
 *
 * The same predicate is the ledger tracker's `cold_keepalive` anomaly
 * (`ledger/cache_tracker.ts`). They are deliberately identical: the row and the
 * scheduler's reaction must agree about what happened, or `shore usage` shows a
 * cold keepalive the schedule went on believing was fine.
 */
export function pingLandedCold(usage: {
  cache_read_tokens: number;
  cache_creation_tokens: number;
}): boolean {
  return usage.cache_read_tokens === 0 && usage.cache_creation_tokens > 0;
}

/**
 * Build the ping from the cached request.
 *
 * The ping MUST be byte-identical to the cached request in every field that
 * participates in the prompt cache prefix (tools, system, model, and the
 * original message sequence) — any divergence forces a cache write at 2.0x
 * instead of a cache read at 0.1x, defeating the entire subsystem.
 *
 * The only permitted differences, mirroring the Rust `build_keepalive_ping`:
 * - `max_tokens = 1` (no generation wanted, just a cache touch)
 * - no `rid` (do not reuse a stale request id)
 * - `call_type = "keepalive"`, which is what makes the row a keepalive row and
 *   lets the tracker's `cold_keepalive` check fire
 * - one extra user message appended (Anthropic requires the conversation to end
 *   on a user turn; the cloned request ends on the assistant reply)
 *
 * Note what is NOT touched: `messages` is copied and appended to, never
 * filtered, and `system`/`tools` are passed through by reference-copy. The
 * prefix is whatever the daemon pushed.
 */
export function buildKeepalivePing(prefix: KeepalivePrefix): SidecarRequest {
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
    // `rid` is dropped by omission, not by assigning `undefined`: the key is
    // optional and `exactOptionalPropertyTypes` keeps those apart, but more to
    // the point an explicit `"rid": null` would go out on the wire.
    const { rid: _stale, ...carried } = context;
    ping.context = { ...carried, call_type: "keepalive" };
  }
  return ping;
}

export class KeepaliveService {
  readonly #entries = new Map<string, Entry>();
  readonly #events: KeepaliveEvent[] = [];
  readonly #send: PingSender;
  readonly #now: () => number;

  constructor(send: PingSender, now: () => number = () => Date.now()) {
    this.#send = send;
    this.#now = now;
  }

  /**
   * Arm (or re-arm) a character from a pushed prefix.
   *
   * Mirrors the daemon's `cache_last_request`: store the body, then feed the
   * cadence to the state machine, which decides for itself whether a model
   * switch means the old prefix is cold.
   */
  arm(prefix: KeepalivePrefix): void {
    const character = prefix.context?.character;
    if (character === undefined) return;
    const maxIdleSecs = prefix.context?.keepalive_max_secs ?? DEFAULT_MAX_IDLE_SECS;
    const entry = this.#entryFor(character, maxIdleSecs);
    entry.prefix = prefix;
    entry.keepalive.setInterval(prefix.keepalive_interval_ms, prefix.model, this.#now());
  }

  /**
   * The daemon invalidated the cached prefix (compaction, prompt reload, a
   * model switch it saw first). Pinging pauses until a real call re-warms.
   */
  disarm(character: string): void {
    const entry = this.#entries.get(character);
    if (entry === undefined) return;
    entry.prefix = undefined;
    entry.keepalive.onCacheInvalidated();
  }

  /**
   * A real provider call landed. Wired to the ledger funnel, which sees every
   * call whichever endpoint or loop made it.
   *
   * Keepalive pings are excluded: they go through `onPingSucceeded`, which
   * advances the ping timer without touching the idle clock. Counting a ping as
   * activity here would let a run of pings keep pushing its own deadline out
   * with nobody there — the second failure mode in `cache_keepalive.ts`.
   *
   * Creates the entry when there is none, which matters for ordering rather
   * than tidiness. The daemon pushes a prefix from
   * `update_last_request_with_response`, i.e. *after* the response is persisted,
   * so on a character's first turn this warm arrives before any prefix. Dropping
   * it would leave `setInterval` with no activity anchor to schedule from, and
   * the character would stay unarmed until its second turn — send one message,
   * walk away, and the cache expires unprotected.
   *
   * A bare entry arms nothing on its own: with no cadence pushed yet there is no
   * interval, so `onCacheWarmed` records the activity and schedules no ping.
   */
  observe(character: string, model: string, callType: string, maxIdleSecs?: number): void {
    if (callType === "keepalive") return;
    const entry =
      this.#entries.get(character) ??
      this.#entryFor(character, maxIdleSecs ?? DEFAULT_MAX_IDLE_SECS);
    entry.keepalive.onCacheWarmed(model, this.#now());
  }

  /**
   * Send a ping right now and report what it read, for the
   * `keepalive_ping_now` diagnostic.
   *
   * Deliberately does **not** touch the schedule — no `onPingSucceeded`, no
   * backoff, no disarm on a cold read. Measuring must not change what is being
   * measured: firing this to ask "is the prefix still warm?" must not move the
   * real deadline or stand the schedule down.
   *
   * It is still a real billed call, so it is still recorded.
   */
  async pingNow(character: string): Promise<PingNowOutcome> {
    const prefix = this.#entries.get(character)?.prefix;
    if (prefix === undefined) {
      return { status: "skipped", cold: false, reason: "no_prefix", detail: "no cached request" };
    }
    const ping = buildKeepalivePing(prefix);
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

  /** Fire whatever is due. Safe to call concurrently with itself; a character
   *  with a ping in flight is skipped rather than double-pinged. */
  async tick(): Promise<void> {
    const due: string[] = [];
    for (const [character, entry] of this.#entries) {
      if (entry.inFlight) continue;
      if (entry.keepalive.tick(this.#now()) !== "ping") continue;
      entry.inFlight = true;
      due.push(character);
    }
    await Promise.all(due.map((character) => this.#ping(character)));
  }

  /**
   * Hand the daemon what happened and what to persist, and forget the events.
   *
   * Draining clears: these are log lines, and the daemon appends them to the
   * heartbeat log as it receives them. The schedules are not cleared — they are
   * current state, reported in full each time.
   *
   * `character` scopes both, because the daemon drains from a per-character
   * autonomy tick that can only reach its own state. Draining unscoped would
   * hand one character's tick events belonging to another, which it would then
   * drop on the floor — and they are already gone from here by then.
   */
  drain(character?: string): KeepaliveDrain {
    const events: KeepaliveEvent[] = [];
    const kept: KeepaliveEvent[] = [];
    for (const event of this.#events) {
      (character === undefined || event.character === character ? events : kept).push(event);
    }
    this.#events.length = 0;
    this.#events.push(...kept);

    const schedules: KeepaliveSchedule[] = [];
    for (const [name, entry] of this.#entries) {
      if (character !== undefined && name !== character) continue;
      const snapshot = entry.keepalive.snapshot();
      if (snapshot !== undefined) schedules.push({ character: name, ...snapshot });
    }
    return { events, schedules };
  }

  /** Re-arm a character from the daemon's persisted snapshot after a restart.
   *  Returns whether the schedule was taken up; the guard lives in `restore`. */
  restore(character: string, snapshot: KeepaliveSnapshot, maxIdleSecs: number): boolean {
    const entry = this.#entryFor(character, maxIdleSecs);
    return entry.keepalive.restore(snapshot, this.#now());
  }

  /** Test seam: the live schedule for a character. */
  scheduleFor(character: string): KeepaliveSnapshot | undefined {
    return this.#entries.get(character)?.keepalive.snapshot();
  }

  #entryFor(character: string, maxIdleSecs: number): Entry {
    const existing = this.#entries.get(character);
    if (existing !== undefined) {
      if (existing.maxIdleSecs === maxIdleSecs) return existing;
      // The ceiling is readonly on the state machine, so a changed
      // `cache_keepalive_max` rebuilds it. Carrying the schedule across via
      // snapshot/restore keeps a config reload from silently disarming a
      // character — but `restore`'s staleness guard still applies, so a
      // schedule too old to be safe stays down.
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
    this.#events.push(event);
    if (this.#events.length > MAX_PENDING_EVENTS) {
      this.#events.splice(0, this.#events.length - MAX_PENDING_EVENTS);
    }
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
      // Nothing to ping from. The daemon pushes a prefix on every foreground
      // turn, so this is a character that has not spoken since the sidecar
      // started — backing off is right, and the next turn re-arms.
      this.#skip(character, entry, "no cached request");
      return;
    }

    const ping = buildKeepalivePing(prefix);

    // Budget-gated exactly like any other call. `onPingFailed`, not a silent
    // return: a blocked ping still has to back off, or it retries every tick
    // for as long as the block lasts.
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
      // Disarm rather than reschedule. A cold read is positive proof the prefix
      // this keepalive existed to protect is already gone, and the ledger says a
      // ping does not rebuild it: twelve consecutive `cold_keepalive` rows at
      // full write price — including two byte-identical pings nine seconds apart
      // that both read 0 — until a real message landed and the write stuck.
      //
      // *Why* a ping's write does not stick is not established. This used to
      // claim the provider refused the response and billed the write without
      // persisting it; that was tested twice and is wrong, so do not re-derive
      // it. The disarm rests on the observation, which holds either way.
      //
      // `onCacheInvalidated`, not `onPingFailed`, because this is knowledge
      // rather than a transient error: retry backoff would buy another
      // guaranteed full write.
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

    // The ping refreshed a warm prefix. `onPingSucceeded` (not `onCacheWarmed`)
    // so the idle ceiling keeps counting from the last real message.
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

/**
 * Run `tick` on a timer until the returned handle is stopped.
 *
 * `unref` so a pending tick never holds the process open — the sidecar's
 * lifetime is the daemon's to decide, and a keepalive timer is not a reason to
 * linger.
 */
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
