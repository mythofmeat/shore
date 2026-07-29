/**
 * Writing rows to `ledger.db`.
 *
 * Ported from the recording half of `crates/daemon/src/ledger/{store,client}.rs`.
 * This side computes cost and cache state because this side makes the calls —
 * it has the usage the moment a response lands.
 *
 * **The daemon still owns the schema.** It starts first and runs the migrations;
 * this opens the file that already exists and inserts into it. Two processes on
 * one SQLite file is fine in WAL — one writer, several readers — which is why
 * `Ledger::open` sets `journal_mode = WAL` (shore commit 297fc2a4). Opening a
 * database that has not been created yet is an error here rather than a
 * `CREATE TABLE`, because a second schema author is how the two drift.
 */

import { Database } from "bun:sqlite";

import {
  CacheTracker,
  CacheTrackers,
  type Anomaly,
  type CacheState,
  type Observation,
} from "./cache_tracker.ts";
import { isAnthropicPricing, PricingEngine, type ModelPricing, type PricingStore } from "./pricing.ts";

/** Flat-plan providers: record the usage, zero the cost. Metered pricing does
 *  not apply, and a non-zero cost here would accrue against usage budgets. */
const SUBSCRIPTION_PROVIDERS = new Set(["opencode-go"]);

export const isSubscriptionProvider = (provider: string): boolean =>
  SUBSCRIPTION_PROVIDERS.has(provider);

/** Dreaming runs its own prefix and is excluded from cache tracking entirely. */
const affectsCacheTracker = (callType: string): boolean => callType !== "dreaming";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd?: number | undefined;
}

export interface Timing {
  total_ms: number;
  time_to_first_token_ms: number;
}

/** One call to record. Mirrors Rust `RecordCall`. */
export interface RecordCall {
  provider: string;
  api_key_name?: string | undefined;
  model: string;
  call_type: string;
  character: string;
  usage: Usage;
  timing: Timing;
  finish_reason: string;
  thinking_enabled: boolean;
  cache_ttl?: string | undefined;
  reasoning_effort?: string | undefined;
}

export interface CallRow {
  ts: string;
  character: string;
  provider: string;
  api_key_name: string | null;
  model: string;
  call_type: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_ttl: string | null;
  reasoning_effort: string | null;
  total_ms: number;
  ttft_ms: number;
  finish_reason: string;
  thinking_enabled: number;
  cache_state: string | null;
  cache_anomaly: string | null;
  input_cost: number | null;
  output_cost: number | null;
  cache_read_cost: number | null;
  cache_write_cost: number | null;
  /** Nullable to match Rust's `Option<String>`: the writer here always sets
   *  one, but rows predating that are still readable. */
  cost_source: string | null;
  total_cost: number | null;
}

const INSERT_SQL = `INSERT INTO calls (
  ts, character, provider, api_key_name, model, call_type,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  cache_ttl, reasoning_effort, total_ms, ttft_ms, finish_reason,
  thinking_enabled, cache_state, cache_anomaly,
  input_cost, output_cost, cache_read_cost, cache_write_cost,
  cost_source, total_cost
) VALUES (
  $ts, $character, $provider, $api_key_name, $model, $call_type,
  $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens,
  $cache_ttl, $reasoning_effort, $total_ms, $ttft_ms, $finish_reason,
  $thinking_enabled, $cache_state, $cache_anomaly,
  $input_cost, $output_cost, $cache_read_cost, $cache_write_cost,
  $cost_source, $total_cost
)`;

/**
 * Recognize Anthropic-family rows. Mirrors the SQL the daemon's `store.rs` and
 * `query.rs` use — `(provider = 'anthropic' OR model LIKE 'anthropic/%')` —
 * which cannot move until the ledger's readers do.
 */
const LAST_ANTHROPIC_CALL_SQL = `SELECT ts, model, thinking_enabled, cache_read_tokens
  FROM calls
 WHERE character = $character
   AND (provider = 'anthropic' OR model LIKE 'anthropic/%')
   AND call_type != 'compaction'
 ORDER BY id DESC
 LIMIT 1`;

interface SeedRow {
  ts: string;
  model: string;
  thinking_enabled: number;
  cache_read_tokens: number;
}

/**
 * The ledger, from the writer's side.
 *
 * Holds the cache trackers, because a row's `cache_state` is a function of the
 * rows before it — recording and tracking are the same act.
 */
export class Ledger {
  readonly #db: Database;
  readonly #trackers = new CacheTrackers();
  readonly #pricing: PricingEngine;
  /** TTL used when seeding a tracker, in seconds. */
  #ttlSecs = 3600;

  private constructor(db: Database, pricing?: PricingEngine) {
    this.#db = db;
    this.#pricing = pricing ?? new PricingEngine(sqlitePricingStore(db));
  }

