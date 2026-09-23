import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import {
  CacheTracker,
  CacheTrackers,
  type Anomaly,
  type CacheState,
  type Observation,
} from "../cache/tracker.ts";
import { isAnthropicPricing, PricingEngine, PRICING_TTL_MS, type ModelPricing, type PricingStore } from "./pricing.ts";
import { NANOGPT_PROVIDER } from "../llm/providers/nanogpt_config.ts";
import {
  nanoGptSubscriptionFresh,
  type NanoGptSubscriptionState,
} from "../llm/nanogpt_subscription.ts";

export { PRICING_TTL_MS } from "./pricing.ts";

const PRICING_CATALOG_SCHEMA = `CREATE TABLE IF NOT EXISTS pricing_catalog_checks (
    url        TEXT PRIMARY KEY,
    fetched_at INTEGER NOT NULL
);`;

const SCHEMA = `
${PRICING_CATALOG_SCHEMA}
CREATE TABLE IF NOT EXISTS calls (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  TEXT    NOT NULL,
    character           TEXT    NOT NULL,
    provider            TEXT    NOT NULL,
    api_key_name        TEXT,
    model               TEXT    NOT NULL,
    call_type           TEXT    NOT NULL,
    input_tokens        INTEGER NOT NULL,
    output_tokens       INTEGER NOT NULL,
    cache_read_tokens   INTEGER NOT NULL,
    cache_write_tokens  INTEGER NOT NULL,
    cache_ttl           TEXT    DEFAULT '1h',
    reasoning_effort    TEXT,
    tool_surface        TEXT,
    total_ms            INTEGER NOT NULL,
    ttft_ms             INTEGER NOT NULL,
    finish_reason       TEXT    NOT NULL,
    thinking_enabled    INTEGER NOT NULL,
    cache_state         TEXT,
    cache_anomaly       TEXT,
    input_cost          REAL,
    output_cost         REAL,
    cache_read_cost     REAL,
    cache_write_cost    REAL,
    cost_source         TEXT    DEFAULT 'pricing_catalog',
    total_cost          REAL,
    output_tokens_estimated INTEGER NOT NULL DEFAULT 0,
    thinking_dropped    INTEGER NOT NULL DEFAULT 0,
    cache_state_reason  TEXT
);

CREATE TABLE IF NOT EXISTS call_attempts (
    id                  TEXT PRIMARY KEY,
    started_at          TEXT NOT NULL,
    finished_at         TEXT,
    status              TEXT NOT NULL,
    character           TEXT NOT NULL,
    provider            TEXT NOT NULL,
    api_key_name        TEXT,
    model               TEXT NOT NULL,
    call_type           TEXT NOT NULL,
    estimated_cost      REAL,
    call_id             INTEGER,
    error               TEXT,
    FOREIGN KEY (call_id) REFERENCES calls(id)
);

CREATE TABLE IF NOT EXISTS pricing (
    model_id              TEXT PRIMARY KEY,
    input_per_token       REAL NOT NULL,
    output_per_token      REAL NOT NULL,
    cache_read_per_token  REAL NOT NULL,
    cache_write_per_token REAL NOT NULL,
    fetched_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_budget_warnings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_name    TEXT NOT NULL,
    period_start   TEXT NOT NULL,
    threshold      TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE (budget_name, period_start, threshold)
);

CREATE INDEX IF NOT EXISTS idx_calls_api_key ON calls (provider, api_key_name);
CREATE INDEX IF NOT EXISTS idx_calls_ts        ON calls (ts);
CREATE INDEX IF NOT EXISTS idx_calls_character ON calls (character);
CREATE INDEX IF NOT EXISTS idx_calls_provider  ON calls (provider);
CREATE INDEX IF NOT EXISTS idx_calls_anomaly   ON calls (cache_anomaly) WHERE cache_anomaly IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_attempts_status ON call_attempts (status, started_at);
CREATE INDEX IF NOT EXISTS idx_usage_budget_warnings_window
    ON usage_budget_warnings (budget_name, period_start);
`;

let subscriptionProviders = new Set(["opencode-go", "opencode"]);
let characterSubscriptionProviders = new Map<string, Set<string>>();

export function setSubscriptionProviders(names: Iterable<string>, characters: Iterable<readonly [string, Iterable<string>]> = []): void {
  subscriptionProviders = new Set(names);
  characterSubscriptionProviders = new Map([...characters].map(([character, providers]) => [character, new Set(providers)]));
}

export const isSubscriptionProvider = (provider: string, character?: string): boolean =>
  (character === undefined ? subscriptionProviders : characterSubscriptionProviders.get(character) ?? subscriptionProviders).has(provider);

let nanoGptCoveredModels = new Set<string>();
let nanoGptSubscriptionState: NanoGptSubscriptionState | undefined;

export function setNanoGptSubscription(
  models: Iterable<string>,
  state: NanoGptSubscriptionState | undefined,
): void {
  nanoGptCoveredModels = new Set(models);
  nanoGptSubscriptionState = state;
}

export function setNanoGptSubscriptionState(
  state: NanoGptSubscriptionState | undefined,
): void {
  nanoGptSubscriptionState = state;
}

export function isSubscriptionCall(
  provider: string,
  model: string,
  now: number = Date.now(),
  character?: string,
): boolean {
  if (provider !== NANOGPT_PROVIDER) return isSubscriptionProvider(provider, character);
  return nanoGptCoveredModels.has(model) &&
    nanoGptSubscriptionState?.active === true &&
    nanoGptSubscriptionState.state === "active" &&
    nanoGptSubscriptionFresh(nanoGptSubscriptionState, now);
}

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

export interface RecordCall {
  subscription?: boolean;
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
  keepalive_window_secs?: number | undefined;
  reasoning_effort?: string | undefined;
  tool_surface?: string | undefined;
  output_tokens_estimated?: boolean | undefined;
  thinking_dropped?: number | undefined;
  error?: string | undefined;
}

export const MAX_ATTEMPT_ERROR_CHARS = 500;

export function attemptErrorText(record: Pick<RecordCall, "finish_reason" | "error">): string | null {
  if (record.finish_reason !== "error") return null;
  const text = record.error?.trim();
  if (text === undefined || text === "") return "provider call failed";
  return text.length <= MAX_ATTEMPT_ERROR_CHARS
    ? text
    : `${text.slice(0, MAX_ATTEMPT_ERROR_CHARS)}…`;
}

export type CacheStateReason =
  | "cancelled"
  | "errored_before_usage"
  | "provider_reports_no_cache";

export interface CacheClassification {
  state: string | null;
  anomaly: string | null;
  reason: CacheStateReason | null;
}

export interface CallRow {
  id?: number;
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
  tool_surface: string | null;
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
  cost_source: string | null;
  total_cost: number | null;
  output_tokens_estimated: number;
  thinking_dropped: number;
  cache_state_reason: string | null;
}

const INSERT_SQL = `INSERT INTO calls (
  ts, character, provider, api_key_name, model, call_type,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  cache_ttl, reasoning_effort, tool_surface, total_ms, ttft_ms, finish_reason,
  thinking_enabled, cache_state, cache_anomaly,
  input_cost, output_cost, cache_read_cost, cache_write_cost,
  cost_source, total_cost, output_tokens_estimated, thinking_dropped, cache_state_reason
) VALUES (
  $ts, $character, $provider, $api_key_name, $model, $call_type,
  $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens,
  $cache_ttl, $reasoning_effort, $tool_surface, $total_ms, $ttft_ms, $finish_reason,
  $thinking_enabled, $cache_state, $cache_anomaly,
  $input_cost, $output_cost, $cache_read_cost, $cache_write_cost,
  $cost_source, $total_cost, $output_tokens_estimated, $thinking_dropped, $cache_state_reason
)`;