  /**
   * Open an existing ledger. Throws if the `calls` table is absent — the
   * daemon creates and migrates the schema, and a second author is how two
   * schemas drift apart.
   */
  static open(path: string, pricing?: PricingEngine): Ledger {
    const db = new Database(path, { create: false, readwrite: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const table = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'calls'")
      .get();
    if (!table) {
      db.close();
      throw new Error(`${path} has no 'calls' table — the daemon owns the schema and creates it`);
    }
    return new Ledger(db, pricing);
  }

  get pricing(): PricingEngine {
    return this.#pricing;
  }

  get trackers(): CacheTrackers {
    return this.#trackers;
  }

  /** Mirror `[behavior.autonomy].cache_keepalive_max` onto the trackers. */
  setMaxIdleSecs(secs: number): void {
    this.#trackers.setMaxIdleSecs(secs);
  }

  setCacheTtlSecs(secs: number): void {
    this.#ttlSecs = secs;
  }

  /** The TTL trackers are seeded and aged against. */
  get cacheTtlSecs(): number {
    return this.#ttlSecs;
  }

  /**
   * The open handle, for the read-side modules.
   *
   * `query.ts` and `budget.ts` are free functions over a `Database`, mirroring
   * the Rust they came from, and the writer has no business re-wrapping them.
   * Exposing the handle keeps one open connection per ledger path rather than a
   * second one racing the first.
   */
  get database(): Database {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Record one provider call and return the row as written.
   *
   * One call, one row. A row carrying a sum across several calls reports a
   * `cache_read` no single call made and poisons the tracker's baseline — see
   * `cache_tracker.ts`.
   */
  record(record: RecordCall, now: () => Date = () => new Date()): CallRow {
    const ts = now().toISOString();
    const [cache_state, cache_anomaly] = this.#trackCacheState(record, ts);
    const row = this.#buildRow(record, ts, cache_state, cache_anomaly);
    this.#db.query(INSERT_SQL).run({
      $ts: row.ts,
      $character: row.character,
      $provider: row.provider,
      $api_key_name: row.api_key_name,
      $model: row.model,
      $call_type: row.call_type,
      $input_tokens: row.input_tokens,
      $output_tokens: row.output_tokens,
      $cache_read_tokens: row.cache_read_tokens,
      $cache_write_tokens: row.cache_write_tokens,
      $cache_ttl: row.cache_ttl,
      $reasoning_effort: row.reasoning_effort,
      $total_ms: row.total_ms,
      $ttft_ms: row.ttft_ms,
      $finish_reason: row.finish_reason,
      $thinking_enabled: row.thinking_enabled,
      $cache_state: row.cache_state,
      $cache_anomaly: row.cache_anomaly,
      $input_cost: row.input_cost,
      $output_cost: row.output_cost,
      $cache_read_cost: row.cache_read_cost,
      $cache_write_cost: row.cache_write_cost,
      $cost_source: row.cost_source,
      $total_cost: row.total_cost,
    });
    return row;
  }

  /**
   * Seed a character's tracker from its last recorded Anthropic call.
   *
   * The daemon did this at startup (`reconstruct_cache_state`); here it happens
   * lazily on the character's first call, which needs no startup ordering
   * between the two processes.
   */
  #seedIfNeeded(character: string): void {
    if (!this.#trackers.needsSeed(character)) return;
    const seed = this.#db.query(LAST_ANTHROPIC_CALL_SQL).get({ $character: character }) as
      | SeedRow
      | null;
    if (!seed) {
      // No prior call — a cold tracker, which `forCharacter` creates.
      this.#trackers.forCharacter(character, this.#ttlSecs);
      return;
    }
    this.#trackers.seed(
      character,
      CacheTracker.reconstruct(
        seed.ts,
        seed.model,
        seed.thinking_enabled !== 0,
        seed.cache_read_tokens,
        this.#ttlSecs,
      ),
    );
  }

  /** Ported from `track_cache_state`. Returns `[state, anomaly]`. */
  #trackCacheState(record: RecordCall, ts: string): [string | null, string | null] {
    // A `cancelled` row stands for a call whose stream was dropped before any
    // terminal frame. Its usage is all zero by construction, so feeding it to
    // the tracker would inject a bogus cold observation.
    if (record.finish_reason === "cancelled") return [null, null];

    // A failure carries a cache signal only when the provider reported one —
    // Anthropic bills the write announced in `message_start` even if the stream
    // then dies, and that write must be tracked. A failure that reported
    // *nothing* is the zero-observation problem again: against a warm baseline
    // it reads as a total cache loss and flips the state to cold on a cache
    // that is fine. The daemon never produced such a row, so this guard is new
    // with the writer: a non-streaming call that fails before the provider
    // answers is recorded here, and it has no usage to report.
    const noCacheSignal =
      record.usage.cache_read_tokens === 0 && record.usage.cache_creation_tokens === 0;
    if (record.finish_reason === "error" && noCacheSignal) return [null, null];
    if (!affectsCacheTracker(record.call_type)) return [null, null];

    this.#seedIfNeeded(record.character);

    // The warm/cold machine encodes Anthropic invariants. Other providers cache
    // with different semantics and generally need no babysitting, so running
    // them through these rules produced only non-actionable false anomalies.
    // They still get a plain warm/cold label derived from this row's own read.
    if (!isAnthropicPricing(record.provider, record.model)) {
      this.#feedForeignCall(record, ts);
      const hasMetrics =
        record.usage.cache_read_tokens > 0 || record.usage.cache_creation_tokens > 0;
      if (!hasMetrics) return [null, null];
      return [record.usage.cache_read_tokens > 0 ? "warm" : "cold", null];
    }

    const observation: Observation = {
      ts,
      model: record.model,
      thinking_enabled: record.thinking_enabled,
      cache_read_tokens: record.usage.cache_read_tokens,
      cache_write_tokens: record.usage.cache_creation_tokens,
      call_type: record.call_type,
    };
    const result = this.#trackers.forCharacter(record.character, this.#ttlSecs).observe(observation);
    const state: CacheState = result.state;
    const anomaly: Anomaly | undefined = result.anomaly;
    return [state, anomaly ?? null];
  }

  /**
   * Keep a non-Anthropic call from corrupting the Anthropic view.
   *
   * Compaction genuinely clears the prefix whatever model ran it. A foreground
   * message or tool loop is activity, which the keepalive-miss window anchors
   * on. Everything else is invisible here.
   */
  #feedForeignCall(record: RecordCall, ts: string): void {
    if (this.#trackers.needsSeed(record.character)) return;
    const tracker = this.#trackers.forCharacter(record.character, this.#ttlSecs);
    if (record.call_type === "compaction") {
      tracker.observe({
        ts,
        model: record.model,
        thinking_enabled: record.thinking_enabled,
        cache_read_tokens: record.usage.cache_read_tokens,
        cache_write_tokens: record.usage.cache_creation_tokens,
        call_type: record.call_type,
      });
    } else if (record.call_type === "message" || record.call_type === "tool_loop") {
      tracker.noteActivity(ts);
    }
  }

  /** Ported from `build_call_row`. */
  #buildRow(
    record: RecordCall,
    ts: string,
    cache_state: string | null,
    cache_anomaly: string | null,
  ): CallRow {
    const subscription = isSubscriptionProvider(record.provider);

    // Cached prices only — no fetch on the recording path. A row that cannot be
    // priced is left unpriced rather than delaying the call.
    const priced = subscription
      ? undefined
      : this.#pricing.cost({
          provider: record.provider,
          model: record.model,
          input_tokens: record.usage.input_tokens,
          output_tokens: record.usage.output_tokens,
          cache_read_tokens: record.usage.cache_read_tokens,
          cache_write_tokens: record.usage.cache_creation_tokens,
          cache_ttl: record.cache_ttl,
        });

    const providerTotal = subscription ? undefined : record.usage.total_cost_usd;
    const cost_source = subscription
      ? "subscription"
      : providerTotal !== undefined
        ? "provider_reported"
        : "pricing_catalog";
    // The per-component breakdown is recorded only when we priced the call
    // ourselves. A provider-reported total, or a subscription call, leaves it null.
    const breakdown = providerTotal === undefined ? priced : undefined;

    return {
      ts,
      character: record.character,
      provider: record.provider,
      api_key_name: record.api_key_name ?? null,
      model: record.model,
      call_type: record.call_type,
      input_tokens: record.usage.input_tokens,
      output_tokens: record.usage.output_tokens,
      cache_read_tokens: record.usage.cache_read_tokens,
      cache_write_tokens: record.usage.cache_creation_tokens,
      cache_ttl: record.cache_ttl ?? null,
      reasoning_effort: record.reasoning_effort ?? null,
      total_ms: record.timing.total_ms,
      ttft_ms: record.timing.time_to_first_token_ms,
      finish_reason: record.finish_reason,
      thinking_enabled: record.thinking_enabled ? 1 : 0,
      cache_state,
      cache_anomaly,
      input_cost: breakdown?.input ?? null,
      output_cost: breakdown?.output ?? null,
      cache_read_cost: breakdown?.cache_read ?? null,
      cache_write_cost: breakdown?.cache_write ?? null,
      cost_source,
      total_cost: providerTotal ?? priced?.total ?? (subscription ? 0 : null),
    };
  }
}

/** The `pricing` table, as a {@link PricingStore}. */
export function sqlitePricingStore(db: Database): PricingStore {
  return {
    get(modelId) {
      const row = db
        .query(
          `SELECT input_per_token, output_per_token, cache_read_per_token, cache_write_per_token
             FROM pricing WHERE model_id = $id`,
        )
        .get({ $id: modelId }) as ModelPricing | null;
      return row ?? undefined;
    },
    put(modelId, pricing) {
      db.query(
        `INSERT OR REPLACE INTO pricing
           (model_id, input_per_token, output_per_token,
            cache_read_per_token, cache_write_per_token, fetched_at)
         VALUES ($id, $input, $output, $read, $write, $at)`,
      ).run({
        $id: modelId,
        $input: pricing.input_per_token,
        $output: pricing.output_per_token,
        $read: pricing.cache_read_per_token,
        $write: pricing.cache_write_per_token,
        $at: new Date().toISOString(),
      });
    },
  };
}