const LAST_ANTHROPIC_CALL_SQL = `SELECT ts, model, thinking_enabled, cache_read_tokens, tool_surface
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
  tool_surface: string | null;
}

export class Ledger {
  readonly #db: Database;
  readonly #trackers = new CacheTrackers();
  readonly #pricing: PricingEngine;
  #ttlSecs = 3600;

  private constructor(db: Database, pricing?: PricingEngine) {
    this.#db = db;
    this.#pricing = pricing ?? new PricingEngine(sqlitePricingStore(db));
  }

  static create(path: string, pricing?: PricingEngine, recoverPending = true): Ledger {
    const db = new Database(path, { create: true, readwrite: true });
    db.run("PRAGMA busy_timeout = 5000;");
    db.run("PRAGMA journal_mode = WAL;");
    db.run(SCHEMA);
    if (recoverPending) db.query("UPDATE call_attempts SET status = 'unresolved' WHERE status = 'pending'").run();
    return new Ledger(db, pricing);
  }

  static open(path: string, pricing?: PricingEngine): Ledger {
    const db = new Database(path, { create: false, readwrite: true });
    db.run("PRAGMA busy_timeout = 5000;");
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

  setMaxIdleSecs(secs: number): void {
    this.#trackers.setMaxIdleSecs(secs);
  }

  setCacheTtlSecs(secs: number): void {
    this.#ttlSecs = secs;
  }

  get cacheTtlSecs(): number {
    return this.#ttlSecs;
  }

  get database(): Database {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }

  beginAttempt(
    record: Pick<RecordCall, "provider" | "api_key_name" | "model" | "call_type" | "character">,
    estimatedCost?: number,
    now: () => Date = () => new Date(),
  ): string {
    const id = randomUUID();
    this.#db.query(
      `INSERT INTO call_attempts (
         id, started_at, status, character, provider, api_key_name, model, call_type, estimated_cost
       ) VALUES ($id, $started_at, 'pending', $character, $provider, $api_key_name,
                 $model, $call_type, $estimated_cost)`,
    ).run({
      $id: id,
      $started_at: now().toISOString(),
      $character: record.character,
      $provider: record.provider,
      $api_key_name: record.api_key_name ?? null,
      $model: record.model,
      $call_type: record.call_type,
      $estimated_cost: estimatedCost ?? null,
    });
    return id;
  }

  record(record: RecordCall, now: () => Date = () => new Date(), attemptId?: string): CallRow {
    const ts = now().toISOString();
    const classified = this.#trackCacheState(record, ts);
    const row = this.#buildRow(record, ts, classified);
    const insert = () => this.#db.query(INSERT_SQL).run({
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
      $tool_surface: row.tool_surface,
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
      $output_tokens_estimated: row.output_tokens_estimated,
      $thinking_dropped: row.thinking_dropped,
      $cache_state_reason: row.cache_state_reason,
    });
    if (attemptId === undefined) {
      const result = insert();
      row.id = Number(result.lastInsertRowid);
      return row;
    }
    this.#db.transaction(() => {
      const result = insert();
      row.id = Number(result.lastInsertRowid);
      this.#db.query(
        `UPDATE call_attempts
            SET status = $status, finished_at = $finished_at, call_id = $call_id,
                error = $error
          WHERE id = $id AND status = 'pending'`,
      ).run({
        $status: record.finish_reason === "error" ? "error" :
          record.finish_reason === "cancelled" ? "cancelled" : "completed",
        $finished_at: row.ts,
        $call_id: row.id,
        $error: attemptErrorText(record),
        $id: attemptId,
      });
    })();
    return row;
  }

  #seedIfNeeded(character: string): void {
    if (!this.#trackers.needsSeed(character)) return;
    const seed = this.#db.query(LAST_ANTHROPIC_CALL_SQL).get({ $character: character }) as
      | SeedRow
      | null;
    if (!seed) {
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
        undefined,
        seed.tool_surface ?? undefined,
      ),
    );
  }

  #trackCacheState(record: RecordCall, ts: string): CacheClassification {
    if (record.finish_reason === "cancelled") {
      return { state: null, anomaly: null, reason: "cancelled" };
    }

    const noCacheSignal =
      record.usage.cache_read_tokens === 0 && record.usage.cache_creation_tokens === 0;
    if (record.finish_reason === "error" && noCacheSignal) {
      return { state: null, anomaly: null, reason: "errored_before_usage" };
    }

    this.#seedIfNeeded(record.character);

    if (!isAnthropicPricing(record.provider, record.model)) {
      this.#feedForeignCall(record, ts);
      const hasMetrics =
        record.usage.cache_read_tokens > 0 || record.usage.cache_creation_tokens > 0;
      if (!hasMetrics) {
        return { state: null, anomaly: null, reason: "provider_reports_no_cache" };
      }
      return {
        state: record.usage.cache_read_tokens > 0 ? "warm" : "cold",
        anomaly: null,
        reason: null,
      };
    }

    const observation: Observation = {
      ts,
      provider: record.provider,
      model: record.model,
      keepalive_window_secs: record.keepalive_window_secs,
      thinking_enabled: record.thinking_enabled,
      cache_read_tokens: record.usage.cache_read_tokens,
      cache_write_tokens: record.usage.cache_creation_tokens,
      call_type: record.call_type,
      tool_surface: record.tool_surface,
    };
    const result = this.#trackers.forCharacter(record.character, this.#ttlSecs).observe(observation);
    const state: CacheState = result.state;
    const anomaly: Anomaly | undefined = result.anomaly;
    return { state, anomaly: anomaly ?? null, reason: null };
  }

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

  #buildRow(record: RecordCall, ts: string, classified: CacheClassification): CallRow {
    const { state: cache_state, anomaly: cache_anomaly } = classified;
    const subscription = record.subscription ?? isSubscriptionCall(record.provider, record.model, Date.parse(ts), record.character);

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
      tool_surface: record.tool_surface ?? null,
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
      output_tokens_estimated: record.output_tokens_estimated === true ? 1 : 0,
      thinking_dropped: record.thinking_dropped ?? 0,
      cache_state_reason: classified.reason,
    };
  }
}

function sqlitePricingStore(db: Database, now: () => number = () => Date.now()): PricingStore {
  return {
    catalogFetchedAt(url) {
      const row = db.query("SELECT fetched_at FROM pricing_catalog_checks WHERE url = ?1")
        .get(url) as { fetched_at: number } | null;
      return row?.fetched_at;
    },
    putCatalogFetchedAt(url, at) {
      db.query("INSERT OR REPLACE INTO pricing_catalog_checks (url, fetched_at) VALUES (?1, ?2)")
        .run(url, at);
    },
    get(modelId) {
      const row = db
        .query(
          `SELECT input_per_token, output_per_token, cache_read_per_token,
                  cache_write_per_token, fetched_at
             FROM pricing WHERE model_id = $id`,
        )
        .get({ $id: modelId }) as (ModelPricing & { fetched_at: string }) | null;
      if (row === null) return undefined;
      const fetchedAt = Date.parse(row.fetched_at);
      if (Number.isNaN(fetchedAt) || now() - fetchedAt >= PRICING_TTL_MS) return undefined;
      return {
        input_per_token: row.input_per_token,
        output_per_token: row.output_per_token,
        cache_read_per_token: row.cache_read_per_token,
        cache_write_per_token: row.cache_write_per_token,
      };
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
